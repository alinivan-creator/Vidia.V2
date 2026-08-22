import crypto from 'node:crypto';
import { google } from 'googleapis';
import { supabase } from '../config/supabase.js';
import { googleEnv, GOOGLE_CALENDAR_SCOPE } from '../config/google.js';
import {
  getGoogleMasterSettings,
  isGoogleServiceAccountConfigured,
  invalidateGoogleMasterSettingsCache,
} from '../db/systemSettingsService.js';
import { upsertBusyEvents, removeStaleGoogleEvents } from '../db/cacheService.js';
import { logError } from '../db/loggerService.js';
import { reportCalendarConfigMissing } from '../db/schemaHealth.js';
import { assertWithinWorkingHours, hasConfiguredOpenDay } from '../utils/workingHours.js';

/** @typedef {import('../db/businessService.js').Business} Business */

/**
 * Cached JWT auth client for the Service Account.
 * @type {{ auth: import('google-auth-library').JWT; email: string; keyFingerprint: string; createdAt: number } | null}
 */
let jwtClientCache = null;

/**
 * @param {Business} business
 */
export function isBusinessMockMode(business) {
  return business.google_calendar_mock_mode === true;
}

/**
 * @param {string | null | undefined} eventId
 */
export function isMockEventId(eventId) {
  return typeof eventId === 'string' && eventId.startsWith('mock_evt_');
}

/**
 * Finds a real Google event for a booking when the stored id is missing/mock.
 * Matches by time window + client phone in summary/description.
 * @param {Object} params
 * @param {Business} params.business
 * @param {string | null | undefined} params.phoneNumber
 * @param {string | null | undefined} params.startIso
 * @param {string | null | undefined} params.endIso
 * @param {string | null} [params.requestId]
 * @returns {Promise<string | null>}
 */
export async function findCalendarEventIdForBooking({
  business,
  phoneNumber,
  startIso,
  endIso,
  calendarId = null,
  requestId = null,
}) {
  if (isBusinessMockMode(business) || !startIso || !endIso) return null;

  const resolvedCalendarId = calendarId || business.google_calendar_id;
  if (!resolvedCalendarId) return null;

  try {
    const calendar = await getCalendarClient(business, resolvedCalendarId);
    const padMs = 3 * 60_000;
    const timeMin = new Date(new Date(startIso).getTime() - padMs).toISOString();
    const timeMax = new Date(new Date(endIso).getTime() + padMs).toISOString();
    const phoneHint = typeof phoneNumber === 'string'
      ? phoneNumber.replace(/\D/g, '').slice(-10)
      : '';

    const response = await calendar.events.list({
      calendarId: resolvedCalendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 20,
    });

    const items = response.data.items ?? [];
    if (!items.length) return null;

    const startMs = new Date(startIso).getTime();
    const scored = items
      .map((ev) => {
        const evStart = ev.start?.dateTime || ev.start?.date || null;
        if (!evStart) return null;
        const delta = Math.abs(new Date(evStart).getTime() - startMs);
        const blob = `${ev.summary || ''} ${ev.description || ''}`;
        const phoneMatch = phoneHint && blob.replace(/\D/g, '').includes(phoneHint);
        const vidiaMatch = /vidia|whatsapp/i.test(blob);
        let score = 0;
        if (delta <= 60_000) score += 5;
        else if (delta <= padMs) score += 2;
        else return null;
        if (phoneMatch) score += 4;
        if (vidiaMatch) score += 1;
        return { id: ev.id || null, score };
      })
      .filter((x) => x && x.id);

    scored.sort((a, b) => /** @type {number} */ (b?.score) - /** @type {number} */ (a?.score));
    return scored[0]?.id ?? null;
  } catch (error) {
    console.error('Eroare detalii:', error);
    await logError({
      message: 'findCalendarEventIdForBooking failed',
      source: 'google_calendar',
      severity: 'warning',
      businessId: business.id,
      requestId,
      error,
    });
    return null;
  }
}

/**
 * Resolves a usable Google event id (skips mock ids when calendar is live).
 * @param {Object} params
 * @param {Business} params.business
 * @param {string | null | undefined} params.eventId
 * @param {string | null | undefined} [params.phoneNumber]
 * @param {string | null | undefined} [params.startIso]
 * @param {string | null | undefined} [params.endIso]
 * @param {string | null} [params.requestId]
 */
export async function resolveCalendarEventId({
  business,
  eventId,
  phoneNumber = null,
  startIso = null,
  endIso = null,
  calendarId = null,
  requestId = null,
}) {
  if (isBusinessMockMode(business)) {
    return eventId || null;
  }
  if (eventId && !isMockEventId(eventId)) {
    return eventId;
  }
  return findCalendarEventIdForBooking({
    business,
    phoneNumber,
    startIso,
    endIso,
    calendarId,
    requestId,
  });
}

/**
 * @param {Business} business
 * @param {string | null} [overrideCalendarId]
 */
function assertBusinessCalendarId(business, overrideCalendarId = null) {
  if (!overrideCalendarId && !business.google_calendar_id) {
    throw new Error(
      'Eroare: Afacerea / angajatul nu are configurat google_calendar_id (email calendar partajat).',
    );
  }
}

/**
 * @param {string} privateKey
 */
function fingerprintKey(privateKey) {
  return crypto.createHash('sha256').update(privateKey).digest('hex').slice(0, 16);
}

/**
 * Builds / returns a google.auth.JWT client from Admin Service Account settings.
 * @param {{ forceRefresh?: boolean }} [options]
 * @returns {Promise<import('google-auth-library').JWT>}
 */
async function getServiceAccountAuth(options = {}) {
  invalidateGoogleMasterSettingsCache();
  const settings = await getGoogleMasterSettings(true);

  if (!isGoogleServiceAccountConfigured(settings)) {
    throw new Error(
      'Eroare: Google Service Account nu este configurat în Admin → Setări sistem ' +
        '(google_service_account_email + google_service_account_private_key).',
    );
  }

  const email = /** @type {string} */ (settings.google_service_account_email);
  const privateKey = /** @type {string} */ (settings.google_service_account_private_key);
  const fp = fingerprintKey(privateKey);

  if (
    !options.forceRefresh &&
    jwtClientCache &&
    jwtClientCache.email === email &&
    jwtClientCache.keyFingerprint === fp
  ) {
    return jwtClientCache.auth;
  }

  const auth = new google.auth.JWT({
    email,
    key: privateKey,
    scopes: [GOOGLE_CALENDAR_SCOPE],
  });

  await auth.authorize();

  jwtClientCache = {
    auth,
    email,
    keyFingerprint: fp,
    createdAt: Date.now(),
  };

  console.log('[google-sa] JWT authorized', { clientEmail: email });
  return auth;
}

/**
 * Auth client only — calendar ID is chosen per call (business or employee).
 * @param {Business} business
 * @param {string | null} [calendarId]
 */
async function getCalendarClient(business, calendarId = null) {
  assertBusinessCalendarId(business, calendarId);
  const auth = await getServiceAccountAuth();
  return google.calendar({ version: 'v3', auth });
}

/**
 * Clears Service Account auth cache.
 * @param {string} [_businessId]
 */
export function invalidateGoogleAccessToken(_businessId) {
  jwtClientCache = null;
  invalidateGoogleMasterSettingsCache();
}

/**
 * Exposes a bearer token for legacy callers / diagnostics.
 * @param {Business} business
 * @param {string | null} [requestId]
 * @param {{ forceRefresh?: boolean }} [options]
 */
async function getAccessToken(business, requestId = null, options = {}) {
  if (isBusinessMockMode(business)) {
    return 'mock-access-token';
  }

  try {
    assertBusinessCalendarId(business);
    const auth = await getServiceAccountAuth({ forceRefresh: options.forceRefresh });
    const token = await auth.getAccessToken();
    return token?.token ?? null;
  } catch (error) {
    console.error('Eroare detalii:', error);
    await logError({
      message: error instanceof Error ? error.message : 'Google Service Account auth failed',
      source: 'google_calendar',
      severity: 'error',
      businessId: business.id,
      requestId,
      error,
    });
    return null;
  }
}

/**
 * @param {unknown} error
 */
function googleErrorStatus(error) {
  const err = /** @type {{ code?: number; response?: { status?: number } }} */ (error);
  return Number(err.code ?? err.response?.status ?? 0) || 0;
}

/**
 * Fetches events from a shared calendar (business or employee) and mirrors busy slots.
 * External booking widgets on the same shared calendar appear as busy — no double-booking.
 *
 * @param {Object} params
 * @param {import('../db/businessService.js').Business} params.business
 * @param {Date} params.timeMin
 * @param {Date} params.timeMax
 * @param {string | null} [params.calendarId] — override (employee calendar)
 * @param {string | null} [params.employeeId]
 * @param {string | null} [params.requestId]
 */
export async function syncEventsToCache({
  business,
  timeMin,
  timeMax,
  calendarId = null,
  employeeId = null,
  requestId = null,
}) {
  if (isBusinessMockMode(business)) {
    console.log('[vidia-v2][google-mock] syncEventsToCache skipped');
    return { synced: 0, mocked: true };
  }

  const resolvedCalendarId = calendarId || business.google_calendar_id;
  if (!resolvedCalendarId) {
    return { synced: 0, error: 'missing_calendar_id' };
  }

  try {
    const calendar = await getCalendarClient(business, resolvedCalendarId);

    const response = await calendar.events.list({
      calendarId: resolvedCalendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    });

    const items = response.data.items ?? [];
    const events = items
      .filter((ev) => ev.status !== 'cancelled')
      .map((ev) => {
        const startRaw = ev.start ?? {};
        const endRaw = ev.end ?? {};
        const slotStart = startRaw.dateTime ?? `${startRaw.date}T00:00:00Z`;
        const slotEnd = endRaw.dateTime ?? `${endRaw.date}T00:00:00Z`;

        return {
          google_event_id: /** @type {string} */ (ev.id),
          google_event_etag: ev.etag ?? undefined,
          slot_start: slotStart,
          slot_end: slotEnd,
          title: ev.summary ?? undefined,
          metadata: {
            htmlLink: ev.htmlLink,
            source: 'google_sync',
            calendarId: resolvedCalendarId,
            employeeId: employeeId ?? null,
          },
        };
      });

    const activeEventIds = events.map((e) => e.google_event_id);
    await removeStaleGoogleEvents({
      businessId: business.id,
      timeMin,
      timeMax,
      activeEventIds,
      employeeId,
      requestId,
    });

    const synced = await upsertBusyEvents({
      businessId: business.id,
      events,
      source: 'google_sync',
      employeeId,
      requestId,
    });

    return { synced, eventCount: events.length };
  } catch (error) {
    console.error('Eroare detalii:', error);
    await logError({
      message: 'syncEventsToCache failed',
      source: 'google_calendar',
      severity: 'error',
      businessId: business.id,
      requestId,
      httpStatus: googleErrorStatus(error),
      error,
      details: { calendarId: resolvedCalendarId, employeeId },
    });
    return { synced: 0, error };
  }
}

/**
 * Lazy sync — refreshes cache if stale (>15 min) or empty.
 * Pass `force: true` for modify/reschedule so availability matches Google Calendar live.
 *
 * @param {Object} params
 * @param {import('../db/businessService.js').Business} params.business
 * @param {string | null} [params.requestId]
 * @param {boolean} [params.force]
 * @param {string | null} [params.calendarId]
 * @param {string | null} [params.employeeId]
 */
export async function lazySyncCalendar({
  business,
  requestId = null,
  force = false,
  calendarId = null,
  employeeId = null,
}) {
  if (!hasConfiguredOpenDay(business)) {
    return { skipped: true, reason: 'admin_hours_closed' };
  }

  const horizonDays = Number(business.booking_settings?.booking_horizon_days ?? 7);
  const timeMin = new Date();
  const timeMax = new Date(Date.now() + horizonDays * 24 * 60 * 60 * 1000);

  if (!force) {
    let latestQuery = supabase
      .from('calendar_cache')
      .select('synced_at')
      .eq('business_id', business.id)
      .order('synced_at', { ascending: false })
      .limit(1);

    if (employeeId) {
      latestQuery = latestQuery.eq('employee_id', employeeId);
    } else {
      latestQuery = latestQuery.is('employee_id', null);
    }

    const { data: latest } = await latestQuery.maybeSingle();

    const staleMs = 15 * 60 * 1000;
    const isStale = !latest?.synced_at || Date.now() - new Date(latest.synced_at).getTime() > staleMs;

    if (!isStale) {
      return { skipped: true, reason: 'cache_fresh' };
    }
  }

  return syncEventsToCache({
    business,
    timeMin,
    timeMax,
    calendarId,
    employeeId,
    requestId,
  });
}

/**
 * Creates an event on the business or employee shared calendar via Service Account.
 * @param {Object} params
 * @param {import('../db/businessService.js').Business} params.business
 * @param {{ summary: string; description?: string; startIso: string; endIso: string }} params.event
 * @param {string | null} [params.calendarId]
 * @param {string | null} [params.employeeId]
 * @param {string | null} [params.requestId]
 */
export async function createCalendarEvent({
  business,
  event,
  calendarId = null,
  employeeId = null,
  requestId = null,
}) {
  const hoursCheck = assertWithinWorkingHours(business, event.startIso, event.endIso);
  if (!hoursCheck.ok) {
    return {
      ok: false,
      eventId: null,
      htmlLink: null,
      error: hoursCheck.message,
      reason: hoursCheck.reason,
    };
  }

  const resolvedCalendarId = calendarId || business.google_calendar_id;

  if (isBusinessMockMode(business)) {
    const mockId = `mock_evt_${Date.now()}`;
    try {
      await upsertBusyEvents({
        businessId: business.id,
        employeeId,
        events: [{
          google_event_id: mockId,
          slot_start: event.startIso,
          slot_end: event.endIso,
          title: event.summary,
          metadata: { mocked: true, employeeId },
        }],
        source: 'vidia_booking',
        requestId,
      });
    } catch (error) {
      console.error('Eroare detalii:', error);
    }

    console.log('[google-calendar] Mock event created:', mockId);
    return { ok: true, eventId: mockId, htmlLink: null, mocked: true };
  }

  if (!resolvedCalendarId) {
    await reportCalendarConfigMissing({
      businessId: business.id,
      employeeId,
      op: 'createCalendarEvent',
    });
    return { ok: false, eventId: null, htmlLink: null, error: 'Missing google_calendar_id' };
  }

  try {
    const calendar = await getCalendarClient(business, resolvedCalendarId);

    const response = await calendar.events.insert({
      calendarId: resolvedCalendarId,
      requestBody: {
        summary: event.summary,
        description: event.description ?? '',
        start: { dateTime: event.startIso, timeZone: business.timezone },
        end: { dateTime: event.endIso, timeZone: business.timezone },
      },
    });

    const eventId = response.data.id;
    if (!eventId) {
      return { ok: false, eventId: null, htmlLink: null, error: 'Missing event id from Google' };
    }

    await upsertBusyEvents({
      businessId: business.id,
      employeeId,
      events: [{
        google_event_id: eventId,
        google_event_etag: response.data.etag ?? undefined,
        slot_start: event.startIso,
        slot_end: event.endIso,
        title: event.summary,
      }],
      source: 'vidia_booking',
      requestId,
    });

    return {
      ok: true,
      eventId,
      htmlLink: response.data.htmlLink ?? null,
      mocked: false,
    };
  } catch (error) {
    console.error('Eroare detalii:', error);
    const message = error instanceof Error ? error.message : String(error);
    await logError({
      message: message.startsWith('Eroare:') ? message : 'createCalendarEvent failed',
      source: 'google_calendar',
      severity: 'error',
      businessId: business.id,
      requestId,
      httpStatus: googleErrorStatus(error),
      error,
      details: { calendarId: resolvedCalendarId, employeeId },
    });
    return { ok: false, eventId: null, htmlLink: null, error: message };
  }
}

/**
 * Live FreeBusy check against Google (bypasses calendar_cache staleness).
 * Returns true when the interval overlaps any busy block on the calendar.
 *
 * @param {Object} params
 * @param {import('../db/businessService.js').Business} params.business
 * @param {string} params.startIso
 * @param {string} params.endIso
 * @param {string | null} [params.calendarId]
 * @param {string | null} [params.requestId]
 * @returns {Promise<boolean>}
 */
export async function isGoogleSlotBusy({
  business,
  startIso,
  endIso,
  calendarId = null,
  requestId = null,
}) {
  if (isBusinessMockMode(business)) return false;

  const resolvedCalendarId = calendarId || business.google_calendar_id;
  if (!resolvedCalendarId || !startIso || !endIso) return false;

  try {
    const calendar = await getCalendarClient(business, resolvedCalendarId);
    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: startIso,
        timeMax: endIso,
        items: [{ id: resolvedCalendarId }],
      },
    });
    const busy = response.data?.calendars?.[resolvedCalendarId]?.busy;
    return Array.isArray(busy) && busy.length > 0;
  } catch (error) {
    console.error('[google-calendar] freebusy query failed', error);
    await logError({
      message: 'isGoogleSlotBusy freebusy failed',
      source: 'google_calendar',
      businessId: business.id,
      requestId,
      error,
      details: { calendarId: resolvedCalendarId },
    });
    // Fail closed for confirm safety when we cannot verify.
    return true;
  }
}

/**
 * True when Google has another event overlapping this interval
 * (excluding our own pending/confirmed event ids).
 *
 * @param {Object} params
 * @param {import('../db/businessService.js').Business} params.business
 * @param {string} params.startIso
 * @param {string} params.endIso
 * @param {string | null} [params.calendarId]
 * @param {string[]} [params.excludeEventIds]
 * @param {string | null} [params.requestId]
 */
export async function hasExternalGoogleOverlap({
  business,
  startIso,
  endIso,
  calendarId = null,
  excludeEventIds = [],
  requestId = null,
}) {
  if (isBusinessMockMode(business)) return false;

  const resolvedCalendarId = calendarId || business.google_calendar_id;
  if (!resolvedCalendarId || !startIso || !endIso) return false;

  const exclude = new Set(
    (Array.isArray(excludeEventIds) ? excludeEventIds : [])
      .filter((id) => typeof id === 'string' && id.trim())
      .map((id) => id.trim()),
  );

  try {
    const calendar = await getCalendarClient(business, resolvedCalendarId);
    const response = await calendar.events.list({
      calendarId: resolvedCalendarId,
      timeMin: startIso,
      timeMax: endIso,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    });

    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();
    const items = response.data.items ?? [];

    return items.some((ev) => {
      if (!ev?.id || ev.status === 'cancelled') return false;
      if (exclude.has(ev.id)) return false;
      const a = new Date(ev.start?.dateTime || `${ev.start?.date}T00:00:00Z`).getTime();
      const b = new Date(ev.end?.dateTime || `${ev.end?.date}T00:00:00Z`).getTime();
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return a < endMs && startMs < b;
    });
  } catch (error) {
    console.error('[google-calendar] overlap list failed', error);
    await logError({
      message: 'hasExternalGoogleOverlap failed',
      source: 'google_calendar',
      businessId: business.id,
      requestId,
      error,
      details: { calendarId: resolvedCalendarId },
    });
    return true;
  }
}

/**
 * Updates an existing calendar event (reschedule).
 */
export async function updateCalendarEvent({
  business,
  eventId,
  updates,
  calendarId = null,
  requestId = null,
}) {
  const startIso =
    /** @type {{ dateTime?: string } | undefined} */ (updates.start)?.dateTime ?? null;
  const endIso =
    /** @type {{ dateTime?: string } | undefined} */ (updates.end)?.dateTime ?? null;

  if (startIso && endIso) {
    const hoursCheck = assertWithinWorkingHours(business, startIso, endIso);
    if (!hoursCheck.ok) {
      return { ok: false, error: hoursCheck.message, reason: hoursCheck.reason };
    }
  }

  const resolvedCalendarId = calendarId || business.google_calendar_id;

  const syncLocalCache = async () => {
    if (!startIso || !endIso) return;
    /** @type {Record<string, unknown>} */
    const patch = {
      slot_start: startIso,
      slot_end: endIso,
      synced_at: new Date().toISOString(),
    };
    if (typeof updates.summary === 'string') {
      patch.title = updates.summary;
    }
    await supabase
      .from('calendar_cache')
      .update(patch)
      .eq('business_id', business.id)
      .eq('google_event_id', eventId);
  };

  if (isBusinessMockMode(business)) {
    try {
      await syncLocalCache();
    } catch (error) {
      console.error('Eroare detalii:', error);
    }
    return { ok: true, mocked: true };
  }

  if (!eventId || isMockEventId(eventId)) {
    return {
      ok: false,
      mocked: false,
      error: 'Missing real Google event id for reschedule',
    };
  }

  try {
    const calendar = await getCalendarClient(business, resolvedCalendarId);

    await calendar.events.patch({
      calendarId: /** @type {string} */ (resolvedCalendarId),
      eventId,
      requestBody: /** @type {Record<string, unknown>} */ (updates),
    });

    await syncLocalCache();
    return { ok: true, mocked: false };
  } catch (error) {
    console.error('Eroare detalii:', error);
    await logError({
      message: 'updateCalendarEvent failed',
      source: 'google_calendar',
      severity: 'error',
      businessId: business.id,
      requestId,
      httpStatus: googleErrorStatus(error),
      error,
    });
    return {
      ok: false,
      mocked: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Deletes a calendar event.
 */
export async function deleteCalendarEvent({
  business,
  eventId,
  calendarId = null,
  requestId = null,
}) {
  if (isBusinessMockMode(business)) {
    if (eventId) {
      await supabase
        .from('calendar_cache')
        .delete()
        .eq('business_id', business.id)
        .eq('google_event_id', eventId);
    }
    return { ok: true, mocked: true };
  }

  if (!eventId || isMockEventId(eventId)) {
    return {
      ok: false,
      mocked: false,
      error: 'Missing real Google event id for delete',
    };
  }

  const resolvedCalendarId = calendarId || business.google_calendar_id;

  try {
    const calendar = await getCalendarClient(business, resolvedCalendarId);

    await calendar.events.delete({
      calendarId: /** @type {string} */ (resolvedCalendarId),
      eventId,
    });

    await supabase
      .from('calendar_cache')
      .delete()
      .eq('business_id', business.id)
      .eq('google_event_id', eventId);

    return { ok: true, mocked: false };
  } catch (error) {
    const status = googleErrorStatus(error);
    if (status === 404) {
      await supabase
        .from('calendar_cache')
        .delete()
        .eq('business_id', business.id)
        .eq('google_event_id', eventId);
      return { ok: true, mocked: false, status: 404 };
    }

    console.error('Eroare detalii:', error);
    await logError({
      message: 'deleteCalendarEvent failed',
      source: 'google_calendar',
      severity: 'error',
      businessId: business.id,
      requestId,
      httpStatus: status,
      error,
    });
    return {
      ok: false,
      status,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Registers Google Calendar push notifications (webhook) for a business calendar.
 */
export async function registerCalendarWatch({ business, requestId = null }) {
  if (!googleEnv.webhookBaseUrl) {
    await logError({
      message: 'PUBLIC_WEBHOOK_BASE_URL not set — cannot register Google Calendar watch',
      source: 'google_calendar',
      severity: 'warning',
      businessId: business.id,
      requestId,
    });
    return { ok: false };
  }

  const channelId = crypto.randomUUID();
  const webhookUrl = `${googleEnv.webhookBaseUrl.replace(/\/$/, '')}/webhook/google/calendar`;

  try {
    const calendar = await getCalendarClient(business);
    const calendarId = /** @type {string} */ (business.google_calendar_id);

    const response = await calendar.events.watch({
      calendarId,
      requestBody: {
        id: channelId,
        type: 'web_hook',
        address: webhookUrl,
      },
    });

    const expirationMs = Number(response.data.expiration ?? Date.now() + 7 * 24 * 3600 * 1000);

    await supabase
      .from('businesses')
      .update({
        google_webhook_channel_id: channelId,
        google_webhook_resource_id: response.data.resourceId,
        google_webhook_expiration: new Date(expirationMs).toISOString(),
      })
      .eq('id', business.id);

    return { ok: true, channelId, resourceId: response.data.resourceId };
  } catch (error) {
    console.error('Eroare detalii:', error);
    await logError({
      message: 'registerCalendarWatch failed',
      source: 'google_calendar',
      severity: 'error',
      businessId: business.id,
      requestId,
      httpStatus: googleErrorStatus(error),
      error,
    });
    return { ok: false };
  }
}

export { getAccessToken as getGoogleAccessToken };
