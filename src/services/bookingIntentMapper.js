/**
 * Layer 1 — booking intent classification (Gemini) → ExtractionResult mapping.
 */

import { getBookingConfig } from '../utils/datetime.js';
import { parseRomanianDateTimeParts, coerceHHmmToOpenHours } from '../utils/roDateTime.js';
import { getHoursForDate } from '../utils/workingHours.js';
import { localToUtc } from '../utils/datetime.js';
import { parseExtractionResult } from '../schemas/extractionResult.js';
import { buildServicesCatalog } from './aiContextLoader.js';
import { detectTimeWindowFromText } from './intentTriageService.js';

export const BOOKING_INTENT_TYPES = /** @type {const} */ ([
  'general_booking_request',
  'specific_service_request',
  'cancellation',
  'question',
  'other',
]);

/** @typedef {typeof BOOKING_INTENT_TYPES[number]} BookingIntentType */

/** @typedef {{ intent: BookingIntentType, service_mentioned: string | null, confidence: 'high' | 'low' }} BookingIntentClassification */

/** Gemini structured output for intent classification only. */
export const BOOKING_INTENT_JSON_SCHEMA = {
  name: 'booking_intent_classification',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['intent', 'service_mentioned', 'confidence'],
    properties: {
      intent: { type: 'string', enum: [...BOOKING_INTENT_TYPES] },
      service_mentioned: { type: ['string', 'null'] },
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
    '- "cancellation": clientul vrea să anuleze o programare existentă',
    '- "question": întrebare generală (program, preț, locație) fără intenție de',
    '  programare',
    '- "other": orice altceva',
    '',
    'PAS 2 — Completează "service_mentioned":',
    '- Dacă intent = "specific_service_request": numele serviciului din listă care',
    '  se potrivește cel mai bine (string exact din listă)',
    '- Dacă intent = "general_booking_request", "cancellation", "question" sau',
    '  "other": null',
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
    'Răspunde DOAR cu JSON valid, fără text suplimentar, fără markdown:',
    '{',
    '  "intent": "general_booking_request" | "specific_service_request" | "cancellation" | "question" | "other",',
    '  "service_mentioned": "<string din lista de servicii>" | null,',
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

  const uttered = parseRomanianDateTimeParts(String(textBody || ''), timezone, new Date());
  const dateHint = uttered.dateKey;
  const when = dateHint
    ? localToUtc(dateHint, '12:00', timezone)
    : new Date();
  const dayHours = getHoursForDate(business, when).dayHours;
  const timeHHmm = uttered.timeHHmm
    ? coerceHHmmToOpenHours(uttered.timeHHmm, dayHours)
    : null;
  const timeWindow = timeHHmm ? null : detectTimeWindowFromText(textBody);

  let intent = 'book';
  let extracted_service = null;
  let numericConfidence = classification.confidence === 'high' ? 0.9 : 0.4;

  if (classification.intent === 'cancellation') {
    intent = 'cancel';
  } else if (classification.intent === 'question') {
    intent = mapQuestionToExtractionIntent(textBody);
  } else if (classification.intent === 'other') {
    intent = 'off_topic';
  } else if (classification.intent === 'specific_service_request') {
    if (classification.confidence === 'high' && classification.service_mentioned) {
      intent = 'select_service';
      extracted_service = classification.service_mentioned;
    } else {
      intent = 'book';
      extracted_service = null;
      numericConfidence = 0.4;
    }
  } else {
    intent = 'book';
    extracted_service = null;
  }

  return parseExtractionResult({
    intent,
    extracted_service,
    extracted_date: dateHint,
    extracted_time: timeHHmm,
    time_window: timeWindow,
    is_ambiguous: false,
    ambiguity_reason: null,
    confidence: numericConfidence,
    booking_intent: classification.intent,
    service_confidence: classification.confidence,
  });
}

/**
 * Whether backend should skip unknown_service and show the service list instead.
 *
 * @param {import('../schemas/extractionResult.js').ExtractionResult | null | undefined} extraction
 * @returns {boolean}
 */
export function shouldOfferServiceListNotUnknown(extraction) {
  if (!extraction?.booking_intent) return false;
  if (extraction.booking_intent === 'general_booking_request') return true;
  if (extraction.booking_intent === 'other') return true;
  if (extraction.booking_intent === 'question') return true;
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
