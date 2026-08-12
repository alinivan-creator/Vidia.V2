import { supabase } from '../config/supabase.js';
import { logError } from './loggerService.js';
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
 * @property {string | null} google_event_id
 * @property {string | null} google_event_link
 * @property {string | null} [employee_id]
 * @property {Record<string, unknown>} conversation_context
 * @property {string} expires_at
 */

const DRAFT_COLUMNS =
  'id, business_id, client_id, phone_number, state, selected_service, selected_slot_start, selected_slot_end, locked_until, google_event_id, google_event_link, employee_id, conversation_context, expires_at';

const DRAFT_COLUMNS_LEGACY =
  'id, business_id, client_id, phone_number, state, selected_service, selected_slot_start, selected_slot_end, locked_until, google_event_id, google_event_link, conversation_context, expires_at';

/** @type {boolean | null} */
let employeeColumnAvailable = null;

async function draftSelectColumns() {
  if (employeeColumnAvailable === false) return DRAFT_COLUMNS_LEGACY;
  return DRAFT_COLUMNS;
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
  requestId = null,
}) {
  const lockedUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  let query = supabase
    .from('draft_bookings')
    .update({
      state: 'pending_confirmation',
      selected_slot_start: slotStart.toISOString(),
      selected_slot_end: slotEnd.toISOString(),
      locked_until: lockedUntil,
      conversation_context: context,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    })
    .eq('id', draftId);
  if (businessId) query = query.eq('business_id', businessId);

  const { data, error } = await query.select(await draftSelectColumns()).single();

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
  let query = supabase
    .from('draft_bookings')
    .update({
      state: 'confirmed',
      google_event_id: googleEventId,
      google_event_link: googleEventLink,
      locked_until: null,
      confirmed_at: new Date().toISOString(),
      conversation_context: context,
    })
    .eq('id', draftId);
  if (businessId) query = query.eq('business_id', businessId);

  const { data, error } = await query.select(await draftSelectColumns()).single();

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

  if (state === 'browsing') {
    updates.selected_slot_start = null;
    updates.selected_slot_end = null;
  }

  let query = supabase.from('draft_bookings').update(updates).eq('id', draftId);
  if (businessId) query = query.eq('business_id', businessId);

  const { data, error } = await query.select(await draftSelectColumns()).single();

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
