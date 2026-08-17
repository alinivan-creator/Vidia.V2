/**
 * Layer 1 — structured NLP extractor.
 * The model never talks to the client. It only returns ExtractionResult JSON.
 */

import { EXTRACTION_JSON_SCHEMA, parseExtractionResult } from '../schemas/extractionResult.js';
import { completeTenantChat } from './aiContextLoader.js';
import { getBookingWait } from './bookingWaitState.js';
import {
  formatDateKey,
  formatTime,
  formatBusinessHoursText,
  getConfiguredBusinessHours,
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
 * Parser-only system prompt. Not the conversational Admin prompt.
 *
 * @param {import('./aiContextLoader.js').AiTenantContext} ctx
 * @param {Object} session
 */
function buildParserSystemPrompt(ctx, session) {
  const business = ctx.snapshot;
  const hours = getConfiguredBusinessHours(business);
  const catalog = getBookingConfig(business).services.map((s) => {
    const dur = s.duration_minutes ? `${s.duration_minutes} min` : '';
    const price = s.price_ron != null && s.price_ron !== '' ? `${s.price_ron} LEI` : '';
    const meta = [dur, price].filter(Boolean).join(', ');
    return meta ? `${s.name} (${meta})` : s.name;
  }).slice(0, 20);
  const clock = session.clock;
  const facts = typeof business.booking_settings?.ai_facts === 'string'
    ? business.booking_settings.ai_facts.trim()
    : '';
  const info = business.booking_settings?.business_info;
  const infoLines = [];
  if (info && typeof info === 'object') {
    for (const [k, v] of Object.entries(info)) {
      if (v == null || v === '') continue;
      if (typeof v === 'object') infoLines.push(`- ${k}: ${JSON.stringify(v)}`);
      else infoLines.push(`- ${k}: ${String(v)}`);
    }
  }

  return [
    'Ești un PARSER NLP. NU vorbești cu clientul. NU confirma programări. NU evalua disponibilitatea.',
    'Returnează DOAR JSON-ul din schema extraction_result.',
    '',
    `Afacere: ${business.name} (business_id=${ctx.businessId})`,
    `CEAS SISTEM (${clock.timezone}): ${clock.human}.`,
    `Referință mașină: ${clock.weekday}, ${clock.date} ${clock.time} (ISO ${clock.iso}).`,
    '',
    'PROGRAM DE LUCRU (doar context — nu decide dacă e liber):',
    hours ? formatBusinessHoursText(hours) : 'nesetat în Admin',
    '',
    `Catalog servicii (doar acestea există): ${catalog.join('; ') || '(gol)'}`,
    '',
    'DATE AFACERE DIN BAZĂ (RAG — nu inventa în afara lor):',
    infoLines.length ? infoLines.join('\n') : '(niciun business_info)',
    facts ? `FACTS ADMIN:\n${facts}` : 'FACTS ADMIN: (gol)',
    '',
    `session.current_state: ${session.current_state}`,
    `session.booking_wait: ${session.booking_wait || 'null'}`,
    `session.draft_booking: ${JSON.stringify(session.draft_booking)}`,
    `session.pending_date: ${session.pending_date || 'null'}`,
    `session.pending_time: ${session.pending_time || 'null'}`,
    '',
    'Ultimele 3 mesaje:',
    session.recent_turns.length
      ? session.recent_turns.map((t) => `- ${t.role}: ${t.text}`).join('\n')
      : '(niciun istoric)',
    '',
    'Reguli stricte:',
    '- extracted_date = YYYY-MM-DD. extracted_time = HH:mm 24h. Folosește CEAS SISTEM ca ancoră absolută.',
    '- Transformă ORICE expresie relativă în YYYY-MM-DD / HH:mm:',
    '  „mâine”, „peste 3 zile”, „joi săptămâna viitoare”, „de azi într-o săptămână”, „peste 2 ore”.',
    '  Ex: dacă azi e 2026-08-17, „mâine” → 2026-08-18; „peste 3 zile” → 2026-08-20.',
    '- „la 9 dimineața” → 09:00. „la 5 seara” / „5 după-amiaza” → 17:00 (nu 05:00).',
    '- Verifică PROGRAM DE LUCRU doar pentru a alege 05:00 vs 17:00; NU decide dacă slotul e liber.',
    '- time_window: morning | afternoon | evening | null când nu există oră exactă („mai pe seară”).',
    '- O cifră izolată (ex. „18”) FĂRĂ „data de”/„pe 17”: dacă booking_wait=waiting_for_time sau waiting_for_confirmation → extracted_time (nu dată).',
    '- Corecții „nu 17, 18”: waiting_for_time / confirmation → change_time 18:00 (păstrează data). waiting_for_date → change_date. Altfel is_ambiguous=true (NU ghici).',
    '- intent cancel / reschedule: extrage data/ora programării MENȚIONATE („anulează azi la 11” → date+time ale programării de anulat).',
    '- intent list_appointments: programări DEJA existente. NU e book.',
    '- intent book: programare NOUĂ SAU disponibilitate („aveți liber?”).',
    '- intent hours / services / contact / menu / off_topic / missing_info — ca înainte.',
    '- Nu inventa servicii în afara catalogului. Dacă nu e clar, extracted_service=null.',
    '- confidence 0–1. is_ambiguous true ⇒ nu completa extracted_date și extracted_time simultan din aceeași cifră.',
  ].join('\n');
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
    maxTokens: 280,
    requestId,
    buildExtraSystem: (ctx) => buildParserSystemPrompt(ctx, session),
    userContent: String(textBody ?? '').slice(0, 500),
  };

  let payload = await completeTenantChat({
    ...chatArgs,
    jsonSchema: EXTRACTION_JSON_SCHEMA,
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

  if (raw && typeof raw === 'object') {
    const row = /** @type {Record<string, unknown>} */ (raw);
    const dateHint = (typeof row.extracted_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.extracted_date))
      ? row.extracted_date
      : session.pending_date;
    const when = dateHint
      ? localToUtc(dateHint, '12:00', timezone)
      : new Date();
    const dayHours = getHoursForDate(business, when).dayHours;
    if (row.extracted_time && !/^\d{2}:\d{2}$/.test(String(row.extracted_time))) {
      const t = parseRomanianDateTimeParts(`la ${row.extracted_time}`, timezone, new Date(), { dayHours });
      row.extracted_time = t.timeHHmm;
    }
    if (typeof row.extracted_time === 'string') {
      row.extracted_time = coerceHHmmToOpenHours(row.extracted_time, dayHours);
    }
    if (row.extracted_date && !/^\d{4}-\d{2}-\d{2}$/.test(String(row.extracted_date))) {
      const d = parseRomanianDateTimeParts(String(row.extracted_date), timezone);
      row.extracted_date = d.dateKey;
    }
  }

  return parseExtractionResult(raw);
}
