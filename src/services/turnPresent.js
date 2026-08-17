/**
 * Step 3 — Presentation only. Formats HandlerResult into WhatsApp text.
 * Must not decide availability, confirm bookings, or invent hours.
 */

import { buildAiTransparencyWelcome, buildBookingConfirmationMessage, buildGdprNote, buildMapsInviteLine } from '../utils/businessMessages.js';
import { WA_DIVIDER, waField, waFooter, waJoin, waServiceMeta, waTitle } from '../utils/waCopy.js';
import { timeWindowBounds } from '../utils/timeWindow.js';
import { formatContactMessage } from './contactService.js';
import { completeTenantChat } from './aiContextLoader.js';
import {
  sendTextMessage,
  sendMessageWithUrlButton,
  sendInteractiveButtons,
  rememberMenuOptions,
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
        mapsLine: buildMapsInviteLine(business)?.messageLine || '',
        includeGdpr: false,
      });
    case 'CONFIRMATION_RESCHEDULE': {
      const maps = buildMapsInviteLine(business)?.messageLine;
      return waJoin(
        waTitle('Programare actualizată'),
        '',
        waField('Serviciu', d.service_name || 'Serviciu'),
        waField('Când', d.slot_label || ''),
        maps ? '' : null,
        maps || null,
        '',
        WA_DIVIDER,
        '',
        waFooter(['*reprogramare*', '*anulează*']),
      );
    }
    case 'CONFIRMATION_CANCELLED':
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
          waTitle(d.service_name ? `Data — ${d.service_name}` : 'Pe ce dată?'),
          'Ex: *luni* sau *18 aug*',
        )
      );
    case 'ASK_TIME': {
      const bounds = timeWindowBounds(d.time_window);
      const windowHint = bounds ? ` (${bounds.labelRo})` : '';
      const head = d.service_name
        ? waJoin(
          waTitle(`Ore libere — ${d.service_name}${windowHint}`),
          d.date_label ? `*Data*\n${d.date_label}` : null,
        )
        : waTitle(`La ce oră?${windowHint}`);
      const alts = (d.alternatives || []).map((s) => s.label || s.time).filter(Boolean).slice(0, 8);
      if (alts.length) {
        return waJoin(
          head,
          '',
          `*Disponibil*\n${alts.join('\n')}`,
          '',
          WA_DIVIDER,
          '',
          'Scrie ora care ți se potrivește — ex: *18:00*.',
        );
      }
      return waJoin(head, '', 'Ex: *10:30* sau *18:00*');
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
      const bounds = timeWindowBounds(d.time_window);
      const windowHint = bounds ? ` (${bounds.labelRo})` : '';
      const head = d.service_name
        ? waJoin(
          waTitle(`Ore libere — ${d.service_name}${windowHint}`),
          d.date_label ? `*Data*\n${d.date_label}` : null,
        )
        : waTitle(`La ce oră?${windowHint}`);
      const alts = (d.alternatives || []).map((s) => s.label || s.time).filter(Boolean).slice(0, 8);
      return alts.length
        ? waJoin(
          head,
          '',
          `*Disponibil*\n${alts.join('\n')}`,
          '',
          WA_DIVIDER,
          '',
          'Scrie ora pe care o vrei.',
        )
        : waJoin(head, '', 'Ex: *17:00*');
    }
    case 'SLOT_UNAVAILABLE': {
      const occupied = d.occupied_label
        ? `*${d.occupied_label}* tocmai s-a ocupat.`
        : (d.client_message || 'Intervalul nu e disponibil.');
      const alts = (d.alternatives || []).map((s) => s.label || s.time).filter(Boolean).slice(0, 8);
      if (!alts.length) {
        return waJoin(waTitle('Indisponibil'), occupied, '', 'Scrie altă oră sau altă zi.');
      }
      return waJoin(
        waTitle('Indisponibil'),
        occupied,
        '',
        `*Disponibil*\n${alts.join('\n')}`,
        '',
        'Scrie ora pe care o vrei.',
      );
    }
    case 'MISSING_APPOINTMENT': {
      const intent = d.intent === 'cancel' ? 'anulezi' : 'reprogramezi';
      const custom = typeof d.client_message === 'string' && d.client_message.trim()
        ? d.client_message.trim()
        : `Care programare vrei să ${intent}?`;
      return waJoin(waTitle('Programări'), custom);
    }
    case 'CONFIRM_CANCEL':
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
      return lang === 'en'
        ? waJoin(
          waTitle(`Booking assistant — ${d.business_name || business.name}`),
          'How can I help?',
          '',
          waFooter(['booking', 'hours', 'contact']),
        )
        : waJoin(
          waTitle(`Asistent programări — ${d.business_name || business.name}`),
          'Cu ce te pot ajuta?',
          '',
          waFooter(['programare', 'orar', 'contact']),
        );
    case 'OFF_TOPIC':
      return lang === 'en'
        ? waJoin(
          waTitle(`Booking assistant — ${d.business_name || business.name}`),
          "I can't discuss that.",
          '',
          waFooter(['booking', 'hours', 'contact']),
        )
        : waJoin(
          waTitle(`Asistent programări — ${d.business_name || business.name}`),
          'Nu pot discuta asta.',
          '',
          waFooter(['programare', 'orar', 'contact']),
        );
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
  const rememberKinds = new Set(['confirm', 'clarify', 'entry']);
  if (result.menu?.options?.length && rememberKinds.has(String(result.menu.kind || ''))) {
    await rememberMenuOptions(business.id, recipientPhone, result.menu.options, result.menu.kind || 'generic');
  } else if (result.status === 'SUCCESS' && !result.next_required_step) {
    clearRememberedMenuOptions(business.id, recipientPhone);
  }

  const rendered = renderHandlerResult(business, result);
  const polished = await polishWithAi(business, result, rendered);
  const text = polished || rendered;

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
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text,
    });
    await sendMessageWithUrlButton({
      business,
      recipientPhone,
      requestId,
      text: 'Adaugă în calendar',
      buttonTitle: result.calendar_cta.title || 'Adaugă în calendar',
      buttonUrl: result.calendar_cta.url,
    });
    return;
  }

  if (result.menu?.options?.length && result.user_message_template_key === 'ASK_CLARIFY_DATE_OR_TIME') {
    await sendInteractiveButtons({
      business,
      recipientPhone,
      requestId,
      bodyText: text,
      buttons: result.menu.options,
      menuKind: 'clarify',
    });
    return;
  }

  if (result.menu?.options?.length && result.user_message_template_key === 'ASK_CONFIRM') {
    await sendInteractiveButtons({
      business,
      recipientPhone,
      requestId,
      bodyText: text,
      buttons: result.menu.options,
      menuKind: result.menu.kind || 'confirm',
    });
    return;
  }

  if (result.menu?.options?.length && result.user_message_template_key === 'CONFIRM_CANCEL') {
    await sendInteractiveButtons({
      business,
      recipientPhone,
      requestId,
      bodyText: text,
      buttons: result.menu.options,
      menuKind: 'confirm',
    });
    return;
  }

  if (result.user_message_template_key === 'MENU') {
    await sendTextMessage({ business, recipientPhone, requestId, text });
    if (result.menu?.options?.length) {
      await simulateHumanDelay({ business, recipientPhone, requestId, delayMs: 800 });
      await sendInteractiveButtons({
        business,
        recipientPhone,
        requestId,
        bodyText: 'Cu ce te putem ajuta?',
        buttons: result.menu.options,
        footerText: business.name,
        menuKind: 'entry',
      });
    }
    return;
  }

  await sendTextMessage({ business, recipientPhone, requestId, text });
}
