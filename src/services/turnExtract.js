/**
 * Step 1 — Extract only. Identifies intent + entities.
 * Never checks availability, hours, or writes bookings.
 */

import { getBookingConfig, localToUtc } from '../utils/datetime.js';
import { getHoursForDate } from '../utils/workingHours.js';
import { listEmployees, matchEmployeeMention, extractLikelyEmployeeName, resolveStaffMentionFromText } from '../db/employeeService.js';
import { CONVERSATION_STEPS, readLastMenu } from '../db/conversationStateService.js';
import { looksLikeBusinessFactQuestion } from '../utils/businessInfoLookup.js';
import { resolveAcceptedOffer } from './pendingOfferService.js';
import {
  interpretPendingActionReply,
  shouldSkipStaffRebind,
} from './pendingActionService.js';
import { resolveNumberedChoice, resolveInteractiveChoice } from './whatsappService.js';
import { isEntryMenuChoiceId, resolveEntryMenuChoiceId } from '../utils/entryMenu.js';
import { GRID_PREFIX, isGridNavChoiceId } from '../utils/bookingGrid.js';
import { looksLikeInteractiveChoiceId, shouldPreferTypedTextOverTap, looksLikeMenuPivotIntent } from '../utils/inboundPayload.js';
import { parseRomanianDateTimeParts } from '../utils/roDateTime.js';
import { BOOKING_PREFIXES, MOD_PREFIX } from './flowIds.js';
import {
  BOOKING_WAIT,
  CLARIFY_IDS,
  getBookingWait,
  interpretNumericFreeText,
} from './bookingWaitState.js';
import { extractBookingEntities } from '../lib/ai/extractor.js';
import { isTypedServiceAttempt, matchServiceMention } from '../utils/serviceMatch.js';
import { matchServiceSemantically } from './serviceSemanticMatch.js';
import {
  detectTimeWindowFromText,
  looksLikeAvailabilityQuestion,
  normalizeTimeWindow,
} from '../utils/timeWindow.js';
import {
  detectModificationIntent,
  looksLikeGreeting,
  looksLikeGratitude,
  looksLikeExplicitSavedReschedule,
  looksLikeInFlightRevision,
  looksLikeTimeOnlyRevision,
  refersToSavedAppointments,
  looksLikeCancelAll,
  looksLikeOffTopicChat,
  looksLikeDatetimeOrSlot,
  looksLikeNewBookingRequest,
  looksLikeGeneralBookingOnly,
  looksLikeExistingAppointmentQuery,
  looksLikeOutOfScopeRequest,
  looksLikeOpeningHoursQuestion,
  isExplicitConfirmReply,
  isExplicitCancelReply,
  isAffirmativeReply,
  wantsSameExpiredBooking,
  looksLikePluralAppointments,
  triageUserIntent,
} from './intentTriageService.js';
import { isLanguageCapabilityQuestion } from '../utils/uiI18n.js';
import {
  allowUnknownServiceError,
  shouldOfferServiceListNotUnknown,
  turnActionForBookingIntent,
} from './bookingIntentMapper.js';
import { isInFlightBookingContext } from './inFlightBookingSession.js';
import { decodeStaffSlotChoiceId } from './colleagueFallbackService.js';

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
 * @property {string | null} [reschedule_new_date]
 * @property {string | null} [reschedule_new_time]
 * @property {'morning' | 'afternoon' | 'evening' | null} [time_window]
 * @property {string | null} appointment_id
 * @property {string | null} slot_id
 * @property {string | null} choice_id
 * @property {string | null} name
 * @property {'high' | 'medium' | 'low'} confidence
 * @property {'menu' | 'keyword' | 'parser' | 'nlu' | 'state'} source
 * @property {string | null} [unknown_service_name]
 * @property {boolean} [cancel_all]
 * @property {boolean} [vague_choice]
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

/**
 * Mid-flow "modific" / "am greșit" → revise the draft; "reprogramez" → saved appointment.
 * @returns {'revise_draft' | 'reschedule' | null}
 */
function resolveRescheduleOrRevise(textBody, { step, wait, activeDraft, context }) {
  if (looksLikeExplicitSavedReschedule(textBody)) return 'reschedule';
  if (
    isInFlightBookingContext({ step, wait, activeDraft, context })
    && looksLikeInFlightRevision(textBody)
  ) {
    return 'revise_draft';
  }
  if (detectModificationIntent(textBody) === 'reschedule') return 'reschedule';
  return null;
}

function emptyExtract(overrides = {}) {
  return {
    action: 'unknown',
    service_id: null,
    service_name: null,
    unknown_service_name: null,
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
    cancel_all: false,
    vague_choice: false,
    confidence: 'low',
    source: 'parser',
    ambiguity: null,
    extraction: null,
    ...overrides,
  };
}

/**
 * Tag cancel/reschedule extracts so execute never guesses among many bookings.
 * Menu taps already locked a booking_id (or cancel-all) — do not treat the label as a vague day.
 * @param {TurnExtract} extract
 * @param {string} textBody
 */
function annotateModifyExtract(extract, textBody) {
  if (!extract) return extract;
  const modify = new Set(['cancel', 'reschedule', 'cancel_all', 'select_appointment', 'confirm_cancel']);
  if (!modify.has(extract.action)) {
    return {
      ...extract,
      cancel_all: Boolean(extract.cancel_all),
      vague_choice: Boolean(extract.vague_choice),
    };
  }
  if (extract.source === 'menu') {
    return {
      ...extract,
      cancel_all: extract.action === 'cancel_all' || Boolean(extract.cancel_all),
      vague_choice: false,
    };
  }
  const cancelAll = extract.action === 'cancel_all' || looksLikeCancelAll(textBody);
  const vague = looksLikePluralAppointments(textBody)
    || (Boolean(extract.date_text) && !extract.time_text);
  return {
    ...extract,
    cancel_all: Boolean(extract.cancel_all) || cancelAll,
    vague_choice: Boolean(extract.vague_choice) || vague,
  };
}

/** Ground catalog + reject invented services as a dedicated action. */
export function finalizeGroundedExtract(extract) {
  if (extract?.unknown_service_name && !extract.service_id) {
    return emptyExtract({
      ...extract,
      action: 'unknown_service',
      service_name: null,
      confidence: extract.confidence || 'high',
      source: extract.source || 'nlu',
    });
  }
  return extract;
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
  if (choiceId === 'confirm_reschedule_yes') {
    return emptyExtract({
      ...base,
      action: 'confirm_reschedule',
      choice_id: choiceId,
      confidence: 'high',
      source: 'menu',
    });
  }
  if (choiceId === 'confirm_reschedule_no') {
    return emptyExtract({
      ...base,
      action: 'abort',
      choice_id: choiceId,
      confidence: 'high',
      source: 'menu',
    });
  }
  if (choiceId.startsWith(PREFIX.STAFF_SLOT) || choiceId.startsWith('staffslot_')) {
    const decoded = decodeStaffSlotChoiceId(choiceId.startsWith(PREFIX.STAFF_SLOT)
      ? choiceId
      : `${PREFIX.STAFF_SLOT}${choiceId.slice('staffslot_'.length)}`);
    if (decoded) {
      return emptyExtract({
        ...base,
        action: 'book',
        employee_id: decoded.employeeId,
        slot_id: decoded.slotId,
        choice_id: choiceId,
        confidence: 'high',
        source: 'menu',
      });
    }
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
  if (choiceId.startsWith(GRID_PREFIX.DAY)) {
    const dateKey = choiceId.slice(GRID_PREFIX.DAY.length);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      return emptyExtract({
        ...base,
        action: 'book',
        date_text: dateKey,
        time_text: null,
        choice_id: choiceId,
        confidence: 'high',
        source: 'menu',
      });
    }
  }
  if (choiceId === GRID_PREFIX.NEXT || choiceId === GRID_PREFIX.PREV) {
    return emptyExtract({
      ...base,
      action: 'grid_nav',
      choice_id: choiceId,
      confidence: 'high',
      source: 'menu',
    });
  }
  if (choiceId === MOD_PREFIX.CANCEL_ALL) {
    return emptyExtract({
      ...base,
      action: 'cancel_all',
      cancel_all: true,
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

  if (choiceId === 'offer_callback' || choiceId === 'callback_request') {
    return emptyExtract({
      ...base,
      action: 'callback',
      choice_id: choiceId,
      confidence: 'high',
      source: 'menu',
    });
  }
  if (choiceId === 'show_services') {
    return emptyExtract({
      ...base,
      action: 'show_services',
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
  if (wait === BOOKING_WAIT.EMPLOYEE && loneNumber && lastMenu?.options?.length) {
    const empMenu = lastMenu.kind === 'employee' ? lastMenu : null;
    if (empMenu) {
      const choiceId = resolveNumberedChoice(textBody, empMenu.options);
      if (choiceId) return extractFromChoiceId(choiceId, {}, business);
    }
  }
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
  if (
    wait === BOOKING_WAIT.EMPLOYEE
    && (numeric.kind === 'date' || numeric.kind === 'time' || numeric.kind === 'datetime')
  ) {
    return emptyExtract({
      action: 'reprompt_employee',
      confidence: 'high',
      source: 'state',
    });
  }
  if (numeric.kind === 'date' || numeric.kind === 'time' || numeric.kind === 'datetime') {
    // Hours FAQ with a day word ("program mâine") must not become a booking draft.
    if (looksLikeOpeningHoursQuestion(textBody)) {
      return null;
    }
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
  const hours = (
    /\b(program|orar|orele|deschid|deschis|deschisi|deschise|inchid|inchis|inchisi|inchise|cand sunteti|hours|opening)\b/.test(n)
    || /\b(pana la cat|de la cat|la ce ora|cat timp|program de lucru)\b/.test(n)
  ) && !/\bprogramar/.test(n);
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
  const mod = detectModificationIntent(textBody);
  if (mod === 'cancel' || triage.intent === 'cancel') {
    return { ...mapped, action: 'cancel', confidence: 'high', source: 'keyword' };
  }
  if (mod === 'reschedule' || triage.intent === 'reschedule') {
    return { ...mapped, action: 'reschedule', confidence: 'high', source: 'keyword' };
  }

  const soft = new Set(['off_topic', 'missing_info', 'unknown', 'chat', 'book', 'clarify_needed']);
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
 * Split "vineri 9:30 … muta la 15:00" into existing vs new slot hints for reschedule.
 *
 * @param {TurnExtract} extract
 * @param {string} textBody
 * @param {string} timezone
 * @param {import('../schemas/extractionResult.js').ExtractionResult | null | undefined} [parsed]
 * @returns {TurnExtract}
 */
function enrichRescheduleKeywordExtract(extract, textBody, timezone, parsed = null) {
  if (parsed?.booking_intent === 'reschedule_request') {
    return {
      ...extract,
      date_text: parsed.existing_appointment_date ?? extract.date_text,
      time_text: parsed.existing_appointment_time_hhmm ?? extract.time_text,
      reschedule_new_date: parsed.requested_reschedule_date ?? extract.reschedule_new_date ?? null,
      reschedule_new_time: parsed.requested_reschedule_time_hhmm ?? extract.reschedule_new_time ?? null,
    };
  }

  const raw = String(textBody || '');
  const n = raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const mutaMatch = n.match(/\b(mut|muta|mutam|mutati|reprogram|schimb)\w*/);
  const splitAt = mutaMatch?.index ?? -1;
  const existingPart = splitAt > 0 ? raw.slice(0, splitAt) : raw;
  const newPart = splitAt > 0 ? raw.slice(splitAt) : '';
  const existing = parseRomanianDateTimeParts(existingPart, timezone);
  const requested = newPart
    ? parseRomanianDateTimeParts(newPart, timezone)
    : { dateKey: null, timeHHmm: null };

  return {
    ...extract,
    date_text: existing.dateKey || extract.date_text,
    time_text: existing.timeHHmm || extract.time_text,
    reschedule_new_date: requested.dateKey || extract.reschedule_new_date || null,
    reschedule_new_time: requested.timeHHmm || extract.reschedule_new_time || null,
  };
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
  if (parsed.booking_intent === 'reschedule_request') {
    return emptyExtract({
      action: 'reschedule',
      date_text: parsed.existing_appointment_date,
      time_text: parsed.existing_appointment_time_hhmm,
      reschedule_new_date: parsed.requested_reschedule_date,
      reschedule_new_time: parsed.requested_reschedule_time_hhmm,
      confidence: confidenceBand(parsed.confidence),
      source: 'nlu',
      extraction: parsed,
    });
  }

  if (parsed.booking_intent === 'cancellation') {
    return emptyExtract({
      action: isPendingHold ? 'cancel_pending' : 'cancel',
      date_text: parsed.existing_appointment_date,
      time_text: parsed.existing_appointment_time_hhmm,
      confidence: confidenceBand(parsed.confidence),
      source: 'nlu',
      extraction: parsed,
    });
  }

  const mod = detectModificationIntent(textBody);
  if (mod === 'cancel') {
    const cancelHints = parseRomanianDateTimeParts(textBody, timezone);
    return emptyExtract({
      action: isPendingHold ? 'cancel_pending' : 'cancel',
      date_text: cancelHints.dateKey,
      time_text: cancelHints.timeHHmm,
      confidence: 'high',
      source: 'keyword',
      extraction: parsed,
    });
  }
  if (mod === 'reschedule') {
    return enrichRescheduleKeywordExtract(emptyExtract({
      action: 'reschedule',
      confidence: 'high',
      source: 'keyword',
      extraction: parsed,
    }), textBody, timezone, parsed);
  }

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

  const classifiedAction = turnActionForBookingIntent(parsed, isPendingHold);
  if (classifiedAction && classifiedAction !== 'book') {
    return emptyExtract({
      action: classifiedAction,
      confidence: confidenceBand(parsed.confidence),
      source: 'nlu',
      extraction: parsed,
    });
  }

  if (classifiedAction === 'book') {
    return emptyExtract({
      action: 'book',
      service_name: parsed.extracted_service,
      date_text: parsed.extracted_date,
      time_text: parsed.extracted_time,
      time_window: parsed.extracted_time
        ? null
        : (normalizeTimeWindow(parsed.time_window) || detectTimeWindowFromText(textBody)),
      confidence: confidenceBand(parsed.confidence),
      source: 'nlu',
      extraction: parsed,
    });
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
    } else {
      // LLM invented or unmatched service — never carry into the state machine.
      next.unknown_service_name = String(next.service_name).trim() || null;
      next.service_name = null;
    }
  }

  const mentionedEmp = matchEmployeeMention(textBody, employees)
    || (next.employee_name ? matchEmployeeMention(next.employee_name, employees) : null);
  if (mentionedEmp && !next.employee_id) {
    next.employee_id = mentionedEmp.id;
    next.employee_name = mentionedEmp.name;
  } else if (!next.employee_id) {
    // Keep unmatched names so execute can ask transparently (spec §11).
    // Never invent a person from a service token ("la tuns").
    if (!next.employee_name) {
      const guessed = extractLikelyEmployeeName(textBody, { services });
      if (guessed) next.employee_name = guessed;
    } else {
      const byName = matchEmployeeMention(String(next.employee_name), employees);
      if (byName) {
        next.employee_id = byName.id;
        next.employee_name = byName.name;
      } else if (
        // NLU set employee_name to a catalog service (e.g. "Tuns") — drop it.
        matchServiceMention(String(next.employee_name), services)
        && !extractLikelyEmployeeName(`la ${next.employee_name}`, { services })
      ) {
        next.employee_name = null;
      }
      // else: keep unknown person name → execute returns MISSING_EMPLOYEE
    }
  }

  applyParsedDateTime(next, textBody, timezone, opts);
  if (!next.time_text && !next.time_window) {
    next.time_window = detectTimeWindowFromText(textBody);
  }
  if (next.time_text) next.time_window = null;
  if (next.date_text && !/^\d{4}-\d{2}-\d{2}$/.test(next.date_text)) {
    const asDate = parseRomanianDateTimeParts(next.date_text, timezone, new Date(), { dayHours: opts.dayHours });
    if (asDate.dateKey) next.date_text = asDate.dateKey;
    else next.date_text = null;
  }
  if (next.time_text && !/^\d{2}:\d{2}$/.test(next.time_text)) {
    const asTime = parseRomanianDateTimeParts(`la ${next.time_text}`, timezone, new Date(), { dayHours: opts.dayHours });
    if (asTime.timeHHmm) next.time_text = asTime.timeHHmm;
    else next.time_text = null;
  }
  // Drop garbage temporal values that would render as "Data de 0" / null UI.
  if (next.date_text && !/^\d{4}-\d{2}-\d{2}$/.test(String(next.date_text))) {
    next.date_text = null;
  }
  if (next.time_text && !/^\d{2}:\d{2}$/.test(String(next.time_text))) {
    next.time_text = null;
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
 * Catalog match + AI semantic fallback (EN phrase → RO Supabase service id).
 * @param {import('../db/businessService.js').Business | null} business
 * @param {string | null} requestId
 */
async function applyCatalogMatchesWithSemantic(extract, textBody, services, employees, timezone, opts = {}, business = null, requestId = null) {
  let next = applyCatalogMatches(extract, textBody, services, employees, timezone, opts);
  const extraction = next.extraction;

  if (
    extraction?.booking_intent === 'reschedule_request'
    || extraction?.booking_intent === 'cancellation'
    || extraction?.booking_intent === 'unable_to_attend'
    || extraction?.booking_intent === 'running_late'
    || extraction?.booking_intent === 'special_request'
    || extraction?.booking_intent === 'chitchat'
    || extraction?.booking_intent === 'off_topic'
    || extraction?.booking_intent === 'question'
  ) {
    next.service_id = null;
    next.service_name = null;
    next.unknown_service_name = null;
    return next;
  }

  const offerList = shouldOfferServiceListNotUnknown(extraction)
    || looksLikeGeneralBookingOnly(textBody, { services });

  if (offerList && !matchServiceMention(textBody, services)) {
    next.service_id = null;
    next.service_name = null;
    next.unknown_service_name = null;
    if (next.action === 'unknown_service') next.action = 'book';
    return next;
  }

  const needsSemantic = !next.service_id
    && !next.unknown_service_name
    && business?.id
    && (next.service_name || (
      next.action === 'book'
      && textBody
      && !offerList
      && extraction?.booking_intent === 'specific_service_request'
    ));

  if (needsSemantic) {
    const phrase = String(next.service_name || textBody || '').trim();
    const semantic = await matchServiceSemantically({
      business,
      text: phrase,
      services,
      requestId,
    });
    if (semantic) {
      next = {
        ...next,
        service_id: semantic.id,
        service_name: semantic.name,
        client_service_label: semantic.client_label,
        unknown_service_name: null,
      };
    } else if (!next.service_id && !next.unknown_service_name) {
      const leftover = String(next.service_name || '').trim();
      const mayReject = allowUnknownServiceError(extraction)
        || (!extraction?.booking_intent && leftover);
      if (leftover && mayReject) {
        next.unknown_service_name = leftover;
        next.service_name = null;
      } else if (
        (next.action === 'book' || next.action === 'select_service')
        && isTypedServiceAttempt(textBody)
        && !matchServiceMention(textBody, services)
        && allowUnknownServiceError(extraction)
      ) {
        next.unknown_service_name = String(textBody || '').trim();
      } else {
        next.unknown_service_name = null;
        next.service_name = null;
      }
    }
  }

  return next;
}

/**
 * While the service picker is open: match catalog rows, allow FAQ pivots, then semantic fallback.
 * @param {string} textBody
 * @param {import('../db/businessService.js').Business} business
 * @param {{ id: string, name: string }[]} services
 * @param {string | null} requestId
 * @returns {Promise<TurnExtract | null>}
 */
async function resolveTypedServiceDuringWait(textBody, business, services, requestId) {
  if (looksLikeGeneralBookingOnly(textBody, { services })) {
    return emptyExtract({ action: 'book', confidence: 'high', source: 'keyword' });
  }
  if (!isTypedServiceAttempt(textBody)) return null;

  const triage = triageUserIntent(textBody, {
    businessType: business.business_type,
    services,
  });
  if (triage.intent === 'contact') {
    return emptyExtract({ action: 'contact', confidence: 'high', source: 'keyword' });
  }
  if (triage.intent === 'menu') {
    return emptyExtract({ action: 'menu', confidence: 'high', source: 'keyword' });
  }
  if (triage.intent === 'faq') {
    return emptyExtract({
      action: faqActionFromText(textBody),
      confidence: 'high',
      source: 'keyword',
    });
  }
  if (triage.intent === 'cancel') {
    return emptyExtract({ action: 'cancel', confidence: 'high', source: 'keyword' });
  }

  const named = matchServiceMention(textBody, services);
  if (named) {
    return emptyExtract({
      action: 'select_service',
      service_id: named.id,
      service_name: named.name,
      confidence: 'high',
      source: 'parser',
    });
  }

  const semantic = await matchServiceSemantically({
    business,
    text: textBody,
    services,
    requestId,
  });
  if (semantic) {
    return emptyExtract({
      action: 'select_service',
      service_id: semantic.id,
      service_name: semantic.name,
      confidence: 'medium',
      source: 'nlu',
    });
  }

  return finalizeGroundedExtract(emptyExtract({
    action: 'unknown_service',
    unknown_service_name: String(textBody || '').trim(),
    confidence: 'high',
    source: 'parser',
  }));
}

/**
 * @param {TurnExtract} next
 * @param {string} text
 * @param {string} timezone
 * @param {{ freezeDate?: boolean, freezeTime?: boolean }} [opts]
 */
/**
 * True when the utterance itself names a calendar day or relative date
 * (not merely an hour). Used so leftover LLM/session dates do not win.
 */
function textHasExplicitDay(text) {
  const n = normalize(text);
  return /\b(luni|marti|miercuri|joi|vineri|sambata|duminica|maine|azi|astazi|poimaine|ieri|alaltaieri|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|yesterday)\b/.test(n)
    || /\b\d{1,2}\s*(ian|feb|mar|apr|mai|iun|iul|aug|sep|oct|nov|dec)/.test(n)
    || /\b(?:pe|on(?:\s+the)?)\s+\d{1,2}/.test(n)
    || /\b(?:peste|in)\s+(\d{1,2}|o|un|una|doi|doua|trei|patru|cinci|sase|sapte|opt|noua|zece)\s+(?:de\s+)?(?:zile|zi|ore|ora|minute|minut|min|saptaman)/.test(n)
    || /\b(?:de\s+azi\s+intr-o\s+saptaman|intr-o\s+saptaman|(?:in\s+)?saptaman(?:a|ii)\s+(?:viitoare|urmatoare)|next\s+week)\b/.test(n);
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
  // Deterministic parse from the user utterance always wins over LLM ISO dates.
  // Otherwise "peste 2 zile" / "săptămâna viitoare" keep a wrong "today" from the model
  // and Supabase is filtered on the current day.
  if (parts.dateKey && !opts.freezeDate) next.date_text = parts.dateKey;
  if (parts.timeHHmm && !opts.freezeTime) next.time_text = parts.timeHHmm;
}

/**
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.textBody
 * @param {string | null} [params.buttonPayload]
 * @param {string | null} [params.buttonTitle] — ButtonText / ListTitle from Twilio
 * @param {string | null} [params.typedText] — raw Body, kept apart from tapped ids
 * @param {import('../db/conversationStateService.js').ConversationState} params.convState
 * @param {import('../db/draftBookingService.js').DraftBooking | null} [params.activeDraft]
 * @param {string | null} [params.requestId]
 * @returns {Promise<TurnExtract>}
 */
async function extractTurnIntentImpl({
  business,
  textBody,
  buttonPayload = null,
  buttonTitle = null,
  typedText = null,
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

  const gridWait = wait === BOOKING_WAIT.DATE
    || wait === BOOKING_WAIT.TIME
    || wait === BOOKING_WAIT.DATE_TIME
    || lastMenu?.kind === 'day_grid'
    || lastMenu?.kind === 'time_grid';

  // ── Free-text first (NLU path). Interactive taps are secondary. ──────────
  // WhatsApp often attaches a stale ButtonPayload to a typed sentence. Prefer
  // the raw Body whenever it looks like language, never a tap id.
  const rawTyped = String(typedText ?? '').trim() || String(textBody ?? '').trim();
  let tappedId = looksLikeInteractiveChoiceId(buttonPayload) ? String(buttonPayload).trim() : null;
  if (shouldPreferTypedTextOverTap({
    typed: rawTyped,
    tappedId,
    buttonTitle,
  })) {
    textBody = rawTyped;
    tappedId = null;
  } else if (tappedId) {
    // Genuine tap: pipeline reads the stable option id.
    textBody = tappedId;
  } else {
    textBody = rawTyped;
  }

  // Entry-menu label/id (Contact / Detalii / Programare) — resolve before grid stale walls or NLU.
  if (
    looksLikeMenuPivotIntent(rawTyped)
    || looksLikeMenuPivotIntent(textBody)
    || (tappedId && isEntryMenuChoiceId(business, tappedId))
  ) {
    const entryResolved = resolveEntryMenuChoiceId(business, {
      choiceId: tappedId,
      textBody: rawTyped || buttonTitle,
    });
    if (entryResolved) {
      const fromEntry = extractFromChoiceId(entryResolved, {}, business);
      if (fromEntry.action !== 'unknown') return fromEntry;
    }
  }

  // Empty inbound (image-only, sticker, accidental send) — menu, not a crash loop.
  if (!String(textBody ?? '').trim() && !tappedId) {
    return emptyExtract({ action: 'menu', confidence: 'low', source: 'keyword' });
  }

  // Modification / booking intents on free text must beat every menu wall.
  // "vreau sa reprogramez o programare" must never become stale_choice or reprompt_grid.
  // Mid-flow "modific" revises the draft being built — not a saved appointment.
  // Gratitude wins even if a stray confirm payload somehow survived — never confirm on "Mulțumesc".
  if (looksLikeGratitude(rawTyped) || (!tappedId && looksLikeGratitude(textBody))) {
    return emptyExtract({ action: 'thanks', confidence: 'high', source: 'keyword' });
  }
  if (!tappedId && isLanguageCapabilityQuestion(rawTyped || textBody)) {
    return emptyExtract({ action: 'language_info', confidence: 'high', source: 'keyword' });
  }

  // Pending-action first: reply is interpreted against what we asked last
  // (e.g. "da / alt nume" → "La Stefan") before service-wait / NLU.
  if (!tappedId) {
    const pendingReply = interpretPendingActionReply({
      textBody,
      convState,
      employees,
      services,
    });
    if (pendingReply) {
      return emptyExtract(pendingReply);
    }
  }

  // Business FAQ (parcare / wifi / …) before aggressive entity / booking paths.
  if (!tappedId && looksLikeBusinessFactQuestion(textBody)) {
    return emptyExtract({ action: 'missing_info', confidence: 'high', source: 'keyword' });
  }

  const earlyModify = !tappedId ? detectModificationIntent(textBody) : null;
  if (earlyModify === 'cancel') {
    const dropHoldOnly = isPendingHold && !refersToSavedAppointments(textBody) && !looksLikeCancelAll(textBody);
    return annotateModifyExtract(emptyExtract({
      action: dropHoldOnly ? 'cancel_pending' : 'cancel',
      date_text: extractDateKey(textBody, tz),
      confidence: 'high',
      source: 'keyword',
    }), textBody);
  }
  if (earlyModify === 'reschedule' || (!tappedId && looksLikeInFlightRevision(textBody))) {
    const routed = resolveRescheduleOrRevise(textBody, {
      step,
      wait,
      activeDraft,
      context: convState.context_data,
    });
    if (routed === 'revise_draft') {
      return emptyExtract({
        action: 'revise_draft',
        date_text: extractDateKey(textBody, tz),
        time_text: looksLikeTimeOnlyRevision(textBody) ? '__keep_date__' : null,
        confidence: 'high',
        source: 'keyword',
      });
    }
    if (routed === 'reschedule') {
      return annotateModifyExtract(
        enrichRescheduleKeywordExtract(emptyExtract({
          action: 'reschedule',
          confidence: 'high',
          source: 'keyword',
        }), textBody, tz),
        textBody,
      );
    }
  }

  if (
    !tappedId
    && (
      gridWait
      || wait === BOOKING_WAIT.SERVICE
      || wait === BOOKING_WAIT.DATE
      || wait === BOOKING_WAIT.TIME
      || wait === BOOKING_WAIT.DATE_TIME
      || step === CONVERSATION_STEPS.WAITING_FOR_SERVICE
      || step === CONVERSATION_STEPS.WAITING_FOR_DATE
      || step === CONVERSATION_STEPS.WAITING_FOR_TIME
      || step === CONVERSATION_STEPS.WAITING_FOR_DATE_TIME
      || step === CONVERSATION_STEPS.SELECTING_SLOT
    )
  ) {
    const pivot = triageUserIntent(textBody, { businessType: business.business_type, services });
    if (pivot.intent === 'contact') {
      return emptyExtract({ action: 'contact', confidence: 'high', source: 'keyword' });
    }
    if (pivot.intent === 'menu') {
      return emptyExtract({ action: 'menu', confidence: 'high', source: 'keyword' });
    }
    if (pivot.intent === 'faq') {
      return emptyExtract({
        action: faqActionFromText(textBody),
        confidence: 'high',
        source: 'keyword',
      });
    }
    if (pivot.intent === 'cancel') {
      return emptyExtract({ action: 'cancel', confidence: 'high', source: 'keyword' });
    }
  }

  if (!tappedId && looksLikeNewBookingRequest(textBody, { services })) {
    // Cold-start book without a day/time — fall through when the utterance already
    // carries a slot so parsers below can fill date_text / time_text.
    if (!looksLikeDatetimeOrSlot(textBody) && !detectTimeWindowFromText(textBody)) {
      const named = matchServiceMention(textBody, services);
      if (wait === BOOKING_WAIT.SERVICE) {
        if (named) {
          return emptyExtract({
            action: 'select_service',
            service_id: named.id,
            service_name: named.name,
            confidence: 'high',
            source: 'parser',
          });
        }
        if (looksLikeGeneralBookingOnly(textBody, { services })) {
          return emptyExtract({
            action: 'book',
            confidence: 'high',
            source: 'keyword',
          });
        }
        const duringWait = await resolveTypedServiceDuringWait(textBody, business, services, requestId);
        if (duringWait) return duringWait;
      } else if (named) {
        return emptyExtract({
          action: 'book',
          service_id: named.id,
          service_name: named.name,
          confidence: 'high',
          source: 'keyword',
        });
      } else if (looksLikeGeneralBookingOnly(textBody, { services })) {
        return emptyExtract({
          action: 'book',
          confidence: 'high',
          source: 'keyword',
        });
      }
      // Catalog-ish text without a confident service match — let NLU resolve.
    }
  }

  // Genuine interactive taps only — free text never enters stale_choice.
  if (tappedId) {
    // Typed FAQ pivots (Contact / orar) over a stale day_/slot_ payload must win.
    const pivotOverStaleGrid = looksLikeMenuPivotIntent(rawTyped)
      && (tappedId.startsWith('slot_')
        || tappedId.startsWith(GRID_PREFIX.DAY)
        || isGridNavChoiceId(tappedId));
    if (pivotOverStaleGrid) {
      tappedId = null;
      textBody = rawTyped;
    }
  }
  if (tappedId) {
    // Pager controls are always live during a grid flow — never "stale history".
    if (isGridNavChoiceId(tappedId)) {
      return extractFromChoiceId(tappedId, {}, business);
    }
    const onGridFlow = lastMenu?.kind === 'day_grid'
      || lastMenu?.kind === 'time_grid'
      || wait === BOOKING_WAIT.DATE
      || wait === BOOKING_WAIT.TIME
      || wait === BOOKING_WAIT.DATE_TIME
      || step === CONVERSATION_STEPS.WAITING_FOR_DATE
      || step === CONVERSATION_STEPS.WAITING_FOR_TIME
      || step === CONVERSATION_STEPS.WAITING_FOR_DATE_TIME
      || step === CONVERSATION_STEPS.RESCHEDULING
      || step === CONVERSATION_STEPS.SELECTING_SLOT;
    // Day/slot ids during an active picker: accept and let execute validate availability.
    if (
      onGridFlow
      && (tappedId.startsWith('slot_') || tappedId.startsWith(GRID_PREFIX.DAY))
    ) {
      const fromGrid = extractFromChoiceId(tappedId, {}, business);
      if (fromGrid.action !== 'unknown') return fromGrid;
    }

    // Entry-menu quick replies (Programare / Detalii / Contact) stay live after booking,
    // TTL reset, or when the client taps an older welcome card — never stale_choice.
    if (isEntryMenuChoiceId(business, tappedId)) {
      const fromEntry = extractFromChoiceId(tappedId, {}, business);
      if (fromEntry.action !== 'unknown') return fromEntry;
    }
    const entryFromLabel = resolveEntryMenuChoiceId(business, {
      choiceId: tappedId,
      textBody: rawTyped || buttonTitle,
    });
    if (entryFromLabel) {
      const fromEntry = extractFromChoiceId(entryFromLabel, {}, business);
      if (fromEntry.action !== 'unknown') return fromEntry;
    }

    const staleTap = !lastMenu?.options?.some((o) => o.id === tappedId);
    if (staleTap) {
      return emptyExtract({
        action: 'stale_choice',
        choice_id: tappedId,
        confidence: 'high',
        source: 'menu',
      });
    }
    if (lastMenu?.options?.length) {
      const choiceId = resolveInteractiveChoice(textBody, tappedId, lastMenu.options);
      if (choiceId) {
        const fromChoice = extractFromChoiceId(choiceId, {}, business);
        if (fromChoice.action !== 'unknown') return fromChoice;
        return emptyExtract({
          action: 'stale_choice',
          choice_id: tappedId,
          confidence: 'high',
          source: 'menu',
        });
      }
    }
  } else if (lastMenu?.options?.length) {
    // Free text OR Body=title+description without ListId: map onto the current menu.
    const loneNumber = /^\d{1,2}$/.test(String(textBody).trim());
    if (loneNumber) {
      const choiceId = resolveNumberedChoice(textBody, lastMenu.options);
      if (choiceId) {
        const fromChoice = extractFromChoiceId(choiceId, {}, business);
        if (fromChoice.action !== 'unknown') return fromChoice;
      }
    }
    const fromBody = resolveInteractiveChoice(textBody, null, lastMenu.options);
    if (fromBody) {
      const fromChoice = extractFromChoiceId(fromBody, {}, business);
      if (fromChoice.action !== 'unknown') return fromChoice;
    }
  }

  // Interactive list/button taps always win (handled above).
  // Free-text NLP still runs during date/time wait (e.g. "mâine la 10").

  if (!tappedId) {
    const entryFromText = resolveEntryMenuChoiceId(business, { textBody: rawTyped });
    if (entryFromText) {
      const fromEntry = extractFromChoiceId(entryFromText, {}, business);
      if (fromEntry.action !== 'unknown') return fromEntry;
    }
  }

  if (looksLikeExistingAppointmentQuery(textBody)) {
    return emptyExtract({ action: 'list_appointments', confidence: 'high', source: 'keyword' });
  }
  if (looksLikeOffTopicChat(textBody)) {
    return emptyExtract({ action: 'off_topic', confidence: 'high', source: 'keyword' });
  }
  // Soft availability must not be stolen as amenity FAQ.
  // Cancel/reschedule (or an in-progress modify step) must keep the appointment picker.
  const modifyIntent = detectModificationIntent(textBody);
  const inModifyStep = step === CONVERSATION_STEPS.RESCHEDULING
    || step === CONVERSATION_STEPS.MODIFYING
    || convState.context_data?.intent === 'reschedule';
  if (
    !modifyIntent
    && !inModifyStep
    && (looksLikeAvailabilityQuestion(textBody) || detectTimeWindowFromText(textBody))
  ) {
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

  // Modification intent wins over NLU book/clarify misreads — go straight to DB lookup in execute.
  if (modifyIntent === 'cancel') {
    const dropHoldOnly = isPendingHold && !refersToSavedAppointments(textBody) && !looksLikeCancelAll(textBody);
    return annotateModifyExtract(emptyExtract({
      action: dropHoldOnly ? 'cancel_pending' : 'cancel',
      date_text: extractDateKey(textBody, tz),
      confidence: 'high',
      source: 'keyword',
    }), textBody);
  }
  if (modifyIntent === 'reschedule' || looksLikeInFlightRevision(textBody)) {
    const routed = resolveRescheduleOrRevise(textBody, {
      step,
      wait,
      activeDraft,
      context: convState.context_data,
    });
    if (routed === 'revise_draft') {
      return emptyExtract({
        action: 'revise_draft',
        date_text: extractDateKey(textBody, tz),
        time_text: looksLikeTimeOnlyRevision(textBody) ? '__keep_date__' : null,
        confidence: 'high',
        source: 'keyword',
      });
    }
    if (routed === 'reschedule') {
      return annotateModifyExtract(
        enrichRescheduleKeywordExtract(emptyExtract({
          action: 'reschedule',
          confidence: 'high',
          source: 'keyword',
        }), textBody, tz),
        textBody,
      );
    }
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

  // Contact / FAQ / menu beat deterministic date parsing ("maine" must not steal orar).
  const triage = triageUserIntent(textBody, { businessType: business.business_type, services });
  if (triage.intent === 'sms_opt_in' || triage.intent === 'sms_opt_out') {
    return emptyExtract({ action: triage.intent, confidence: 'high', source: 'keyword' });
  }
  if (triage.intent === 'contact') {
    return emptyExtract({ action: 'contact', confidence: 'high', source: 'keyword' });
  }
  if (triage.intent === 'menu') {
    return emptyExtract({ action: 'menu', confidence: 'high', source: 'keyword' });
  }
  if (triage.intent === 'faq') {
    return emptyExtract({
      action: faqActionFromText(textBody),
      confidence: 'high',
      source: 'keyword',
    });
  }

  const inModifyEarly = step === CONVERSATION_STEPS.RESCHEDULING
    || step === CONVERSATION_STEPS.MODIFYING
    || convState.context_data?.intent === 'reschedule';

  // Named staff + explicit slot must beat bare date/time deterministic parse
  // ("azi la 15 la Mihai" → holdRequestedSlot + colleague fallback, not date grid).
  const explicitEarly = resolveExplicitSlot(textBody, business, now);
  if (explicitEarly?.dateKey && explicitEarly?.timeHHmm && !looksLikeExistingAppointmentQuery(textBody)) {
    const staffEarly = resolveStaffMentionFromText(textBody, employees, services);
    if (staffEarly.employee_id || staffEarly.employee_name) {
      const modEarly = triageUserIntent(textBody, { businessType: business.business_type, services });
      if (modEarly.intent !== 'cancel') {
        const namedEarly = matchServiceMention(textBody, services);
        return emptyExtract({
          action: inModifyEarly || modEarly.intent === 'reschedule' ? 'reschedule' : 'book',
          date_text: explicitEarly.dateKey,
          time_text: explicitEarly.timeHHmm,
          datetime: explicitEarly.datetime,
          service_id: namedEarly?.id ?? null,
          service_name: namedEarly?.name ?? null,
          employee_id: staffEarly.employee_id,
          employee_name: staffEarly.employee_name,
          confidence: 'high',
          source: 'parser',
        });
      }
    }
  }

  const deterministic = resolveDeterministicInbound({
    textBody,
    lastMenu,
    wait,
    timezone: tz,
    pendingDateKey,
    business,
    inModify: step === CONVERSATION_STEPS.RESCHEDULING
      || step === CONVERSATION_STEPS.MODIFYING
      || convState.context_data?.intent === 'reschedule',
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
    && (isExplicitConfirmReply(textBody) || wantsSameExpiredBooking(textBody, triage))
  ) {
    return emptyExtract({ action: 'resume_yes', confidence: 'high', source: 'state' });
  }
  if (step === CONVERSATION_STEPS.OFFERING_RESUME && isExplicitCancelReply(textBody)) {
    return emptyExtract({ action: 'resume_no', confidence: 'high', source: 'state' });
  }

  const inModify = step === CONVERSATION_STEPS.RESCHEDULING
    || step === CONVERSATION_STEPS.MODIFYING
    || convState.context_data?.intent === 'reschedule';
  const explicit = resolveExplicitSlot(textBody, business, now);
  if (explicit?.dateKey && explicit?.timeHHmm && !looksLikeExistingAppointmentQuery(textBody)) {
    const mod = triageUserIntent(textBody, { businessType: business.business_type, services });
    if (mod.intent !== 'cancel') {
      const named = matchServiceMention(textBody, services);
      const staff = resolveStaffMentionFromText(textBody, employees, services);
      return emptyExtract({
        action: inModify || mod.intent === 'reschedule' ? 'reschedule' : 'book',
        date_text: explicit.dateKey,
        time_text: explicit.timeHHmm,
        datetime: explicit.datetime,
        service_id: named?.id ?? null,
        service_name: named?.name ?? null,
        employee_id: staff.employee_id,
        employee_name: staff.employee_name,
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
      const staff = resolveStaffMentionFromText(textBody, employees, services);
      return emptyExtract({
        action: wait === BOOKING_WAIT.SERVICE ? 'select_service' : 'book',
        service_id: named.id,
        service_name: named.name,
        employee_id: staff.employee_id,
        employee_name: staff.employee_name,
        confidence: 'high',
        source: 'parser',
      });
    }
  }
  if (
    wait === BOOKING_WAIT.SERVICE
    && isTypedServiceAttempt(textBody)
    && !matchServiceMention(textBody, services)
    && !looksLikeDatetimeOrSlot(textBody)
    && !isExplicitCancelReply(textBody)
    && triage.intent !== 'menu'
    && triage.intent !== 'services'
    && triage.intent !== 'contact'
    && triage.intent !== 'faq'
    && triage.intent !== 'cancel'
  ) {
    const duringWait = await resolveTypedServiceDuringWait(textBody, business, services, requestId);
    if (duringWait) return duringWait;
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
    if (mapped.action === 'clarify_needed' && !detectModificationIntent(textBody)) return mapped;
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
      'cancel_all', 'reschedule', 'off_topic', 'missing_info',
    ]);
    if (direct.has(mapped.action)) return mapped;
    if (mapped.action === 'unknown') {
      return emptyExtract({ action: 'chat', confidence: 'low', source: 'nlu', extraction: nlu });
    }
    return finalizeGroundedExtract(await applyCatalogMatchesWithSemantic(
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
      business,
      requestId,
    ));
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
  else if (triage.intent === 'thanks') extract.action = 'thanks';
  else if (triage.intent === 'reschedule') {
    const routed = resolveRescheduleOrRevise(textBody, {
      step,
      wait,
      activeDraft,
      context: convState.context_data,
    });
    extract.action = routed === 'revise_draft' ? 'revise_draft' : 'reschedule';
    if (routed === 'revise_draft' && looksLikeTimeOnlyRevision(textBody)) {
      extract.time_text = '__keep_date__';
    }
  }
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

  extract = finalizeGroundedExtract(await applyCatalogMatchesWithSemantic(extract, textBody, services, employees, tz, { dayHours }, business, requestId));
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

  // While waiting on the day/time picker: if free text did not yield a temporal choice,
  // gently re-show the list (list taps + NLP like "mâine la 10" already returned above).
  if (gridWait) {
    const hasTemporal = Boolean(
      extract.datetime
      || extract.date_text
      || extract.time_text
      || extract.slot_id
      || extract.time_window
    );
    const leavePicker = new Set([
      'select_slot', 'grid_nav', 'reprompt_grid', 'confirm', 'cancel', 'cancel_pending',
      'cancel_all', 'select_appointment', 'stale_choice', 'book', 'reschedule',
      'menu', 'contact', 'list_appointments', 'callback', 'hours', 'services', 'hours_and_services',
      'missing_info', 'resolve_clarification', 'clarify_needed', 'abort', 'set_name',
      'select_service', 'select_employee', 'accept_offer', 'resume_yes', 'resume_no',
      'unknown_service', 'show_services', 'reprompt_employee',
    ]);
    if (hasTemporal || leavePicker.has(extract.action)) {
      return extract;
    }
    if (extract.action === 'book' || extract.action === 'reschedule') {
      // Free-text booking/reschedule without a parsed day/time — keep going (execute re-asks).
      return extract;
    }
    if (extract.action === 'chat' || extract.action === 'off_topic' || extract.action === 'unknown') {
      return emptyExtract({
        action: 'reprompt_grid',
        confidence: 'medium',
        source: 'state',
      });
    }
  }

  return extract;
}

export async function extractTurnIntent(params) {
  const extract = await extractTurnIntentImpl(params);
  const annotated = annotateModifyExtract(extract, params.textBody);

  // Re-bind staff from free text for booking flows only.
  // Never attach "la salon" / "la dvs" guesses onto FAQ / thanks / menu.
  if (shouldSkipStaffRebind(annotated.action)) {
    annotated.employee_id = null;
    annotated.employee_name = null;
    return annotated;
  }

  try {
    const services = getBookingConfig(params.business).services;
    const employees = await listEmployees(params.business.id, { activeOnly: true });
    const staff = resolveStaffMentionFromText(params.textBody || '', employees, services);
    if (staff.employee_id) {
      annotated.employee_id = staff.employee_id;
      annotated.employee_name = staff.employee_name;
    } else if (staff.employee_name) {
      annotated.employee_id = null;
      annotated.employee_name = staff.employee_name;
    }
  } catch {
    // Extraction must still return even if employee lookup fails.
  }

  return annotated;
}
