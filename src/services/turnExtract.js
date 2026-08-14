/**
 * Step 1 — Extract only. Identifies intent + entities.
 * Never checks availability, hours, or writes bookings.
 */

import { getBookingConfig, formatDateKey, localToUtc, getWeekdayInTimezone } from '../utils/datetime.js';
import { listEmployees, matchEmployeeMention } from '../db/employeeService.js';
import { CONVERSATION_STEPS, readLastMenu } from '../db/conversationStateService.js';
import {
  triageUserIntent,
  looksLikeDatetimeOrSlot,
  isExplicitConfirmReply,
  isExplicitCancelReply,
  isAffirmativeReply,
  looksLikeOutOfScopeRequest,
  wantsSameExpiredBooking,
} from './intentTriageService.js';
import { resolveAcceptedOffer } from './pendingOfferService.js';
import { completeTenantChat } from './aiContextLoader.js';
import { markOpenAiUnavailable } from './openaiGate.js';
import { resolveNumberedChoice } from './whatsappService.js';
import { parseRomanianDateTime } from '../utils/roDateTime.js';
import { BOOKING_PREFIXES, MOD_PREFIX } from './flowIds.js';

/** @typedef {import('../db/businessService.js').Business} Business */

const PREFIX = BOOKING_PREFIXES;

const WEEKDAY_MAP = {
  duminica: 0,
  luni: 1,
  marti: 2,
  miercuri: 3,
  joi: 4,
  vineri: 5,
  sambata: 6,
};

/**
 * @typedef {Object} TurnExtract
 * @property {string} action
 * @property {string | null} service_id
 * @property {string | null} service_name
 * @property {string | null} employee_id
 * @property {string | null} employee_name
 * @property {Date | null} datetime
 * @property {string | null} date_text
 * @property {string | null} time_text
 * @property {string | null} appointment_id
 * @property {string | null} slot_id
 * @property {string | null} choice_id
 * @property {string | null} name
 * @property {'high' | 'medium' | 'low'} confidence
 * @property {'menu' | 'keyword' | 'parser' | 'nlu' | 'state'} source
 */

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function emptyExtract(overrides = {}) {
  return {
    action: 'unknown',
    service_id: null,
    service_name: null,
    employee_id: null,
    employee_name: null,
    datetime: null,
    date_text: null,
    time_text: null,
    appointment_id: null,
    slot_id: null,
    choice_id: null,
    name: null,
    confidence: 'low',
    source: 'parser',
    ...overrides,
  };
}

/**
 * @param {string} text
 * @param {{ id: string, name: string }[]} services
 */
function matchServiceMention(text, services) {
  const n = normalize(text);
  if (!n || n.length < 3) return null;
  /** @type {{ id: string, name: string } | null} */
  let best = null;
  let bestLen = 0;
  for (const s of services) {
    const name = normalize(s.name);
    if (name.length >= 3 && n.includes(name) && name.length > bestLen) {
      best = s;
      bestLen = name.length;
    }
  }
  return best;
}

/**
 * Date hint without requiring a clock time (YYYY-MM-DD in business TZ).
 * @param {string} text
 * @param {string} timezone
 * @returns {string | null}
 */
export function extractDateKey(text, timezone) {
  const n = normalize(text);
  const iso = n.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];

  const now = new Date();
  const dayName = Object.keys(WEEKDAY_MAP).find((d) => new RegExp(`\\b${d}\\b`).test(n));
  if (dayName) {
    const want = WEEKDAY_MAP[/** @type {keyof typeof WEEKDAY_MAP} */ (dayName)];
    const current = getWeekdayInTimezone(now, timezone);
    let add = (want - current + 7) % 7;
    if (add === 0 && !/\bazi\b/.test(n)) add = 7;
    const target = new Date(now.getTime() + add * 24 * 60 * 60 * 1000);
    return formatDateKey(target, timezone);
  }
  if (/\bmaine\b/.test(n)) {
    return formatDateKey(new Date(now.getTime() + 24 * 60 * 60 * 1000), timezone);
  }
  if (/\bpoimaine\b/.test(n)) {
    return formatDateKey(new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000), timezone);
  }
  if (/\bazi\b/.test(n)) return formatDateKey(now, timezone);
  return null;
}

function extractTimeText(text) {
  const n = normalize(text);
  const match = n.match(/\b(\d{1,2})[:\.](\d{2})\b/) || n.match(/\b(\d{1,2})\s*(?:am|pm)?\b/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = match[2] !== undefined ? Number(match[2]) : 0;
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * @param {string} choiceId
 * @param {TurnExtract} base
 * @param {Business} business
 */
function extractFromChoiceId(choiceId, base, business) {
  if (choiceId.startsWith(PREFIX.SERVICE)) {
    const serviceId = choiceId.slice(PREFIX.SERVICE.length);
    const service = getBookingConfig(business).services.find((s) => s.id === serviceId);
    return emptyExtract({
      ...base,
      action: 'select_service',
      service_id: serviceId,
      service_name: service?.name ?? null,
      choice_id: choiceId,
      confidence: 'high',
      source: 'menu',
    });
  }
  if (choiceId === PREFIX.ANY_EMPLOYEE) {
    return emptyExtract({
      ...base,
      action: 'select_employee',
      employee_id: 'any',
      choice_id: choiceId,
      confidence: 'high',
      source: 'menu',
    });
  }
  if (choiceId.startsWith(PREFIX.EMPLOYEE)) {
    return emptyExtract({
      ...base,
      action: 'select_employee',
      employee_id: choiceId.slice(PREFIX.EMPLOYEE.length),
      choice_id: choiceId,
      confidence: 'high',
      source: 'menu',
    });
  }
  if (choiceId.startsWith('slot_')) {
    return emptyExtract({
      ...base,
      action: 'select_slot',
      slot_id: choiceId,
      choice_id: choiceId,
      confidence: 'high',
      source: 'menu',
    });
  }
  if (choiceId.startsWith(MOD_PREFIX.APPT)) {
    return emptyExtract({
      ...base,
      action: 'select_appointment',
      appointment_id: choiceId.slice(MOD_PREFIX.APPT.length),
      choice_id: choiceId,
      confidence: 'high',
      source: 'menu',
    });
  }
  if (choiceId === PREFIX.CONFIRM || choiceId === PREFIX.RESUME_YES) {
    return emptyExtract({
      ...base,
      action: choiceId === PREFIX.RESUME_YES ? 'resume_yes' : 'confirm',
      choice_id: choiceId,
      confidence: 'high',
      source: 'menu',
    });
  }
  if (choiceId === PREFIX.CANCEL) {
    return emptyExtract({
      ...base,
      action: 'cancel_pending',
      choice_id: choiceId,
      confidence: 'high',
      source: 'menu',
    });
  }
  if (choiceId === PREFIX.RESUME_NO) {
    return emptyExtract({
      ...base,
      action: 'resume_no',
      choice_id: choiceId,
      confidence: 'high',
      source: 'menu',
    });
  }
  if (choiceId === MOD_PREFIX.CONFIRM_CANCEL) {
    return emptyExtract({
      ...base,
      action: 'confirm_cancel',
      choice_id: choiceId,
      confidence: 'high',
      source: 'menu',
    });
  }
  if (choiceId === MOD_PREFIX.ABORT) {
    return emptyExtract({
      ...base,
      action: 'abort',
      choice_id: choiceId,
      confidence: 'high',
      source: 'menu',
    });
  }

  const menuButton = (business.menu_buttons || []).find((btn) => btn.id === choiceId);
  if (menuButton?.action === 'start_booking') {
    return emptyExtract({ ...base, action: 'book', choice_id: choiceId, confidence: 'high', source: 'menu' });
  }
  if (menuButton?.action === 'show_info') {
    return emptyExtract({ ...base, action: 'services', choice_id: choiceId, confidence: 'high', source: 'menu' });
  }
  if (menuButton?.action === 'show_contact') {
    return emptyExtract({ ...base, action: 'contact', choice_id: choiceId, confidence: 'high', source: 'menu' });
  }

  return emptyExtract({ ...base, action: 'unknown', choice_id: choiceId, source: 'menu' });
}

function faqActionFromText(text) {
  const n = normalize(text);
  if (/\b(program|orar|orele|deschid|inchid|cand sunteti)\b/.test(n)) return 'hours';
  return 'services';
}

/**
 * Optional LLM JSON extract — intent/entities only. No availability fields.
 * @returns {Promise<TurnExtract | null>}
 */
async function extractWithLlm({ business, textBody, requestId = null }) {
  if (!business?.id) return null;

  const result = await completeTenantChat({
    businessId: business.id,
    buildExtraSystem: (ctx) => {
      const catalog = getBookingConfig(ctx.snapshot).services.map((s) => s.name).slice(0, 20);
      return (
        'SARCINĂ EXTRACT (NLU): extragi DOAR intenția și entitățile din mesajul clientului WhatsApp. ' +
        'Nu decide disponibilitate, ore libere, confirmări sau prețuri. ' +
        'Răspunde strict JSON: ' +
        '{"action":"book|reschedule|cancel|confirm|cancel_pending|hours|services|contact|callback|menu|chat",' +
        '"service_name":null,"employee_name":null,"date_text":null,"time_text":null}. ' +
        `Servicii catalog: ${catalog.join(', ') || '(gol)'}.`
      );
    },
    userContent: String(textBody ?? '').slice(0, 500),
    jsonMode: true,
    temperature: 0,
    maxTokens: 220,
    requestId,
  });
  if (!result.ok || !result.text) return null;

  try {
    const parsed = JSON.parse(result.text.replace(/```json\s*|```/g, '').trim());
    const action = typeof parsed.action === 'string' ? parsed.action : 'chat';
    const allowed = new Set([
      'book', 'reschedule', 'cancel', 'confirm', 'cancel_pending',
      'hours', 'services', 'contact', 'callback', 'menu', 'chat',
    ]);
    return emptyExtract({
      action: allowed.has(action) ? action : 'chat',
      service_name: typeof parsed.service_name === 'string' ? parsed.service_name : null,
      employee_name: typeof parsed.employee_name === 'string' ? parsed.employee_name : null,
      date_text: typeof parsed.date_text === 'string' ? parsed.date_text : null,
      time_text: typeof parsed.time_text === 'string' ? parsed.time_text : null,
      confidence: 'medium',
      source: 'nlu',
    });
  } catch (error) {
    console.warn('[turnExtract] NLU extract failed', error);
    markOpenAiUnavailable();
    return null;
  }
}

function applyCatalogMatches(extract, textBody, services, employees, timezone) {
  const next = { ...extract };
  const namedService = matchServiceMention(textBody, services);
  if (namedService && !next.service_id) {
    next.service_id = namedService.id;
    next.service_name = namedService.name;
  } else if (next.service_name && !next.service_id) {
    const hit = matchServiceMention(next.service_name, services);
    if (hit) {
      next.service_id = hit.id;
      next.service_name = hit.name;
    }
  }

  const mentionedEmp = matchEmployeeMention(textBody, employees)
    || (next.employee_name ? matchEmployeeMention(next.employee_name, employees) : null);
  if (mentionedEmp && !next.employee_id) {
    next.employee_id = mentionedEmp.id;
    next.employee_name = mentionedEmp.name;
  }

  const parsed = parseRomanianDateTime(textBody, timezone)
    || (next.date_text || next.time_text
      ? parseRomanianDateTime(
          [next.date_text, next.time_text].filter(Boolean).join(' '),
          timezone,
        )
      : null);
  if (parsed) next.datetime = parsed;
  if (!next.date_text) next.date_text = extractDateKey(textBody, timezone);
  if (!next.time_text) next.time_text = extractTimeText(textBody);
  if (!next.datetime && next.date_text && next.time_text) {
    next.datetime = localToUtc(next.date_text, next.time_text, timezone);
  }
  return next;
}

/**
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.textBody
 * @param {import('../db/conversationStateService.js').ConversationState} params.convState
 * @param {import('../db/draftBookingService.js').DraftBooking | null} [params.activeDraft]
 * @param {string | null} [params.requestId]
 * @returns {Promise<TurnExtract>}
 */
export async function extractTurnIntent({
  business,
  textBody,
  convState,
  activeDraft = null,
  requestId = null,
}) {
  const step = convState.current_step;
  const lastMenu = readLastMenu(convState);
  const services = getBookingConfig(business).services;
  const employees = await listEmployees(business.id, { activeOnly: true });
  const tz = business.timezone;
  const isPendingHold =
    activeDraft?.state === 'pending_confirmation'
    || step === CONVERSATION_STEPS.CONFIRMING
    || step === CONVERSATION_STEPS.ASKING_NAME;

  if (lastMenu?.options?.length) {
    const choiceId = resolveNumberedChoice(textBody, lastMenu.options);
    if (choiceId) {
      return extractFromChoiceId(choiceId, {}, business);
    }
  }

  if (step === CONVERSATION_STEPS.ASKING_NAME) {
    const n = normalize(textBody);
    if (isExplicitCancelReply(textBody) || n === 'meniu' || n === 'menu' || n.includes('renunt')) {
      return emptyExtract({
        action: n === 'meniu' || n === 'menu' ? 'menu' : 'cancel_pending',
        confidence: 'high',
        source: 'state',
      });
    }
    if (!looksLikeDatetimeOrSlot(textBody) && triageUserIntent(textBody, { businessType: business.business_type }).intent === 'unknown') {
      return emptyExtract({
        action: 'set_name',
        name: String(textBody || '').trim(),
        confidence: 'high',
        source: 'state',
      });
    }
  }

  if (step === CONVERSATION_STEPS.CONFIRMING_CANCEL && isExplicitConfirmReply(textBody)) {
    return emptyExtract({ action: 'confirm_cancel', confidence: 'high', source: 'state' });
  }
  if (step === CONVERSATION_STEPS.CONFIRMING_CANCEL && isExplicitCancelReply(textBody)) {
    return emptyExtract({ action: 'abort', confidence: 'high', source: 'state' });
  }

  if (isPendingHold && isExplicitCancelReply(textBody)) {
    return emptyExtract({ action: 'cancel_pending', confidence: 'high', source: 'state' });
  }
  if (step === CONVERSATION_STEPS.CONFIRMING && isExplicitConfirmReply(textBody)) {
    return emptyExtract({ action: 'confirm', confidence: 'high', source: 'state' });
  }

  if (isAffirmativeReply(textBody) && !looksLikeDatetimeOrSlot(textBody)) {
    const resolved = resolveAcceptedOffer({ convState, employees, services });
    if (resolved?.employee || resolved?.service) {
      return emptyExtract({
        action: 'accept_offer',
        service_id: resolved.service?.id ?? null,
        service_name: resolved.service?.name ?? null,
        employee_id: resolved.employee?.id ?? null,
        employee_name: resolved.employee?.name ?? null,
        confidence: 'high',
        source: 'state',
      });
    }
  }

  if (
    step === CONVERSATION_STEPS.OFFERING_RESUME
    && (isExplicitConfirmReply(textBody) || wantsSameExpiredBooking(textBody, triageUserIntent(textBody)))
  ) {
    return emptyExtract({ action: 'resume_yes', confidence: 'high', source: 'state' });
  }
  if (step === CONVERSATION_STEPS.OFFERING_RESUME && isExplicitCancelReply(textBody)) {
    return emptyExtract({ action: 'resume_no', confidence: 'high', source: 'state' });
  }

  const triage = triageUserIntent(textBody, { businessType: business.business_type });
  /** @type {TurnExtract} */
  let extract = emptyExtract({ source: 'keyword', confidence: triage.confidence });

  if (triage.intent === 'sms_opt_in') extract.action = 'sms_opt_in';
  else if (triage.intent === 'sms_opt_out') extract.action = 'sms_opt_out';
  else if (triage.intent === 'callback' || looksLikeOutOfScopeRequest(textBody)) extract.action = 'callback';
  else if (triage.intent === 'cancel') extract.action = isPendingHold ? 'cancel_pending' : 'cancel';
  else if (triage.intent === 'reschedule') extract.action = 'reschedule';
  else if (triage.intent === 'book') extract.action = 'book';
  else if (triage.intent === 'contact') extract.action = 'contact';
  else if (triage.intent === 'faq') extract.action = faqActionFromText(textBody);
  else if (triage.intent === 'menu') extract.action = 'menu';

  extract = applyCatalogMatches(extract, textBody, services, employees, tz);

  if (extract.action === 'unknown' || extract.action === 'chat') {
    const inModify = step === CONVERSATION_STEPS.RESCHEDULING || step === CONVERSATION_STEPS.MODIFYING;
    if (
      extract.datetime
      || extract.date_text
      || extract.service_id
      || extract.employee_id
      || looksLikeDatetimeOrSlot(textBody)
    ) {
      extract.action = inModify ? 'reschedule' : 'book';
      extract.confidence = 'medium';
      extract.source = 'parser';
    }
  }

  if (extract.action === 'unknown') {
    const nlu = await extractWithLlm({ business, textBody, requestId });
    if (nlu) {
      extract = applyCatalogMatches(
        { ...nlu, datetime: extract.datetime, date_text: extract.date_text || nlu.date_text, time_text: extract.time_text || nlu.time_text },
        textBody,
        services,
        employees,
        tz,
      );
    }
  }

  if (extract.action === 'unknown') extract.action = 'chat';
  return extract;
}
