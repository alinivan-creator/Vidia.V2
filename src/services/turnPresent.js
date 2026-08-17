/**
 * Step 3 — Presentation only. Formats HandlerResult into WhatsApp text.
 * Must not decide availability, confirm bookings, or invent hours.
 */

import { buildAiTransparencyWelcome, buildBookingConfirmationMessage, buildGdprNote } from '../utils/businessMessages.js';
import { WA_DIVIDER, waField, waFooter, waJoin, waServiceMeta, waTitle } from '../utils/waCopy.js';
import { timeWindowBounds } from '../utils/timeWindow.js';
import { formatContactMessage } from './contactService.js';
import { completeTenantChat } from './aiContextLoader.js';
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

/** @typedef {import('../db/businessService.js').Business} Business */
/** @typedef {import('./handlerResult.js').HandlerResult} HandlerResult */

/**
 * Deterministic templates from backend JSON. No invented facts.
 * @param {Business} business
 * @param {HandlerResult} result
 */
export function renderHandlerResult(business, result) {
  const d = result.data || {};
  const key = result.user_message_template_key;
  const lang = d.client_language === 'en' ? 'en' : 'ro';

  // Grid window bodies are authoritative — do not let machine polish overwrite them.
  if (
    typeof d.client_message === 'string'
    && d.client_message.trim()
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
          waTitle('Cum te cheamă?'),
          'Prenume și nume — ex: *Ana Popescu*',
        )
      );
    case 'ASK_CONFIRM': {
      return waJoin(
        waTitle('Confirmi programarea?'),
        '',
        waField('Client', d.client_name),
        waField('Specialist', d.employee_name),
        waField('Serviciu', d.service_name || 'Serviciu'),
        waField('Când', d.slot_label || ''),
      );
    }
    case 'CONFIRMATION_BOOKED':
      return buildBookingConfirmationMessage({
        business,
        serviceName: String(d.service_name || 'Serviciu'),
        slotLabel: String(d.slot_label || ''),
        clientName: String(d.client_name || ''),
        calendarLine: '',
        // No markdown maps line — WhatsApp already shows the location card / Maps CTA.
        mapsLine: '',
        includeGdpr: false,
      });
    case 'CONFIRMATION_RESCHEDULE': {
      return waJoin(
        waTitle('Programare actualizată'),
        '',
        waField('Serviciu', d.service_name || 'Serviciu'),
        waField('Când', d.slot_label || ''),
        '',
        WA_DIVIDER,
        '',
        waFooter(['*reprogramare*', '*anulează*']),
      );
    }
    case 'CONFIRMATION_CANCELLED':
      if (typeof d.client_message === 'string' && d.client_message.trim()) {
        return waJoin(
          waTitle('Programări anulate'),
          d.client_message.trim(),
        );
      }
      return waJoin(
        waTitle('Programare anulată'),
        'Te așteptăm oricând dorești o nouă programare.',
      );
    case 'CANCEL_PENDING':
      return waJoin(
        waTitle('Anulat'),
        'Pentru o programare nouă, scrie *programare*.',
      );
    case 'FLOW_ABORTED':
      return waJoin(
        waTitle('Ok, m-am oprit'),
        'Cu ce te mai pot ajuta?',
      );
    case 'MISSING_EMPLOYEE': {
      const names = (d.services || []).map((e) => e.name).filter(Boolean);
      const intro = d.client_message || 'Nu am găsit specialistul. Alege din echipă:';
      return names.length
        ? waJoin(waTitle('Specialist'), `${intro} ${names.join(', ')}.`)
        : intro;
    }
    case 'MISSING_SERVICE':
      return formatServiceAskMessage(d.services || []);
    case 'ASK_DATE':
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
      const occupied = d.occupied_label
        ? `*${d.occupied_label}* tocmai s-a ocupat.`
        : (d.client_message || 'Intervalul nu e disponibil.');
      if (typeof d.client_message === 'string' && d.client_message.trim()) {
        return d.client_message;
      }
      return waJoin(waTitle('Indisponibil'), occupied, '', 'Alege altă zi din listă.');
    }
    case 'MISSING_APPOINTMENT': {
      const intent = d.intent === 'cancel' ? 'anulezi' : 'reprogramezi';
      const custom = typeof d.client_message === 'string' && d.client_message.trim()
        ? d.client_message.trim()
        : `Care programare vrei să ${intent}?`;
      return waJoin(waTitle('Programări'), custom);
    }
    case 'CONFIRM_CANCEL':
      if (typeof d.client_message === 'string' && d.client_message.trim()) {
        return waJoin(waTitle('Confirmi anularea?'), '', d.client_message.trim());
      }
      return waJoin(
        waTitle('Confirmi anularea?'),
        '',
        waField('Serviciu', d.service_name || 'Programare'),
        waField('Când', d.slot_label || ''),
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
      return buildAiTransparencyWelcome(business);
    case 'CALLBACK_SENT':
      return waJoin(
        waTitle('Cerere înregistrată'),
        `Un coleg de la *${d.business_name || business.name}* te sună în curând.`,
      );
    case 'MY_APPOINTMENTS': {
      const rows = d.appointments || [];
      if (!rows.length) {
        return waJoin(
          waTitle('Programările tale'),
          'Nicio programare activă.',
          '',
          'Pentru una nouă: *luni la 17*',
        );
      }
      const lines = rows.map((a) => `• *${a.service_name || 'Programare'}*\n  ${a.slot_label || ''}`);
      return waJoin(
        waTitle('Programările tale'),
        '',
        lines.join('\n\n'),
        '',
        WA_DIVIDER,
        '',
        waFooter(['*anulează*', '*reprogramare*']),
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
    case 'MISSING_INFO':
      return d.client_message
        || missingBusinessInfoMessage(d.topic_label || null, lang)
        || unknownInfoClientMessage();
    case 'ADMIN_FACT':
      return String(d.fact || unknownInfoClientMessage());
    default:
      return String(d.client_message || 'Spune-mi cum te pot ajuta.');
  }
}

/**
 * Optional polish: rephrase JSON only. Never add hours/availability/confirmations.
 * @returns {Promise<string | null>}
 */
async function polishWithAi(business, result, rendered) {
  const action = result.machine_action;
  const allow = action === MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION
    || action === MACHINE_ACTIONS.ACTION_ASK_CLARIFICATION;
  if (!allow || !business?.id) return null;

  const payload = {
    status: result.status,
    action_performed: result.action_performed,
    data: result.data,
    next_required_step: result.next_required_step,
    template: rendered,
  };

  const extraSystem = action
    ? formatterSystemHint(action)
    : (
      'SARCINĂ FORMATTER WhatsApp: reformulează politicos în română textul din JSON-ul backend. ' +
      'NU inventa ore, prețuri, disponibilitate sau confirmări. ' +
      'NU spune că o programare e confirmată. Folosește doar câmpurile din JSON.'
    );

  const chat = await completeTenantChat({
    businessId: business.id,
    parserMode: true,
    extraSystem,
    userContent: JSON.stringify(payload).slice(0, 2500),
    temperature: 0.2,
    maxTokens: 280,
  });
  return chat.ok && chat.text ? chat.text : null;
}

/**
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {HandlerResult} params.result
 * @param {string | null} [params.requestId]
 */
export async function presentTurn({ business, recipientPhone, result, requestId = null }) {
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
    || result.user_message_template_key === 'CONTACT';
  const polished = skipPolish ? null : await polishWithAi(business, result, rendered);
  const text = polished || rendered;
  const d = result.data || {};

  await simulateHumanDelay({ business, recipientPhone, requestId });

  const needsGdpr =
    result.action_performed === 'BOOKED' || result.action_performed === 'RESCHEDULED';
  if (needsGdpr) {
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: buildGdprNote(business),
    });
  }

  if (result.calendar_cta?.url) {
    // One message: confirmation body + calendar URL button (no trailing maps markdown).
    await sendMessageWithUrlButton({
      business,
      recipientPhone,
      requestId,
      text,
      buttonTitle: result.calendar_cta.title || 'Adaugă în calendar',
      buttonUrl: result.calendar_cta.url,
    });
    return;
  }

  if (d.link_ctas?.length || d.maps_cta?.url || d.website_cta?.url) {
    const buttons = Array.isArray(d.link_ctas) && d.link_ctas.length
      ? d.link_ctas
      : [
        d.maps_cta?.url ? { title: d.maps_cta.title || 'Vezi locația', url: d.maps_cta.url } : null,
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
      cta: 'Deschide calendarul',
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
        rememberOptions: days.map((day) => ({ id: day.id, title: day.title, description: day.description })),
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
    'MENU',
  ]);

  if (result.menu?.options?.length && interactiveKeys.has(String(result.user_message_template_key || ''))) {
    if (result.user_message_template_key === 'MENU') {
      await sendTextMessage({ business, recipientPhone, requestId, text });
      await simulateHumanDelay({ business, recipientPhone, requestId, delayMs: 800 });
      await sendInteractiveButtons({
        business,
        recipientPhone,
        requestId,
        bodyText: 'Cu ce te putem ajuta?',
        buttons: result.menu.options,
        footerText: business.name,
        menuKind: result.menu.kind || 'entry',
        rememberOptions: result.menu.catalog || result.menu.options,
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
      const buttonLabel = typeof d.list_button === 'string' && d.list_button
        ? d.list_button
        : (kind === 'day_grid' ? 'Zile disponibile' : kind === 'service' ? 'Servicii' : kind === 'modify' ? 'Programările tale' : 'Ore libere');
      await sendInteractiveList({
        business,
        recipientPhone,
        requestId,
        bodyText: text,
        buttonText: buttonLabel,
        sections: [{
          title: kind === 'day_grid' ? 'Zile' : kind === 'service' ? 'Servicii' : kind === 'modify' ? 'Programări' : 'Ore',
          rows: result.menu.options.map((opt) => ({
            id: opt.id,
            title: opt.title,
            description: opt.description || (kind === 'day_grid' ? 'Disponibil' : kind === 'service' ? 'Din catalog' : kind === 'modify' ? 'Programare activă' : 'Liber'),
          })),
        }],
        footerText: business.name,
        menuKind: kind || 'list',
        rememberOptions: result.menu.catalog || result.menu.options,
      });
      return;
    }

    await sendInteractiveButtons({
      business,
      recipientPhone,
      requestId,
      bodyText: text,
      buttons: result.menu.options,
      footerText: business.name,
      menuKind: kind || 'generic',
      rememberOptions: result.menu.catalog || result.menu.options,
    });
    return;
  }

  await sendTextMessage({ business, recipientPhone, requestId, text });
}
