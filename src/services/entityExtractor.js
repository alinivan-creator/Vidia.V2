/**
 * Layer 1 — structured NLP extractor.
 * The model never talks to the client. It returns booking intent JSON, mapped to ExtractionResult.
 */

import {
  BOOKING_INTENT_JSON_SCHEMA,
  buildBookingIntentSystemPrompt,
  mapBookingIntentToExtraction,
  parseBookingIntentClassification,
} from './bookingIntentMapper.js';
import {
  completeTenantChat,
} from './aiContextLoader.js';
import { getBookingWait } from './bookingWaitState.js';
import {
  formatDateKey,
  formatTime,
  getBookingConfig,
  localToUtc,
} from '../utils/datetime.js';
import { parseRomanianDateTimeParts, coerceHHmmToOpenHours } from '../utils/roDateTime.js';
import { getHoursForDate } from '../utils/workingHours.js';

/** @typedef {import('../db/businessService.js').Business} Business */
/** @typedef {import('../schemas/extractionResult.js').ExtractionResult} ExtractionResult */

const MONTHS_RO_LONG = [
  'ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie',
  'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie',
];

function weekdayRo(date, timezone) {
  return new Intl.DateTimeFormat('ro-RO', { weekday: 'long', timeZone: timezone }).format(date);
}

/**
 * @param {string} timezone
 * @param {Date} [now]
 */
export function buildSystemClock(timezone, now = new Date()) {
  const date = formatDateKey(now, timezone);
  const time = formatTime(now, timezone);
  const [year, month, day] = date.split('-').map(Number);
  const weekday = weekdayRo(now, timezone);
  const weekdayCap = weekday ? `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}` : '';
  const monthLabel = MONTHS_RO_LONG[month - 1] || '';
  const human =
    `Astăzi este ${weekdayCap}, ${day} ${monthLabel} ${year}, ora ${time}`;

  return {
    timezone,
    iso: now.toISOString(),
    date,
    time,
    weekday,
    year,
    month,
    day,
    human,
  };
}

function lastTurns(convState, limit = 3) {
  const turns = Array.isArray(convState?.context_data?.recent_turns)
    ? convState.context_data.recent_turns
    : [];
  return turns.slice(-limit).map((t) => ({
    role: t?.role === 'assistant' ? 'assistant' : 'user',
    text: String(t?.text ?? '').slice(0, 240),
  }));
}

function draftSnapshot(activeDraft) {
  if (!activeDraft) return null;
  const service = activeDraft.selected_service && typeof activeDraft.selected_service === 'object'
    ? /** @type {{ name?: string, id?: string }} */ (activeDraft.selected_service)
    : null;
  return {
    state: activeDraft.state,
    service_id: service?.id ?? null,
    service_name: service?.name ?? null,
    slot_start: activeDraft.selected_slot_start ?? null,
    slot_end: activeDraft.selected_slot_end ?? null,
  };
}

/**
 * Apply deterministic date/time overrides after classification mapping.
 *
 * @param {ExtractionResult} parsed
 * @param {string} textBody
 * @param {string} timezone
 * @param {Business} business
 * @param {string | null} pendingDate
 */
function applyDeterministicDateTime(parsed, textBody, timezone, business, pendingDate) {
  const uttered = parseRomanianDateTimeParts(String(textBody || ''), timezone, new Date());
  const next = { ...parsed };
  if (uttered.dateKey) next.extracted_date = uttered.dateKey;
  if (uttered.timeHHmm) next.extracted_time = uttered.timeHHmm;

  const dateHint = next.extracted_date || pendingDate;
  const when = dateHint
    ? localToUtc(dateHint, '12:00', timezone)
    : new Date();
  const dayHours = getHoursForDate(business, when).dayHours;
  if (next.extracted_time && !/^\d{2}:\d{2}$/.test(String(next.extracted_time))) {
    const t = parseRomanianDateTimeParts(`la ${next.extracted_time}`, timezone, new Date(), { dayHours });
    next.extracted_time = t.timeHHmm;
  }
  if (typeof next.extracted_time === 'string') {
    next.extracted_time = coerceHHmmToOpenHours(next.extracted_time, dayHours);
  }
  if (next.extracted_date && !/^\d{4}-\d{2}-\d{2}$/.test(String(next.extracted_date))) {
    const d = parseRomanianDateTimeParts(String(next.extracted_date), timezone);
    next.extracted_date = d.dateKey;
  }
  if (next.extracted_time) next.time_window = null;
  return next;
}

/**
 * Layer 1 entry: structured extraction for one WhatsApp turn.
 *
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.textBody
 * @param {import('../db/conversationStateService.js').ConversationState} params.convState
 * @param {import('../db/draftBookingService.js').DraftBooking | null} [params.activeDraft]
 * @param {string | null} [params.requestId]
 * @returns {Promise<ExtractionResult | null>}
 */
export async function extractEntities({
  business,
  textBody,
  convState,
  activeDraft = null,
  requestId = null,
}) {
  if (!business?.id) return null;

  const timezone = business.timezone || 'Europe/Bucharest';
  const clock = buildSystemClock(timezone);
  const ctxData = convState?.context_data || {};
  const session = {
    clock,
    current_state: convState?.current_step || 'IDLE',
    booking_wait: getBookingWait(convState),
    draft_booking: draftSnapshot(activeDraft),
    pending_date: typeof ctxData.pending_date_text === 'string' ? ctxData.pending_date_text : null,
    pending_time: typeof ctxData.pending_time_text === 'string' ? ctxData.pending_time_text : null,
    recent_turns: lastTurns(convState, 3),
  };

  const chatArgs = {
    businessId: business.id,
    parserMode: true,
    jsonMode: true,
    temperature: 0,
    maxTokens: 180,
    requestId,
    buildExtraSystem: (ctx) => {
      const base = buildBookingIntentSystemPrompt(ctx);
      return [
        base,
        '',
        `Context sesiune (doar informativ): step=${session.current_state}, booking_wait=${session.booking_wait || 'null'}.`,
        `CEAS SISTEM (${clock.timezone}): ${clock.human}.`,
      ].join('\n');
    },
    userContent: String(textBody ?? '').slice(0, 500),
  };

  let payload = await completeTenantChat({
    ...chatArgs,
    jsonSchema: BOOKING_INTENT_JSON_SCHEMA,
  });
  if ((!payload.ok || !payload.text) && payload.error && String(payload.error).startsWith('http_4')) {
    payload = await completeTenantChat({
      ...chatArgs,
      jsonSchema: null,
    });
  }

  if (!payload.ok || !payload.text) return null;

  let raw;
  try {
    raw = JSON.parse(payload.text.replace(/```json\s*|```/g, '').trim());
  } catch {
    return null;
  }

  const classification = parseBookingIntentClassification(raw);
  if (!classification) return null;

  let parsed = mapBookingIntentToExtraction(
    classification,
    textBody,
    timezone,
    business,
  );
  if (!parsed) return null;

  parsed = applyDeterministicDateTime(
    parsed,
    textBody,
    timezone,
    business,
    session.pending_date,
  );

  return parsed;
}
