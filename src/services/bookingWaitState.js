/**
 * Booking wait-state machine for free-text date/time.
 * Isolated numbers follow the current wait step. Ambiguous corrections
 * never guess — they ask date vs time.
 */

import { CONVERSATION_STEPS } from '../db/conversationStateService.js';
import { formatDateKey } from '../utils/datetime.js';
import { coerceHourToOpenHours, parseRomanianDateTimeParts } from '../utils/roDateTime.js';

export const BOOKING_WAIT = {
  SERVICE: 'waiting_for_service',
  DATE: 'waiting_for_date',
  TIME: 'waiting_for_time',
  DATE_TIME: 'waiting_for_date_time',
  CONFIRMATION: 'waiting_for_confirmation',
  CLARIFICATION: 'waiting_for_clarification',
};

export const CLARIFY_IDS = {
  DATE: 'clarify_date',
  TIME: 'clarify_time',
};

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isValidDay(year, month, day) {
  if (day < 1 || day > 31 || month < 1 || month > 12) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

/**
 * @param {import('../db/conversationStateService.js').ConversationState | null | undefined} convState
 * @returns {string | null}
 */
export function getBookingWait(convState) {
  const step = convState?.current_step;
  const ctx = convState?.context_data || {};

  if (
    step === CONVERSATION_STEPS.WAITING_FOR_CLARIFICATION
    || step === BOOKING_WAIT.CLARIFICATION
  ) {
    return BOOKING_WAIT.CLARIFICATION;
  }
  if (step === CONVERSATION_STEPS.WAITING_FOR_DATE || step === BOOKING_WAIT.DATE) {
    return BOOKING_WAIT.DATE;
  }
  if (step === CONVERSATION_STEPS.WAITING_FOR_TIME || step === BOOKING_WAIT.TIME) {
    return BOOKING_WAIT.TIME;
  }
  if (
    step === CONVERSATION_STEPS.WAITING_FOR_DATE_TIME
    || step === BOOKING_WAIT.DATE_TIME
  ) {
    if (ctx.pending_date_text && !ctx.pending_time_text) return BOOKING_WAIT.TIME;
    if (ctx.pending_time_text && !ctx.pending_date_text) return BOOKING_WAIT.DATE;
    return BOOKING_WAIT.DATE_TIME;
  }
  if (
    step === CONVERSATION_STEPS.WAITING_FOR_SERVICE
    || step === BOOKING_WAIT.SERVICE
    || step === CONVERSATION_STEPS.CHOOSING_SERVICE
    || step === CONVERSATION_STEPS.CHOOSING_EMPLOYEE
  ) {
    return BOOKING_WAIT.SERVICE;
  }
  if (
    step === CONVERSATION_STEPS.WAITING_FOR_CONFIRMATION
    || step === BOOKING_WAIT.CONFIRMATION
    || step === CONVERSATION_STEPS.CONFIRMING
  ) {
    return BOOKING_WAIT.CONFIRMATION;
  }
  if (step === CONVERSATION_STEPS.SELECTING_SLOT) {
    return ctx.pending_date_text ? BOOKING_WAIT.TIME : BOOKING_WAIT.DATE;
  }
  if (typeof ctx.booking_wait === 'string' && Object.values(BOOKING_WAIT).includes(ctx.booking_wait)) {
    return ctx.booking_wait;
  }
  return null;
}

/**
 * @param {number} day
 * @param {string} timezone
 * @param {string | null} pendingDateKey
 * @param {Date} [now]
 */
export function dateKeyFromDayNumber(day, timezone, pendingDateKey = null, now = new Date()) {
  const today = formatDateKey(now, timezone);
  const base = pendingDateKey && /^\d{4}-\d{2}-\d{2}$/.test(pendingDateKey) ? pendingDateKey : today;
  let year = Number(base.slice(0, 4));
  let month = Number(base.slice(5, 7));
  if (!isValidDay(year, month, day)) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  if (!isValidDay(year, month, day)) return null;
  let key = `${year}-${pad2(month)}-${pad2(day)}`;
  if (key < today) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    if (!isValidDay(year, month, day)) return null;
    key = `${year}-${pad2(month)}-${pad2(day)}`;
  }
  return key;
}

/**
 * @param {number} hour
 * @param {string} timezone
 */
export function timeFromHourNumber(hour, timezone, dayHours = null) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  const coerced = coerceHourToOpenHours(hour, 0, dayHours);
  return `${pad2(coerced.hour)}:${pad2(coerced.minute || 0)}`;
}

function parseCorrection(normalized) {
  const nuThen = normalized.match(
    /\bnu(?:\s+(?:pe|la|ora|data|ziua))?\s+(\d{1,2})\s*(?:,|;|ci)\s*(?:(?:pe|la|ora|data(?:\s+de)?)\s+)?(\d{1,2})\b/,
  );
  if (nuThen) {
    return { rejected: Number(nuThen[1]), value: Number(nuThen[2]) };
  }
  const valueThenNu = normalized.match(
    /\b(\d{1,2})\s*(?:,|;)?\s*nu(?:\s+(?:pe|la|ora|data))?\s+(\d{1,2})\b/,
  );
  if (valueThenNu) {
    return { rejected: Number(valueThenNu[2]), value: Number(valueThenNu[1]) };
  }
  return null;
}

function explicitField(normalized) {
  const timeHit = normalized.match(/\b(?:la|ora)\s+(\d{1,2})(?:[:.,](\d{2}))?\b/)
    || normalized.match(/\b(\d{1,2})[:.,](\d{2})\b/);
  const dateHit = normalized.match(/\b(?:data(?:\s+de)?|ziua(?:\s+de)?|pe)\s+(\d{1,2})\b/);
  const hasTimeWords = /\b(ora|dimineata|dupa[\s-]*amiaza|seara)\b/.test(normalized);
  const hasDateWords = /\b(data|ziua|luni|marti|miercuri|joi|vineri|sambata|duminica|aug|ian|feb|mar|apr|mai|iun|iul|sep|oct|nov|dec)\b/.test(normalized);

  if (hasTimeWords && !hasDateWords && timeHit) return 'time';
  if (hasDateWords && !hasTimeWords && (dateHit || /\b\d{1,2}\s+(ian|feb|mar|apr|mai|iun|iul|aug|sep|oct|nov|dec)/.test(normalized))) {
    return 'date';
  }
  if (/\b(?:la|ora)\s+\d{1,2}\b/.test(normalized) && !hasDateWords) return 'time';
  if (/\b(?:data|ziua)\b/.test(normalized) && !hasTimeWords) return 'date';
  if (/\b\d{1,2}[:.,]\d{2}\b/.test(normalized) && !hasDateWords) return 'time';
  return null;
}

function isolatedNumber(normalized) {
  const m = normalized.match(/^(\d{1,2})$/);
  return m ? Number(m[1]) : null;
}

function numberAfterCue(normalized) {
  const m = normalized.match(/\b(?:la|ora|pe|data(?:\s+de)?|ziua(?:\s+de)?)\s+(\d{1,2})\b/);
  return m ? Number(m[1]) : null;
}

function canBeHour(n) {
  return Number.isInteger(n) && n >= 0 && n <= 23;
}

function canBeDay(n) {
  return Number.isInteger(n) && n >= 1 && n <= 31;
}

/**
 * @param {Object} params
 * @param {string} params.text
 * @param {string | null} params.wait
 * @param {string} params.timezone
 * @param {string | null} [params.pendingDateKey]
 * @returns {{
 *   kind: 'none' | 'date' | 'time' | 'datetime' | 'ambiguous' | 'clarification_date' | 'clarification_time',
 *   value?: number,
 *   rejected?: number | null,
 *   dateKey?: string | null,
 *   timeHHmm?: string | null,
 *   dateLabel?: string,
 *   timeLabel?: string,
 * }}
 */
export function interpretNumericFreeText({
  text,
  wait,
  timezone,
  pendingDateKey = null,
  dayHours = null,
}) {
  const normalized = normalize(text);
  if (!normalized) return { kind: 'none' };

  if (wait === BOOKING_WAIT.CLARIFICATION) {
    if (/\b(ora|timpul|hour)\b/.test(normalized) && !/\b(data|ziua)\b/.test(normalized)) {
      return { kind: 'clarification_time' };
    }
    if (/\b(data|ziua|zi)\b/.test(normalized) && !/\b(ora|timpul)\b/.test(normalized)) {
      return { kind: 'clarification_date' };
    }
  }

  const spoken = parseRomanianDateTimeParts(text, timezone, new Date(), { dayHours });
  const hasClockMinutes = /\b\d{1,2}[:.,]\d{2}\b/.test(normalized);
  const hasColloquial = /\b(jumatate|jumate|juma|sfer(?:t)?|fara)\b/.test(normalized)
    || /\b\d{1,2}\s+si\s+\d{1,2}\b/.test(normalized);
  if (spoken.timeHHmm && (hasClockMinutes || hasColloquial)) {
    if (spoken.dateKey) {
      return { kind: 'none' };
    }
    return { kind: 'time', timeHHmm: spoken.timeHHmm };
  }

  const field = explicitField(normalized);
  const correction = parseCorrection(normalized);
  const lone = isolatedNumber(normalized);
  const value = correction?.value ?? lone ?? numberAfterCue(normalized);
  const rejected = correction?.rejected ?? null;

  if (value == null) return { kind: 'none' };

  if (field === 'time' && canBeHour(value)) {
    return { kind: 'time', value, rejected, timeHHmm: timeFromHourNumber(value, timezone, dayHours) };
  }
  if (field === 'date' && canBeDay(value)) {
    return {
      kind: 'date',
      value,
      rejected,
      dateKey: dateKeyFromDayNumber(value, timezone, pendingDateKey),
    };
  }

  if (wait === BOOKING_WAIT.TIME && canBeHour(value)) {
    return { kind: 'time', value, rejected, timeHHmm: timeFromHourNumber(value, timezone, dayHours) };
  }
  if (wait === BOOKING_WAIT.DATE && canBeDay(value)) {
    return {
      kind: 'date',
      value,
      rejected,
      dateKey: dateKeyFromDayNumber(value, timezone, pendingDateKey),
    };
  }
  if (wait === BOOKING_WAIT.CONFIRMATION && canBeHour(value) && (correction || lone != null)) {
    return { kind: 'time', value, rejected, timeHHmm: timeFromHourNumber(value, timezone, dayHours) };
  }
  if (
    wait === BOOKING_WAIT.DATE_TIME
    && canBeHour(value)
    && (correction || lone != null)
    && pendingDateKey
  ) {
    return { kind: 'time', value, rejected, timeHHmm: timeFromHourNumber(value, timezone, dayHours) };
  }

  if (!wait && lone != null && !field && !correction) {
    return { kind: 'none' };
  }

  const dateOk = canBeDay(value);
  const timeOk = canBeHour(value);
  if ((correction || lone != null) && dateOk && timeOk) {
    return {
      kind: 'ambiguous',
      value,
      rejected,
      dateKey: dateKeyFromDayNumber(value, timezone, pendingDateKey),
      timeHHmm: timeFromHourNumber(value, timezone, dayHours),
      dateLabel: String(value),
      timeLabel: String(value),
    };
  }
  if (timeOk && !dateOk) {
    return { kind: 'time', value, rejected, timeHHmm: timeFromHourNumber(value, timezone, dayHours) };
  }
  if (dateOk && !timeOk) {
    return {
      kind: 'date',
      value,
      rejected,
      dateKey: dateKeyFromDayNumber(value, timezone, pendingDateKey),
    };
  }
  return { kind: 'none' };
}

export function clarificationPrompt(value) {
  const n = String(value);
  return `❓ *${n}* e data sau ora *${n}:00*?`;
}
