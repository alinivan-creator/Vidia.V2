/**
 * Step 3 — Presentation only. Formats HandlerResult into WhatsApp text.
 * Must not decide availability, confirm bookings, or invent hours.
 */

import { buildAiTransparencyWelcome, buildBookingConfirmationMessage, buildGdprNote, buildMapsInviteLine, MAPS_ANCHOR_LABEL, mapsAnchorLabel, withMandatoryAiDisclosure } from '../utils/businessMessages.js';
import { WA_DIVIDER, waField, waFooter, waJoin, waServiceMeta, waTitle } from '../utils/waCopy.js';
import { timeWindowBounds } from '../utils/timeWindow.js';
import { formatContactMessage } from './contactService.js';
import { completeTenantChat } from './aiContextLoader.js';
import { isSupersededTurn } from './turnSequencer.js';
import {
  sendTextMessage,
  sendMessageWithUrlButton,
  sendInteractiveButtons,
  sendInteractiveList,
  sendBookingFlow,
  clearRememberedMenuOptions,
  simulateHumanDelay,
} from './whatsappService.js';
import { formatMachineAction, formatterSystemHint } from '../lib/ai/responseFormatter.js';
import { MACHINE_ACTIONS } from '../lib/booking/stateMachine.js';
import { unknownInfoClientMessage } from '../utils/workingHours.js';
import { missingBusinessInfoMessage } from '../utils/businessInfoLookup.js';
import { formatServiceAskMessage, bookingExamplePhrase } from '../utils/serviceMatch.js';
import { mergeMenuOptions } from '../utils/bookingGrid.js';
import { t, localizeMenuOptions, normalizeUiLang, entryMenuBodyText, withEnglishSwitchOption } from '../utils/uiI18n.js';
import { formatSlotLabel, localToUtc } from '../utils/datetime.js';

/** @typedef {import('../db/businessService.js').Business} Business */
/** @typedef {import('./handlerResult.js').HandlerResult} HandlerResult */

/**
 * Prefer rebuilding the slot label in the session language when date+time are known.
 * @param {Business} business
 * @param {Record<string, unknown>} d
 * @param {'ro' | 'en'} lang
 */
function slotLabelForLang(business, d, lang) {
  const dateKey = typeof d.date_key === 'string' ? d.date_key : null;
  const time = typeof d.time_hhmm === 'string' ? d.time_hhmm : null;
  if (dateKey && time && /^\d{4}-\d{2}-\d{2}$/.test(dateKey) && /^\d{2}:\d{2}$/.test(time)) {
    const start = localToUtc(dateKey, time, business.timezone || 'Europe/Bucharest');
    if (start && !Number.isNaN(start.getTime())) {
      return formatSlotLabel(start, business.timezone || 'Europe/Bucharest', lang);
    }
  }
  return String(d.slot_label || '');
}

/**
 * Ensure the Admin maps CTA survives AI polish (which often drops markdown links).
 * @param {Business} business
 * @param {string} text
 * @param {'ro' | 'en'} [lang]
 * @returns {string}
 */
function ensureMapsInviteOnConfirmation(business, text, lang = 'ro') {
  const body = String(text || '').trimEnd();
  if (!body) return body;
  const maps = buildMapsInviteLine(business, lang);
  if (!maps?.messageLine || !maps.url) return body;
  const anchor = mapsAnchorLabel(lang);
  if (body.includes(maps.url) || body.includes(anchor) || body.includes(MAPS_ANCHOR_LABEL)) return body;
  return `${body}\n\n${maps.messageLine}`;
}

/**
 * Deterministic templates from backend JSON. No invented facts.
 * @param {Business} business
 * @param {HandlerResult} result
 */
export function renderHandlerResult(business, result) {
  const d = result.data || {};
  const key = result.user_message_template_key;
  // Optional EN overlay only — default path stays the stable Romanian templates.
  const lang = normalizeUiLang(d.ui_language);
  const en = lang === 'en';

  // Grid window bodies are authoritative in RO — for EN, prefer bilingual templates /
  // machine actions so session_language actually switches copy (not only button titles).
  if (
    typeof d.client_message === 'string'
    && d.client_message.trim()
    && !en
    && (key === 'ASK_DATE' || key === 'ASK_TIME' || key === 'MISSING_SLOT')
  ) {
    return d.client_message.trim();
  }

  const machineText = result.machine_action
    ? formatMachineAction({
      action: result.machine_action,
      draft: {
        service_name: d.service_name || d.draft_service_name || null,
        date: d.date_key || d.date || null,
        time: d.time_hhmm || d.time || null,
      },
      clientName: d.client_name || null,
      employeeName: d.employee_name || null,
      timezone: business.timezone || 'Europe/Bucharest',
      clarifyValue: d.value ?? null,
      alternatives: d.alternatives || [],
      occupiedLabel: d.occupied_label || null,
      services: d.services || [],
      lang,
    })
    : null;
  if (machineText) return machineText;

  const menuBlock = '';

  switch (key) {
    case 'ASK_NAME':
      return (
        (typeof d.client_message === 'string' && d.client_message)
        || waJoin(
          waTitle(en ? 'What is your name?' : 'Cum te cheamă?'),
          en ? 'First and last name — e.g. *Ana Popescu*' : 'Prenume și nume — ex: *Ana Popescu*',
        )
      );
    case 'ASK_CONFIRM': {
      const when = slotLabelForLang(business, d, lang) || String(d.slot_label || '');
      if (en) {
        return waJoin(
          waTitle(t('confirmTitle', 'en')),
          '',
          waField(t('labelClient', 'en'), d.client_name),
          waField(t('labelSpecialist', 'en'), d.employee_name),
          waField(t('labelService', 'en'), d.service_name || t('labelService', 'en')),
          waField(t('labelWhen', 'en'), when),
        );
      }
      return waJoin(
        waTitle('Confirmi programarea?'),
        '',
        waField('Client', d.client_name),
        waField('Specialist', d.employee_name),
        waField('Serviciu', d.service_name || 'Serviciu'),
        waField('Când', when || d.slot_label || ''),
      );
    }
    case 'CONFIRMATION_BOOKED':
      return buildBookingConfirmationMessage({
        business,
        serviceName: String(d.service_name || (en ? 'Service' : 'Serviciu')),
        slotLabel: slotLabelForLang(business, d, lang) || String(d.slot_label || ''),
        clientName: String(d.client_name || ''),
        calendarLine: '',
        // mapsLine omitted → Admin Link hartă / adresă (buildMapsInviteLine)
        includeGdpr: false,
        lang,
      });
    case 'CONFIRMATION_RESCHEDULE': {
      if (typeof d.client_message === 'string' && d.client_message.trim()) {
        return d.client_message.trim();
      }
      return waJoin(
        waTitle(en ? t('rescheduledTitle', 'en') : t('rescheduledTitle', 'ro')),
        '',
        waField(en ? t('labelService', 'en') : t('labelService', 'ro'), d.service_name || (en ? 'Service' : 'Serviciu')),
        waField(en ? t('labelNewDate', 'en') : t('labelNewDate', 'ro'), d.slot_label || ''),
        '',
        en ? t('rescheduledHint', 'en') : t('rescheduledHint', 'ro'),
      );
    }
    case 'CONFIRMATION_CANCELLED':
      if (typeof d.client_message === 'string' && d.client_message.trim()) {
        return d.client_message.trim();
      }
      return waJoin(
        waTitle(en ? t('cancelledTitle', 'en') : t('cancelledTitle', 'ro')),
        en ? t('cancelledHint', 'en') : t('cancelledHint', 'ro'),
      );
    case 'CANCEL_PENDING':
      return lang === 'en'
        ? waJoin(
          waTitle('Cancelled'),
          'For a new booking, type *booking*.',
        )
        : waJoin(
          waTitle('Anulat'),
          'Pentru o programare nouă, scrie *programare*.',
        );
    case 'FLOW_ABORTED':
      return waJoin(
        waTitle('Ok, m-am oprit'),
        'Cu ce te mai pot ajuta?',
      );
    case 'THANKS':
      return (typeof d.client_message === 'string' && d.client_message.trim())
        || 'Cu plăcere! Dacă mai ai nevoie — o programare, orarul sau contact — scrie-mi oricând.';
    case 'MISSING_EMPLOYEE': {
      const names = (d.services || []).map((e) => e.name).filter(Boolean);
      const intro = d.client_message || 'Nu am găsit specialistul. Alege din echipă:';
      return names.length
        ? waJoin(waTitle('Specialist'), `${intro} ${names.join(', ')}.`)
        : intro;
    }
    case 'MISSING_SERVICE':
      if (en) {
        return formatServiceAskMessage(d.services || [], 'en');
      }
      return formatServiceAskMessage(d.services || [], 'ro');
    case 'ASK_DATE':
      if (en && !(typeof d.client_message === 'string' && d.client_message.trim())) {
        return waJoin(
          waTitle(d.service_name ? `${t('askDayTitle', 'en')} — ${d.service_name}` : t('askDayTitle', 'en')),
          t('askDayHint', 'en'),
        );
      }
      return (
        (typeof d.client_message === 'string' && d.client_message)
        || waJoin(
          waTitle(d.service_name ? `Alege ziua — ${d.service_name}` : 'Alege ziua'),
          'Apasă *Zile disponibile* și selectează data.',
        )
      );
    case 'ASK_TIME': {
      if (typeof d.client_message === 'string' && d.client_message.trim()) {
        return d.client_message.trim();
      }
      const bounds = timeWindowBounds(d.time_window);
      if (en) {
        const windowHint = bounds ? ` (${bounds.labelEn || bounds.labelRo})` : '';
        return waJoin(
          waTitle(d.service_name ? `${t('askTimeTitle', 'en')} — ${d.service_name}${windowHint}` : `${t('askTimeTitle', 'en')}${windowHint}`),
          d.date_label ? `*${t('labelDate', 'en')}*\n${d.date_label}` : null,
          t('askTimeHint', 'en'),
        );
      }
      const windowHint = bounds ? ` (${bounds.labelRo})` : '';
      return waJoin(
        waTitle(d.service_name ? `Alege ora — ${d.service_name}${windowHint}` : `Alege ora${windowHint}`),
        d.date_label ? `*Data*\n${d.date_label}` : null,
        'Atinge ora dorită mai jos.',
      );
    }
    case 'ASK_CLARIFY_DATE_OR_TIME':
      return (
        (typeof d.client_message === 'string' && d.client_message)
        || waJoin(
          waTitle('Lămurire'),
          `*${d.date_label || d.value}* e data sau ora *${d.time_label || d.value}*?`,
        )
      );
    case 'MISSING_SLOT': {
      if (typeof d.client_message === 'string' && d.client_message.trim()) {
        return d.client_message.trim();
      }
      const bounds = timeWindowBounds(d.time_window);
      const windowHint = bounds ? ` (${bounds.labelRo})` : '';
      return waJoin(
        waTitle(d.service_name ? `Alege ora — ${d.service_name}${windowHint}` : `Alege ora${windowHint}`),
        d.date_label ? `*Data*\n${d.date_label}` : null,
        'Atinge ora dorită mai jos.',
      );
    }
    case 'SLOT_UNAVAILABLE': {
      if (typeof d.client_message === 'string' && d.client_message.trim()) {
        return d.client_message.trim();
      }
      const occupied = d.occupied_label
        ? `Înțeleg — *${d.occupied_label}* nu mai e liber.`
        : 'Înțeleg, intervalul ăsta nu mai e liber.';
      return waJoin(
        waTitle('Hai să alegem altceva'),
        occupied,
        '',
        'Te rog alege altă oră din listă (sau altă zi, dacă preferi).',
      );
    }
    case 'MISSING_APPOINTMENT': {
      const body = typeof d.client_message === 'string' && d.client_message.trim()
        ? d.client_message.trim()
        : t(d.intent === 'cancel' ? 'whichToCancel' : 'whichToMove', lang);
      return waJoin(waTitle(t('listAppointments', lang)), body);
    }
    case 'CONFIRM_CANCEL':
      if (typeof d.client_message === 'string' && d.client_message.trim()) {
        return waJoin(
          waTitle(en ? 'Confirm cancellation?' : 'Confirmi anularea?'),
          '',
          d.client_message.trim(),
        );
      }
      return waJoin(
        waTitle(en ? 'Confirm cancellation?' : 'Confirmi anularea?'),
        '',
        waField(en ? t('labelService', 'en') : t('labelService', 'ro'), d.service_name || (en ? 'Appointment' : 'Programare')),
        waField(en ? t('labelWhen', 'en') : t('labelWhen', 'ro'), d.slot_label || ''),
      );
    case 'CLOSED_HOURS':
    case 'ERROR_DURATION':
    case 'ERROR_CALENDAR':
    case 'ERROR_NO_APPOINTMENT':
    case 'ERROR_GENERIC':
    case 'HOLD_EXPIRED':
      return String(d.client_message || 'A apărut o eroare. Încearcă din nou sau scrie *contact*.');
    case 'SERVICES_LIST': {
      const services = d.services || [];
      if (!services.length) return unknownInfoClientMessage();
      const blocks = [waTitle(`Servicii — ${business.name}`), ''];
      services.forEach((s, i) => {
        const meta = waServiceMeta(s);
        blocks.push(`*${i + 1}. ${s.name}*`);
        if (meta) blocks.push(meta);
        blocks.push('');
      });
      blocks.push(WA_DIVIDER, '', `Pentru programare: *${bookingExamplePhrase(services)}*`);
      return blocks.join('\n');
    }
    case 'HOURS_LIST':
      if (!d.hours_configured || !d.hours_text) {
        return unknownInfoClientMessage();
      }
      return lang === 'en'
        ? waJoin(waTitle(`Hours — ${business.name}`), '', d.hours_text)
        : waJoin(waTitle(`Program — ${business.name}`), '', d.hours_text);
    case 'HOURS_AND_SERVICES': {
      const hoursBlock = d.hours_configured && d.hours_text
        ? (lang === 'en'
          ? waJoin(waTitle(`Hours — ${business.name}`), '', d.hours_text)
          : waJoin(waTitle(`Program — ${business.name}`), '', d.hours_text))
        : '';
      const services = d.services || [];
      const serviceBlocks = [waTitle('Servicii'), ''];
      services.forEach((s, i) => {
        const meta = waServiceMeta(s);
        serviceBlocks.push(`*${i + 1}. ${s.name}*`);
        if (meta) serviceBlocks.push(meta);
        serviceBlocks.push('');
      });
      return [hoursBlock, serviceBlocks.join('\n')].filter(Boolean).join(`\n\n${WA_DIVIDER}\n\n`);
    }
    case 'CONTACT':
      return formatContactMessage(business);
    case 'MENU':
      return buildAiTransparencyWelcome(business, lang);
    case 'CALLBACK_SENT':
      return waJoin(
        waTitle('Cerere înregistrată'),
        `Un coleg de la *${d.business_name || business.name}* te sună în curând.`,
      );
    case 'MY_APPOINTMENTS': {
      const rows = d.appointments || [];
      if (!rows.length) {
        return waJoin(
          waTitle(t('listAppointments', lang)),
          t('noActiveAppts', lang),
          '',
          t('myApptsEmptyHint', lang),
        );
      }
      const lines = rows.map((a) => `• *${a.service_name || (en ? 'Appointment' : 'Programare')}*\n  ${a.slot_label || ''}`);
      return waJoin(
        waTitle(t('listAppointments', lang)),
        '',
        lines.join('\n\n'),
        '',
        WA_DIVIDER,
        '',
        waFooter(en ? ['*cancel*', '*reschedule*'] : ['*anulează*', '*reprogramare*']),
      );
    }
    case 'CHAT_FALLBACK':
      return (typeof d.client_message === 'string' && d.client_message.trim())
        || (lang === 'en'
          ? waJoin(
            waTitle(`Booking assistant — ${d.business_name || business.name}`),
            "I didn't catch that. Please pick an option from the menu or rephrase (e.g. *Friday at 11*).",
            '',
            waFooter(['booking', 'hours', 'contact']),
          )
          : waJoin(
            waTitle(`Asistent programări — ${d.business_name || business.name}`),
            'Nu am înțeles exact. Te rog alege o opțiune din meniu sau reformulează (ex: *vreau vineri la 11*).',
            '',
            waFooter(['programare', 'orar', 'contact']),
          ));
    case 'OFF_TOPIC':
      return lang === 'en'
        ? waJoin(
          waTitle(`Booking assistant — ${d.business_name || business.name}`),
          "I can help with bookings, hours, and contact. Please pick a menu option or rephrase (e.g. *book tomorrow at 10*).",
          '',
          waFooter(['booking', 'hours', 'contact']),
        )
        : waJoin(
          waTitle(`Asistent programări — ${d.business_name || business.name}`),
          'Te pot ajuta cu programări, orar și contact. Alege din meniu sau reformulează (ex: *vreau mâine la 10*).',
          '',
          waFooter(['programare', 'orar', 'contact']),
        );
    case 'UNKNOWN_SERVICE':
      return (typeof d.client_message === 'string' && d.client_message.trim())
        || (lang === 'en'
          ? `Unfortunately we don't offer that service. Please choose from the list.`
          : 'Din păcate nu oferim acest serviciu. Te rog alege din listă.');
    case 'STALE_CHOICE':
      return (typeof d.client_message === 'string' && d.client_message.trim())
        || 'Opțiunea aia nu mai e pe lista curentă. Te rog alege din mesajul cel mai recent (sau scrie *programare*).';
    case 'ADMIN_FACT':
      return String(d.fact || unknownInfoClientMessage(lang));
    case 'MISSING_INFO':
      return d.client_message
        || missingBusinessInfoMessage(d.topic_label || null, lang)
        || unknownInfoClientMessage(lang);
    default:
      return String(d.client_message || 'Spune-mi cum te pot ajuta.');
  }
}

/**
 * Optional polish: rephrase rendered copy only. Never add hours/availability/confirmations.
 * @returns {Promise<string | null>}
 */
async function polishWithAi(business, result, rendered) {
  if (!business?.id || !rendered?.trim()) return null;

  // Never polish EN sessions back into Romanian (formatter hints are RO-only).
  if (normalizeUiLang(result.data?.ui_language) === 'en') return null;

  const action = result.machine_action;
  const templateKey = result.user_message_template_key;
  const allowByMachine = action === MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION
    || action === MACHINE_ACTIONS.ACTION_ASK_CLARIFICATION
    || action === MACHINE_ACTIONS.ACTION_ASK_DATE
    || action === MACHINE_ACTIONS.ACTION_ASK_TIME
    || action === MACHINE_ACTIONS.ACTION_ASK_DATE_TIME
    || action === MACHINE_ACTIONS.ACTION_ASK_SERVICE;
  const allowByTemplate = templateKey === 'CONFIRMATION_BOOKED'
    || templateKey === 'CONFIRMATION_RESCHEDULE'
    || templateKey === 'CONFIRMATION_CANCELLED'
    || templateKey === 'CANCEL_PENDING'
    || templateKey === 'FLOW_ABORTED'
    || templateKey === 'OUT_OF_HOURS'
    || templateKey === 'CLARIFY'
    || templateKey === 'ASK_WHICH_BOOKING'
    || templateKey === 'WELCOME'
    || templateKey === 'MENU'
    || templateKey === 'CHAT'
    || templateKey === 'OFF_TOPIC'
    || templateKey === 'THANKS'
    || templateKey === 'ERROR_NO_APPOINTMENT'
    || templateKey === 'ERROR_GENERIC'
    || templateKey === 'ERROR_CALENDAR';
  if (!allowByMachine && !allowByTemplate) return null;

  const payload = {
    status: result.status,
    action_performed: result.action_performed,
    template_key: templateKey,
    data: result.data,
    next_required_step: result.next_required_step,
    template: rendered,
  };

  const extraSystem = action
    ? formatterSystemHint(action)
    : formatterSystemHint(templateKey || 'default');

  const chat = await completeTenantChat({
    businessId: business.id,
    parserMode: true,
    extraSystem,
    userContent: JSON.stringify(payload).slice(0, 2500),
    temperature: 0.45,
    maxTokens: 320,
  });
  return chat.ok && chat.text ? chat.text : null;
}

/**
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {HandlerResult} params.result
 * @param {string | null} [params.requestId]
 * @param {number | null} [params.turnStamp] — session timestamp this turn started from
 */
export async function presentTurn({
  business,
  recipientPhone,
  result,
  requestId = null,
  turnStamp = null,
}) {
  // The client already sent another message — replying now would land out of order.
  if (await isSupersededTurn({ business, recipientPhone, turnStamp })) {
    console.log('[turn-order] Skip presentation, newer inbound arrived', {
      businessId: business?.id ?? null,
      requestId,
      template: result?.user_message_template_key ?? null,
    });
    return;
  }

  const gridKinds = new Set(['day_grid', 'time_grid', 'confirm', 'clarify', 'entry', 'resume', 'service', 'unknown_service', 'modify']);
  if (result.menu?.options?.length && gridKinds.has(String(result.menu.kind || ''))) {
    // Remembered by sendInteractiveButtons (full catalog when provided).
  } else if (result.status === 'SUCCESS' && !result.next_required_step) {
    clearRememberedMenuOptions(business.id, recipientPhone);
  }

  const rendered = renderHandlerResult(business, result);
  // Do not polish grid layouts — AI would flatten the window framing.
  const skipPolish = result.menu?.kind === 'day_grid'
    || result.menu?.kind === 'time_grid'
    || result.menu?.kind === 'service'
    || result.menu?.kind === 'unknown_service'
    || result.menu?.kind === 'modify'
    || result.user_message_template_key === 'ASK_DATE'
    || result.user_message_template_key === 'ASK_TIME'
    || result.user_message_template_key === 'MISSING_SLOT'
    || result.user_message_template_key === 'MISSING_SERVICE'
    || result.user_message_template_key === 'MISSING_APPOINTMENT'
    || result.user_message_template_key === 'UNKNOWN_SERVICE'
    || result.user_message_template_key === 'STALE_CHOICE'
    || result.user_message_template_key === 'CONTACT'
    || result.user_message_template_key === 'ASK_CONFIRM'
    || result.user_message_template_key === 'CONFIRM_CANCEL'
    || result.user_message_template_key === 'CONFIRMATION_BOOKED';
  const polished = skipPolish ? null : await polishWithAi(business, result, rendered);
  let text = polished || rendered;
  if (
    result.user_message_template_key === 'CONFIRMATION_BOOKED'
    || result.action_performed === 'BOOKED'
  ) {
    text = ensureMapsInviteOnConfirmation(business, text, normalizeUiLang(result.data?.ui_language));
  }
  const d = result.data || {};
  const lang = normalizeUiLang(d.ui_language);
  const en = lang === 'en';

  // Legal: first reply on a new conversation thread must disclose AI + short GDPR.
  // MENU welcome already embeds the disclosure — skip double-wrapping.
  if (d.attach_ai_disclosure === true && result.user_message_template_key !== 'MENU') {
    text = withMandatoryAiDisclosure(text, business, lang);
  }

  await simulateHumanDelay({ business, recipientPhone, requestId });

  const needsGdpr =
    result.action_performed === 'BOOKED' || result.action_performed === 'RESCHEDULED';
  if (needsGdpr) {
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: buildGdprNote(business, lang),
    });
  }

  if (result.calendar_cta?.url) {
    // Confirmation body (with short maps markdown) + calendar URL button.
    await sendMessageWithUrlButton({
      business,
      recipientPhone,
      requestId,
      text,
      buttonTitle: en ? t('addCalendar', 'en') : t('addCalendar', 'ro'),
      buttonUrl: result.calendar_cta.url,
    });
    return;
  }

  if (d.link_ctas?.length || d.maps_cta?.url || d.website_cta?.url) {
    const buttons = Array.isArray(d.link_ctas) && d.link_ctas.length
      ? d.link_ctas
      : [
        d.maps_cta?.url ? { title: d.maps_cta.title || (en ? t('seeLocation', 'en') : 'Vezi locația'), url: d.maps_cta.url } : null,
        d.website_cta?.url ? { title: d.website_cta.title || 'Website', url: d.website_cta.url } : null,
      ].filter(Boolean);
    const [first, ...rest] = buttons;
    if (first?.url) {
      await sendMessageWithUrlButton({
        business,
        recipientPhone,
        requestId,
        text,
        buttonTitle: String(first.title || 'Link').slice(0, 20),
        buttonUrl: first.url,
        extraButtons: rest,
      });
      return;
    }
  }

  // Native WhatsApp Flow when configured; on failure fall through to list-picker.
  if (d.ui === 'whatsapp_flow' && d.flow_id) {
    const sent = await sendBookingFlow({
      business,
      recipientPhone,
      flowId: String(d.flow_id),
      bodyText: text,
      cta: en ? t('openCalendar', 'en') : 'Deschide calendarul',
      requestId,
      flowToken: typeof d.flow_token === 'string' ? d.flow_token : null,
    });
    if (sent.ok) return;

    const { listOpenDayWindows, buildListPickerPage, formatDayGridMessage } = await import('../utils/bookingGrid.js');
    const days = listOpenDayWindows(business);
    const listPage = buildListPickerPage(days, 0);
    if (listPage.items.length) {
      await sendInteractiveList({
        business,
        recipientPhone,
        requestId,
        bodyText: formatDayGridMessage(days, business.timezone, d.service_name ? String(d.service_name) : null),
        buttonText: 'Zile disponibile',
        sections: [{
          title: 'Zile',
          rows: listPage.items.map((i) => ({
            id: i.id,
            title: i.title,
            description: i.description || 'Disponibil',
          })),
        }],
        footerText: business.name,
        menuKind: 'day_grid',
        rememberOptions: mergeMenuOptions(
          listPage.items.map((i) => ({ id: i.id, title: i.title, description: i.description })),
          days.map((day) => ({ id: day.id, title: day.title, description: day.description })),
        ),
      });
      return;
    }
  }

  const interactiveKeys = new Set([
    'ASK_CLARIFY_DATE_OR_TIME',
    'ASK_CONFIRM',
    'CONFIRM_CANCEL',
    'ASK_DATE',
    'ASK_TIME',
    'MISSING_SLOT',
    'MISSING_SERVICE',
    'MISSING_APPOINTMENT',
    'UNKNOWN_SERVICE',
    'STALE_CHOICE',
    'MENU',
  ]);

  if (result.menu?.options?.length && interactiveKeys.has(String(result.user_message_template_key || ''))) {
    if (result.user_message_template_key === 'MENU') {
      await sendTextMessage({ business, recipientPhone, requestId, text });
      await simulateHumanDelay({ business, recipientPhone, requestId, delayMs: 800 });
      const menuButtons = localizeMenuOptions(
        withEnglishSwitchOption(result.menu.options, lang),
        lang,
      );
      await sendInteractiveButtons({
        business,
        recipientPhone,
        requestId,
        bodyText: entryMenuBodyText(lang),
        buttons: menuButtons,
        footerText: business.name,
        menuKind: result.menu.kind || 'entry',
        rememberOptions: mergeMenuOptions(menuButtons, localizeMenuOptions(result.menu.catalog || [], lang)),
      });
      return;
    }

    const kind = String(result.menu.kind || '');
    const wantsList = kind === 'day_grid'
      || kind === 'service'
      || kind === 'modify'
      || (kind === 'time_grid' && d.ui === 'list_picker')
      || (kind === 'time_grid' && result.menu.options.length > 3);

    if (wantsList) {
      const buttonLabel = en
        ? (kind === 'day_grid' ? t('listDays', 'en')
          : kind === 'service' ? t('listServices', 'en')
            : kind === 'modify' ? t('listAppointments', 'en')
              : t('listTimes', 'en'))
        : (typeof d.list_button === 'string' && d.list_button
          ? d.list_button
          : (kind === 'day_grid' ? 'Zile disponibile' : kind === 'service' ? 'Servicii' : kind === 'modify' ? 'Programările tale' : 'Ore libere'));
      const sectionTitle = en
        ? (kind === 'day_grid' ? t('sectionDays', 'en')
          : kind === 'service' ? t('sectionServices', 'en')
            : kind === 'modify' ? t('sectionAppointments', 'en')
              : t('sectionTimes', 'en'))
        : (kind === 'day_grid' ? 'Zile' : kind === 'service' ? 'Servicii' : kind === 'modify' ? 'Programări' : 'Ore');
      const rowDesc = en
        ? (kind === 'day_grid' ? t('available', 'en')
          : kind === 'service' ? t('fromCatalog', 'en')
            : kind === 'modify' ? t('activeBooking', 'en')
              : t('freeSlot', 'en'))
        : (kind === 'day_grid' ? 'Disponibil' : kind === 'service' ? 'Din catalog' : kind === 'modify' ? 'Programare activă' : 'Liber');
      const listOptions = localizeMenuOptions(result.menu.options, lang);
      await sendInteractiveList({
        business,
        recipientPhone,
        requestId,
        bodyText: text,
        buttonText: buttonLabel,
        sections: [{
          title: sectionTitle,
          rows: listOptions.map((opt) => ({
            id: opt.id,
            title: opt.title,
            description: opt.description || rowDesc,
          })),
        }],
        footerText: business.name,
        menuKind: kind || 'list',
        // Must include page nav ids (grid_next / grid_prev) + full catalog for this picker.
        rememberOptions: mergeMenuOptions(listOptions, localizeMenuOptions(result.menu.catalog || [], lang)),
      });
      return;
    }

    const btnOptions = localizeMenuOptions(result.menu.options, lang);
    await sendInteractiveButtons({
      business,
      recipientPhone,
      requestId,
      bodyText: text,
      buttons: btnOptions,
      footerText: business.name,
      menuKind: kind || 'generic',
      rememberOptions: mergeMenuOptions(btnOptions, localizeMenuOptions(result.menu.catalog || [], lang)),
    });
    return;
  }

  await sendTextMessage({ business, recipientPhone, requestId, text });
}
