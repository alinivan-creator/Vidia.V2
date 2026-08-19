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
 * Text no WhatsApp option title could be: titles are capped at 24 chars and none of
 * ours carry a question mark. Used where there is no title to compare against.
 *
 * @param {string | null | undefined} body
 */
export function looksLikeFreeTextBody(body) {
  const typed = String(body ?? '').trim();
  if (!typed) return false;
  return typed.length > MAX_TITLE_LENGTH || /[?]/.test(typed);
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
  return looksLikeFreeTextBody(typed);
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
