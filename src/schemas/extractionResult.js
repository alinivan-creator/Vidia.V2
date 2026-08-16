import { z } from 'zod';

export const EXTRACTION_INTENTS = /** @type {const} */ ([
  'book',
  'change_time',
  'change_date',
  'select_service',
  'confirm',
  'cancel',
  'list_appointments',
  'reschedule',
  'hours',
  'services',
  'contact',
  'menu',
  'off_topic',
  'missing_info',
  'unknown',
]);

export const TIME_WINDOWS = /** @type {const} */ (['morning', 'afternoon', 'evening']);

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

export const ExtractionResultSchema = z.object({
  intent: z.enum(EXTRACTION_INTENTS),
  extracted_service: z.string().nullable(),
  extracted_date: ymd.nullable(),
  extracted_time: hhmm.nullable(),
  time_window: z.enum(TIME_WINDOWS).nullable(),
  is_ambiguous: z.boolean(),
  ambiguity_reason: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

/** @typedef {z.infer<typeof ExtractionResultSchema>} ExtractionResult */

/** OpenAI Structured Outputs (strict) — all keys required, no additionalProperties. */
export const EXTRACTION_JSON_SCHEMA = {
  name: 'extraction_result',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'intent',
      'extracted_service',
      'extracted_date',
      'extracted_time',
      'time_window',
      'is_ambiguous',
      'ambiguity_reason',
      'confidence',
    ],
    properties: {
      intent: { type: 'string', enum: [...EXTRACTION_INTENTS] },
      extracted_service: { type: ['string', 'null'] },
      extracted_date: {
        type: ['string', 'null'],
        description: 'Calendar date YYYY-MM-DD, never a clock hour.',
      },
      extracted_time: {
        type: ['string', 'null'],
        description: 'Clock time HH:mm 24h. 5 după-amiaza = 17:00, never 05:00.',
      },
      time_window: {
        type: ['string', 'null'],
        enum: [...TIME_WINDOWS, null],
        description:
          'Soft day-part when no exact clock: morning/afternoon/evening. „Mai pe seară?” → evening + book. Null if exact HH:mm is set.',
      },
      is_ambiguous: { type: 'boolean' },
      ambiguity_reason: { type: ['string', 'null'] },
      confidence: { type: 'number' },
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
 * @returns {ExtractionResult | null}
 */
export function parseExtractionResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const row = /** @type {Record<string, unknown>} */ (raw);
  const date = emptyToNull(row.extracted_date);
  const time = emptyToNull(row.extracted_time);
  const service = emptyToNull(row.extracted_service);
  const reason = emptyToNull(row.ambiguity_reason);
  const intent = EXTRACTION_INTENTS.includes(/** @type {typeof EXTRACTION_INTENTS[number]} */ (row.intent))
    ? row.intent
    : 'unknown';
  const confidence = Number(row.confidence);
  const windowRaw = emptyToNull(row.time_window);
  const timeWindow = TIME_WINDOWS.includes(/** @type {typeof TIME_WINDOWS[number]} */ (windowRaw))
    ? windowRaw
    : null;
  const candidate = {
    intent,
    extracted_service: service,
    extracted_date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    extracted_time: time && /^\d{2}:\d{2}$/.test(time) ? time : null,
    time_window: time && /^\d{2}:\d{2}$/.test(time) ? null : timeWindow,
    is_ambiguous: Boolean(row.is_ambiguous),
    ambiguity_reason: reason,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
  };
  const parsed = ExtractionResultSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
