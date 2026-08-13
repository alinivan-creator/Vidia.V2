import { supabase } from '../config/supabase.js';
import { logError } from './loggerService.js';
import { reportQueryFailure } from './schemaHealth.js';
import { toE164 } from '../utils/phone.js';

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
      return supabase.from('draft_bookings').update(p).eq('id', existing.id).select(columns).single();
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
 * @param {Record<string, unknown>} params.service
 * @param {Record<string, unknown>} params.context
 * @param {string | null} [params.requestId]
 */
export async function setSelectedService({
  draftId,
  businessId = null,
  service,
  context,
  requestId = null,
}) {
  let query = supabase
    .from('draft_bookings')
    .update({
      selected_service: service,
      conversation_context: context,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    })
    .eq('id', draftId);
  if (businessId) query = query.eq('business_id', businessId);

  const { data, error } = await query.select(await draftSelectColumns()).single();

  if (error) {
    await logError({
      message: 'setSelectedService failed',
      source: 'database',
      requestId,
      draftBookingId: draftId,
      error,
    });
    return null;
  }

  return /** @type {DraftBooking} */ (data);
}

/**
 * Soft-locks a slot and moves draft to pending_confirmation.
 * @param {Object} params
 * @param {string} params.draftId
 * @param {Date} params.slotStart
 * @param {Date} params.slotEnd
 * @param {Record<string, unknown>} params.context
 * @param {string | null} [params.requestId]
 */
export async function setSelectedSlot({
  draftId,
  businessId = null,
  slotStart,
  slotEnd,
  context,
  ttlMinutes = 5,
  requestId = null,
}) {
  const minutes = Number.isFinite(Number(ttlMinutes))
    ? Math.min(60, Math.max(1, Math.round(Number(ttlMinutes))))
    : 5;
  const ttl = pendingTtlIso(Date.now(), minutes * 60 * 1000);
  const mergedContext = { ...context, pending_expires_at: ttl };

  /** @type {Record<string, unknown>} */
  const payload = {
    state: 'pending_confirmation',
    selected_slot_start: slotStart.toISOString(),
    selected_slot_end: slotEnd.toISOString(),
    locked_until: ttl,
    conversation_context: mergedContext,
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
  if (pendingExpiresColumnAvailable !== false) {
    payload.pending_expires_at = ttl;
  }

  let query = supabase.from('draft_bookings').update(payload).eq('id', draftId);
  if (businessId) query = query.eq('business_id', businessId);

  let { data, error } = await query.select(await draftSelectColumns()).single();

  if (error && /pending_expires_at/i.test(error.message ?? '')) {
    pendingExpiresColumnAvailable = false;
    const { pending_expires_at: _p, ...without } = payload;
    let retry = supabase.from('draft_bookings').update(without).eq('id', draftId);
    if (businessId) retry = retry.eq('business_id', businessId);
    ({ data, error } = await retry.select(DRAFT_COLUMNS_NO_PENDING_EXPIRES).single());
  }

  if (error) {
    await logError({
      message: 'setSelectedSlot failed',
      source: 'database',
      requestId,
      draftBookingId: draftId,
      error,
    });
    return null;
  }

  return /** @type {DraftBooking} */ (data);
}

/**
 * @param {Object} params
 * @param {string} params.draftId
 * @param {string} params.googleEventId
 * @param {string | null} params.googleEventLink
 * @param {Record<string, unknown>} params.context
 * @param {string | null} [params.requestId]
 */
export async function confirmDraftBooking({
  draftId,
  businessId = null,
  googleEventId,
  googleEventLink,
  context,
  requestId = null,
}) {
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

  let query = supabase.from('draft_bookings').update(updates).eq('id', draftId);
  if (businessId) query = query.eq('business_id', businessId);

  let { data, error } = await query.select(await draftSelectColumns()).single();

  if (error && /pending_expires_at/i.test(error.message ?? '')) {
    pendingExpiresColumnAvailable = false;
    const { pending_expires_at: _p, ...without } = updates;
    let retry = supabase.from('draft_bookings').update(without).eq('id', draftId);
    if (businessId) retry = retry.eq('business_id', businessId);
    ({ data, error } = await retry.select(DRAFT_COLUMNS_NO_PENDING_EXPIRES).single());
  }

  if (error) {
    await logError({
      message: 'confirmDraftBooking failed',
      source: 'database',
      requestId,
      draftBookingId: draftId,
      error,
    });
    return null;
  }

  return /** @type {DraftBooking} */ (data);
}

/**
 * @param {Object} params
 * @param {string} params.draftId
 * @param {'cancelled' | 'browsing'} params.state
 * @param {Record<string, unknown>} params.context
 * @param {string | null} [params.requestId]
 */
export async function cancelOrResetDraft({
  draftId,
  businessId = null,
  state,
  context,
  requestId = null,
}) {
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

  let query = supabase.from('draft_bookings').update(updates).eq('id', draftId);
  if (businessId) query = query.eq('business_id', businessId);

  let { data, error } = await query.select(await draftSelectColumns()).single();

  if (error && /pending_expires_at/i.test(error.message ?? '')) {
    pendingExpiresColumnAvailable = false;
    const { pending_expires_at: _p, ...without } = updates;
    let retry = supabase.from('draft_bookings').update(without).eq('id', draftId);
    if (businessId) retry = retry.eq('business_id', businessId);
    ({ data, error } = await retry.select(DRAFT_COLUMNS_NO_PENDING_EXPIRES).single());
  }

  if (error) {
    await logError({
      message: 'cancelOrResetDraft failed',
      source: 'database',
      requestId,
      draftBookingId: draftId,
      error,
    });
    return null;
  }

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

  return /** @type {DraftBooking[]} */ (data ?? []);
}

export async function updateDraftContext({ draftId, context, requestId = null }) {
  const { error } = await supabase
    .from('draft_bookings')
    .update({ conversation_context: context })
    .eq('id', draftId);

  if (error) {
    await logError({
      message: 'updateDraftContext failed',
      source: 'database',
      requestId,
      draftBookingId: draftId,
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
    .limit(5);

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
 * @param {Date | string} params.slotStart
 * @param {Date | string} params.slotEnd
 * @param {Record<string, unknown>} [params.context]
 * @param {string | null} [params.requestId]
 */
export async function updateConfirmedBookingSlot({
  draftId,
  businessId = null,
  slotStart,
  slotEnd,
  context = {},
  googleEventId = undefined,
  requestId = null,
}) {
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

  let query = supabase
    .from('draft_bookings')
    .update(updates)
    .eq('id', draftId)
    .eq('state', 'confirmed');
  if (businessId) query = query.eq('business_id', businessId);

  const { data, error } = await query.select(await draftSelectColumns()).single();

  if (error) {
    await logError({
      message: 'updateConfirmedBookingSlot failed',
      source: 'database',
      requestId,
      draftBookingId: draftId,
      error,
    });
    return null;
  }

  return /** @type {DraftBooking} */ (data);
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
