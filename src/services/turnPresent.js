/**
 * Step 3 — Presentation only. Formats HandlerResult into WhatsApp text.
 * Must not decide availability, confirm bookings, or invent hours.
 */

import { buildAiTransparencyWelcome, buildBookingConfirmationMessage, buildGdprNote, buildMapsInviteLine } from '../utils/businessMessages.js';
import { formatContactMessage } from './contactService.js';
import { completeTenantChat } from './aiContextLoader.js';
import {
  sendTextMessage,
  sendMessageWithUrlButton,
  sendIcsDocument,
  sendInteractiveButtons,
  rememberMenuOptions,
  clearRememberedMenuOptions,
  simulateHumanDelay,
} from './whatsappService.js';
import { slotNumberEmoji } from '../utils/datetime.js';

/** @typedef {import('../db/businessService.js').Business} Business */
/** @typedef {import('./handlerResult.js').HandlerResult} HandlerResult */

function formatServiceLine(s) {
  const price =
    s.price_ron != null && s.price_ron !== ''
      ? `💰 ${s.price_ron} LEI`
      : '💰 —';
  const duration = s.duration_minutes ? `⏱️ ${s.duration_minutes} min` : '';
  return `${price}${duration ? `  |  ${duration}` : ''}`;
}

function numberedOptions(options) {
  return (options || [])
    .map((opt, i) => `${slotNumberEmoji(i)} ${opt.title}`)
    .join('\n');
}

/**
 * Deterministic templates from backend JSON. No invented facts.
 * @param {Business} business
 * @param {HandlerResult} result
 */
export function renderHandlerResult(business, result) {
  const d = result.data || {};
  const key = result.user_message_template_key;
  const menuBlock = result.menu?.options?.length
    ? `\n\n${numberedOptions(result.menu.options)}\n\nRăspunde cu numărul opțiunii (ex: 1).`
    : '';

  switch (key) {
    case 'ASK_NAME':
      return (
        (typeof d.client_message === 'string' && d.client_message)
        || 'Pentru rezervare am nevoie de *numele tău* (cum să te trecem în calendar).\nScrie prenumele și numele, ex: *Ana Popescu*.'
      );
    case 'ASK_CONFIRM': {
      const emp = d.employee_name ? `💇 cu *${d.employee_name}*\n` : '';
      const name = d.client_name ? `👤 *${d.client_name}*\n` : '';
      return (
        `Confirmi programarea?\n\n` +
        name +
        emp +
        `📋 *${d.service_name || 'Serviciu'}*\n` +
        `🕐 ${d.slot_label || ''}`
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
      return (
        `✅ *Programare actualizată!*\n\n` +
        `📋 ${d.service_name || 'Serviciu'}\n` +
        `🕐 ${d.slot_label || ''}` +
        (maps ? `\n${maps}` : '') +
        `\n\nTe așteptăm! Pentru anulare, scrie *anulează*.`
      );
    }
    case 'CONFIRMATION_CANCELLED':
      return 'Programarea ta a fost anulată cu succes. Te așteptăm cu drag altă dată!';
    case 'CANCEL_PENDING':
      return 'Programarea a fost anulată. Dacă dorești, poți începe o programare nouă oricând.';
    case 'FLOW_ABORTED':
      return 'Ok, am renunțat. Cu ce te mai pot ajuta?';
    case 'MISSING_EMPLOYEE': {
      const intro = d.client_message || 'Alege specialistul:';
      return `${intro}${menuBlock}`;
    }
    case 'MISSING_SERVICE': {
      const lines = ['📋 *Alege serviciul dorit:*', ''];
      (d.services || []).forEach((s, i) => {
        lines.push(`${slotNumberEmoji(i)} *${s.name}*`);
        lines.push(formatServiceLine(s));
        lines.push('');
      });
      lines.push('Răspunde cu numărul opțiunii (ex: 1).');
      return lines.join('\n');
    }
    case 'ASK_DATE':
      return (
        (typeof d.client_message === 'string' && d.client_message)
        || `Pe ce dată vrei${d.service_name ? ` *${d.service_name}*` : ''}? Scrie de exemplu *luni* sau *18 aug*.`
      );
    case 'ASK_TIME': {
      const head = d.service_name
        ? `La ce oră vrei *${d.service_name}*${d.date_label ? ` pe ${d.date_label}` : ''}?`
        : 'La ce oră vrei programarea?';
      const alts = (d.alternatives || []).map((s, i) => `${slotNumberEmoji(i)} ${s.label}`);
      if (alts.length) {
        return [`${head} Alege din listă sau scrie ora (ex: *18*):`, '', ...alts].join('\n');
      }
      return `${head} Scrie ora (ex: *10:30* sau *18*).`;
    }
    case 'ASK_CLARIFY_DATE_OR_TIME':
      return (
        (typeof d.client_message === 'string' && d.client_message)
        || `Scuze, nu am înțeles corect, te referi la data de ${d.date_label || d.value} sau la ora ${d.time_label || d.value}?`
      );
    case 'MISSING_SLOT': {
      const head = d.service_name
        ? `📅 *Alege ora pentru ${d.service_name}:*`
        : '📅 *Alege o oră:*';
      const alts = (d.alternatives || []).map((s, i) => `${slotNumberEmoji(i)} ${s.label}`);
      return [head, '', ...alts, '', '👉 _Răspunde cu numărul opțiunii dorite._'].join('\n');
    }
    case 'SLOT_UNAVAILABLE': {
      const occupied = d.occupied_label
        ? `Intervalul *${d.occupied_label}* tocmai a fost ocupat.`
        : (d.client_message || 'Intervalul nu e disponibil.');
      const alts = (d.alternatives || []).map((s, i) => `${slotNumberEmoji(i)} ${s.label}`);
      if (!alts.length) return occupied;
      return `${occupied} Alege din listă:\n\n${alts.join('\n')}\n\n👉 _Răspunde cu numărul opțiunii._`;
    }
    case 'MISSING_APPOINTMENT': {
      const intent = d.intent === 'cancel' ? 'anulezi' : 'reprogramezi';
      return `Care programare vrei să ${intent}?${menuBlock}`;
    }
    case 'CONFIRM_CANCEL':
      return (
        `Confirmi anularea?\n\n` +
        `📋 *${d.service_name || 'Programare'}*\n` +
        `🕐 ${d.slot_label || ''}`
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
      if (!services.length) return 'Nu există servicii configurate încă în Admin.';
      const lines = ['📋 *Servicii:*', ''];
      services.forEach((s) => {
        lines.push(`*${s.name}*`);
        lines.push(formatServiceLine(s));
        lines.push('');
      });
      lines.push('Pentru programare, scrie serviciul și ora (ex: *tuns mâine la 10*).');
      return lines.join('\n');
    }
    case 'HOURS_LIST':
      if (!d.hours_configured || !d.hours_text) {
        return 'Programul de lucru nu este setat încă în Admin. Nu pot oferi ore.';
      }
      return `🕐 *Program ${business.name}*\n\n${d.hours_text}`;
    case 'CONTACT':
      return formatContactMessage(business);
    case 'MENU':
      return buildAiTransparencyWelcome(business);
    case 'CALLBACK_SENT':
      return (
        `Am înregistrat cererea. Un coleg de la *${d.business_name || business.name}* ` +
        `te va contacta în curând.`
      );
    case 'CHAT_FALLBACK':
      return (
        `Te pot ajuta cu programări, reprogramări, anulări și informații la *${d.business_name || business.name}*.\n` +
        `Scrie de exemplu: *tuns mâine la 10*, *program*, *servicii* sau *contact*.`
      );
    default:
      return String(d.client_message || 'Spune-mi cum te pot ajuta.');
  }
}

/**
 * Optional polish: rephrase JSON only. Never add hours/availability/confirmations.
 * @returns {Promise<string | null>}
 */
async function polishWithAi(business, result, rendered) {
  if (result.status !== 'CHAT' || !business?.id) return null;

  const payload = {
    status: result.status,
    action_performed: result.action_performed,
    data: result.data,
    next_required_step: result.next_required_step,
    template: rendered,
  };

  const extraSystem =
    'SARCINĂ FORMATTER WhatsApp: reformulează politicos în română textul din JSON-ul backend. ' +
    'NU inventa ore, prețuri, disponibilitate sau confirmări. ' +
    'NU spune că o programare e confirmată. Folosește doar câmpurile din JSON.';

  const chat = await completeTenantChat({
    businessId: business.id,
    extraSystem,
    userContent: JSON.stringify(payload).slice(0, 2500),
    temperature: 0.3,
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
  if (result.menu?.options?.length) {
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
    const media = await sendIcsDocument({
      business,
      recipientPhone,
      mediaUrl: result.calendar_cta.url,
      requestId,
    });
    if (!media.ok) {
      await sendMessageWithUrlButton({
        business,
        recipientPhone,
        requestId,
        text: 'Adaugă programarea în calendar:',
        buttonTitle: result.calendar_cta.title || 'Adaugă în calendar',
        buttonUrl: result.calendar_cta.url,
      });
    }
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
        bodyText: 'Cu ce te putem ajuta? Alege o opțiune:',
        buttons: result.menu.options,
        footerText: business.name,
        menuKind: 'entry',
      });
    }
    return;
  }

  await sendTextMessage({ business, recipientPhone, requestId, text });
}
