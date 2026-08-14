/**
 * Step 1 — Extract only. Identifies intent + entities.
 * Never checks availability, hours, or writes bookings.
 */

import { getBookingConfig } from '../utils/datetime.js';
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
import { parseRomanianDateTimeParts } from '../utils/roDateTime.js';
import { BOOKING_PREFIXES, MOD_PREFIX } from './flowIds.js';
import {
  BOOKING_WAIT,
  CLARIFY_IDS,
  getBookingWait,
  interpretNumericFreeText,
} from './bookingWaitState.js';

/** @typedef {import('../db/businessService.js').Business} Business */

const PREFIX = BOOKING_PREFIXES;

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
 * @property {Record<string, unknown> | null} [ambiguity]
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
    ambiguity: null,
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
  return parseRomanianDateTimeParts(text, timezone).dateKey;
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

  if (choiceId === PREFIX.CLARIFY_DATE || choiceId === CLARIFY_IDS.DATE) {
    return emptyExtract({
      ...base,
      action: 'resolve_clarification',
      choice_id: choiceId,
      confidence: 'high',
      source: 'menu',
      ambiguity: { field: 'date' },
    });
  }
  if (choiceId === PREFIX.CLARIFY_TIME || choiceId === CLARIFY_IDS.TIME) {
    return emptyExtract({
      ...base,
      action: 'resolve_clarification',
      choice_id: choiceId,
      confidence: 'high',
      source: 'menu',
      ambiguity: { field: 'time' },
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
        'Ore în 24h: „5 după-amiaza” / „la 5 seara” = 17:00, NU 05:00. „17 Aug” este DATA, nu ora. ' +
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

  applyParsedDateTime(next, textBody, timezone);
  if (next.date_text && !/^\d{4}-\d{2}-\d{2}$/.test(next.date_text)) {
    const asDate = parseRomanianDateTimeParts(next.date_text, timezone);
    if (asDate.dateKey) next.date_text = asDate.dateKey;
  }
  if (next.time_text && !/^\d{2}:\d{2}$/.test(next.time_text)) {
    const asTime = parseRomanianDateTimeParts(`la ${next.time_text}`, timezone);
    if (asTime.timeHHmm) next.time_text = asTime.timeHHmm;
  }
  if (next.date_text && next.time_text) {
    const combined = parseRomanianDateTimeParts(`${next.date_text} ${next.time_text}`, timezone);
    if (combined.datetime) next.datetime = combined.datetime;
  }
  return next;
}

/**
 * @param {TurnExtract} next
 * @param {string} text
 * @param {string} timezone
 */
function applyParsedDateTime(next, text, timezone) {
  const parts = parseRomanianDateTimeParts(text, timezone);
  if (parts.dateKey) next.date_text = parts.dateKey;
  if (parts.timeHHmm) next.time_text = parts.timeHHmm;
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
  const wait = getBookingWait(convState);
  const isPendingHold =
    activeDraft?.state === 'pending_confirmation'
    || wait === BOOKING_WAIT.CONFIRMATION
    || step === CONVERSATION_STEPS.CONFIRMING
    || step === CONVERSATION_STEPS.ASKING_NAME
    || step === CONVERSATION_STEPS.WAITING_FOR_CONFIRMATION;

  if (wait === BOOKING_WAIT.CLARIFICATION) {
    const pending = convState.context_data?.clarification || {};
    const numeric = interpretNumericFreeText({
      text: textBody,
      wait: BOOKING_WAIT.CLARIFICATION,
      timezone: tz,
      pendingDateKey: typeof convState.context_data?.pending_date_text === 'string'
        ? convState.context_data.pending_date_text
        : null,
    });
    if (lastMenu?.options?.length) {
      const choiceId = resolveNumberedChoice(textBody, lastMenu.options);
      if (choiceId) return extractFromChoiceId(choiceId, {}, business);
    }
    if (numeric.kind === 'clarification_date' || numeric.kind === 'clarification_time') {
      return emptyExtract({
        action: 'resolve_clarification',
        confidence: 'high',
        source: 'state',
        ambiguity: {
          field: numeric.kind === 'clarification_date' ? 'date' : 'time',
          value: pending.value,
        },
      });
    }
    if (isExplicitCancelReply(textBody)) {
      return emptyExtract({ action: 'cancel_pending', confidence: 'high', source: 'state' });
    }
    return emptyExtract({
      action: 'clarify_needed',
      confidence: 'high',
      source: 'state',
      ambiguity: {
        value: pending.value,
        rejected: pending.rejected ?? null,
        date_key: pending.date_candidate,
        time_hhmm: pending.time_candidate,
        date_label: String(pending.raw_value || pending.value || ''),
        time_label: String(pending.raw_value || pending.value || ''),
        resume_wait: pending.resume_wait,
      },
    });
  }

  const loneNumber = /^\d{1,2}$/.test(String(textBody ?? '').trim());
  const numeric = interpretNumericFreeText({
    text: textBody,
    wait,
    timezone: tz,
    pendingDateKey: typeof convState.context_data?.pending_date_text === 'string'
      ? convState.context_data.pending_date_text
      : null,
  });

  const menuInRange = Boolean(
    lastMenu?.options?.length
    && loneNumber
    && Number(String(textBody).trim()) >= 1
    && Number(String(textBody).trim()) <= lastMenu.options.length,
  );

  if (numeric.kind === 'ambiguous') {
    return emptyExtract({
      action: 'clarify_needed',
      confidence: 'high',
      source: 'state',
      ambiguity: {
        value: numeric.value,
        rejected: numeric.rejected ?? null,
        date_key: numeric.dateKey,
        time_hhmm: numeric.timeHHmm,
        date_label: numeric.dateLabel,
        time_label: numeric.timeLabel,
        resume_wait: wait,
      },
    });
  }

  if (!menuInRange && (numeric.kind === 'date' || numeric.kind === 'time')) {
    const inModify = step === CONVERSATION_STEPS.RESCHEDULING || step === CONVERSATION_STEPS.MODIFYING;
    return emptyExtract({
      action: inModify ? 'reschedule' : 'book',
      date_text: numeric.kind === 'date' ? numeric.dateKey : null,
      time_text: numeric.kind === 'time' ? numeric.timeHHmm : null,
      confidence: 'high',
      source: 'state',
    });
  }

  if (lastMenu?.options?.length) {
    if (loneNumber || !looksLikeDatetimeOrSlot(textBody)) {
      const choiceId = resolveNumberedChoice(textBody, lastMenu.options);
      if (choiceId) {
        return extractFromChoiceId(choiceId, {}, business);
      }
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
  if (
    (step === CONVERSATION_STEPS.CONFIRMING || step === CONVERSATION_STEPS.WAITING_FOR_CONFIRMATION)
    && isExplicitConfirmReply(textBody)
  ) {
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
