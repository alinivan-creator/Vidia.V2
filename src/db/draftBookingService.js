import { supabase } from '../config/supabase.js';
import { logError } from './loggerService.js';
import { reportQueryFailure } from './schemaHealth.js';
import { toE164 } from '../utils/phone.js';
import { getEmployeeById } from './employeeService.js';
import {
  clearPendingHoldFromCache,
  hasOverlappingBookingLock,
  registerPendingHoldInCache,
} from './cacheService.js';

/** @typedef {'browsing' | 'pending_confirmation' | 'confirmed' | 'cancelled' | 'expired'} DraftBookingState */

/**
 * @typedef {Object} DraftBooking
 * @property {string} id
 * @property {string} business_id
 * @property {string | null} client_id
 * @property {string} phone_number
 * @property {DraftBookingState} state
 * @property {Record<string, unknown> | null} selected_service
 * @property {string | null} selected_slot_start
 * @property {string | null} selected_slot_end
 * @property {string | null} locked_until
 * @property {string | null} [pending_expires_at]
 * @property {string | null} google_event_id
 * @property {string | null} google_event_link
 * @property {string | null} [employee_id]
 * @property {Record<string, unknown>} conversation_context
 * @property {string} expires_at
 * @property {string} [created_at]
 * @property {string} [updated_at]
 */

const PENDING_TTL_MS = 5 * 60 * 1000;

const DRAFT_COLUMNS =
  'id, business_id, client_id, phone_number, state, selected_service, selected_slot_start, selected_slot_end, locked_until, pending_expires_at, google_event_id, google_event_link, employee_id, conversation_context, expires_at, created_at, updated_at';

const DRAFT_COLUMNS_NO_PENDING_EXPIRES =
  'id, business_id, client_id, phone_number, state, selected_service, selected_slot_start, selected_slot_end, locked_until, google_event_id, google_event_link, employee_id, conversation_context, expires_at, created_at, updated_at';

const DRAFT_COLUMNS_LEGACY =
  'id, business_id, client_id, phone_number, state, selected_service, selected_slot_start, selected_slot_end, locked_until, google_event_id, google_event_link, conversation_context, expires_at, created_at, updated_at';

const JOURNAL_COLUMNS =
  'id, phone_number, state, selected_service, selected_slot_start, selected_slot_end, locked_until, google_event_id, conversation_context, created_at, updated_at';

/** @type {boolean | null} */
let employeeColumnAvailable = null;
/** @type {boolean | null} */
let pendingExpiresColumnAvailable = null;

async function draftSelectColumns() {
  if (employeeColumnAvailable === false) return DRAFT_COLUMNS_LEGACY;
  if (pendingExpiresColumnAvailable === false) return DRAFT_COLUMNS_NO_PENDING_EXPIRES;
  return DRAFT_COLUMNS;
}

/**
 * @returns {string} ISO timestamp now + 5 minutes
 */
export function pendingTtlIso(fromMs = Date.now(), ttlMs = PENDING_TTL_MS) {
  const ms = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : PENDING_TTL_MS;
  return new Date(fromMs + ms).toISOString();
}

/**
 * @param {DraftBooking | null | undefined} draft
 * @returns {string | null}
 */
export function resolvePendingExpiresAt(draft) {
  if (!draft) return null;
  if (typeof draft.pending_expires_at === 'string' && draft.pending_expires_at) {
    return draft.pending_expires_at;
  }
  const ctx = draft.conversation_context?.pending_expires_at;
  if (typeof ctx === 'string' && ctx) return ctx;
  return typeof draft.locked_until === 'string' ? draft.locked_until : null;
}

/**
 * Pending hold is stale when the explicit TTL elapsed, or — if that column
 * is missing — when updated_at/created_at is older than ttlMinutes.
 * No clock at all → treat as expired so a hold can never last forever.
 *
 * @param {DraftBooking | null | undefined} draft
 * @param {number} [ttlMinutes]
 */
export function isPendingConfirmationExpired(draft, ttlMinutes = 5) {
  if (!draft || draft.state !== 'pending_confirmation') return false;

  const now = Date.now();
  const ttlMs = Math.min(60, Math.max(1, Number(ttlMinutes) || 5)) * 60 * 1000;

  const explicit = draft.pending_expires_at || draft.conversation_context?.pending_expires_at;
  if (typeof explicit === 'string' && explicit) {
    const t = new Date(explicit).getTime();
    if (Number.isFinite(t)) return t <= now;
  }

  if (typeof draft.locked_until === 'string' && draft.locked_until) {
    const locked = new Date(draft.locked_until).getTime();
    if (Number.isFinite(locked) && locked <= now) return true;
  }

  const started = draft.updated_at || draft.created_at;
  if (typeof started === 'string' && started) {
    const t = new Date(started).getTime();
    if (Number.isFinite(t)) return now - t >= ttlMs;
  }

  return true;
}

const ACTIVE_STATES = ['browsing', 'pending_confirmation'];

/**
 * @param {string} businessId
 * @param {string} rawPhone
 * @returns {Promise<DraftBooking | null>}
 */
export async function getActiveDraftBooking(businessId, rawPhone) {
  const phoneNumber = toE164(rawPhone);
  const columns = await draftSelectColumns();

  const { data, error } = await supabase
    .from('draft_bookings')
    .select(columns)
    .eq('business_id', businessId)
    .eq('phone_number', phoneNumber)
    .in('state', ACTIVE_STATES)
    .maybeSingle();

  if (error) {
    if (/pending_expires_at/i.test(error.message ?? '')) {
      pendingExpiresColumnAvailable = false;
      return getActiveDraftBooking(businessId, rawPhone);
    }
    if (/employee_id|PGRST204/i.test(error.message ?? '')) {
      employeeColumnAvailable = false;
      const retry = await supabase
        .from('draft_bookings')
        .select(DRAFT_COLUMNS_LEGACY)
        .eq('business_id', businessId)
        .eq('phone_number', phoneNumber)
        .in('state', ACTIVE_STATES)
        .maybeSingle();
      return /** @type {DraftBooking | null} */ (retry.data ?? null);
    }
    await logError({
      message: 'getActiveDraftBooking failed',
      source: 'database',
      businessId,
      phoneNumber,
      error,
    });
    return null;
  }

  employeeColumnAvailable = true;
  return /** @type {DraftBooking | null} */ (data);
}

/**
 * Tenant-scoped draft lookup — `business_id` is mandatory (never trust id alone).
 * @param {string} draftId
 * @param {string} businessId
 * @returns {Promise<DraftBooking | null>}
 */
export async function getDraftBookingById(draftId, businessId) {
  if (!draftId || !businessId) return null;

  const columns = await draftSelectColumns();
  const { data, error } = await supabase
    .from('draft_bookings')
    .select(columns)
    .eq('id', draftId)
    .eq('business_id', businessId)
    .maybeSingle();

  if (error) {
    if (/pending_expires_at/i.test(error.message ?? '')) {
      pendingExpiresColumnAvailable = false;
      return getDraftBookingById(draftId, businessId);
    }
    if (/employee_id|PGRST204/i.test(error.message ?? '')) {
      employeeColumnAvailable = false;
      const retry = await supabase
        .from('draft_bookings')
        .select(DRAFT_COLUMNS_LEGACY)
        .eq('id', draftId)
        .eq('business_id', businessId)
        .maybeSingle();
      return /** @type {DraftBooking | null} */ (retry.data ?? null);
    }
    await logError({
      message: 'getDraftBookingById failed',
      source: 'database',
      businessId,
      draftBookingId: draftId,
      error,
    });
    return null;
  }

  return /** @type {DraftBooking | null} */ (data);
}

/**
 * Assigns an employee to the active draft (creates soft association for calendar routing).
 * @param {Object} params
 * @param {string} params.draftId
 * @param {string} params.businessId
 * @param {string | null} params.employeeId
 * @param {Record<string, unknown>} [params.context]
 * @param {string | null} [params.requestId]
 */
export async function setDraftEmployee({
  draftId,
  businessId,
  employeeId,
  context = null,
  requestId = null,
}) {
  if (!draftId || !businessId) return null;

  if (employeeId) {
    const employee = await getEmployeeById(employeeId, businessId);
    if (!employee) return null;
  }

  /** @type {Record<string, unknown>} */
  const patch = { employee_id: employeeId };
  if (context) patch.conversation_context = context;

  const { data, error } = await supabase
    .from('draft_bookings')
    .update(patch)
    .eq('id', draftId)
    .eq('business_id', businessId)
    .select(await draftSelectColumns())
    .single();

  if (error) {
    if (/employee_id|PGRST204/i.test(error.message ?? '')) {
      employeeColumnAvailable = false;
      // Persist in conversation_context only until migration is applied
      if (context) {
        await supabase
          .from('draft_bookings')
          .update({ conversation_context: context })
          .eq('id', draftId)
          .eq('business_id', businessId);
      }
      return getDraftBookingById(draftId, businessId);
    }
    await logError({
      message: 'setDraftEmployee failed',
      source: 'database',
      businessId,
      requestId,
      draftBookingId: draftId,
      error,
    });
    return null;
  }

  return /** @type {DraftBooking} */ (data);
}

/**
 * Sets or refreshes a draft booking in `browsing` state (booking flow entry).
 */
export async function startBrowsingFlow({
  businessId,
  clientId,
  rawPhone,
  context = {},
  requestId = null,
}) {
  const phoneNumber = toE164(rawPhone);
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  /** @type {Record<string, unknown>} */
  const payload = {
    business_id: businessId,
    client_id: clientId,
    phone_number: phoneNumber,
    state: 'browsing',
    selected_service: null,
    selected_slot_start: null,
    selected_slot_end: null,
    locked_until: null,
    employee_id: null,
    conversation_context: {
      flow: 'booking',
      step: 'select_service',
      started_at: new Date().toISOString(),
      ...context,
    },
    expires_at: expiresAt,
  };

  const existing = await getActiveDraftBooking(businessId, rawPhone);
  const columns = await draftSelectColumns();

  /**
   * @param {Record<string, unknown>} p
   */
  async function tryWrite(p, mode) {
    if (mode === 'update' && existing) {
      return supabase
        .from('draft_bookings')
        .update(p)
        .eq('id', existing.id)
        .eq('business_id', businessId)
        .select(columns)
        .single();
    }
    return supabase.from('draft_bookings').insert(p).select(columns).single();
  }

  const mode = existing ? 'update' : 'insert';
  let { data, error } = await tryWrite(payload, mode);

  if (error && /employee_id|PGRST204/i.test(error.message ?? '')) {
    employeeColumnAvailable = false;
    const { employee_id: _e, ...legacy } = payload;
    ({ data, error } = await tryWrite(legacy, mode));
  }

  if (error) {
    await logError({
      message: `startBrowsingFlow ${mode} failed`,
      source: 'database',
      businessId,
      requestId,
      phoneNumber,
      draftBookingId: existing?.id,
      error,
    });
    return null;
  }

  return /** @type {DraftBooking} */ (data);
}

/**
 * @param {Object} params
 * @param {string} params.draftId
 * @param {string} params.businessId
 * @param {Record<string, unknown>} params.service
 * @param {Record<string, unknown>} params.context
 * @param {string | null} [params.requestId]
 */
export async function setSelectedService({
  draftId,
  businessId,
  service,
  context,
  requestId = null,
}) {
  if (!draftId || !businessId) {
    await logError({
      message: 'setSelectedService refused: draftId and businessId required',
      source: 'database',
      requestId,
      draftBookingId: draftId || null,
      businessId: businessId || null,
    });
    return null;
  }

  const { data, error } = await supabase
    .from('draft_bookings')
    .update({
      selected_service: service,
      conversation_context: context,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    })
    .eq('id', draftId)
    .eq('business_id', businessId)
    .select(await draftSelectColumns())
    .single();

  if (error) {
    await logError({
      message: 'setSelectedService failed',
      source: 'database',
      requestId,
      draftBookingId: draftId,
      businessId,
      error,
    });
    return null;
  }

  return /** @type {DraftBooking} */ (data);
}

/**
 * Soft-locks a slot and moves draft to pending_confirmation.
 * Atomic via claim_booking_slot RPC (first writer wins).
 *
 * @returns {Promise<DraftBooking | null>}
 */
export async function setSelectedSlot({
  draftId,
  businessId,
  slotStart,
  slotEnd,
  context,
  ttlMinutes = 5,
  employeeId = null,
  requestId = null,
}) {
  if (!draftId || !businessId) {
    await logError({
      message: 'setSelectedSlot refused: draftId and businessId required',
      source: 'database',
      requestId,
      draftBookingId: draftId || null,
      businessId: businessId || null,
    });
    return null;
  }
  const claimed = await claimSlotForDraft({
    draftId,
    businessId,
    slotStart,
    slotEnd,
    context,
    ttlMinutes,
    employeeId,
    mode: 'hold',
    requestId,
  });
  return claimed.ok ? claimed.draft : null;
}

/**
 * @typedef {{ ok: true, draft: DraftBooking, reason: null } | { ok: false, draft: null, reason: 'slot_taken' | 'error' | 'not_found' | 'invalid_range' }} SlotClaimResult
 */

/** @type {boolean | null} */
let claimRpcAvailable = null;

function isSlotTakenDbError(error) {
  if (!error || typeof error !== 'object') return false;
  const code = /** @type {{ code?: string }} */ (error).code ?? '';
  const message = /** @type {{ message?: string }} */ (error).message ?? '';
  return (
    code === '23P01'
    || code === '23505'
    || /exclusion_violation|no_overlapping_slots|duplicate key/i.test(message)
  );
}

/**
 * First-writer-wins slot claim. Concurrent WhatsApp holds on the same interval:
 * one succeeds, the other gets reason=slot_taken.
 *
 * @param {Object} params
 * @returns {Promise<SlotClaimResult>}
 */
export async function claimSlotForDraft({
  draftId,
  businessId,
  slotStart,
  slotEnd,
  context = {},
  ttlMinutes = 5,
  employeeId = null,
  mode = 'hold',
  requestId = null,
}) {
  if (!draftId || !businessId) {
    await logError({
      message: 'claimSlotForDraft refused: draftId and businessId required',
      source: 'database',
      requestId,
      draftBookingId: draftId || null,
      businessId: businessId || null,
    });
    return { ok: false, draft: null, reason: 'error' };
  }

  const minutes = Number.isFinite(Number(ttlMinutes))
    ? Math.min(60, Math.max(1, Math.round(Number(ttlMinutes))))
    : 5;
  const ttl = pendingTtlIso(Date.now(), minutes * 60 * 1000);
  const mergedContext = { ...context, pending_expires_at: ttl };
  const startIso = slotStart instanceof Date ? slotStart.toISOString() : String(slotStart);
  const endIso = slotEnd instanceof Date ? slotEnd.toISOString() : String(slotEnd);

  /** @type {DraftBooking | null} */
  let claimedDraft = null;

  if (claimRpcAvailable !== false) {
    const { data, error } = await supabase.rpc('claim_booking_slot', {
      p_draft_id: draftId,
      p_business_id: businessId,
      p_slot_start: startIso,
      p_slot_end: endIso,
      p_ttl_minutes: minutes,
      p_context: mergedContext,
      p_employee_id: employeeId,
      p_mode: mode === 'reschedule' ? 'reschedule' : 'hold',
    });

    if (error && /PGRST202|could not find the function|claim_booking_slot|pending_expires_at|slot_lock_key/i.test(error.message ?? '')) {
      claimRpcAvailable = false;
    } else if (error) {
      await logError({
        message: 'claim_booking_slot RPC failed',
        source: 'database',
        requestId,
        draftBookingId: draftId,
        businessId,
        error,
      });
      if (isSlotTakenDbError(error)) {
        return { ok: false, draft: null, reason: 'slot_taken' };
      }
      return { ok: false, draft: null, reason: 'error' };
    } else {
      claimRpcAvailable = true;
      const payload = /** @type {{ ok?: boolean, reason?: string | null, draft?: DraftBooking | null }} */ (data || {});
      if (payload.ok && payload.draft) {
        claimedDraft = payload.draft;
      } else {
        const reason = payload.reason === 'slot_taken' || payload.reason === 'not_found' || payload.reason === 'invalid_range'
          ? payload.reason
          : 'error';
        return { ok: false, draft: null, reason };
      }
    }
  }

  if (!claimedDraft && mode !== 'reschedule') {
    // Fallback path (no RPC): refuse if any other pending/confirmed overlaps this interval.
    const overlap = await hasOverlappingBookingLock({
      businessId,
      draftId,
      startIso,
      endIso,
    });
    if (overlap) {
      return { ok: false, draft: null, reason: 'slot_taken' };
    }

    /** @type {Record<string, unknown>} */
    const payload = {
      state: 'pending_confirmation',
      selected_slot_start: startIso,
      selected_slot_end: endIso,
      locked_until: ttl,
      conversation_context: mergedContext,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    if (pendingExpiresColumnAvailable !== false) {
      payload.pending_expires_at = ttl;
    }
    if (employeeId && employeeColumnAvailable !== false) {
      payload.employee_id = employeeId;
    }

    let query = supabase
      .from('draft_bookings')
      .update(payload)
      .eq('id', draftId)
      .eq('business_id', businessId)
      .in('state', ['browsing', 'pending_confirmation']);

    let { data, error } = await query.select(await draftSelectColumns()).single();

    if (error && /pending_expires_at/i.test(error.message ?? '')) {
      pendingExpiresColumnAvailable = false;
      const { pending_expires_at: _p, ...without } = payload;
      ({ data, error } = await supabase
        .from('draft_bookings')
        .update(without)
        .eq('id', draftId)
        .eq('business_id', businessId)
        .in('state', ['browsing', 'pending_confirmation'])
        .select(DRAFT_COLUMNS_NO_PENDING_EXPIRES)
        .single());
    }

    if (error) {
      await logError({
        message: 'claimSlotForDraft fallback update failed',
        source: 'database',
        requestId,
        draftBookingId: draftId,
        businessId,
        error,
      });
      if (isSlotTakenDbError(error)) {
        return { ok: false, draft: null, reason: 'slot_taken' };
      }
      return { ok: false, draft: null, reason: 'error' };
    }

    claimedDraft = /** @type {DraftBooking} */ (data);
  } else if (!claimedDraft && mode === 'reschedule') {
    /** @type {Record<string, unknown>} */
    const payload = {
      selected_slot_start: startIso,
      selected_slot_end: endIso,
      conversation_context: mergedContext,
    };
    let { data, error } = await supabase
      .from('draft_bookings')
      .update(payload)
      .eq('id', draftId)
      .eq('business_id', businessId)
      .eq('state', 'confirmed')
      .select(await draftSelectColumns())
      .single();

    if (error) {
      await logError({
        message: 'claimSlotForDraft reschedule update failed',
        source: 'database',
        requestId,
        draftBookingId: draftId,
        businessId,
        error,
      });
      return { ok: false, draft: null, reason: 'error' };
    }
    claimedDraft = /** @type {DraftBooking} */ (data);
  }

  if (!claimedDraft) {
    return { ok: false, draft: null, reason: 'error' };
  }

  // Hold must block availability immediately via calendar_cache (not only draft soft-lock).
  if (mode !== 'reschedule' && claimedDraft.state === 'pending_confirmation') {
    try {
      await registerPendingHoldInCache({
        businessId,
        draftId: claimedDraft.id,
        slotStart: claimedDraft.selected_slot_start || startIso,
        slotEnd: claimedDraft.selected_slot_end || endIso,
        // Store as business-wide busy (null employee) so any-staff availability sees it.
        employeeId: null,
        requestId,
        title: 'Pending WhatsApp booking',
      });
    } catch (error) {
      console.error('[booking] registerPendingHoldInCache failed', error);
    }
  }

  return { ok: true, draft: claimedDraft, reason: null };
}

/**
 * @param {Object} params
 * @param {string} params.draftId
 * @param {string} params.businessId
 * @param {string} params.googleEventId
 * @param {string | null} params.googleEventLink
 * @param {Record<string, unknown>} params.context
 * @param {string | null} [params.requestId]
 */
export async function confirmDraftBooking({
  draftId,
  businessId,
  googleEventId,
  googleEventLink,
  context,
  requestId = null,
}) {
  if (!draftId || !businessId) {
    await logError({
      message: 'confirmDraftBooking refused: draftId and businessId required',
      source: 'database',
      requestId,
      draftBookingId: draftId || null,
      businessId: businessId || null,
    });
    return null;
  }

  /** @type {Record<string, unknown>} */
  const updates = {
    state: 'confirmed',
    google_event_id: googleEventId,
    google_event_link: googleEventLink,
    locked_until: null,
    confirmed_at: new Date().toISOString(),
    conversation_context: context,
  };
  if (pendingExpiresColumnAvailable !== false) {
    updates.pending_expires_at = null;
  }

  let { data, error } = await supabase
    .from('draft_bookings')
    .update(updates)
    .eq('id', draftId)
    .eq('business_id', businessId)
    .select(await draftSelectColumns())
    .single();

  if (error && /pending_expires_at/i.test(error.message ?? '')) {
    pendingExpiresColumnAvailable = false;
    const { pending_expires_at: _p, ...without } = updates;
    ({ data, error } = await supabase
      .from('draft_bookings')
      .update(without)
      .eq('id', draftId)
      .eq('business_id', businessId)
      .select(DRAFT_COLUMNS_NO_PENDING_EXPIRES)
      .single());
  }

  if (error) {
    await logError({
      message: 'confirmDraftBooking failed',
      source: 'database',
      requestId,
      draftBookingId: draftId,
      businessId,
      error,
    });
    return null;
  }

  // Real Google event now occupies the slot — drop the synthetic pending hold.
  await clearPendingHoldFromCache({ businessId, draftId, requestId }).catch(() => false);

  return /** @type {DraftBooking} */ (data);
}

/**
 * @param {Object} params
 * @param {string} params.draftId
 * @param {string} params.businessId
 * @param {'cancelled' | 'browsing'} params.state
 * @param {Record<string, unknown>} params.context
 * @param {string | null} [params.requestId]
 */
export async function cancelOrResetDraft({
  draftId,
  businessId,
  state,
  context,
  requestId = null,
}) {
  if (!draftId || !businessId) {
    await logError({
      message: 'cancelOrResetDraft refused: draftId and businessId required',
      source: 'database',
      requestId,
      draftBookingId: draftId || null,
      businessId: businessId || null,
    });
    return null;
  }

  /** @type {Record<string, unknown>} */
  const updates = {
    state,
    locked_until: null,
    cancelled_at: state === 'cancelled' ? new Date().toISOString() : null,
    conversation_context: context,
  };
  if (pendingExpiresColumnAvailable !== false) {
    updates.pending_expires_at = null;
  }

  if (state === 'browsing') {
    updates.selected_slot_start = null;
    updates.selected_slot_end = null;
  }

  let { data, error } = await supabase
    .from('draft_bookings')
    .update(updates)
    .eq('id', draftId)
    .eq('business_id', businessId)
    .select(await draftSelectColumns())
    .single();

  if (error && /pending_expires_at/i.test(error.message ?? '')) {
    pendingExpiresColumnAvailable = false;
    const { pending_expires_at: _p, ...without } = updates;
    ({ data, error } = await supabase
      .from('draft_bookings')
      .update(without)
      .eq('id', draftId)
      .eq('business_id', businessId)
      .select(DRAFT_COLUMNS_NO_PENDING_EXPIRES)
      .single());
  }

  if (error) {
    await logError({
      message: 'cancelOrResetDraft failed',
      source: 'database',
      requestId,
      draftBookingId: draftId,
      businessId,
      error,
    });
    return null;
  }

  await clearPendingHoldFromCache({ businessId, draftId, requestId }).catch(() => false);

  return /** @type {DraftBooking} */ (data);
}

/**
 * Immediately cancels every active draft (browsing / pending_confirmation)
 * for this phone — used when the client sends "2" / Anulează.
 * @param {Object} params
 * @param {string} params.businessId
 * @param {string} params.rawPhone
 * @param {Record<string, unknown>} [params.context]
 * @param {string | null} [params.requestId]
 * @returns {Promise<DraftBooking[]>}
 */
export async function cancelActiveDraftsForPhone({
  businessId,
  rawPhone,
  context = { step: 'cancelled_by_user' },
  requestId = null,
}) {
  const phoneNumber = toE164(rawPhone);
  if (!businessId || !phoneNumber) return [];

  /** @type {Record<string, unknown>} */
  const updates = {
    state: 'cancelled',
    locked_until: null,
    cancelled_at: new Date().toISOString(),
    conversation_context: context,
  };
  if (pendingExpiresColumnAvailable !== false) {
    updates.pending_expires_at = null;
  }

  let { data, error } = await supabase
    .from('draft_bookings')
    .update(updates)
    .eq('business_id', businessId)
    .eq('phone_number', phoneNumber)
    .in('state', ACTIVE_STATES)
    .select(await draftSelectColumns());

  if (error && /pending_expires_at/i.test(error.message ?? '')) {
    pendingExpiresColumnAvailable = false;
    const { pending_expires_at: _p, ...without } = updates;
    ({ data, error } = await supabase
      .from('draft_bookings')
      .update(without)
      .eq('business_id', businessId)
      .eq('phone_number', phoneNumber)
      .in('state', ACTIVE_STATES)
      .select(DRAFT_COLUMNS_NO_PENDING_EXPIRES));
  }

  if (error) {
    await logError({
      message: 'cancelActiveDraftsForPhone failed',
      source: 'database',
      businessId,
      requestId,
      phoneNumber,
      error,
    });
    return [];
  }

  const cancelled = /** @type {DraftBooking[]} */ (data ?? []);
  await Promise.all(
    cancelled.map((row) =>
      clearPendingHoldFromCache({
        businessId,
        draftId: row.id,
        requestId,
      }).catch(() => false),
    ),
  );
  return cancelled;
}

export async function updateDraftContext({ draftId, businessId, context, requestId = null }) {
  if (!draftId || !businessId) {
    await logError({
      message: 'updateDraftContext refused: draftId and businessId required',
      source: 'database',
      requestId,
      draftBookingId: draftId || null,
      businessId: businessId || null,
    });
    return;
  }

  const { error } = await supabase
    .from('draft_bookings')
    .update({ conversation_context: context })
    .eq('id', draftId)
    .eq('business_id', businessId);

  if (error) {
    await logError({
      message: 'updateDraftContext failed',
      source: 'database',
      requestId,
      draftBookingId: draftId,
      businessId,
      error,
    });
  }
}

/**
 * Upcoming confirmed appointments for a phone (for cancel / reschedule).
 * @param {string} businessId
 * @param {string} rawPhone
 * @returns {Promise<DraftBooking[]>}
 */
export async function listUpcomingConfirmedBookings(businessId, rawPhone) {
  const phoneNumber = toE164(rawPhone);

  const { data, error } = await supabase
    .from('draft_bookings')
    .select(await draftSelectColumns())
    .eq('business_id', businessId)
    .eq('phone_number', phoneNumber)
    .eq('state', 'confirmed')
    .gte('selected_slot_start', new Date().toISOString())
    .order('selected_slot_start', { ascending: true })
    .limit(10);

  if (error) {
    await logError({
      message: 'listUpcomingConfirmedBookings failed',
      source: 'database',
      businessId,
      phoneNumber,
      error,
    });
    return [];
  }

  return /** @type {DraftBooking[]} */ (data ?? []);
}

/**
 * Updates a confirmed booking's slot (reschedule) — keeps same google_event_id.
 * @param {Object} params
 * @param {string} params.draftId
 * @param {string} params.businessId
 * @param {Date | string} params.slotStart
 * @param {Date | string} params.slotEnd
 * @param {Record<string, unknown>} [params.context]
 * @param {string | null} [params.requestId]
 */
export async function updateConfirmedBookingSlot({
  draftId,
  businessId,
  slotStart,
  slotEnd,
  context = {},
  googleEventId = undefined,
  requestId = null,
}) {
  if (!draftId || !businessId) {
    await logError({
      message: 'updateConfirmedBookingSlot refused: draftId and businessId required',
      source: 'database',
      requestId,
      draftBookingId: draftId || null,
      businessId: businessId || null,
    });
    return null;
  }

  /** @type {Record<string, unknown>} */
  const updates = {
    selected_slot_start: new Date(slotStart).toISOString(),
    selected_slot_end: new Date(slotEnd).toISOString(),
    conversation_context: context,
    updated_at: new Date().toISOString(),
  };
  if (typeof googleEventId === 'string' && googleEventId) {
    updates.google_event_id = googleEventId;
  }

  const { data, error } = await supabase
    .from('draft_bookings')
    .update(updates)
    .eq('id', draftId)
    .eq('business_id', businessId)
    .eq('state', 'confirmed')
    .select(await draftSelectColumns())
    .single();

  if (error) {
    await logError({
      message: 'updateConfirmedBookingSlot failed',
      source: 'database',
      requestId,
      draftBookingId: draftId,
      businessId,
      error,
    });
    return null;
  }

  return /** @type {DraftBooking} */ (data);
}

/** @type {boolean | null} */
let rescheduleRpcAvailable = null;
/** @type {boolean | null} */
let cancelRpcAvailable = null;

/**
 * Atomic reschedule: UPDATE the same confirmed row in place (never INSERT a twin booking).
 * Prefers reschedule_confirmed_booking RPC; falls back to claim_booking_slot + update.
 *
 * @param {Object} params
 * @param {string} params.draftId
 * @param {string} params.businessId
 * @param {Date | string} params.slotStart
 * @param {Date | string} params.slotEnd
 * @param {string | null} [params.employeeId]
 * @param {string | null} [params.googleEventId]
 * @param {Record<string, unknown>} [params.context]
 * @param {string | null} [params.requestId]
 * @returns {Promise<{ ok: boolean, draft: DraftBooking | null, reason: string | null }>}
 */
export async function rescheduleConfirmedBookingAtomic({
  draftId,
  businessId,
  slotStart,
  slotEnd,
  employeeId = null,
  googleEventId = null,
  context = {},
  requestId = null,
}) {
  if (!draftId || !businessId) {
    return { ok: false, draft: null, reason: 'error' };
  }

  const startIso = slotStart instanceof Date ? slotStart.toISOString() : String(slotStart);
  const endIso = slotEnd instanceof Date ? slotEnd.toISOString() : String(slotEnd);

  if (rescheduleRpcAvailable !== false) {
    const { data, error } = await supabase.rpc('reschedule_confirmed_booking', {
      p_draft_id: draftId,
      p_business_id: businessId,
      p_slot_start: startIso,
      p_slot_end: endIso,
      p_context: context,
      p_employee_id: employeeId,
      p_google_event_id: googleEventId || null,
    });

    if (error && /PGRST202|could not find the function|reschedule_confirmed_booking/i.test(error.message ?? '')) {
      rescheduleRpcAvailable = false;
    } else if (error) {
      await logError({
        message: 'reschedule_confirmed_booking RPC failed',
        source: 'database',
        requestId,
        draftBookingId: draftId,
        businessId,
        error,
      });
      if (isSlotTakenDbError(error)) {
        return { ok: false, draft: null, reason: 'slot_taken' };
      }
      return { ok: false, draft: null, reason: 'error' };
    } else {
      rescheduleRpcAvailable = true;
      const payload = /** @type {{ ok?: boolean, reason?: string | null, draft?: DraftBooking | null }} */ (data || {});
      if (payload.ok && payload.draft) {
        return { ok: true, draft: payload.draft, reason: null };
      }
      const reason = payload.reason === 'slot_taken' || payload.reason === 'not_found' || payload.reason === 'invalid_range'
        ? payload.reason
        : 'error';
      return { ok: false, draft: null, reason };
    }
  }

  const claimed = await claimSlotForDraft({
    draftId,
    businessId,
    slotStart,
    slotEnd,
    employeeId,
    mode: 'reschedule',
    context,
    requestId,
  });
  if (!claimed.ok) {
    return { ok: false, draft: null, reason: claimed.reason || 'error' };
  }

  const updated = await updateConfirmedBookingSlot({
    draftId,
    businessId,
    slotStart,
    slotEnd,
    googleEventId: googleEventId || undefined,
    context,
    requestId,
  });
  if (!updated) {
    return { ok: false, draft: null, reason: 'error' };
  }
  return { ok: true, draft: updated, reason: null };
}

/**
 * Atomic cancel: mark the confirmed booking cancelled (never leaves an orphaned active slot).
 *
 * @param {Object} params
 * @param {string} params.draftId
 * @param {string} params.businessId
 * @param {Record<string, unknown>} [params.context]
 * @param {string | null} [params.requestId]
 * @returns {Promise<{ ok: boolean, draft: DraftBooking | null, reason: string | null }>}
 */
export async function cancelConfirmedBookingAtomic({
  draftId,
  businessId,
  context = {},
  requestId = null,
}) {
  if (!draftId || !businessId) {
    return { ok: false, draft: null, reason: 'error' };
  }

  if (cancelRpcAvailable !== false) {
    const { data, error } = await supabase.rpc('cancel_confirmed_booking', {
      p_draft_id: draftId,
      p_business_id: businessId,
      p_context: context,
    });

    if (error && /PGRST202|could not find the function|cancel_confirmed_booking/i.test(error.message ?? '')) {
      cancelRpcAvailable = false;
    } else if (error) {
      await logError({
        message: 'cancel_confirmed_booking RPC failed',
        source: 'database',
        requestId,
        draftBookingId: draftId,
        businessId,
        error,
      });
      return { ok: false, draft: null, reason: 'error' };
    } else {
      cancelRpcAvailable = true;
      const payload = /** @type {{ ok?: boolean, reason?: string | null, draft?: DraftBooking | null }} */ (data || {});
      if (payload.ok && payload.draft) {
        return { ok: true, draft: payload.draft, reason: null };
      }
      return { ok: false, draft: null, reason: payload.reason === 'not_found' ? 'not_found' : 'error' };
    }
  }

  /** @type {Record<string, unknown>} */
  const updates = {
    state: 'cancelled',
    locked_until: null,
    cancelled_at: new Date().toISOString(),
    conversation_context: context,
  };
  if (pendingExpiresColumnAvailable !== false) {
    updates.pending_expires_at = null;
  }

  let { data, error } = await supabase
    .from('draft_bookings')
    .update(updates)
    .eq('id', draftId)
    .eq('business_id', businessId)
    .eq('state', 'confirmed')
    .select(await draftSelectColumns())
    .single();

  if (error && /pending_expires_at/i.test(error.message ?? '')) {
    pendingExpiresColumnAvailable = false;
    const { pending_expires_at: _p, ...without } = updates;
    ({ data, error } = await supabase
      .from('draft_bookings')
      .update(without)
      .eq('id', draftId)
      .eq('business_id', businessId)
      .eq('state', 'confirmed')
      .select(DRAFT_COLUMNS_NO_PENDING_EXPIRES)
      .single());
  }

  if (error) {
    await logError({
      message: 'cancelConfirmedBookingAtomic fallback failed',
      source: 'database',
      requestId,
      draftBookingId: draftId,
      businessId,
      error,
    });
    return { ok: false, draft: null, reason: 'error' };
  }

  return { ok: true, draft: /** @type {DraftBooking} */ (data), reason: null };
}

/**
 * @param {string} businessId
 * @returns {Promise<DraftBooking[]>}
 */
export async function listPendingConfirmationDrafts(businessId) {
  if (!businessId) return [];
  const columns = await draftSelectColumns();
  const { data, error } = await supabase
    .from('draft_bookings')
    .select(columns)
    .eq('business_id', businessId)
    .eq('state', 'pending_confirmation');

  if (error) {
    if (/pending_expires_at/i.test(error.message ?? '')) {
      pendingExpiresColumnAvailable = false;
      return listPendingConfirmationDrafts(businessId);
    }
    return [];
  }
  return /** @type {DraftBooking[]} */ (data ?? []);
}

/**
 * Marks a pending draft expired and releases the soft lock. Slot times stay for history.
 * @param {Object} params
 * @param {string} params.draftId
 * @param {string} params.businessId
 * @param {Record<string, unknown>} [params.context]
 * @param {string | null} [params.requestId]
 */
export async function markDraftExpired({
  draftId,
  businessId,
  context = {},
  requestId = null,
}) {
  /** @type {Record<string, unknown>} */
  const updates = {
    state: 'expired',
    locked_until: null,
    conversation_context: context,
  };
  if (pendingExpiresColumnAvailable !== false) {
    updates.pending_expires_at = null;
  }

  const { data, error } = await supabase
    .from('draft_bookings')
    .update(updates)
    .eq('id', draftId)
    .eq('business_id', businessId)
    .eq('state', 'pending_confirmation')
    .select(await draftSelectColumns())
    .maybeSingle();

  if (error) {
    await logError({
      message: 'markDraftExpired failed',
      source: 'database',
      businessId,
      requestId,
      draftBookingId: draftId,
      error,
    });
    return null;
  }

  if (data) {
    await clearPendingHoldFromCache({ businessId, draftId, requestId }).catch(() => false);
  }

  return /** @type {DraftBooking | null} */ (data);
}

/**
 * Most recent expired hold for this phone — restores last-intent memory
 * if a DB cron expired the row before the app copied context.
 * @param {string} businessId
 * @param {string} rawPhone
 * @param {number} [maxAgeMs]
 */
export async function getLatestExpiredDraft(businessId, rawPhone, maxAgeMs = 12 * 60 * 60 * 1000) {
  const phoneNumber = toE164(rawPhone);
  const since = new Date(Date.now() - maxAgeMs).toISOString();
  const { data, error } = await supabase
    .from('draft_bookings')
    .select(await draftSelectColumns())
    .eq('business_id', businessId)
    .eq('phone_number', phoneNumber)
    .eq('state', 'expired')
    .not('selected_slot_start', 'is', null)
    .gte('updated_at', since)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    if (/pending_expires_at/i.test(error.message ?? '')) {
      pendingExpiresColumnAvailable = false;
      return getLatestExpiredDraft(businessId, rawPhone, maxAgeMs);
    }
    return null;
  }
  return /** @type {DraftBooking | null} */ (data);
}

/**
 * Admin journal: never selects pending_expires_at (column may be missing).
 * TTL for the UI is hydrated from context / locked_until.
 *
 * @param {string} businessId
 * @param {number} [limit]
 */
export async function listRecentDraftsForJournal(businessId, limit = 40) {
  const cap = Math.min(Math.max(Number(limit) || 40, 1), 100);
  if (!businessId) return [];

  const { data, error } = await supabase
    .from('draft_bookings')
    .select(JOURNAL_COLUMNS)
    .eq('business_id', businessId)
    .order('updated_at', { ascending: false })
    .limit(cap);

  if (!error) {
    return (data ?? []).map(hydrateJournalDraft);
  }

  const retry = await supabase
    .from('draft_bookings')
    .select('id, phone_number, state, selected_service, selected_slot_start, locked_until, google_event_id, created_at')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(cap);

  if (retry.error) {
    await reportQueryFailure({
      table: 'draft_bookings',
      error: retry.error,
      op: 'journal.bookings',
      businessId,
      critical: true,
    });
    return [];
  }

  return (retry.data ?? []).map(hydrateJournalDraft);
}

/**
 * @param {Record<string, unknown>} row
 */
function hydrateJournalDraft(row) {
  const ctx = row.conversation_context && typeof row.conversation_context === 'object'
    ? /** @type {Record<string, unknown>} */ (row.conversation_context)
    : {};
  const pending =
    (typeof ctx.pending_expires_at === 'string' && ctx.pending_expires_at)
    || (typeof row.locked_until === 'string' ? row.locked_until : null);
  return { ...row, pending_expires_at: pending };
}
