/**
 * Shared "in-flight new booking" detection.
 * Used by extract + execute so "Modific" on the confirm card never becomes
 * a saved-appointment reschedule list.
 */

import { CONVERSATION_STEPS } from '../db/conversationStateService.js';
import { BOOKING_WAIT } from './bookingWaitState.js';

const LIVE_DRAFT_STATES = new Set(['browsing', 'pending_confirmation']);

const BOOKING_STEPS = new Set([
  CONVERSATION_STEPS.WAITING_FOR_SERVICE,
  CONVERSATION_STEPS.CHOOSING_SERVICE,
  CONVERSATION_STEPS.WAITING_FOR_DATE,
  CONVERSATION_STEPS.WAITING_FOR_TIME,
  CONVERSATION_STEPS.WAITING_FOR_DATE_TIME,
  CONVERSATION_STEPS.WAITING_FOR_CONFIRMATION,
  CONVERSATION_STEPS.CONFIRMING,
  CONVERSATION_STEPS.SELECTING_SLOT,
  CONVERSATION_STEPS.CHOOSING_EMPLOYEE,
  CONVERSATION_STEPS.ASKING_NAME,
]);

const MODIFY_STEPS = new Set([
  CONVERSATION_STEPS.RESCHEDULING,
  CONVERSATION_STEPS.MODIFYING,
  CONVERSATION_STEPS.CONFIRMING_CANCEL,
]);

/**
 * @param {Record<string, unknown> | null | undefined} context
 * @returns {boolean}
 */
function contextLooksLikeInFlight(context) {
  if (!context || typeof context !== 'object') return false;
  const menuKind = context.last_menu && typeof context.last_menu === 'object'
    ? /** @type {{ kind?: string }} */ (context.last_menu).kind
    : null;
  if (menuKind === 'confirm' || menuKind === 'day_grid' || menuKind === 'time_grid' || menuKind === 'service') {
    return true;
  }
  if (typeof context.draft_id === 'string' && context.draft_id) return true;
  if (context.draft_booking && typeof context.draft_booking === 'object') return true;
  if (context.booking_wait === BOOKING_WAIT.CONFIRMATION
    || context.booking_wait === BOOKING_WAIT.DATE
    || context.booking_wait === BOOKING_WAIT.TIME
    || context.booking_wait === BOOKING_WAIT.DATE_TIME
    || context.booking_wait === BOOKING_WAIT.SERVICE) {
    return true;
  }
  if (context.service && typeof context.service === 'object') return true;
  return false;
}

/**
 * True while the client is building a NEW booking (draft / confirm card),
 * not while already in a saved-appointment reschedule/cancel flow.
 *
 * @param {Object} params
 * @param {string} [params.step]
 * @param {string | null} [params.wait]
 * @param {{ state?: string } | null} [params.activeDraft]
 * @param {Record<string, unknown> | null | undefined} [params.context]
 */
export function isInFlightBookingContext({ step, wait, activeDraft, context }) {
  const intent = context?.intent;
  if (intent === 'reschedule' || intent === 'cancel') return false;
  if (MODIFY_STEPS.has(step)) return false;

  if (activeDraft && LIVE_DRAFT_STATES.has(String(activeDraft.state || ''))) {
    return true;
  }
  if (BOOKING_STEPS.has(step)) return true;
  if (
    wait === BOOKING_WAIT.SERVICE
    || wait === BOOKING_WAIT.DATE
    || wait === BOOKING_WAIT.TIME
    || wait === BOOKING_WAIT.DATE_TIME
    || wait === BOOKING_WAIT.CONFIRMATION
  ) {
    return true;
  }
  // Confirm / grid memory can outlive a TTL-expired draft for one turn.
  if (contextLooksLikeInFlight(context) && intent !== 'reschedule' && intent !== 'cancel') {
    return true;
  }
  return false;
}

/**
 * Service remembered on the confirm card / expired hold / draft.
 * @param {Record<string, unknown> | null | undefined} context
 * @param {{ selected_service?: unknown } | null} [draft]
 * @returns {{ id?: string, name?: string, duration_minutes?: number } | null}
 */
export function serviceFromInFlightContext(context, draft = null) {
  if (draft?.selected_service && typeof draft.selected_service === 'object') {
    return /** @type {{ id?: string, name?: string, duration_minutes?: number }} */ (draft.selected_service);
  }
  const ctx = context || {};
  if (ctx.service && typeof ctx.service === 'object') {
    return /** @type {{ id?: string, name?: string, duration_minutes?: number }} */ (ctx.service);
  }
  const booking = ctx.draft_booking;
  if (booking && typeof booking === 'object') {
    const b = /** @type {{ service_id?: string, service_name?: string, duration?: number }} */ (booking);
    if (b.service_id || b.service_name) {
      return {
        id: b.service_id || undefined,
        name: b.service_name || undefined,
        duration_minutes: b.duration,
      };
    }
  }
  const li = ctx.last_booking_intent;
  if (li && typeof li === 'object') {
    const intent = /** @type {{ service_id?: string, service_name?: string, duration?: number }} */ (li);
    if (intent.service_id || intent.service_name) {
      return {
        id: intent.service_id || undefined,
        name: intent.service_name || undefined,
        duration_minutes: intent.duration,
      };
    }
  }
  return null;
}
