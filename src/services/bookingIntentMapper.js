/**
 * Layer 1 — booking intent classification (Gemini) → ExtractionResult mapping.
 */

import { getBookingConfig } from '../utils/datetime.js';
import { parseRomanianDateTimeParts, coerceHHmmToOpenHours, resolveRelativeDate } from '../utils/roDateTime.js';
import { getHoursForDate } from '../utils/workingHours.js';
import { localToUtc } from '../utils/datetime.js';
import { parseExtractionResult } from '../schemas/extractionResult.js';
import { buildServicesCatalog } from './aiContextLoader.js';
import { detectTimeWindowFromText } from './intentTriageService.js';
import { buildBookingIntentFewShotBlock } from './bookingIntentFewShot.js';
import { BOOKING_INTENT_TYPES } from '../schemas/extractionResult.js';

/** @typedef {typeof BOOKING_INTENT_TYPES[number]} BookingIntentType */

/**
 * @typedef {Object} BookingIntentClassification
 * @property {BookingIntentType} intent
 * @property {string | null} service_mentioned
 * @property {string | null} existing_appointment_time
 * @property {string | null} requested_new_time
 * @property {boolean} sensitive_topic
 * @property {boolean} contains_complaint_or_feedback
 * @property {'high' | 'low'} confidence
 */

export { BOOKING_INTENT_TYPES };

/** Gemini structured output for intent classification only. */
export const BOOKING_INTENT_JSON_SCHEMA = {
  name: 'booking_intent_classification',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'intent',
      'service_mentioned',
      'existing_appointment_time',
      'requested_new_time',
      'sensitive_topic',
      'contains_complaint_or_feedback',
      'confidence',
    ],
    properties: {
      intent: { type: 'string', enum: [...BOOKING_INTENT_TYPES] },
      service_mentioned: { type: ['string', 'null'] },
      existing_appointment_time: { type: ['string', 'null'] },
      requested_new_time: { type: ['string', 'null'] },
      sensitive_topic: { type: 'boolean' },
      contains_complaint_or_feedback: { type: 'boolean' },
      confidence: { type: 'string', enum: ['high', 'low'] },
    },
  },
};

function emptyToNull(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

/**
 * @param {unknown} raw
 * @returns {BookingIntentClassification | null}
 */
export function parseBookingIntentClassification(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const row = /** @type {Record<string, unknown>} */ (raw);
  const intent = BOOKING_INTENT_TYPES.includes(/** @type {BookingIntentType} */ (row.intent))
    ? row.intent
    : null;
  if (!intent) return null;
  const confidence = row.confidence === 'high' || row.confidence === 'low'
    ? row.confidence
    : 'low';
  return {
    intent,
    service_mentioned: emptyToNull(row.service_mentioned),
    existing_appointment_time: emptyToNull(row.existing_appointment_time),
    requested_new_time: emptyToNull(row.requested_new_time),
    sensitive_topic: row.sensitive_topic === true,
    contains_complaint_or_feedback: row.contains_complaint_or_feedback === true,
    confidence,
  };
}

function mapQuestionToExtractionIntent(text) {
  const n = String(text ?? '').toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const hours = (
    /\b(program|orar|orele|deschid|deschis|deschisi|inchid|inchis|inchisi|cand sunteti|hours|opening)\b/.test(n)
    || /\b(la ce ora|pana la ce ora|cat timp)\b/.test(n)
  ) && !/\bprogramar/.test(n);
  const prices = /\b(pret|preturi|cost|tarif|price|prices)\b/.test(n);
  if (hours && prices) return 'services';
  if (hours) return 'hours';
  if (prices) return 'services';
  return 'missing_info';
}

/**
 * Parse a raw time fragment deterministically (never via LLM date math).
 *
 * @param {string | null} raw
 * @param {string} timezone
 * @param {import('../db/businessService.js').Business} business
 * @param {Date} [referenceDate]
 */
function parseRawTimeFragment(raw, timezone, business, referenceDate = new Date()) {
  if (!raw) return { dateKey: null, timeHHmm: null };
  const parts = resolveRelativeDate(raw, timezone, referenceDate);
  const dateHint = parts.dateKey;
  const when = dateHint
    ? localToUtc(dateHint, '12:00', timezone)
    : referenceDate;
  const dayHours = getHoursForDate(business, when).dayHours;
  const timeHHmm = parts.timeHHmm
    ? coerceHHmmToOpenHours(parts.timeHHmm, dayHours)
    : null;
  return { dateKey: dateHint, timeHHmm };
}

/**
 * Build Gemini system prompt for two-step intent + service classification.
 *
 * @param {import('./aiContextLoader.js').AiTenantContext} ctx
 */
export function buildBookingIntentSystemPrompt(ctx) {
  const business = ctx.snapshot;
  const serviceList = buildServicesCatalog(business).trim()
    || getBookingConfig(business).services.map((s) => `- ${s.name}`).join('\n')
    || '(gol)';

  return [
    'Ești un modul de înțelegere a limbajului natural pentru un sistem de programări',
    'prin WhatsApp. Primești mesajul brut al unui client și trebuie să-l transformi',
    'în JSON structurat, FĂRĂ să inventezi informații care nu sunt în mesaj.',
    '',
    'Lista de servicii disponibile pentru acest business:',
    serviceList,
    '',
    'Analizează mesajul clientului în doi pași:',
    '',
    'Acest prompt este folosit pentru mai multe tipuri de business (barber shop,',
    'frizerie, salon cosmetică, salon masaj, salon bronzat, epilat, manichiură/',
    'pedichiură, clinică stomatologică, stație ITP etc.). Nu presupune niciodată',
    'că e vorba de un salon — limbajul clientului variază de la o verticală la',
    'alta, iar lista de servicii e cea care dă contextul real.',
    '',
    'PAS 1 — Clasifică intenția (câmpul "intent"), una dintre:',
    '- "general_booking_request": clientul vrea să facă o programare dar NU a',
    '  specificat un serviciu anume din lista de mai sus (ex: "vreau o programare",',
    '  "doresc sa fac o programare la dvs", "aveți liber mâine?", "as vrea sa vin',
    '  cu masina", "cand ma puteti baga in programare")',
    '- "specific_service_request": clientul a menționat explicit un serviciu sau o',
    '  variantă foarte apropiată de un serviciu care apare EXACT în lista de mai',
    '  sus (ex: "vreau tuns", "as vrea o programare pentru vopsit", "vreau sa fac',
    '  ITP", "am nevoie de o detartrare", "vreau epilat la picioare") — indiferent',
    '  de verticala business-ului. Dacă lista are un singur serviciu (ex. doar',
    '  "ITP auto"), orice mesaj care numește acel serviciu, chiar generic',
    '  ("vreau ITP", "am nevoie de verificare tehnica"), se clasifică aici.',
    '- "reschedule_request": clientul face referire la o programare EXISTENTĂ (menționează',
    '  o dată/oră deja stabilită) și cere explicit mutarea ei la altă oră/dată (ex: "am si',
    '  eu o programare vineri la 9:30, se poate sa o mutam la ora 15?", "pot sa imi mut',
    '  programarea de maine mai tarziu?"). Diferă de "general_booking_request": aici',
    '  clientul NU cere o programare nouă, ci schimbarea uneia deja făcută.',
    '- "cancellation": clientul vrea EXPLICIT să anuleze o programare existentă (folosește',
    '  cuvântul "anulez"/"anulati" sau echivalent clar)',
    '- "unable_to_attend": clientul spune că nu poate ajunge la programare, FĂRĂ să',
    '  folosească explicit cuvântul "anulare" sau "reprogramare" (ex: "nu mai pot sa',
    '  ajung", "nu cred ca pot veni maine", "nu am cum sa vin la ora aia").',
    '- "running_late": clientul anunță o întârziere la o programare existentă, fără să',
    '  ceară mutarea ei la altă oră (ex: "pot sa intarzii 5 minute?", "voi ajunge cu',
    '  putin mai tarziu", "intarzii 10 min, e ok?")',
    '- "question": întrebare generală (program, preț, locație, proceduri) fără intenție',
    '  de programare. Setează "sensitive_topic": true dacă întrebarea ține de durere,',
    '  siguranță medicală, reacții adverse sau subiecte unde un răspuns generic ar fi riscant.',
    '- "off_topic": mesaj clar fără legătură cu serviciile business-ului, absurd sau glumeț',
    '- "special_request": clientul cere o excepție invocând o autorizare pe care AI-ul NU',
    '  o poate verifica (ex: "am vorbit cu patronul sa ma bagi la ora 9 desi stiu ca e ocupat")',
    '- "chitchat": small talk, saluturi fără intenție de programare, mulțumiri, confirmări',
    '  scurte (ex: "ok multumesc", "este in regula"). Setează "contains_complaint_or_feedback"',
    '  true dacă mesajul conține nemulțumire sau feedback negativ.',
    '- "other": orice altceva care nu se încadrează clar în categoriile de mai sus',
    '',
    'PAS 2 — Completează câmpurile suplimentare:',
    '- "service_mentioned": dacă intent = "specific_service_request", numele exact din',
    '  listă; altfel null.',
    '- "existing_appointment_time": dacă intent = "reschedule_request" sau',
    '  "cancellation", data/ora programării existente menționate de client — extrasă',
    '  ca TEXT BRUT, exact cum a scris clientul (ex: "vineri", "luni viitoare"), nu',
    '  calculată/interpretată de tine. Aplică-se identic pentru ambele intenții.',
    '- "requested_new_time": dacă intent = "reschedule_request", noua oră/dată cerută',
    '  de client, extrasă tot ca TEXT BRUT (ex: "ora 15", "sambata"), sau null dacă',
    '  nu a fost specificată.',
    '',
    'REGULĂ CRITICĂ PENTRU DATE ȘI ZILE ALE SĂPTĂMÂNII: NU calcula tu însuți ce',
    'dată calendaristică reprezintă o zi menționată relativ (ex. "luni", "vineri',
    'viitoare", "sambata"). NU ai informația sigură despre ce dată este azi din',
    'perspectiva sistemului. Extrage doar TEXTUL BRUT exact cum l-a scris clientul,',
    'în câmpurile "existing_appointment_time" și "requested_new_time" — conversia',
    'în dată absolută se face separat, determinist, de backend.',
    '',
    'REGULĂ CRITICĂ: nu seta "specific_service_request" doar pentru că mesajul',
    'conține cuvântul "programare", "salon", "clinica" sau numele business-ului.',
    'Aceste cuvinte NU sunt nume de servicii. Un mesaj care spune doar că vrea o',
    'programare, fără să numească un serviciu concret din listă, este ÎNTOTDEAUNA',
    '"general_booking_request", nu o încercare eșuată de match.',
    '',
    'Nu inventa un serviciu care nu apare, cuvânt cu cuvânt sau ca sinonim clar, în',
    'lista de mai sus.',
    '',
    buildBookingIntentFewShotBlock(),
    '',
    'Răspunde DOAR cu JSON valid, fără text suplimentar, fără markdown:',
    '{',
    '  "intent": "general_booking_request" | "specific_service_request" | "reschedule_request" | "cancellation" | "unable_to_attend" | "running_late" | "question" | "off_topic" | "special_request" | "chitchat" | "other",',
    '  "service_mentioned": "<string din lista de servicii>" | null,',
    '  "existing_appointment_time": "<string, ex: vineri 9:30>" | null,',
    '  "requested_new_time": "<string, ex: ora 15>" | null,',
    '  "sensitive_topic": true | false,',
    '  "contains_complaint_or_feedback": true | false,',
    '  "confidence": "high" | "low"',
    '}',
  ].join('\n');
}

/**
 * @param {BookingIntentClassification} classification
 * @param {string} textBody
 * @param {string} timezone
 * @param {import('../db/businessService.js').Business} business
 * @returns {import('../schemas/extractionResult.js').ExtractionResult | null}
 */
export function mapBookingIntentToExtraction(classification, textBody, timezone, business) {
  if (!classification) return null;

  const referenceDate = new Date();
  let intent = 'book';
  let extracted_service = null;
  let extracted_date = null;
  let extracted_time = null;
  let timeWindow = null;
  let numericConfidence = classification.confidence === 'high' ? 0.9 : 0.4;
  let existing_appointment_date = null;
  let existing_appointment_time_hhmm = null;
  let requested_reschedule_date = null;
  let requested_reschedule_time_hhmm = null;
  let sensitive_topic = classification.sensitive_topic;
  let contains_complaint_or_feedback = classification.contains_complaint_or_feedback;

  if (classification.intent === 'reschedule_request') {
    intent = 'reschedule';
    const existing = parseRawTimeFragment(
      classification.existing_appointment_time,
      timezone,
      business,
      referenceDate,
    );
    const requested = parseRawTimeFragment(
      classification.requested_new_time,
      timezone,
      business,
      referenceDate,
    );
    existing_appointment_date = existing.dateKey;
    existing_appointment_time_hhmm = existing.timeHHmm;
    requested_reschedule_date = requested.dateKey;
    requested_reschedule_time_hhmm = requested.timeHHmm;
  } else if (classification.intent === 'cancellation') {
    intent = 'cancel';
    const existing = parseRawTimeFragment(
      classification.existing_appointment_time,
      timezone,
      business,
      referenceDate,
    );
    existing_appointment_date = existing.dateKey;
    existing_appointment_time_hhmm = existing.timeHHmm;
  } else if (classification.intent === 'question') {
    intent = mapQuestionToExtractionIntent(textBody);
  } else if (classification.intent === 'off_topic') {
    intent = 'off_topic';
  } else if (classification.intent === 'unable_to_attend') {
    intent = 'unknown';
  } else if (classification.intent === 'running_late') {
    intent = 'unknown';
  } else if (classification.intent === 'special_request') {
    intent = 'unknown';
  } else if (classification.intent === 'chitchat') {
    intent = 'off_topic';
  } else if (classification.intent === 'other') {
    intent = 'book';
  } else if (classification.intent === 'specific_service_request') {
    if (classification.confidence === 'high' && classification.service_mentioned) {
      intent = 'select_service';
      extracted_service = classification.service_mentioned;
    } else {
      intent = 'book';
      extracted_service = null;
      numericConfidence = 0.4;
    }
    const uttered = parseRomanianDateTimeParts(String(textBody || ''), timezone, referenceDate);
    extracted_date = uttered.dateKey;
    extracted_time = uttered.timeHHmm
      ? coerceHHmmToOpenHours(
        uttered.timeHHmm,
        getHoursForDate(
          business,
          uttered.dateKey ? localToUtc(uttered.dateKey, '12:00', timezone) : referenceDate,
        ).dayHours,
      )
      : null;
    timeWindow = extracted_time ? null : detectTimeWindowFromText(textBody);
  } else {
    intent = 'book';
    extracted_service = null;
    const uttered = parseRomanianDateTimeParts(String(textBody || ''), timezone, referenceDate);
    extracted_date = uttered.dateKey;
    extracted_time = uttered.timeHHmm
      ? coerceHHmmToOpenHours(
        uttered.timeHHmm,
        getHoursForDate(
          business,
          uttered.dateKey ? localToUtc(uttered.dateKey, '12:00', timezone) : referenceDate,
        ).dayHours,
      )
      : null;
    timeWindow = extracted_time ? null : detectTimeWindowFromText(textBody);
  }

  return parseExtractionResult({
    intent,
    extracted_service,
    extracted_date,
    extracted_time,
    time_window: timeWindow,
    is_ambiguous: false,
    ambiguity_reason: null,
    confidence: numericConfidence,
    booking_intent: classification.intent,
    service_confidence: classification.confidence,
    modify_target_raw: classification.existing_appointment_time,
    modify_new_raw: classification.requested_new_time,
    existing_appointment_date,
    existing_appointment_time_hhmm,
    requested_reschedule_date,
    requested_reschedule_time_hhmm,
    sensitive_topic,
    contains_complaint_or_feedback,
  });
}

/**
 * Map booking_intent classification to TurnExtract.action when NLU path runs.
 *
 * @param {import('../schemas/extractionResult.js').ExtractionResult | null | undefined} extraction
 * @param {boolean} isPendingHold
 * @returns {string | null}
 */
export function turnActionForBookingIntent(extraction, isPendingHold = false) {
  if (!extraction?.booking_intent) return null;
  switch (extraction.booking_intent) {
    case 'reschedule_request':
      return 'reschedule';
    case 'cancellation':
      return isPendingHold ? 'cancel_pending' : 'cancel';
    case 'unable_to_attend':
      return 'unable_to_attend';
    case 'running_late':
      return 'running_late';
    case 'special_request':
      return 'special_request';
    case 'chitchat':
      return 'chitchat';
    case 'off_topic':
      return 'off_topic';
    case 'question':
      return extraction.sensitive_topic ? 'sensitive_question' : null;
    case 'general_booking_request':
      return 'book';
    case 'other':
      return 'book';
    default:
      return null;
  }
}

/**
 * Whether backend should skip unknown_service and show the service list instead.
 *
 * @param {import('../schemas/extractionResult.js').ExtractionResult | null | undefined} extraction
 * @returns {boolean}
 */
export function shouldOfferServiceListNotUnknown(extraction) {
  if (!extraction?.booking_intent) return false;
  if (extraction.booking_intent === 'reschedule_request') return false;
  if (extraction.booking_intent === 'cancellation') return false;
  if (extraction.booking_intent === 'unable_to_attend') return false;
  if (extraction.booking_intent === 'running_late') return false;
  if (extraction.booking_intent === 'special_request') return false;
  if (extraction.booking_intent === 'chitchat') return false;
  if (extraction.booking_intent === 'off_topic') return false;
  if (extraction.booking_intent === 'general_booking_request') return true;
  if (extraction.booking_intent === 'other') return true;
  if (extraction.booking_intent === 'question') return !extraction.sensitive_topic;
  if (
    extraction.booking_intent === 'specific_service_request'
    && extraction.service_confidence === 'low'
  ) {
    return true;
  }
  return false;
}

/**
 * Whether unknown_service is allowed (explicit high-confidence service miss).
 *
 * @param {import('../schemas/extractionResult.js').ExtractionResult | null | undefined} extraction
 * @returns {boolean}
 */
export function allowUnknownServiceError(extraction) {
  return extraction?.booking_intent === 'specific_service_request'
    && extraction?.service_confidence === 'high';
}

export { resolveRelativeDate };
