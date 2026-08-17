import { supabase } from '../config/supabase.js';
import { logError } from './loggerService.js';
import {
  decodeSlotId,
  formatSlotLabel,
  getBookingConfig,
  getWeekdayInTimezone,
  intervalsOverlap,
  localToUtc,
  encodeSlotId,
} from '../utils/datetime.js';
import { assertWithinWorkingHours, hasConfiguredOpenDay } from '../utils/workingHours.js';
import { slotMatchesTimeWindow } from '../utils/timeWindow.js';

/** @typedef {import('../db/businessService.js').Business} Business */

/**
 * Expire overdue pending_confirmation locks before computing availability.
 * @param {Business} business
 */
async function releaseExpiredLocks(business) {
  try {
    const { expireStalePendingForBusiness } = await import('../services/pendingExpiryService.js');
    await expireStalePendingForBusiness(business);
  } catch {
    // Availability must still work if expiry helper fails
  }
}

/**
 * @typedef {Object} BusyInterval
 * @property {Date} start
 * @property {Date} end
 */

/**
 * @typedef {Object} AvailableSlot
 * @property {Date} start
 * @property {Date} end
 * @property {string} id
 * @property {string} title
 * @property {string} description
 */

const CACHE_STALE_MS = 15 * 60 * 1000;

/**
 * @param {string} businessId
 * @returns {Promise<boolean>}
 */
export async function isCacheStale(businessId) {
  const { data } = await supabase
    .from('calendar_cache')
    .select('synced_at')
    .eq('business_id', businessId)
    .order('synced_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data?.synced_at) return true;
  return Date.now() - new Date(data.synced_at).getTime() > CACHE_STALE_MS;
}

/**
 * @param {Object} params
 * @param {string} params.businessId
 * @param {Date} params.timeMin
 * @param {Date} params.timeMax
 * @param {string | null} [params.requestId]
 */
export async function getBusyIntervalsFromCache({
  businessId,
  timeMin,
  timeMax,
  employeeId = null,
  requestId = null,
}) {
  let query = supabase
    .from('calendar_cache')
    .select('slot_start, slot_end, status, google_event_id, employee_id')
    .eq('business_id', businessId)
    .in('status', ['busy', 'blocked'])
    .gte('slot_end', timeMin.toISOString())
    .lte('slot_start', timeMax.toISOString());

  // Scope busy intervals to one staff calendar (external widgets on that calendar still sync in)
  if (employeeId) {
    query = query.eq('employee_id', employeeId);
  } else {
    query = query.is('employee_id', null);
  }

  const { data, error } = await query;

  if (error) {
    // Pre-migration: column missing — fall back to business-wide cache
    if (/employee_id|PGRST204/i.test(error.message ?? '')) {
      const fallback = await supabase
        .from('calendar_cache')
        .select('slot_start, slot_end, status, google_event_id')
        .eq('business_id', businessId)
        .in('status', ['busy', 'blocked'])
        .gte('slot_end', timeMin.toISOString())
        .lte('slot_start', timeMax.toISOString());
      return (fallback.data ?? []).map((row) => ({
        start: new Date(row.slot_start),
        end: new Date(row.slot_end),
      }));
    }
    await logError({
      message: 'getBusyIntervalsFromCache failed',
      source: 'database',
      businessId,
      requestId,
      error,
    });
    return [];
  }

  return (data ?? []).map((row) => ({
    start: new Date(row.slot_start),
    end: new Date(row.slot_end),
  }));
}

/**
 * Active soft locks from other pending drafts.
 * @param {Object} params
 * @param {string} params.businessId
 * @param {string | null} [params.excludeDraftId]
 */
export async function getSoftLockIntervals({
  businessId,
  excludeDraftId = null,
  employeeId = null,
}) {
  let query = supabase
    .from('draft_bookings')
    .select('id, selected_slot_start, selected_slot_end, locked_until, employee_id')
    .eq('business_id', businessId)
    .eq('state', 'pending_confirmation')
    .gt('locked_until', new Date().toISOString())
    .not('selected_slot_start', 'is', null)
    .not('selected_slot_end', 'is', null);

  if (excludeDraftId) {
    query = query.neq('id', excludeDraftId);
  }

  const { data, error } = await query;

  if (error) {
    return [];
  }

  return (data ?? [])
    .filter((row) => {
      if (!employeeId) return !row.employee_id;
      return row.employee_id === employeeId || !row.employee_id;
    })
    .map((row) => ({
      start: new Date(/** @type {string} */ (row.selected_slot_start)),
      end: new Date(/** @type {string} */ (row.selected_slot_end)),
    }));
}

/**
 * Upserts busy events into calendar_cache (by google_event_id).
 * @param {Object} params
 * @param {string} params.businessId
 * @param {Object[]} params.events
 * @param {'google_sync' | 'vidia_booking' | 'manual'} params.source
 * @param {string | null} [params.requestId]
 */
export async function upsertBusyEvents({
  businessId,
  events,
  source,
  employeeId = null,
  requestId = null,
}) {
  if (events.length === 0) return 0;

  const rows = events.map((ev) => ({
    business_id: businessId,
    employee_id: employeeId ?? ev.employee_id ?? null,
    slot_start: ev.slot_start,
    slot_end: ev.slot_end,
    status: 'busy',
    source,
    google_event_id: ev.google_event_id,
    google_event_etag: ev.google_event_etag ?? null,
    title: ev.title ?? null,
    metadata: ev.metadata ?? {},
    synced_at: new Date().toISOString(),
  }));

  let upserted = 0;

  for (const row of rows) {
    let existingQuery = supabase
      .from('calendar_cache')
      .select('id')
      .eq('business_id', businessId)
      .eq('google_event_id', row.google_event_id);

    if (row.employee_id) {
      existingQuery = existingQuery.eq('employee_id', row.employee_id);
    }

    const { data: existing } = await existingQuery.maybeSingle();

    if (existing) {
      const { error } = await supabase.from('calendar_cache').update(row).eq('id', existing.id);
      if (!error) upserted += 1;
      else if (/employee_id/i.test(error.message ?? '')) {
        // Pre-migration: strip employee_id and retry
        const { employee_id: _e, ...legacy } = row;
        const { error: e2 } = await supabase.from('calendar_cache').update(legacy).eq('id', existing.id);
        if (!e2) upserted += 1;
      }
    } else {
      const { error } = await supabase.from('calendar_cache').insert(row);
      if (!error) upserted += 1;
      else if (/employee_id/i.test(error.message ?? '')) {
        const { employee_id: _e, ...legacy } = row;
        const { error: e2 } = await supabase.from('calendar_cache').insert(legacy);
        if (!e2) upserted += 1;
      }
    }
  }

  if (upserted < rows.length) {
    await logError({
      message: 'upsertBusyEvents partial failure',
      source: 'database',
      businessId,
      requestId,
      details: { attempted: rows.length, upserted },
    });
  }

  return upserted;
}

/**
 * Removes google_sync rows no longer returned by Google in the synced window.
 * @param {Object} params
 * @param {string} params.businessId
 * @param {Date} params.timeMin
 * @param {Date} params.timeMax
 * @param {string[]} params.activeEventIds
 * @param {string | null} [params.requestId]
 */
export async function removeStaleGoogleEvents({
  businessId,
  timeMin,
  timeMax,
  activeEventIds,
  employeeId = null,
  requestId = null,
}) {
  let query = supabase
    .from('calendar_cache')
    .select('id, google_event_id')
    .eq('business_id', businessId)
    .eq('source', 'google_sync')
    .gte('slot_end', timeMin.toISOString())
    .lte('slot_start', timeMax.toISOString());

  if (employeeId) {
    query = query.eq('employee_id', employeeId);
  } else {
    query = query.is('employee_id', null);
  }

  const { data: existing, error: readError } = await query;

  if (readError) {
    if (/employee_id/i.test(readError.message ?? '')) {
      return; // pre-migration — skip scoped cleanup
    }
    await logError({
      message: 'removeStaleGoogleEvents read failed',
      source: 'database',
      businessId,
      requestId,
      error: readError,
    });
    return;
  }

  const staleIds = (existing ?? [])
    .filter((row) => row.google_event_id && !activeEventIds.includes(row.google_event_id))
    .map((row) => row.id);

  if (staleIds.length === 0) return;

  const { error } = await supabase.from('calendar_cache').delete().in('id', staleIds);

  if (error) {
    await logError({
      message: 'removeStaleGoogleEvents delete failed',
      source: 'database',
      businessId,
      requestId,
      error,
    });
  }
}

/**
 * Computes available slots purely from cache + business hours (no Google API call).
 * @param {Object} params
 * @param {Business} params.business
 * @param {number} params.durationMinutes
 * @param {number} [params.limit]
 * @param {string | null} [params.excludeDraftId]
 * @returns {Promise<AvailableSlot[]>}
 */
export async function getAvailableSlots({
  business,
  durationMinutes,
  limit = 10,
  excludeDraftId = null,
  employeeId = null,
  dateKey = null,
  timeWindow = null,
}) {
  const duration = Number(durationMinutes);
  if (!Number.isFinite(duration) || duration <= 0) return [];
  if (!hasConfiguredOpenDay(business)) return [];

  await releaseExpiredLocks(business);

  const config = getBookingConfig(business);
  const timezone = business.timezone;
  const now = new Date();
  const horizonDays = Math.max(14, Number(config.bookingHorizonDays) || 14);
  const horizonEnd = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);

  const busy = await getBusyIntervalsFromCache({
    businessId: business.id,
    timeMin: now,
    timeMax: horizonEnd,
    employeeId,
  });

  const softLocks = await getSoftLockIntervals({
    businessId: business.id,
    excludeDraftId,
    employeeId,
  });

  const blocked = [...busy, ...softLocks];
  const slots = [];

  /** When a concrete date is requested, scan only that calendar day — never fall back to "today". */
  const dayKeys = [];
  if (dateKey && /^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    dayKeys.push(dateKey);
  } else {
    for (let dayOffset = 0; dayOffset < horizonDays; dayOffset++) {
      const day = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
      const dayKey = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(day);
      if (!dayKeys.includes(dayKey)) dayKeys.push(dayKey);
    }
  }

  for (const dayKey of dayKeys) {
    if (slots.length >= limit) break;
    const noon = localToUtc(dayKey, '12:00', timezone);
    const weekday = getWeekdayInTimezone(noon, timezone);
    if (weekday == null) continue;
    const hours = config.businessHours[String(weekday)];
    if (!hours || !hours.open || !hours.close) continue;

    let cursor = localToUtc(dayKey, hours.open, timezone);
    const dayClose = localToUtc(dayKey, hours.close, timezone);

    while (cursor.getTime() + duration * 60_000 <= dayClose.getTime() && slots.length < limit) {
      const slotEnd = new Date(cursor.getTime() + duration * 60_000);

      if (cursor > now) {
        const hoursOk = assertWithinWorkingHours(business, cursor, slotEnd);
        const overlaps = blocked.some((b) => intervalsOverlap(cursor, slotEnd, b.start, b.end));
        const windowOk = slotMatchesTimeWindow(cursor, timezone, timeWindow);

        if (hoursOk.ok && !overlaps && windowOk) {
          slots.push({
            start: new Date(cursor),
            end: slotEnd,
            id: encodeSlotId(cursor, timezone),
            title: formatSlotLabel(cursor, timezone),
            description: '',
          });
        }
      }

      cursor = new Date(cursor.getTime() + config.slotIntervalMinutes * 60_000);
    }
  }

  return slots.slice(0, limit);
}

/**
 * Validates a slot id against cache availability.
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.slotId
 * @param {number} params.durationMinutes
 * @param {string | null} [params.excludeDraftId]
 * @param {string | null} [params.employeeId]
 */
export async function isSlotAvailable({
  business,
  slotId,
  durationMinutes,
  excludeDraftId = null,
  employeeId = null,
}) {
  const duration = Number(durationMinutes);
  if (!Number.isFinite(duration) || duration <= 0) return false;

  const start = decodeSlotId(slotId, business.timezone);
  if (!start) return false;

  const end = new Date(start.getTime() + duration * 60_000);
  const hoursCheck = assertWithinWorkingHours(business, start, end);
  if (!hoursCheck.ok) return false;

  await releaseExpiredLocks(business);

  const busy = await getBusyIntervalsFromCache({
    businessId: business.id,
    timeMin: start,
    timeMax: end,
    employeeId,
  });
  const softLocks = await getSoftLockIntervals({
    businessId: business.id,
    excludeDraftId,
    employeeId,
  });

  return ![...busy, ...softLocks].some((b) => intervalsOverlap(start, end, b.start, b.end));
}

export { decodeSlotId, encodeSlotId };
