/**
 * Step 1 — Extract only. Identifies intent + entities.
 * Never checks availability, hours, or writes bookings.
 */

import { getBookingConfig, localToUtc } from '../utils/datetime.js';
import { getHoursForDate } from '../utils/workingHours.js';
import { listEmployees, matchEmployeeMention } from '../db/employeeService.js';
import { CONVERSATION_STEPS, readLastMenu } from '../db/conversationStateService.js';
import { looksLikeBusinessFactQuestion } from '../utils/businessInfoLookup.js';
import { resolveAcceptedOffer } from './pendingOfferService.js';
import { resolveNumberedChoice } from './whatsappService.js';
import { parseRomanianDateTimeParts } from '../utils/roDateTime.js';
import { BOOKING_PREFIXES, MOD_PREFIX } from './flowIds.js';
import {
  BOOKING_WAIT,
  CLARIFY_IDS,
  getBookingWait,
  interpretNumericFreeText,
} from './bookingWaitState.js';
import { extractBookingEntities } from '../lib/ai/extractor.js';
import { matchServiceMention } from '../utils/serviceMatch.js';
import {
  detectTimeWindowFromText,
  looksLikeAvailabilityQuestion,
  normalizeTimeWindow,
} from '../utils/timeWindow.js';
import {
  looksLikeDatetimeOrSlot,
  isExplicitConfirmReply,
  isExplicitCancelReply,
  isAffirmativeReply,
  looksLikeOutOfScopeRequest,
  wantsSameExpiredBooking,
  looksLikeExistingAppointmentQuery,
  looksLikeNewBookingRequest,
  looksLikeGreeting,
  looksLikeOffTopicChat,
  triageUserIntent,
} from './intentTriageService.js';

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
 * @property {'morning' | 'afternoon' | 'evening' | null} [time_window]
 * @property {string | null} appointment_id
 * @property {string | null} slot_id
 * @property {string | null} choice_id
 * @property {string | null} name
 * @property {'high' | 'medium' | 'low'} confidence
 * @property {'menu' | 'keyword' | 'parser' | 'nlu' | 'state'} source
 * @property {Record<string, unknown> | null} [ambiguity]
 * @property {import('../schemas/extractionResult.js').ExtractionResult | null} [extraction]
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
    time_window: null,
    appointment_id: null,
    slot_id: null,
    choice_id: null,
    name: null,
    confidence: 'low',
    source: 'parser',
    ambiguity: null,
    extraction: null,
    ...overrides,
  };
}

export { matchServiceMention };

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

/**
 * Numbered menus always beat "1" = 01:00. Isolated digits are times only in a time wait.
 *
 * @param {Object} params
 * @param {string} params.textBody
 * @param {{ kind?: string, options?: { id: string }[] } | null} params.lastMenu
 * @param {string | null} params.wait
 * @param {string} params.timezone
 * @param {string | null} [params.pendingDateKey]
 * @param {Business} params.business
 * @param {boolean} [params.inModify]
 * @param {{ open?: string, close?: string } | null} [params.dayHours]
 * @param {Date} [params.now]
 * @returns {TurnExtract | null}
 */
export function resolveDeterministicInbound({
  textBody,
  lastMenu,
  wait,
  timezone,
  pendingDateKey = null,
  business,
  inModify = false,
  dayHours = null,
  now = new Date(),
}) {
  const loneNumber = /^\d{1,2}$/.test(String(textBody ?? '').trim());
  if (wait === BOOKING_WAIT.SERVICE && loneNumber) {
    const catalog = getBookingConfig(business).services;
    const serviceMenu = lastMenu?.kind === 'service' && lastMenu.options?.length
      ? lastMenu
      : {
        kind: 'service',
        options: catalog.slice(0, 10).map((s) => ({
          id: `${PREFIX.SERVICE}${s.id}`,
          title: s.name,
        })),
      };
    const choiceId = resolveNumberedChoice(textBody, serviceMenu.options);
    if (choiceId) return extractFromChoiceId(choiceId, {}, business);
    const idx = Number(String(textBody).trim()) - 1;
    if (idx >= 0 && idx < catalog.length) {
      return emptyExtract({
        action: 'select_service',
        service_id: catalog[idx].id,
        service_name: catalog[idx].name,
        confidence: 'high',
        source: 'menu',
      });
    }
  }
  if (
    wait === BOOKING_WAIT.CONFIRMATION
    && lastMenu?.kind === 'confirm'
    && lastMenu.options?.length
    && loneNumber
  ) {
    const choiceId = resolveNumberedChoice(textBody, lastMenu.options);
    if (choiceId) return extractFromChoiceId(choiceId, {}, business);
  }
  if (!wait && loneNumber) {
    const entryOptions = lastMenu?.kind === 'entry' && lastMenu.options?.length
      ? lastMenu.options
      : (business.menu_buttons || []).map((btn) => ({ id: btn.id, title: btn.label }));
    if (entryOptions.length) {
      const choiceId = resolveNumberedChoice(textBody, entryOptions);
      if (choiceId) return extractFromChoiceId(choiceId, {}, business);
      const idx = Number(String(textBody).trim()) - 1;
      const buttons = business.menu_buttons || [];
      if (idx >= 0 && idx < buttons.length) {
        return extractFromChoiceId(buttons[idx].id, {}, business);
      }
    }
  }
  const slotMenu = lastMenu?.kind && lastMenu.kind !== 'service' && lastMenu.kind !== 'entry'
    ? lastMenu
    : null;
  if (
    wait !== BOOKING_WAIT.SERVICE
    && wait !== BOOKING_WAIT.CONFIRMATION
    && wait !== BOOKING_WAIT.DATE
    && wait !== BOOKING_WAIT.TIME
    && wait !== BOOKING_WAIT.DATE_TIME
    && slotMenu?.options?.length
    && loneNumber
  ) {
    const choiceId = resolveNumberedChoice(textBody, slotMenu.options);
    if (choiceId) return extractFromChoiceId(choiceId, {}, business);
  }

  const numeric = interpretNumericFreeText({
    text: textBody,
    wait,
    timezone,
    pendingDateKey,
    dayHours,
    now,
  });
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
  if (numeric.kind === 'date' || numeric.kind === 'time' || numeric.kind === 'datetime') {
    const named = matchServiceMention(textBody, getBookingConfig(business).services);
    return emptyExtract({
      action: inModify ? 'reschedule' : 'book',
      date_text: numeric.kind === 'time' ? null : numeric.dateKey,
      time_text: numeric.kind === 'date' ? null : numeric.timeHHmm,
      service_id: named?.id ?? null,
      service_name: named?.name ?? null,
      confidence: 'high',
      source: 'state',
    });
  }
  return null;
}

export function looksLikePersonName(text) {
  const n = normalize(text);
  if (!n || n.length > 60 || /\d/.test(n) || /[?]/.test(String(text ?? ''))) return false;
  if (looksLikeExistingAppointmentQuery(n) || looksLikeNewBookingRequest(n, { services: getBookingConfig(business).services }) || looksLikeDatetimeOrSlot(n)) {
    return false;
  }
  if (/\b(cum|ce|cine|unde|cand|de ce|ai|esti|sunt|fac|faci|cheama|numele|parcare|mancat|prost|pula|fut|idiot)\b/.test(n)) {
    return false;
  }
  const words = n.split(' ').filter(Boolean);
  return words.length >= 1 && words.length <= 4;
}

function faqActionFromText(text) {
  const n = normalize(text);
  const hours = /\b(program|orar|orele|deschid|inchid|cand sunteti|hours|opening)\b/.test(n)
    && !/\bprogramar/.test(n);
  const prices = /\b(pret|preturi|cost|tarif|price|prices)\b/.test(n);
  if (hours && prices) return 'hours_and_services';
  if (hours) return 'hours';
  return 'services';
}

/**
 * Parser off_topic/unknown must not steal salut, "programare", hours, contact.
 * @param {TurnExtract} mapped
 * @param {string} textBody
 * @param {import('./intentTriageService.js').TriageResult} triage
 * @param {boolean} inModify
 * @returns {TurnExtract}
 */
export function recoverSoftParserIntent(mapped, textBody, triage, inModify = false, services = null) {
  const soft = new Set(['off_topic', 'missing_info', 'unknown', 'chat']);
  if (!soft.has(mapped.action)) return mapped;

  if (looksLikeExistingAppointmentQuery(textBody) || triage.intent === 'list_appointments') {
    return { ...mapped, action: 'list_appointments', confidence: 'high', source: 'keyword' };
  }
  if (looksLikeBusinessFactQuestion(textBody) || triage.reason === 'business_fact') {
    return { ...mapped, action: 'missing_info', confidence: 'high', source: 'keyword' };
  }
  if (looksLikeOffTopicChat(textBody) || triage.reason === 'off_topic_chat') {
    return { ...mapped, action: 'off_topic', confidence: 'high', source: 'keyword' };
  }
  if (
    looksLikeNewBookingRequest(textBody, services?.length ? { services } : {})
    || triage.intent === 'book'
    || looksLikeAvailabilityQuestion(textBody)
    || (looksLikeDatetimeOrSlot(textBody) && (/\d/.test(String(textBody)) || detectTimeWindowFromText(textBody)))
  ) {
    return {
      ...mapped,
      action: inModify ? 'reschedule' : 'book',
      confidence: 'high',
      source: 'keyword',
      time_window: mapped.time_window || detectTimeWindowFromText(textBody),
    };
  }
  if (triage.intent === 'contact') {
    return { ...mapped, action: 'contact', confidence: 'high', source: 'keyword' };
  }
  if (triage.intent === 'faq') {
    return { ...mapped, action: faqActionFromText(textBody), confidence: 'high', source: 'keyword' };
  }
  if (triage.intent === 'cancel') {
    return { ...mapped, action: 'cancel', confidence: 'high', source: 'keyword' };
  }
  if (triage.intent === 'reschedule') {
    return { ...mapped, action: 'reschedule', confidence: 'high', source: 'keyword' };
  }
  if (triage.intent === 'menu' || looksLikeGreeting(textBody)) {
    return { ...mapped, action: 'menu', confidence: 'high', source: 'keyword' };
  }
  return mapped;
}

function confidenceBand(value) {
  if (value >= 0.8) return 'high';
  if (value >= 0.45) return 'medium';
  return 'low';
}

function firstDigitPair(text) {
  const m = String(text ?? '').match(/\b(\d{1,2})\b/);
  return m ? Number(m[1]) : null;
}

/**
 * Map Layer 1 ExtractionResult onto TurnExtract. Does not talk to the client.
 *
 * @param {import('../schemas/extractionResult.js').ExtractionResult} parsed
 * @param {Object} opts
 * @param {string} opts.textBody
 * @param {boolean} opts.isPendingHold
 * @param {boolean} opts.inModify
 * @param {string | null} opts.wait
 * @param {string} opts.timezone
 * @returns {TurnExtract}
 */
function mapExtractionToTurnExtract(parsed, { textBody, isPendingHold, inModify, wait, timezone }) {
  const numeric = interpretNumericFreeText({
    text: textBody,
    wait,
    timezone,
    now: new Date(),
  });

  if (parsed.is_ambiguous) {
    if (
      (wait === BOOKING_WAIT.TIME || wait === BOOKING_WAIT.CONFIRMATION)
      && (numeric.kind === 'time' || numeric.kind === 'datetime')
    ) {
      return emptyExtract({
        action: inModify ? 'reschedule' : 'book',
        time_text: numeric.timeHHmm,
        confidence: 'high',
        source: 'nlu',
        extraction: { ...parsed, intent: 'change_time', is_ambiguous: false, extracted_time: numeric.timeHHmm },
      });
    }
    if (wait === BOOKING_WAIT.DATE && numeric.kind === 'date') {
      return emptyExtract({
        action: inModify ? 'reschedule' : 'book',
        date_text: numeric.dateKey,
        confidence: 'high',
        source: 'nlu',
        extraction: { ...parsed, intent: 'change_date', is_ambiguous: false, extracted_date: numeric.dateKey },
      });
    }
    const value = numeric.value ?? firstDigitPair(textBody);
    return emptyExtract({
      action: 'clarify_needed',
      confidence: parsed.confidence >= 0.7 ? 'high' : 'medium',
      source: 'nlu',
      extraction: parsed,
      ambiguity: {
        value,
        rejected: numeric.rejected ?? null,
        date_key: parsed.extracted_date || numeric.dateKey || null,
        time_hhmm: parsed.extracted_time || numeric.timeHHmm || null,
        date_label: numeric.dateLabel || (value != null ? String(value) : parsed.ambiguity_reason),
        time_label: numeric.timeLabel || (value != null ? String(value) : parsed.ambiguity_reason),
        resume_wait: wait,
        reason: parsed.ambiguity_reason,
      },
    });
  }

  const bookingAction = inModify ? 'reschedule' : 'book';
  let action = 'unknown';
  if (parsed.intent === 'confirm') action = 'confirm';
  else if (parsed.intent === 'cancel') action = isPendingHold ? 'cancel_pending' : 'cancel';
  else if (parsed.intent === 'list_appointments') action = 'list_appointments';
  else if (parsed.intent === 'hours') action = 'hours';
  else if (parsed.intent === 'services') action = 'services';
  else if (parsed.intent === 'contact') action = 'contact';
  else if (parsed.intent === 'menu') action = 'menu';
  else if (parsed.intent === 'off_topic') action = 'off_topic';
  else if (parsed.intent === 'missing_info') action = 'missing_info';
  else if (parsed.intent === 'reschedule') action = 'reschedule';
  else if (
    parsed.intent === 'book'
    || parsed.intent === 'change_time'
    || parsed.intent === 'change_date'
    || parsed.intent === 'select_service'
  ) {
    action = bookingAction;
  } else if (parsed.extracted_date || parsed.extracted_time || parsed.extracted_service) {
    action = bookingAction;
  }

  return emptyExtract({
    action,
    service_name: parsed.extracted_service,
    date_text: parsed.intent === 'change_time' ? null : parsed.extracted_date,
    time_text: parsed.intent === 'change_date' ? null : parsed.extracted_time,
    time_window: parsed.extracted_time
      ? null
      : (normalizeTimeWindow(parsed.time_window) || detectTimeWindowFromText(textBody)),
    confidence: confidenceBand(parsed.confidence),
    source: 'nlu',
    extraction: parsed,
  });
}

function applyCatalogMatches(extract, textBody, services, employees, timezone, opts = {}) {
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

  applyParsedDateTime(next, textBody, timezone, opts);
  if (!next.time_text && !next.time_window) {
    next.time_window = detectTimeWindowFromText(textBody);
  }
  if (next.time_text) next.time_window = null;
  if (next.date_text && !/^\d{4}-\d{2}-\d{2}$/.test(next.date_text)) {
    const asDate = parseRomanianDateTimeParts(next.date_text, timezone, new Date(), { dayHours: opts.dayHours });
    if (asDate.dateKey) next.date_text = asDate.dateKey;
  }
  if (next.time_text && !/^\d{2}:\d{2}$/.test(next.time_text)) {
    const asTime = parseRomanianDateTimeParts(`la ${next.time_text}`, timezone, new Date(), { dayHours: opts.dayHours });
    if (asTime.timeHHmm) next.time_text = asTime.timeHHmm;
  }
  if (next.date_text && next.time_text) {
    const combined = parseRomanianDateTimeParts(`${next.date_text} ${next.time_text}`, timezone, new Date(), { dayHours: opts.dayHours });
    if (combined.datetime) next.datetime = combined.datetime;
  } else if (!next.date_text || !next.time_text) {
    next.datetime = null;
  }
  return next;
}

/**
 * @param {TurnExtract} next
 * @param {string} text
 * @param {string} timezone
 * @param {{ freezeDate?: boolean, freezeTime?: boolean }} [opts]
 */
function textHasExplicitDay(text) {
  const n = normalize(text);
  return /\b(luni|marti|miercuri|joi|vineri|sambata|duminica|maine|azi|astazi|poimaine|ieri|alaltaieri|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|yesterday)\b/.test(n)
    || /\b\d{1,2}\s*(ian|feb|mar|apr|mai|iun|iul|aug|sep|oct|nov|dec)/.test(n)
    || /\b(?:pe|on(?:\s+the)?)\s+\d{1,2}/.test(n);
}

/**
 * Weekday + hour in the user text beat the LLM and leftover session dates.
 * Time is coerced against that day's Admin hours ("marți la 3" → 15:00, not Sunday).
 *
 * @param {string} textBody
 * @param {Business} business
 * @param {Date} [now]
 */
export function resolveExplicitSlot(textBody, business, now = new Date()) {
  const tz = business.timezone || 'Europe/Bucharest';
  const n = normalize(textBody);
  const hasClockOrColloquial = /\b(?:la|ora|at)\s+\d{1,2}\b/.test(n)
    || /\b\d{1,2}[:.,]\d{2}\b/.test(n)
    || /\b\d{1,2}\s*(?:si\s+)?(?:o\s+)?(?:jumatate|jumate|juma|sfer(?:t)?)\b/.test(n)
    || /\b\d{1,2}\s+fara\s+/.test(n)
    || /\b\d{1,2}\s+si\s+\d{1,2}\b/.test(n);
  if (!textHasExplicitDay(textBody) && !hasClockOrColloquial) {
    return null;
  }
  const first = parseRomanianDateTimeParts(textBody, tz, now);
  const when = first.dateKey ? localToUtc(first.dateKey, '12:00', tz) : now;
  const dayHours = getHoursForDate(business, when).dayHours;
  const parts = parseRomanianDateTimeParts(textBody, tz, now, { dayHours });
  if (!parts.dateKey && !parts.timeHHmm) return null;
  return parts;
}

function applyParsedDateTime(next, text, timezone, opts = {}) {
  const parts = parseRomanianDateTimeParts(text, timezone, new Date(), { dayHours: opts.dayHours ?? null });
  const explicitDay = textHasExplicitDay(text);
  const dateLocked = Boolean(opts.freezeDate)
    || (!explicitDay && next.date_text && /^\d{4}-\d{2}-\d{2}$/.test(next.date_text));
  const timeLocked = Boolean(opts.freezeTime)
    || (!explicitDay && next.time_text && /^\d{2}:\d{2}$/.test(next.time_text));
  if (parts.dateKey && !dateLocked) next.date_text = parts.dateKey;
  if (parts.timeHHmm && !timeLocked) next.time_text = parts.timeHHmm;
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
  const now = new Date();
  const wait = getBookingWait(convState);
  const pendingDateKey = typeof convState.context_data?.pending_date_text === 'string'
    ? convState.context_data.pending_date_text
    : null;
  const hoursWhen = pendingDateKey && tz ? localToUtc(pendingDateKey, '12:00', tz) : now;
  const dayHours = getHoursForDate(business, hoursWhen).dayHours;
  const isPendingHold =
    activeDraft?.state === 'pending_confirmation'
    || wait === BOOKING_WAIT.CONFIRMATION
    || step === CONVERSATION_STEPS.CONFIRMING
    || step === CONVERSATION_STEPS.ASKING_NAME
    || step === CONVERSATION_STEPS.WAITING_FOR_CONFIRMATION;

  if (looksLikeExistingAppointmentQuery(textBody)) {
    return emptyExtract({ action: 'list_appointments', confidence: 'high', source: 'keyword' });
  }
  if (looksLikeOffTopicChat(textBody)) {
    return emptyExtract({ action: 'off_topic', confidence: 'high', source: 'keyword' });
  }
  // Soft availability must not be stolen as amenity FAQ.
  if (looksLikeAvailabilityQuestion(textBody) || detectTimeWindowFromText(textBody)) {
    const named = matchServiceMention(textBody, services);
    return emptyExtract({
      action: 'book',
      service_id: named?.id ?? null,
      service_name: named?.name ?? null,
      time_window: detectTimeWindowFromText(textBody),
      date_text: extractDateKey(textBody, tz),
      confidence: 'high',
      source: 'keyword',
    });
  }
  if (looksLikeBusinessFactQuestion(textBody)) {
    return emptyExtract({ action: 'missing_info', confidence: 'high', source: 'keyword' });
  }

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

  if (
    (step === CONVERSATION_STEPS.CONFIRMING
      || step === CONVERSATION_STEPS.WAITING_FOR_CONFIRMATION
      || wait === BOOKING_WAIT.CONFIRMATION)
    && isExplicitConfirmReply(textBody)
    && !looksLikeDatetimeOrSlot(textBody)
  ) {
    return emptyExtract({ action: 'confirm', confidence: 'high', source: 'state' });
  }
  if (isPendingHold && isExplicitCancelReply(textBody) && !looksLikeDatetimeOrSlot(textBody)) {
    return emptyExtract({ action: 'cancel_pending', confidence: 'high', source: 'state' });
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
    if (!looksLikeDatetimeOrSlot(textBody) && looksLikePersonName(textBody)) {
      return emptyExtract({
        action: 'set_name',
        name: String(textBody || '').trim(),
        confidence: 'high',
        source: 'state',
      });
    }
  }

  const deterministic = resolveDeterministicInbound({
    textBody,
    lastMenu,
    wait,
    timezone: tz,
    pendingDateKey,
    business,
    inModify: step === CONVERSATION_STEPS.RESCHEDULING || step === CONVERSATION_STEPS.MODIFYING,
    dayHours,
    now,
  });
  if (deterministic) return deterministic;

  if (step === CONVERSATION_STEPS.CONFIRMING_CANCEL && isExplicitConfirmReply(textBody)) {
    return emptyExtract({ action: 'confirm_cancel', confidence: 'high', source: 'state' });
  }
  if (step === CONVERSATION_STEPS.CONFIRMING_CANCEL && isExplicitCancelReply(textBody)) {
    return emptyExtract({ action: 'abort', confidence: 'high', source: 'state' });
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
    && (isExplicitConfirmReply(textBody) || wantsSameExpiredBooking(textBody, triageUserIntent(textBody, { businessType: business.business_type, services })))
  ) {
    return emptyExtract({ action: 'resume_yes', confidence: 'high', source: 'state' });
  }
  if (step === CONVERSATION_STEPS.OFFERING_RESUME && isExplicitCancelReply(textBody)) {
    return emptyExtract({ action: 'resume_no', confidence: 'high', source: 'state' });
  }

  const triage = triageUserIntent(textBody, { businessType: business.business_type, services });
  if (triage.intent === 'sms_opt_in' || triage.intent === 'sms_opt_out') {
    return emptyExtract({ action: triage.intent, confidence: 'high', source: 'keyword' });
  }

  const inModify = step === CONVERSATION_STEPS.RESCHEDULING || step === CONVERSATION_STEPS.MODIFYING;
  const explicit = resolveExplicitSlot(textBody, business, now);
  if (explicit?.dateKey && explicit?.timeHHmm && !looksLikeExistingAppointmentQuery(textBody)) {
    const mod = triageUserIntent(textBody, { businessType: business.business_type, services });
    if (mod.intent !== 'cancel') {
      const named = matchServiceMention(textBody, services);
      return emptyExtract({
        action: inModify || mod.intent === 'reschedule' ? 'reschedule' : 'book',
        date_text: explicit.dateKey,
        time_text: explicit.timeHHmm,
        datetime: explicit.datetime,
        service_id: named?.id ?? null,
        service_name: named?.name ?? null,
        confidence: 'high',
        source: 'parser',
      });
    }
  }
  if (!looksLikeExistingAppointmentQuery(textBody)
    && triage.intent !== 'faq'
    && triage.intent !== 'contact'
    && triage.intent !== 'cancel'
    && !looksLikeDatetimeOrSlot(textBody)
  ) {
    const named = matchServiceMention(textBody, services);
    if (named) {
      return emptyExtract({
        action: wait === BOOKING_WAIT.SERVICE ? 'select_service' : 'book',
        service_id: named.id,
        service_name: named.name,
        confidence: 'high',
        source: 'parser',
      });
    }
  }
  const nlu = await extractBookingEntities({
    business,
    textBody,
    convState,
    activeDraft,
    requestId,
  });
  if (nlu) {
    const mapped = recoverSoftParserIntent(
      mapExtractionToTurnExtract(nlu, {
        textBody,
        isPendingHold,
        inModify,
        wait,
        timezone: tz,
      }),
      textBody,
      triage,
      inModify,
      services,
    );
    if (mapped.action === 'clarify_needed') return mapped;
    if (mapped.action === 'list_appointments' || looksLikeExistingAppointmentQuery(textBody)) {
      return emptyExtract({
        action: 'list_appointments',
        confidence: 'high',
        source: 'nlu',
        extraction: nlu,
      });
    }
    const direct = new Set([
      'hours', 'services', 'hours_and_services', 'contact', 'menu', 'confirm', 'cancel', 'cancel_pending',
      'reschedule', 'off_topic', 'missing_info',
    ]);
    if (direct.has(mapped.action)) return mapped;
    if (mapped.action === 'unknown') {
      return emptyExtract({ action: 'chat', confidence: 'low', source: 'nlu', extraction: nlu });
    }
    return applyCatalogMatches(
      {
        ...mapped,
        extraction: nlu,
      },
      textBody,
      services,
      employees,
      tz,
      {
        freezeDate: nlu.intent === 'change_time',
        freezeTime: nlu.intent === 'change_date',
        dayHours,
      },
    );
  }

  /** @type {TurnExtract} */
  let extract = emptyExtract({ source: 'keyword', confidence: triage.confidence });
  if (triage.intent === 'callback') extract.action = 'callback';
  else if (
    looksLikeOutOfScopeRequest(textBody)
    && triage.intent !== 'faq'
    && triage.intent !== 'book'
    && triage.intent !== 'contact'
    && triage.intent !== 'menu'
    && triage.intent !== 'list_appointments'
  ) {
    extract.action = 'callback';
  }
  else if (triage.intent === 'cancel') extract.action = isPendingHold ? 'cancel_pending' : 'cancel';
  else if (triage.intent === 'reschedule') extract.action = 'reschedule';
  else if (triage.intent === 'list_appointments') extract.action = 'list_appointments';
  else if (triage.intent === 'book') extract.action = 'book';
  else if (triage.intent === 'contact') extract.action = 'contact';
  else if (triage.intent === 'faq') extract.action = faqActionFromText(textBody);
  else if (triage.intent === 'menu') extract.action = 'menu';
  else if (looksLikeBusinessFactQuestion(textBody) || triage.reason === 'business_fact') {
    extract.action = 'missing_info';
  } else if (looksLikeOffTopicChat(textBody) || triage.reason === 'off_topic_chat') {
    extract.action = 'off_topic';
  }

  extract = applyCatalogMatches(extract, textBody, services, employees, tz, { dayHours });
  if (!extract.time_window && !extract.time_text) {
    extract.time_window = detectTimeWindowFromText(textBody);
  }
  if (extract.action === 'unknown' || extract.action === 'chat') {
    if (
      looksLikeNewBookingRequest(textBody, { services })
      || looksLikeAvailabilityQuestion(textBody)
      || extract.datetime
      || extract.date_text
      || extract.time_text
      || extract.time_window
      || extract.service_id
      || looksLikeDatetimeOrSlot(textBody)
    ) {
      extract.action = inModify ? 'reschedule' : 'book';
      extract.confidence = 'medium';
      extract.source = 'parser';
    }
  }
  if (extract.action === 'unknown') extract.action = 'chat';
  return extract;
}
