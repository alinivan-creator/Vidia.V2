/**
 * Layer 2 — Deterministic booking state machine.
 * All flow decisions live here. The LLM does not choose the next WhatsApp screen.
 */

import {
  CONVERSATION_STEPS,
  setConversationStep,
} from '../../db/conversationStateService.js';
import { BOOKING_WAIT, dateKeyFromDayNumber, getBookingWait } from '../../services/bookingWaitState.js';
import { getBookingConfig } from '../../utils/datetime.js';
import { resolveServiceDurationMinutes } from '../../utils/workingHours.js';

/** @typedef {import('../../schemas/extractionResult.js').ExtractionResult} ExtractionResult */

export const SESSION_STATES = /** @type {const} */ ({
  INIT: 'INIT',
  WAITING_FOR_SERVICE: 'WAITING_FOR_SERVICE',
  WAITING_FOR_DATE: 'WAITING_FOR_DATE',
  WAITING_FOR_TIME: 'WAITING_FOR_TIME',
  WAITING_FOR_DATE_TIME: 'WAITING_FOR_DATE_TIME',
  WAITING_FOR_CLARIFICATION: 'WAITING_FOR_CLARIFICATION',
  WAITING_FOR_CONFIRMATION: 'WAITING_FOR_CONFIRMATION',
  CONFIRMED: 'CONFIRMED',
});

export const MACHINE_ACTIONS = /** @type {const} */ ({
  ACTION_ASK_SERVICE: 'ACTION_ASK_SERVICE',
  ACTION_ASK_DATE: 'ACTION_ASK_DATE',
  ACTION_ASK_TIME: 'ACTION_ASK_TIME',
  ACTION_ASK_DATE_TIME: 'ACTION_ASK_DATE_TIME',
  ACTION_ASK_CLARIFICATION: 'ACTION_ASK_CLARIFICATION',
  ACTION_SLOT_UNAVAILABLE: 'ACTION_SLOT_UNAVAILABLE',
  ACTION_SHOW_CONFIRMATION: 'ACTION_SHOW_CONFIRMATION',
  ACTION_CHECK_SLOT: 'ACTION_CHECK_SLOT',
  ACTION_CONFIRMED: 'ACTION_CONFIRMED',
  ACTION_NONE: 'ACTION_NONE',
});

const TIME_CONTEXT_STATES = new Set([
  SESSION_STATES.WAITING_FOR_TIME,
  SESSION_STATES.WAITING_FOR_CONFIRMATION,
]);

const DATE_CONTEXT_STATES = new Set([
  SESSION_STATES.WAITING_FOR_DATE,
]);

/**
 * @typedef {Object} DraftBookingSnapshot
 * @property {string | null} service_id
 * @property {string | null} [service_name]
 * @property {string | null} date
 * @property {string | null} time
 * @property {number | null} duration
 */

/**
 * @typedef {Object} MachineResult
 * @property {string} state
 * @property {DraftBookingSnapshot} draft
 * @property {string} action
 * @property {number | null} [clarify_value]
 * @property {string | null} [clarify_reason]
 * @property {string | null} [rejected]
 */

export function emptyDraft(overrides = {}) {
  return {
    service_id: null,
    service_name: null,
    date: null,
    time: null,
    duration: null,
    ...overrides,
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function hourToHHmm(hour) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  return `${pad2(hour)}:00`;
}

function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * "nu 17, 18" / "nu 17 ci 18" → overwrite target is 18.
 */
export function parseInFlightCorrection(text) {
  const n = normalizeText(text);
  const nuThen = n.match(
    /\b(?:nu+|no|not)(?:\s+(?:pe|la|ora|data|ziua))?\s+(\d{1,2})\s*(?:,|;|ci)\s*(?:(?:pe|la|ora|data(?:\s+de)?|at)\s+)?(\d{1,2})\b/,
  );
  if (nuThen) return { rejected: Number(nuThen[1]), value: Number(nuThen[2]) };
  const valueThenNu = n.match(
    /\b(\d{1,2})\s*(?:,|;)?\s*nu(?:\s+(?:pe|la|ora|data))?\s+(\d{1,2})\b/,
  );
  if (valueThenNu) return { rejected: Number(valueThenNu[2]), value: Number(valueThenNu[1]) };
  return null;
}

function isolatedHour(text) {
  const n = normalizeText(text);
  if (/\b(data(?:\s+de)?|ziua(?:\s+de)?)\b/.test(n) && /\bpe\s+\d{1,2}\b/.test(n)) return null;
  const m = n.match(/^(\d{1,2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  return hour >= 0 && hour <= 23 ? hour : null;
}

/**
 * Map persisted conversation_states.current_step → SESSION_STATES.
 * @param {string | null | undefined} step
 */
export function mapSessionState(step) {
  switch (step) {
    case CONVERSATION_STEPS.WAITING_FOR_SERVICE:
    case CONVERSATION_STEPS.CHOOSING_SERVICE:
      return SESSION_STATES.WAITING_FOR_SERVICE;
    case CONVERSATION_STEPS.WAITING_FOR_DATE:
      return SESSION_STATES.WAITING_FOR_DATE;
    case CONVERSATION_STEPS.WAITING_FOR_TIME:
    case CONVERSATION_STEPS.SELECTING_SLOT:
    case CONVERSATION_STEPS.CHOOSING_EMPLOYEE:
      return SESSION_STATES.WAITING_FOR_TIME;
    case CONVERSATION_STEPS.WAITING_FOR_DATE_TIME:
      return SESSION_STATES.WAITING_FOR_DATE_TIME;
    case CONVERSATION_STEPS.WAITING_FOR_CLARIFICATION:
      return SESSION_STATES.WAITING_FOR_CLARIFICATION;
    case CONVERSATION_STEPS.WAITING_FOR_CONFIRMATION:
    case CONVERSATION_STEPS.CONFIRMING:
    case CONVERSATION_STEPS.ASKING_NAME:
      return SESSION_STATES.WAITING_FOR_CONFIRMATION;
    case CONVERSATION_STEPS.CONFIRMED:
      return SESSION_STATES.CONFIRMED;
    default:
      return SESSION_STATES.INIT;
  }
}

/**
 * @param {string} state
 */
export function toConversationStep(state) {
  switch (state) {
    case SESSION_STATES.WAITING_FOR_SERVICE:
      return CONVERSATION_STEPS.WAITING_FOR_SERVICE;
    case SESSION_STATES.WAITING_FOR_DATE:
      return CONVERSATION_STEPS.WAITING_FOR_DATE;
    case SESSION_STATES.WAITING_FOR_TIME:
      return CONVERSATION_STEPS.WAITING_FOR_TIME;
    case SESSION_STATES.WAITING_FOR_DATE_TIME:
      return CONVERSATION_STEPS.WAITING_FOR_DATE_TIME;
    case SESSION_STATES.WAITING_FOR_CLARIFICATION:
      return CONVERSATION_STEPS.WAITING_FOR_CLARIFICATION;
    case SESSION_STATES.WAITING_FOR_CONFIRMATION:
      return CONVERSATION_STEPS.WAITING_FOR_CONFIRMATION;
    case SESSION_STATES.CONFIRMED:
      return CONVERSATION_STEPS.CONFIRMED;
    default:
      return CONVERSATION_STEPS.IDLE;
  }
}

function waitFromState(state) {
  switch (state) {
    case SESSION_STATES.WAITING_FOR_SERVICE:
      return BOOKING_WAIT.SERVICE;
    case SESSION_STATES.WAITING_FOR_DATE:
      return BOOKING_WAIT.DATE;
    case SESSION_STATES.WAITING_FOR_TIME:
      return BOOKING_WAIT.TIME;
    case SESSION_STATES.WAITING_FOR_DATE_TIME:
      return BOOKING_WAIT.DATE_TIME;
    case SESSION_STATES.WAITING_FOR_CLARIFICATION:
      return BOOKING_WAIT.CLARIFICATION;
    case SESSION_STATES.WAITING_FOR_CONFIRMATION:
      return BOOKING_WAIT.CONFIRMATION;
    default:
      return null;
  }
}

/**
 * @param {import('../../db/conversationStateService.js').ConversationState | null | undefined} convState
 * @param {import('../../db/draftBookingService.js').DraftBooking | null} [activeDraft]
 * @returns {DraftBookingSnapshot}
 */
export function readDraftBooking(convState, activeDraft = null) {
  const ctx = convState?.context_data || {};
  const stored = ctx.draft_booking && typeof ctx.draft_booking === 'object'
    ? /** @type {Record<string, unknown>} */ (ctx.draft_booking)
    : {};
  const service = activeDraft?.selected_service && typeof activeDraft.selected_service === 'object'
    ? /** @type {{ id?: string, name?: string, duration_minutes?: number }} */ (activeDraft.selected_service)
    : null;

  return emptyDraft({
    service_id: (typeof stored.service_id === 'string' && stored.service_id)
      || (typeof ctx.pending_service_id === 'string' && ctx.pending_service_id)
      || service?.id
      || null,
    service_name: (typeof stored.service_name === 'string' && stored.service_name)
      || service?.name
      || null,
    date: (typeof stored.date === 'string' && stored.date)
      || (typeof ctx.pending_date_text === 'string' && ctx.pending_date_text)
      || null,
    time: (typeof stored.time === 'string' && stored.time)
      || (typeof ctx.pending_time_text === 'string' && ctx.pending_time_text)
      || null,
    duration: Number.isFinite(Number(stored.duration))
      ? Number(stored.duration)
      : (service?.duration_minutes ?? null),
  });
}

/**
 * Case B: state tells us whether a number overwrites time or date.
 * @param {string} state
 * @param {DraftBookingSnapshot} draft
 * @returns {'time' | 'date' | null}
 */
export function disambiguateByState(state, draft) {
  if (state === SESSION_STATES.WAITING_FOR_SERVICE) return null;
  if (TIME_CONTEXT_STATES.has(state)) return 'time';
  if (DATE_CONTEXT_STATES.has(state)) return 'date';
  if (state === SESSION_STATES.WAITING_FOR_DATE_TIME) {
    if (draft.date && !draft.time) return 'time';
    if (draft.time && !draft.date) return 'date';
  }
  if (state === SESSION_STATES.WAITING_FOR_CLARIFICATION) return null;
  if (draft.time && (state === SESSION_STATES.WAITING_FOR_CONFIRMATION || draft.date)) {
    return 'time';
  }
  return null;
}

function nextFromDraft(draft) {
  if (!draft.service_id) {
    return {
      state: SESSION_STATES.WAITING_FOR_SERVICE,
      draft,
      action: MACHINE_ACTIONS.ACTION_ASK_SERVICE,
    };
  }
  if (!draft.date && !draft.time) {
    return {
      state: SESSION_STATES.WAITING_FOR_DATE_TIME,
      draft,
      action: MACHINE_ACTIONS.ACTION_ASK_DATE_TIME,
    };
  }
  if (!draft.date) {
    return {
      state: SESSION_STATES.WAITING_FOR_DATE,
      draft,
      action: MACHINE_ACTIONS.ACTION_ASK_DATE,
    };
  }
  if (!draft.time) {
    return {
      state: SESSION_STATES.WAITING_FOR_TIME,
      draft,
      action: MACHINE_ACTIONS.ACTION_ASK_TIME,
    };
  }
  return {
    state: SESSION_STATES.WAITING_FOR_CONFIRMATION,
    draft,
    action: MACHINE_ACTIONS.ACTION_CHECK_SLOT,
  };
}

export function nextActionFromDraft(draft) {
  return nextFromDraft(emptyDraft(draft));
}

/**
 * Leftover catalog picks from an old draft must not skip the service question.
 * Keep a previously chosen service only while this booking is still collecting
 * date/time/confirm — never on a fresh "miercuri la 2".
 *
 * @param {string} state
 */
export function sessionKeepsChosenService(state) {
  return state === SESSION_STATES.WAITING_FOR_DATE
    || state === SESSION_STATES.WAITING_FOR_TIME
    || state === SESSION_STATES.WAITING_FOR_DATE_TIME
    || state === SESSION_STATES.WAITING_FOR_CONFIRMATION;
}

function applyNumberToDraft(draft, field, value, timezone) {
  if (field === 'time') {
    const time = hourToHHmm(value);
    return time ? { ...draft, time } : draft;
  }
  const date = dateKeyFromDayNumber(value, timezone, draft.date);
  return date ? { ...draft, date } : draft;
}

/**
 * Pure reducer — no I/O. Slot availability is applied afterwards via afterSlotCheck().
 *
 * @param {Object} params
 * @param {string} params.state
 * @param {DraftBookingSnapshot} params.draft
 * @param {ExtractionResult | null} [params.extraction]
 * @param {string} [params.text]
 * @param {string} [params.timezone]
 * @param {string | null} [params.extractDate]
 * @param {string | null} [params.extractTime]
 * @param {string | null} [params.extractServiceId]
 * @param {string | null} [params.extractServiceName]
 */
export function reduceBookingTurn({
  state,
  draft,
  extraction = null,
  text = '',
  timezone = 'Europe/Bucharest',
  extractDate = null,
  extractTime = null,
  extractServiceId = null,
  extractServiceName = null,
}) {
  let nextDraft = emptyDraft(draft);
  if (extractServiceId) {
    nextDraft.service_id = extractServiceId;
    if (extractServiceName) nextDraft.service_name = extractServiceName;
  } else if (extraction?.extracted_service) {
    nextDraft.service_name = extraction.extracted_service;
  }

  const correction = parseInFlightCorrection(text);
  const field = disambiguateByState(state, nextDraft);
  const choseServiceThisTurn = Boolean(extractServiceId);

  if (correction && field && !choseServiceThisTurn) {
    nextDraft = applyNumberToDraft(nextDraft, field, correction.value, timezone);
    return nextFromDraft(nextDraft);
  }

  if (!correction && field === 'time' && !choseServiceThisTurn) {
    const hour = isolatedHour(text);
    if (hour != null) {
      nextDraft = applyNumberToDraft(nextDraft, 'time', hour, timezone);
      return nextFromDraft(nextDraft);
    }
  }
  if (!correction && field === 'date' && !choseServiceThisTurn) {
    const n = normalizeText(text);
    const lone = n.match(/^(\d{1,2})$/);
    if (lone) {
      nextDraft = applyNumberToDraft(nextDraft, 'date', Number(lone[1]), timezone);
      return nextFromDraft(nextDraft);
    }
  }

  const ambiguous = Boolean(
    extraction?.is_ambiguous
    || (extraction && extraction.confidence < 0.8 && correction && !field),
  );
  if (ambiguous && !field) {
    const value = correction?.value
      ?? isolatedHour(text)
      ?? (extraction?.ambiguity_reason ? Number(String(extraction.ambiguity_reason).match(/\d{1,2}/)?.[0]) : null);
    return {
      state: SESSION_STATES.WAITING_FOR_CLARIFICATION,
      draft: nextDraft,
      action: MACHINE_ACTIONS.ACTION_ASK_CLARIFICATION,
      clarify_value: Number.isFinite(value) ? value : (correction?.value ?? null),
      clarify_reason: extraction?.ambiguity_reason
        || (correction
          ? `User wrote ${correction.value}, which could mean day ${correction.value} or ${pad2(correction.value)}:00`
          : 'Ambiguous number'),
      rejected: correction?.rejected != null ? String(correction.rejected) : null,
    };
  }

  if (ambiguous && field && correction) {
    nextDraft = applyNumberToDraft(nextDraft, field, correction.value, timezone);
    return nextFromDraft(nextDraft);
  }

  const intent = extraction?.intent;
  const dateValue = extractDate || extraction?.extracted_date || null;
  const timeValue = extractTime || extraction?.extracted_time || null;

  if (intent === 'change_time') {
    if (timeValue) nextDraft.time = timeValue;
  } else if (intent === 'change_date') {
    if (dateValue) nextDraft.date = dateValue;
  } else {
    if (dateValue) nextDraft.date = dateValue;
    if (timeValue) nextDraft.time = timeValue;
  }

  return nextFromDraft(nextDraft);
}

/**
 * Case C follow-up after the DB availability check.
 *
 * @param {MachineResult} reduced
 * @param {{ available: boolean, alternatives?: { id?: string, label: string }[] }} slot
 * @returns {MachineResult & { alternatives?: { id?: string, label: string }[] }}
 */
export function afterSlotCheck(reduced, slot) {
  if (reduced.action !== MACHINE_ACTIONS.ACTION_CHECK_SLOT) return reduced;
  if (!slot.available) {
    return {
      ...reduced,
      state: SESSION_STATES.WAITING_FOR_TIME,
      action: MACHINE_ACTIONS.ACTION_SLOT_UNAVAILABLE,
      alternatives: slot.alternatives || [],
    };
  }
  return {
    ...reduced,
    state: SESSION_STATES.WAITING_FOR_CONFIRMATION,
    action: MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION,
    alternatives: [],
  };
}

/**
 * Persist current_state + draft_booking in one upsert (conversation_states).
 *
 * @param {Object} params
 * @param {string} params.businessId
 * @param {string} params.rawPhone
 * @param {string} params.state
 * @param {DraftBookingSnapshot} params.draft
 * @param {Record<string, unknown>} [params.extraContext]
 * @param {string | null} [params.requestId]
 */
export async function persistSessionDraft({
  businessId,
  rawPhone,
  state,
  draft,
  extraContext = {},
  requestId = null,
}) {
  const snapshot = emptyDraft(draft);
  return setConversationStep({
    businessId,
    rawPhone,
    step: toConversationStep(state),
    context: {
      draft_booking: snapshot,
      pending_date_text: snapshot.date,
      pending_time_text: snapshot.time,
      pending_service_id: snapshot.service_id,
      booking_wait: waitFromState(state),
      ...extraContext,
    },
    mergeContext: true,
    requestId,
  });
}

/**
 * Resolve duration/name for a service the client already named.
 * Does not pick a catalog item on their behalf.
 *
 * @param {DraftBookingSnapshot} draft
 * @param {import('../../db/businessService.js').Business} business
 */
export function hydrateCatalogService(draft, business) {
  const next = emptyDraft(draft);
  const services = getBookingConfig(business).services;
  if (next.service_id) {
    const hit = services.find((s) => s.id === next.service_id);
    if (hit) {
      next.service_name = hit.name;
      next.duration = resolveServiceDurationMinutes(business, hit);
    }
    return next;
  }
  if (next.service_name) {
    const n = String(next.service_name).toLowerCase();
    const hit = services.find((s) => String(s.name).toLowerCase() === n)
      || services.find((s) => n.includes(String(s.name).toLowerCase()));
    if (hit) {
      next.service_id = hit.id;
      next.service_name = hit.name;
      next.duration = resolveServiceDurationMinutes(business, hit);
      return next;
    }
  }
  return next;
}

export { getBookingWait };
