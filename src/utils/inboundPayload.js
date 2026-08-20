/**
 * Inbound WhatsApp payload classification.
 *
 * Twilio delivers a quick-reply tap as ButtonPayload (stable id) + Body/ButtonText
 * (the visible title), and a list pick as ListId + ListTitle. Those ids are the only
 * input allowed to trigger the "stale option" path, because a stale id is the only
 * thing that can actually be stale.
 *
 * A typed sentence must never be read as a tap: WhatsApp can attach a button payload
 * to a message the client wrote (quoted reply to an interactive message, provider
 * echo of the previous tap), and treating that as a click both drops the sentence and
 * fires "Opțiunea dintr-un mesaj mai vechi nu mai e valabilă." on a perfectly good
 * question. Whenever a body looks like free text, the payload is discarded and the
 * text goes to the natural-language path.
 */

import { BOOKING_PREFIXES, MOD_PREFIX } from '../services/flowIds.js';
import { GRID_PREFIX } from './bookingGrid.js';
import {
  looksLikeGratitude,
  looksLikeInFlightRevision,
} from '../services/intentTriageService.js';

/** WhatsApp caps button titles at 20 chars and list row titles at 24. */
const MAX_TITLE_LENGTH = 24;

const ID_PREFIXES = [
  BOOKING_PREFIXES.SERVICE,
  BOOKING_PREFIXES.EMPLOYEE,
  MOD_PREFIX.APPT,
  GRID_PREFIX.DAY,
  'slot_',
  'grid_',
  'mod_',
  'menu_',
  'clarify_',
  'resume_',
];

const ID_EXACT = new Set([
  BOOKING_PREFIXES.CONFIRM,
  BOOKING_PREFIXES.CANCEL,
  BOOKING_PREFIXES.RESUME_YES,
  BOOKING_PREFIXES.RESUME_NO,
  BOOKING_PREFIXES.RESCHEDULE,
  BOOKING_PREFIXES.ANY_EMPLOYEE,
  BOOKING_PREFIXES.CLARIFY_DATE,
  BOOKING_PREFIXES.CLARIFY_TIME,
  MOD_PREFIX.CANCEL_ALL,
  MOD_PREFIX.CONFIRM_CANCEL,
  MOD_PREFIX.ABORT,
  GRID_PREFIX.NEXT,
  GRID_PREFIX.PREV,
]);

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Token shape of an option id we (or the Admin menu config) can emit.
 * Tenant menu ids are arbitrary, so shape — not a fixed list — is the test.
 *
 * @param {string | null | undefined} value
 */
export function looksLikeInteractiveChoiceId(value) {
  const id = String(value ?? '').trim();
  if (!id || id.length > 128) return false;
  if (ID_EXACT.has(id)) return true;
  if (ID_PREFIXES.some((p) => id.startsWith(p))) return true;
  return /^[A-Za-z0-9][A-Za-z0-9_\-:.+]*$/.test(id);
}

/**
 * Text that cannot be a WhatsApp option title — questions, over-cap length, or
 * clear intent sentences. Short list-row titles like "Luni, 24 Aug" must still
 * count as taps when a day_/slot_ payload is present.
 *
 * @param {string | null | undefined} body
 */
export function looksLikeFreeTextBody(body) {
  const typed = String(body ?? '').trim();
  if (!typed) return false;
  if (looksLikeGratitude(typed) || looksLikeInFlightRevision(typed)) return true;
  if (typed.length > MAX_TITLE_LENGTH) return true;
  if (/[?]/.test(typed)) return true;
  const n = normalize(typed);
  // Intent verbs / booking phrases that never appear as our option titles.
  if (/\b(vreau|as vrea|doresc|anulez|anuleaza|anulare|reprogram|modific|schimb|muta|programare|rezervare|programez|programeaza|multumesc|mersi)\b/.test(n)) {
    return true;
  }
  // Four+ tokens is a sentence, not a 24-char list row.
  if (typed.split(/\s+/).filter(Boolean).length >= 4) return true;
  return false;
}

/**
 * True when the body is something the client typed rather than the title of the
 * button that carried the payload.
 *
 * @param {string} typed
 * @param {string} title
 * @param {string} payload
 */
function looksLikeTypedText(typed, title, payload) {
  if (!typed) return false;
  const t = normalize(typed);
  if (!t) return false;
  if (t === normalize(title) || t === normalize(payload)) return false;
  // Twilio echoes the tapped title in Body, so a mismatch against a known title is typing.
  if (title) return true;
  // No ButtonText: our own option ids (day_/slot_/…) still win for short row titles.
  // Intent sentences with a stray payload must not.
  if (looksLikeInteractiveChoiceId(payload)) {
    return looksLikeFreeTextBody(typed);
  }
  return looksLikeFreeTextBody(typed);
}

/**
 * Prefer the raw typed Body over a button payload whenever the Body is a real sentence.
 * Used by the extract layer as a second defense after classifyInboundMessage.
 *
 * IMPORTANT: Twilio list/quick-reply taps put the *visible title* in Body and the
 * stable id in ListId/ButtonPayload. Title ≠ id is normal — that must NOT discard
 * the tap (or "Alte opțiuni ›" / grid_next becomes free text / stale walls).
 *
 * @param {Object} params
 * @param {string | null | undefined} params.typed
 * @param {string | null | undefined} params.tappedId
 * @param {string | null | undefined} [params.buttonTitle] — ButtonText / ListTitle
 * @returns {boolean}
 */
export function shouldPreferTypedTextOverTap({ typed, tappedId, buttonTitle = null }) {
  const body = String(typed ?? '').trim();
  if (!body) return false;
  const tap = String(tappedId ?? '').trim();
  if (!tap) return looksLikeFreeTextBody(body);

  const nBody = normalize(body);
  const nTap = normalize(tap);
  const nTitle = normalize(buttonTitle);

  // Provider echoed the id itself.
  if (nBody === nTap) return false;
  // Normal Twilio tap: Body matches the visible button/list title.
  if (nTitle && nBody === nTitle) return false;

  // Courtesy / mid-flow revise typed over a stray confirm-button payload.
  if (looksLikeGratitude(body) || looksLikeInFlightRevision(body)) return true;

  // Short list-row title + known option id → keep the tap (≤ WhatsApp title cap).
  if (
    looksLikeInteractiveChoiceId(tap)
    && body.length <= MAX_TITLE_LENGTH
    && !looksLikeFreeTextBody(body)
  ) {
    return false;
  }

  // Real typed sentence while a stray payload rode along.
  return looksLikeFreeTextBody(body);
}

/**
 * @typedef {Object} InboundMessage
 * @property {'flow' | 'interactive' | 'text'} kind
 * @property {string} textBody — what the pipeline should read (option id for taps)
 * @property {string | null} buttonPayload — set only for real interactive taps
 * @property {boolean} isInteractive
 */

/**
 * @param {Object} params
 * @param {unknown} [params.body] — Twilio Body
 * @param {unknown} [params.buttonPayload] — Twilio ButtonPayload / ListId
 * @param {unknown} [params.buttonText] — Twilio ButtonText / ListTitle
 * @param {boolean} [params.flowSubmission] — InteractiveData / FlowData present
 * @returns {InboundMessage}
 */
export function classifyInboundMessage({
  body,
  buttonPayload,
  buttonText,
  flowSubmission = false,
}) {
  const typed = String(body ?? '').trim();
  const payload = String(buttonPayload ?? '').trim();
  const title = String(buttonText ?? '').trim();

  if (flowSubmission) {
    return {
      kind: 'flow',
      textBody: typed || payload,
      buttonPayload: payload || null,
      isInteractive: true,
    };
  }
  if (!payload) {
    return { kind: 'text', textBody: typed, buttonPayload: null, isInteractive: false };
  }
  if (!looksLikeInteractiveChoiceId(payload)) {
    return {
      kind: 'text',
      textBody: typed || payload,
      buttonPayload: null,
      isInteractive: false,
    };
  }
  if (looksLikeTypedText(typed, title, payload)) {
    return { kind: 'text', textBody: typed, buttonPayload: null, isInteractive: false };
  }
  return { kind: 'interactive', textBody: payload, buttonPayload: payload, isInteractive: true };
}
