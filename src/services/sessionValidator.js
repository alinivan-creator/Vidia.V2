/**
 * Dual-AI session validator.
 * Conversation idle TTL is independent of the calendar hold TTL (pending_ttl_minutes).
 */

/** @typedef {import('../db/businessService.js').Business} Business */
/** @typedef {import('../db/conversationStateService.js').ConversationState} ConversationState */

export const DEFAULT_SESSION_TTL_MINUTES = 10;

const ACTIVE_STEPS = new Set([
  'CHOOSING_SERVICE',
  'CHOOSING_EMPLOYEE',
  'SELECTING_SLOT',
  'ASKING_NAME',
  'CONFIRMING',
  'OFFERING_RESUME',
  'MODIFYING',
  'RESCHEDULING',
  'CONFIRMING_CANCEL',
  'waiting_for_service',
  'waiting_for_date',
  'waiting_for_time',
  'waiting_for_date_time',
  'waiting_for_confirmation',
  'waiting_for_clarification',
]);

/**
 * @param {Business | null | undefined} business
 * @returns {number} minutes, 2–120
 */
export function getSessionTtlMinutes(business) {
  const n = Number(business?.booking_settings?.session_ttl_minutes);
  if (!Number.isFinite(n)) return DEFAULT_SESSION_TTL_MINUTES;
  return Math.min(120, Math.max(2, Math.round(n)));
}

/**
 * Last client inbound, not assistant writes.
 * @param {ConversationState | null | undefined} convState
 * @returns {number} epoch ms, 0 if unknown
 */
export function readSessionTimestamp(convState) {
  const ctx = convState?.context_data && typeof convState.context_data === 'object'
    ? convState.context_data
    : {};
  const raw = ctx.session_timestamp || ctx.last_inbound_at || convState?.updated_at;
  if (!raw) return 0;
  const ms = new Date(String(raw)).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Strictly the last client inbound stamp — no `updated_at` fallback, so backend
 * writes during a turn can never look like a new client message.
 *
 * @param {ConversationState | null | undefined} convState
 * @returns {number} epoch ms, 0 if never stamped
 */
export function readInboundStamp(convState) {
  const ctx = convState?.context_data && typeof convState.context_data === 'object'
    ? convState.context_data
    : {};
  const raw = ctx.session_timestamp || ctx.last_inbound_at;
  if (!raw) return 0;
  const ms = new Date(String(raw)).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function hasInFlightContext(convState) {
  const ctx = convState?.context_data && typeof convState.context_data === 'object'
    ? convState.context_data
    : {};
  return Boolean(
    ctx.draft_id
    || ctx.appointment_id
    || ctx.booking_wait
    || ctx.last_menu
    || ctx.pending_date_text
    || ctx.intent,
  );
}

/**
 * True when the booking/modify session has been idle longer than TTL.
 * Also expires IDLE sessions that only hold an ephemeral language choice,
 * so the next conversation can pick RO/EN again.
 *
 * @param {ConversationState | null | undefined} convState
 * @param {number} ttlMinutes
 * @param {number} [now]
 */
export function isConversationSessionExpired(convState, ttlMinutes, now = Date.now()) {
  const step = String(convState?.current_step || 'IDLE');
  const ctx = convState?.context_data && typeof convState.context_data === 'object'
    ? convState.context_data
    : {};
  const stickyLang = ctx.session_language === 'en' || ctx.session_language === 'ro';
  const active = ACTIVE_STEPS.has(step) || hasInFlightContext(convState) || stickyLang;
  if (!active) return false;
  const ts = readSessionTimestamp(convState);
  if (!ts) return false;
  const ttlMs = Math.max(1, Number(ttlMinutes) || DEFAULT_SESSION_TTL_MINUTES) * 60 * 1000;
  return now - ts > ttlMs;
}

/**
 * Fresh greeting after TTL — no leftover booking context.
 * @param {Business | null | undefined} [business]
 */
export function buildFreshSessionGreeting(business) {
  const name = typeof business?.name === 'string' && business.name.trim()
    ? business.name.trim()
    : null;
  if (name) {
    return `Asistent Vidia — cu ce te pot ajuta la *${name}*?`;
  }
  return 'Asistent Vidia — cu ce te pot ajuta?';
}
