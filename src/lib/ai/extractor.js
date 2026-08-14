/**
 * Layer 1 — Structured NLP extractor.
 * The model never replies to the client. It only returns ExtractionResult JSON.
 *
 * Canonical entry: extractBookingEntities()
 */

import { extractEntities as extractEntitiesFromLlm } from '../../services/entityExtractor.js';
import { parseExtractionResult } from '../../schemas/extractionResult.js';
import {
  coerceHHmmToOpenHours,
  parseRomanianDateTimeParts,
} from '../../utils/roDateTime.js';
import { getHoursForDate } from '../../utils/workingHours.js';
import { localToUtc } from '../../utils/datetime.js';
import { BOOKING_WAIT, getBookingWait, interpretNumericFreeText } from '../../services/bookingWaitState.js';

/** @typedef {import('../../db/businessService.js').Business} Business */
/** @typedef {import('../../schemas/extractionResult.js').ExtractionResult} ExtractionResult */

/**
 * @param {Business} business
 * @param {string | null} dateKey
 */
export function dayHoursForDate(business, dateKey = null) {
  const tz = business.timezone || 'Europe/Bucharest';
  const when = dateKey && /^\d{4}-\d{2}-\d{2}$/.test(dateKey)
    ? localToUtc(dateKey, '12:00', tz)
    : new Date();
  return getHoursForDate(business, when).dayHours;
}

/**
 * Isolated "17"/"18" without "data de"/"pe 17", while waiting for time → HH:mm.
 *
 * @param {Object} params
 * @param {string} params.text
 * @param {string | null} params.wait
 * @param {string} params.timezone
 * @param {string | null} [params.pendingDateKey]
 * @param {{ open?: string, close?: string } | null} [params.dayHours]
 * @returns {ExtractionResult | null}
 */
export function extractIsolatedTime({
  text,
  wait,
  timezone,
  pendingDateKey = null,
  dayHours = null,
}) {
  const n = String(text ?? '').toLowerCase();
  if (/\b(data(?:\s+de)?|ziua(?:\s+de)?|pe)\s+\d{1,2}\b/.test(n)) return null;
  if (wait !== BOOKING_WAIT.TIME && wait !== BOOKING_WAIT.CONFIRMATION) return null;

  const numeric = interpretNumericFreeText({ text, wait, timezone, pendingDateKey });
  if (numeric.kind !== 'time' || !numeric.timeHHmm) return null;

  return parseExtractionResult({
    intent: 'change_time',
    extracted_service: null,
    extracted_date: null,
    extracted_time: coerceHHmmToOpenHours(numeric.timeHHmm, dayHours),
    is_ambiguous: false,
    ambiguity_reason: null,
    confidence: 1,
  });
}

/**
 * Apply Admin hours to an LLM/parser clock value ("la 5" → 17:00 when 05:00 is closed).
 *
 * @param {ExtractionResult} parsed
 * @param {{ open?: string, close?: string } | null} dayHours
 * @returns {ExtractionResult}
 */
export function applyBusinessHoursToExtraction(parsed, dayHours) {
  if (!parsed?.extracted_time) return parsed;
  const next = coerceHHmmToOpenHours(parsed.extracted_time, dayHours);
  if (next === parsed.extracted_time) return parsed;
  return { ...parsed, extracted_time: next };
}

/**
 * Layer 1 public API — structured JSON only.
 *
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.textBody
 * @param {import('../../db/conversationStateService.js').ConversationState} params.convState
 * @param {import('../../db/draftBookingService.js').DraftBooking | null} [params.activeDraft]
 * @param {string | null} [params.requestId]
 * @returns {Promise<ExtractionResult | null>}
 */
export async function extractBookingEntities({
  business,
  textBody,
  convState,
  activeDraft = null,
  requestId = null,
}) {
  const timezone = business.timezone || 'Europe/Bucharest';
  const wait = getBookingWait(convState);
  const ctx = convState?.context_data || {};
  const pendingDate = typeof ctx.pending_date_text === 'string' ? ctx.pending_date_text : null;
  const draftDate = ctx.draft_booking && typeof ctx.draft_booking === 'object'
    ? /** @type {{ date?: string | null }} */ (ctx.draft_booking).date
    : null;
  const dateKey = pendingDate || draftDate || null;
  const dayHours = dayHoursForDate(business, dateKey);

  const isolated = extractIsolatedTime({
    text: textBody,
    wait,
    timezone,
    pendingDateKey: dateKey,
    dayHours,
  });
  if (isolated) return isolated;

  const parsed = await extractEntitiesFromLlm({
    business,
    textBody,
    convState,
    activeDraft,
    requestId,
  });
  if (!parsed) {
    const fallback = parseRomanianDateTimeParts(textBody, timezone, new Date(), { dayHours });
    if (!fallback.dateKey && !fallback.timeHHmm) return null;
    return parseExtractionResult({
      intent: 'book',
      extracted_service: null,
      extracted_date: fallback.dateKey,
      extracted_time: coerceHHmmToOpenHours(fallback.timeHHmm, dayHours),
      is_ambiguous: false,
      ambiguity_reason: null,
      confidence: 0.7,
    });
  }

  return applyBusinessHoursToExtraction(parsed, dayHours);
}

export { extractEntitiesFromLlm as extractEntities };
export { parseExtractionResult } from '../../schemas/extractionResult.js';
