import {
  isPendingConfirmationExpired,
  listPendingConfirmationDrafts,
  listPendingConfirmationDraftsForPhone,
  listActiveDraftsForPhone,
  markDraftExpired,
  getLatestExpiredDraft,
  getActiveDraftBooking,
  getDraftBookingById,
  cancelActiveDraftsForPhone,
  cancelOrResetDraft,
} from '../db/draftBookingService.js';
import { getPendingTtlMinutes } from '../config/conversationConfig.js';
import {
  CONVERSATION_STEPS,
  setConversationStep,
  getOrCreateConversationState,
  isBookingFlowStep,
  isModificationFlowStep,
} from '../db/conversationStateService.js';
import { getEmployeeById, resolveEmployeeCalendarId } from '../db/employeeService.js';
import { deleteCalendarEvent, resolveCalendarEventId, isMockEventId } from './googleCalendarService.js';
import { formatSlotLabel } from '../utils/datetime.js';
import { getSessionTtlMinutes, readSessionTimestamp } from './sessionValidator.js';

/** @typedef {import('../db/businessService.js').Business} Business */
/** @typedef {import('../db/draftBookingService.js').DraftBooking} DraftBooking */

/**
 * @param {DraftBooking} draft
 * @param {Business} business
 */
export function buildLastBookingIntent(draft, business) {
  const start = draft.selected_slot_start;
  return {
    service: draft.selected_service,
    slot_start: start,
    slot_end: draft.selected_slot_end,
    employee_id: draft.employee_id ?? draft.conversation_context?.employee_id ?? null,
    slot_label: start ? formatSlotLabel(new Date(start), business.timezone) : '',
    expired_at: new Date().toISOString(),
  };
}

/**
 * Delete the visible Google Calendar ⏳ HOLD for a draft (best-effort).
 * @param {Object} params
 * @param {Business} params.business
 * @param {DraftBooking} params.draft
 * @param {string | null} [params.requestId]
 * @returns {Promise<boolean>}
 */
export async function releaseGoogleHoldForDraft({ business, draft, requestId = null }) {
  if (!draft?.google_event_id || isMockEventId(draft.google_event_id)) return false;
  try {
    const empId =
      typeof draft.employee_id === 'string'
        ? draft.employee_id
        : typeof draft.conversation_context?.employee_id === 'string'
          ? draft.conversation_context.employee_id
          : null;
    const employee = empId ? await getEmployeeById(empId, business.id) : null;
    const calendarId = resolveEmployeeCalendarId(business, employee);
    const eventId = await resolveCalendarEventId({
      business,
      eventId: draft.google_event_id,
      phoneNumber: draft.phone_number,
      startIso: draft.selected_slot_start,
      endIso: draft.selected_slot_end,
      calendarId,
      requestId,
    });
    if (eventId) {
      await deleteCalendarEvent({ business, eventId, calendarId, requestId });
      return true;
    }
  } catch (error) {
    console.warn('[hold-release] calendar delete failed', {
      draftId: draft?.id ?? null,
      eventId: draft?.google_event_id ?? null,
      error,
    });
  }
  return false;
}

/**
 * Cancel every active draft for this phone AND delete Google HOLD events first.
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.rawPhone
 * @param {Record<string, unknown>} [params.context]
 * @param {string | null} [params.requestId]
 */
export async function cancelActiveDraftsForPhoneWithCalendar({
  business,
  rawPhone,
  context = { step: 'cancelled_by_user' },
  requestId = null,
}) {
  const drafts = await listActiveDraftsForPhone(business.id, rawPhone);
  for (const draft of drafts) {
    await releaseGoogleHoldForDraft({ business, draft, requestId });
  }
  return cancelActiveDraftsForPhone({
    businessId: business.id,
    rawPhone,
    context,
    requestId,
  });
}

/**
 * Reset/cancel one draft after deleting its Google HOLD (if any).
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.draftId
 * @param {'cancelled' | 'browsing'} params.state
 * @param {Record<string, unknown>} params.context
 * @param {string | null} [params.requestId]
 */
export async function cancelOrResetDraftWithCalendar({
  business,
  draftId,
  state,
  context,
  requestId = null,
}) {
  const existing = await getDraftBookingById(draftId, business.id);
  if (existing) {
    await releaseGoogleHoldForDraft({ business, draft: existing, requestId });
  }
  return cancelOrResetDraft({
    draftId,
    businessId: business.id,
    state,
    context,
    requestId,
  });
}

/**
 * Drop duplicate pending holds for the same phone before claiming a new slot.
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.rawPhone
 * @param {string | null} [params.keepDraftId]
 * @param {string | null} [params.requestId]
 */
export async function purgeDuplicatePendingHoldsForPhone({
  business,
  rawPhone,
  keepDraftId = null,
  requestId = null,
}) {
  const ttlMinutes = getPendingTtlMinutes(business);
  const pending = await listPendingConfirmationDraftsForPhone(business.id, rawPhone);
  let purged = 0;
  for (const draft of pending) {
    if (keepDraftId && draft.id === keepDraftId) continue;
    await releaseGoogleHoldForDraft({ business, draft, requestId });
    if (isPendingConfirmationExpired(draft, ttlMinutes)) {
      await expirePendingDraft({ business, draft, requestId });
    } else {
      await markDraftExpired({
        draftId: draft.id,
        businessId: business.id,
        context: {
          ...draft.conversation_context,
          step: 'superseded_by_new_hold',
          superseded_at: new Date().toISOString(),
        },
        requestId,
      });
    }
    purged += 1;
  }
  if (purged > 0) {
    console.log('[hold-release] Purged duplicate pending holds', {
      businessId: business.id,
      rawPhone,
      purged,
      keepDraftId,
      requestId,
    });
  }
  return purged;
}

/**
 * Releases an expired pending_confirmation: calendar event + soft lock.
 * Keeps last slot/day in conversation memory (does not block the calendar).
 *
 * @param {Object} params
 * @param {Business} params.business
 * @param {DraftBooking} params.draft
 * @param {string | null} [params.requestId]
 */
export async function expirePendingDraft({ business, draft, requestId = null }) {
  if (!draft || draft.state !== 'pending_confirmation') {
    return { expired: false, lastIntent: null };
  }

  const lastIntent = buildLastBookingIntent(draft, business);

  await releaseGoogleHoldForDraft({ business, draft, requestId });

  await markDraftExpired({
    draftId: draft.id,
    businessId: business.id,
    context: {
      ...draft.conversation_context,
      step: 'expired_ttl',
      last_booking_intent: lastIntent,
    },
    requestId,
  });

  const existing = await getOrCreateConversationState(business.id, draft.phone_number);
  const preserved = { ...(existing.context_data ?? {}) };
  delete preserved.draft_id;
  delete preserved.awaiting_name;

  await setConversationStep({
    businessId: business.id,
    rawPhone: draft.phone_number,
    step: CONVERSATION_STEPS.IDLE,
    context: {
      ...preserved,
      last_booking_intent: lastIntent,
    },
    mergeContext: false,
    requestId,
  });

  console.log('[pending-ttl] Released expired pending slot', {
    draftId: draft.id,
    businessId: business.id,
    slot: lastIntent.slot_label,
  });

  return { expired: true, lastIntent };
}

/**
 * Last remembered slot for this phone (conversation memory, else latest expired draft).
 * @param {Business} business
 * @param {string} rawPhone
 */
export async function resolveLastBookingIntent(business, rawPhone) {
  const conv = await getOrCreateConversationState(business.id, rawPhone);
  if (conv.context_data?.pending_dismissed) return null;

  const fromConv = conv.context_data?.last_booking_intent;
  if (fromConv?.slot_start) return fromConv;

  const expiredDraft = await getLatestExpiredDraft(business.id, rawPhone);
  if (!expiredDraft) return null;
  const lastIntent = buildLastBookingIntent(expiredDraft, business);

  await setConversationStep({
    businessId: business.id,
    rawPhone,
    step: conv.current_step || CONVERSATION_STEPS.IDLE,
    context: { last_booking_intent: lastIntent },
    mergeContext: true,
  });

  return lastIntent;
}

/**
 * If this draft's 5-minute pending TTL elapsed, expire it and keep memory.
 *
 * @param {Object} params
 * @param {Business} params.business
 * @param {DraftBooking | null} params.draft
 * @param {string} params.recipientPhone
 * @param {string | null} [params.requestId]
 */
export async function expirePendingIfNeeded({
  business,
  draft,
  recipientPhone,
  requestId = null,
}) {
  const ttlMinutes = getPendingTtlMinutes(business);
  if (!draft || !isPendingConfirmationExpired(draft, ttlMinutes)) {
    return { expired: false, lastIntent: null, draft };
  }

  const result = await expirePendingDraft({ business, draft, requestId });
  return { ...result, draft: null, recipientPhone };
}

/**
 * Lazy TTL: run on every inbound WhatsApp message, before routing.
 * Expires a stale pending hold and unsticks CONFIRMING / ASKING_NAME.
 *
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.rawPhone
 * @param {string | null} [params.requestId]
 */
export async function sweepStalePendingForPhone({
  business,
  rawPhone,
  requestId = null,
}) {
  const ttlMinutes = getPendingTtlMinutes(business);
  const ttlMs = ttlMinutes * 60 * 1000;

  let draft = await getActiveDraftBooking(business.id, rawPhone);
  let expired = false;
  /** @type {object | null} */
  let lastIntent = null;

  const pendingForPhone = await listPendingConfirmationDraftsForPhone(business.id, rawPhone);
  for (const row of pendingForPhone) {
    if (!isPendingConfirmationExpired(row, ttlMinutes)) continue;
    const result = await expirePendingDraft({ business, draft: row, requestId });
    if (result.expired) {
      expired = true;
      lastIntent = result.lastIntent ?? lastIntent;
    }
  }
  draft = await getActiveDraftBooking(business.id, rawPhone);

  let conv = await getOrCreateConversationState(business.id, rawPhone);
  const pendingStep =
    conv.current_step === CONVERSATION_STEPS.CONFIRMING
    || conv.current_step === CONVERSATION_STEPS.ASKING_NAME;

  if (pendingStep) {
    const convAge = conv.updated_at ? Date.now() - new Date(conv.updated_at).getTime() : 0;
    const convStale = !Number.isFinite(convAge) || convAge >= ttlMs;
    const holdGone = expired || !draft || draft.state !== 'pending_confirmation';

    if (holdGone || convStale) {
      const reconciled = await reconcileConversationAfterPendingGone({
        business,
        rawPhone,
        lastIntentHint: lastIntent,
        requestId,
      });
      conv = reconciled.conv;
      lastIntent = lastIntent ?? reconciled.lastIntent ?? null;
      expired = expired || holdGone || convStale;
    }
  }

  const pickerUnstuck = await unstickStaleBookingPicker({
    business,
    rawPhone,
    conv,
    draft,
    requestId,
  });
  if (pickerUnstuck.unstuck) {
    conv = pickerUnstuck.conv;
    draft = pickerUnstuck.draft;
    expired = true;
  }

  return { draft, conv, expired, lastIntent, idleExpired: pickerUnstuck.unstuck === true };
}

/** Idle conversation uses session TTL (default 10 min), not the 5-min slot hold. */
function stalePickerMs(business) {
  return Math.max(1, getSessionTtlMinutes(business)) * 60 * 1000;
}

/**
 * CHOOSING_SERVICE / waiting_for_* left idle longer than session TTL must not
 * resume as if the client never left — cancel draft and reset to IDLE.
 */
async function unstickStaleBookingPicker({
  business,
  rawPhone,
  conv,
  draft,
  requestId = null,
}) {
  const step = conv?.current_step;
  const pickerStep =
    step === CONVERSATION_STEPS.CHOOSING_SERVICE
    || step === CONVERSATION_STEPS.CHOOSING_EMPLOYEE
    || step === CONVERSATION_STEPS.SELECTING_SLOT
    || step === CONVERSATION_STEPS.WAITING_FOR_SERVICE
    || step === CONVERSATION_STEPS.WAITING_FOR_DATE
    || step === CONVERSATION_STEPS.WAITING_FOR_TIME
    || step === CONVERSATION_STEPS.WAITING_FOR_DATE_TIME
    || step === CONVERSATION_STEPS.WAITING_FOR_CLARIFICATION
    || isModificationFlowStep(step)
    || (isBookingFlowStep(step) && draft?.state === 'browsing');

  if (!pickerStep && draft?.state !== 'browsing') {
    return { unstuck: false, conv, draft };
  }
  if (draft?.state === 'pending_confirmation') {
    return { unstuck: false, conv, draft };
  }

  const ttlMs = stalePickerMs(business);
  const inboundTs = readSessionTimestamp(conv);
  const convAge = inboundTs ? Date.now() - inboundTs : Number.POSITIVE_INFINITY;
  const draftAge = draft?.updated_at ? Date.now() - new Date(draft.updated_at).getTime() : 0;
  const stale = convAge >= ttlMs || draftAge >= ttlMs;
  if (!stale) {
    return { unstuck: false, conv, draft };
  }

  console.log('[webhook] Cancel stale booking conversation (idle TTL)', {
    step,
    convAgeMs: convAge,
    draftAgeMs: draftAge,
    ttlMs,
    draftState: draft?.state ?? null,
  });

  if (draft && ['browsing', 'pending_confirmation'].includes(draft.state)) {
    await cancelActiveDraftsForPhoneWithCalendar({
      business,
      rawPhone,
      context: { step: 'cancelled_idle_ttl', idle_ms: Math.max(convAge, draftAge) },
      requestId,
    });
  }

  const preserved = { ...(conv.context_data ?? {}) };
  delete preserved.draft_id;
  delete preserved.awaiting_name;
  delete preserved.booking_wait;
  delete preserved.pending_date_text;
  delete preserved.pending_time_text;
  delete preserved.pending_service_id;
  const updated = await setConversationStep({
    businessId: business.id,
    rawPhone,
    step: CONVERSATION_STEPS.IDLE,
    context: {
      last_booking_intent: preserved.last_booking_intent ?? null,
      recent_turns: preserved.recent_turns ?? [],
      last_menu: null,
      idle_expired_at: new Date().toISOString(),
    },
    mergeContext: false,
    requestId,
  });

  return { unstuck: true, conv: updated ?? conv, draft: null };
}

/**
 * If a DB cron already expired the pending row, conversation may still be
 * CONFIRMING / ASKING_NAME. Move to IDLE and restore last-intent memory.
 *
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.rawPhone
 * @param {object | null} [params.lastIntentHint]
 * @param {string | null} [params.requestId]
 */
export async function reconcileConversationAfterPendingGone({
  business,
  rawPhone,
  lastIntentHint = null,
  requestId = null,
}) {
  const conv = await getOrCreateConversationState(business.id, rawPhone);
  const stale =
    conv.current_step === CONVERSATION_STEPS.CONFIRMING
    || conv.current_step === CONVERSATION_STEPS.ASKING_NAME;
  if (!stale) {
    return {
      conv,
      lastIntent: conv.context_data?.last_booking_intent ?? lastIntentHint ?? null,
    };
  }

  let lastIntent = conv.context_data?.last_booking_intent ?? lastIntentHint;
  if (!lastIntent?.slot_start) {
    lastIntent = await resolveLastBookingIntent(business, rawPhone);
  }

  const preserved = { ...(conv.context_data ?? {}) };
  delete preserved.draft_id;
  delete preserved.awaiting_name;

  const updated = await setConversationStep({
    businessId: business.id,
    rawPhone,
    step: CONVERSATION_STEPS.IDLE,
    context: {
      ...preserved,
      ...(lastIntent ? { last_booking_intent: lastIntent } : {}),
    },
    mergeContext: false,
    requestId,
  });

  return { conv: updated ?? conv, lastIntent };
}

/**
 * Expire all overdue pending confirmations for a business (availability checks).
 * @param {Business} business
 * @param {string | null} [requestId]
 */
export async function expireStalePendingForBusiness(business, requestId = null) {
  if (!business?.id) return 0;
  const pending = await listPendingConfirmationDrafts(business.id);
  const ttlMinutes = getPendingTtlMinutes(business);
  let count = 0;
  for (const draft of pending) {
    if (!isPendingConfirmationExpired(draft, ttlMinutes)) continue;
    await expirePendingDraft({ business, draft, requestId });
    count += 1;
  }
  return count;
}
