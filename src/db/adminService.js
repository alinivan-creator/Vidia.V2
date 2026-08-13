import { supabase } from '../config/supabase.js';
import { logError } from './loggerService.js';
import { getSchemaHealthSnapshot, reportQueryFailure } from './schemaHealth.js';
import { hydrateBusiness } from './businessService.js';
import { listServicesForBusiness, replaceServicesForBusiness } from './serviceCatalog.js';
import { listRecentDraftsForJournal } from './draftBookingService.js';

/** @typedef {import('./businessService.js').Business} Business */

/** Use * so optional migration columns are returned when present. */
const ADMIN_BUSINESS_COLUMNS = '*';

/**
 * Masks sensitive token fields for admin display.
 * @param {Record<string, unknown>} row
 * @param {Array<{ id: string; name: string; price_ron: number | null; duration_minutes: number }> | null} [services]
 */
function sanitizeBusinessRow(row, services = null) {
  const hydrated = hydrateBusiness(row) ?? row;
  const waToken = /** @type {string | null} */ (hydrated.whatsapp_access_token);
  const twToken = /** @type {string | null} */ (hydrated.twilio_auth_token);

  const mask = (val) =>
    typeof val === 'string' && val.length
      ? `${'*'.repeat(Math.max(0, val.length - 4))}${val.slice(-4)}`
      : null;

  const fromJson = Array.isArray(hydrated.booking_settings?.services)
    ? hydrated.booking_settings.services
    : [];

  const serviceList =
    services ??
    (Array.isArray(hydrated.services) && hydrated.services.length ? hydrated.services : null) ??
    fromJson;

  return {
    ...hydrated,
    whatsapp_access_token: mask(waToken),
    has_whatsapp_token: Boolean(waToken),
    twilio_auth_token: mask(twToken),
    has_twilio_auth_token: Boolean(twToken),
    twilio_account_sid: hydrated.twilio_account_sid ?? null,
    google_calendar_id: hydrated.google_calendar_id ?? null,
    google_calendar_mock_mode: hydrated.google_calendar_mock_mode !== false,
    services: serviceList,
  };
}

/**
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function listAllBusinessesAdmin() {
  const { data, error } = await supabase
    .from('businesses')
    .select(ADMIN_BUSINESS_COLUMNS)
    .order('created_at', { ascending: false });

  if (error) {
    await logError({
      message: 'listAllBusinessesAdmin failed',
      source: 'database',
      severity: 'error',
      error,
    });
    return [];
  }

  return Promise.all(
    (data ?? []).map(async (row) => {
      const fromTable = await listServicesForBusiness(row.id, { activeOnly: false });
      return sanitizeBusinessRow(/** @type {Record<string, unknown>} */ (row), fromTable.length ? fromTable : null);
    }),
  );
}

/**
 * @param {string} name
 * @returns {string}
 */
export function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Default entry menu for new businesses. */
export const DEFAULT_MENU_BUTTONS = [
  { id: 'book', label: '📅 Programare', action: 'start_booking' },
  { id: 'info', label: 'ℹ️ Detalii & Prețuri', action: 'show_info' },
  { id: 'contact', label: '📞 Contact & Locație', action: 'show_contact' },
];

/**
 * Strips masked / empty secrets so updates don't wipe stored values.
 * @param {Record<string, unknown>} payload
 * @param {string[]} keys
 * @param {boolean} isUpdate
 */
function scrubSecrets(payload, keys, isUpdate) {
  for (const key of keys) {
    const val = payload[key];
    if (typeof val === 'string' && val.includes('***')) {
      delete payload[key];
    }
    if ((val === null || val === '') && isUpdate) {
      delete payload[key];
    }
  }
}

/**
 * @param {Record<string, unknown>} input
 * @returns {Promise<{ business: Record<string, unknown> | null; error: string | null }>}
 */
export async function upsertBusinessAdmin(input) {
  const id = /** @type {string | undefined} */ (input.id);
  const name = String(input.name ?? '').trim();

  if (!name) {
    return { business: null, error: 'Numele afacerii este obligatoriu' };
  }

  /** @type {Record<string, unknown> | null} */
  let existingRow = null;
  if (id) {
    const { data: existing } = await supabase
      .from('businesses')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    existingRow = /** @type {Record<string, unknown> | null} */ (existing);
  }

  const businessType = input.business_type === 'consulting' ? 'consulting' : 'booking';
  const slug = String(input.slug ?? slugify(name)).trim() || slugify(name);
  const mockMode =
    input.google_calendar_mock_mode === false || input.google_calendar_mock_mode === 'false'
      ? false
      : true;

  const incomingServices = Array.isArray(input.services)
    ? input.services
    : Array.isArray(/** @type {Record<string, unknown>} */ (input.booking_settings)?.services)
      ? /** @type {unknown[]} */ (/** @type {Record<string, unknown>} */ (input.booking_settings).services)
      : null;

  const existingSettings =
    existingRow?.booking_settings && typeof existingRow.booking_settings === 'object'
      ? /** @type {Record<string, unknown>} */ (existingRow.booking_settings)
      : {};
  const incomingSettings =
    input.booking_settings && typeof input.booking_settings === 'object'
      ? /** @type {Record<string, unknown>} */ (input.booking_settings)
      : {};

  /** @type {Record<string, unknown>} */
  const bookingSettings = {
    ...existingSettings,
    ...incomingSettings,
  };

  // Keep JSON mirror for pre-migration / offline reads
  if (incomingServices) {
    bookingSettings.services = incomingServices;
  }

  const existingGoogle = {
    ...(typeof existingSettings.google === 'object' && existingSettings.google
      ? /** @type {Record<string, unknown>} */ (existingSettings.google)
      : {}),
    ...(typeof bookingSettings.google === 'object' && bookingSettings.google
      ? /** @type {Record<string, unknown>} */ (bookingSettings.google)
      : {}),
  };
  // Calendar Share model: only mock_mode in JSON bridge (no per-business OAuth secrets)
  bookingSettings.google = {
    ...existingGoogle,
    mock_mode: mockMode,
  };
  delete bookingSettings.google.client_id;
  delete bookingSettings.google.client_secret;
  delete bookingSettings.google.refresh_token;

  const existingTwilio = {
    ...(typeof existingSettings.twilio === 'object' && existingSettings.twilio
      ? /** @type {Record<string, unknown>} */ (existingSettings.twilio)
      : {}),
    ...(typeof bookingSettings.twilio === 'object' && bookingSettings.twilio
      ? /** @type {Record<string, unknown>} */ (bookingSettings.twilio)
      : {}),
  };
  /** @type {Record<string, unknown>} */
  const twilioBridge = { ...existingTwilio };
  if (input.twilio_account_sid) twilioBridge.account_sid = input.twilio_account_sid;
  if (input.twilio_auth_token) twilioBridge.auth_token = input.twilio_auth_token;
  bookingSettings.twilio = twilioBridge;

  const welcomeFromInput =
    input.welcome_message != null && String(input.welcome_message).trim()
      ? String(input.welcome_message).trim()
      : null;
  const timezoneFromInput =
    input.timezone != null && String(input.timezone).trim()
      ? String(input.timezone).trim()
      : null;
  const aiModelFromInput =
    input.ai_model != null && String(input.ai_model).trim()
      ? String(input.ai_model).trim()
      : null;
  const aiTempProvided = input.ai_temperature != null && input.ai_temperature !== '';
  const menuButtons = Array.isArray(input.menu_buttons)
    ? input.menu_buttons
    : (existingRow?.menu_buttons ?? DEFAULT_MENU_BUTTONS);

  /** @type {Record<string, unknown>} */
  const basePayload = {
    name,
    slug,
    business_type: businessType,
    status: input.status === 'paused' ? 'paused' : 'active',
    welcome_message:
      welcomeFromInput
      || (typeof existingRow?.welcome_message === 'string' && existingRow.welcome_message.trim()
        ? existingRow.welcome_message
        : `Bun venit la ${name}!`),
    menu_buttons: menuButtons,
    whatsapp_phone_number_id:
      input.whatsapp_phone_number_id != null && String(input.whatsapp_phone_number_id).trim()
        ? String(input.whatsapp_phone_number_id).trim()
        : (id ? (existingRow?.whatsapp_phone_number_id ?? null) : null),
    whatsapp_access_token:
      input.whatsapp_access_token !== undefined
        ? input.whatsapp_access_token
        : (existingRow?.whatsapp_access_token ?? null),
    google_calendar_id:
      input.google_calendar_id != null && String(input.google_calendar_id).trim()
        ? String(input.google_calendar_id).trim()
        : (id ? (existingRow?.google_calendar_id ?? null) : null),
    ai_system_prompt:
      input.ai_system_prompt != null
        ? String(input.ai_system_prompt)
        : (typeof existingRow?.ai_system_prompt === 'string' ? existingRow.ai_system_prompt : ''),
    ai_model:
      aiModelFromInput
      || (typeof existingRow?.ai_model === 'string' && existingRow.ai_model
        ? existingRow.ai_model
        : 'gpt-4o-mini'),
    ai_temperature: aiTempProvided
      ? Number(input.ai_temperature)
      : Number(existingRow?.ai_temperature ?? 0.3),
    booking_settings: bookingSettings,
    timezone:
      timezoneFromInput
      || (typeof existingRow?.timezone === 'string' && existingRow.timezone
        ? existingRow.timezone
        : 'Europe/Bucharest'),
  };

  scrubSecrets(basePayload, ['whatsapp_access_token'], Boolean(id));

  /**
   * Prefer dedicated columns when migration 003 applied
   */
  const fullPayload = {
    ...basePayload,
    google_calendar_mock_mode: mockMode,
    twilio_account_sid:
      input.twilio_account_sid !== undefined && input.twilio_account_sid !== null && String(input.twilio_account_sid).trim()
        ? String(input.twilio_account_sid).trim()
        : (existingRow?.twilio_account_sid ?? null),
    twilio_auth_token:
      input.twilio_auth_token !== undefined
        ? input.twilio_auth_token
        : (existingRow?.twilio_auth_token ?? null),
  };

  scrubSecrets(fullPayload, ['twilio_auth_token', 'whatsapp_access_token'], Boolean(id));
  if (id && (fullPayload.twilio_account_sid === null || fullPayload.twilio_account_sid === '')) {
    delete fullPayload.twilio_account_sid;
  }

  /**
   * @param {Record<string, unknown>} payload
   */
  async function tryWrite(payload) {
    if (id) {
      return supabase
        .from('businesses')
        .update(payload)
        .eq('id', id)
        .select(ADMIN_BUSINESS_COLUMNS)
        .single();
    }
    return supabase
      .from('businesses')
      .insert(payload)
      .select(ADMIN_BUSINESS_COLUMNS)
      .single();
  }

  let { data, error } = await tryWrite(fullPayload);

  if (error && /google_calendar_mock|twilio_account|twilio_auth/i.test(error.message)) {
    // Drop Twilio cols only
    const withoutTwilio = { ...fullPayload };
    delete withoutTwilio.twilio_account_sid;
    delete withoutTwilio.twilio_auth_token;
    ({ data, error } = await tryWrite(withoutTwilio));
  }

  if (error && /google_calendar_mock/i.test(error.message)) {
    ({ data, error } = await tryWrite(basePayload));
  }

  if (error) {
    await logError({
      message: id ? 'upsertBusinessAdmin update failed' : 'upsertBusinessAdmin insert failed',
      source: 'database',
      severity: 'error',
      businessId: id ?? null,
      error,
      details: { slug },
    });
    return { business: null, error: error.message };
  }

  const businessId = /** @type {string} */ (data.id);
  let savedServices = null;

  if (incomingServices) {
    const replaced = await replaceServicesForBusiness(
      businessId,
      /** @type {Array<{ id?: string; name: string; price_ron?: number | null; duration_minutes?: number }>} */ (
        incomingServices
      ),
    );
    if (replaced.ok) {
      savedServices = replaced.services;
    } else if (replaced.error && !/lipsește|does not exist|PGRST205/i.test(replaced.error)) {
      // Soft-warn: business row saved; services stayed in booking_settings JSON
      console.warn('[admin] services table sync:', replaced.error);
    }
  } else {
    savedServices = await listServicesForBusiness(businessId, { activeOnly: false });
  }

  return {
    business: sanitizeBusinessRow(/** @type {Record<string, unknown>} */ (data), savedServices),
    error: null,
  };
}

/**
 * @param {string} businessId
 * @param {'active' | 'paused'} status
 */
export async function setBusinessStatusAdmin(businessId, status) {
  if (!businessId) return { business: null, error: 'ID lipsă' };
  if (status !== 'active' && status !== 'paused') {
    return { business: null, error: 'Status invalid' };
  }

  const { data, error } = await supabase
    .from('businesses')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', businessId)
    .select(ADMIN_BUSINESS_COLUMNS)
    .single();

  if (error) {
    await logError({
      message: 'setBusinessStatusAdmin failed',
      source: 'database',
      severity: 'error',
      businessId,
      error,
    });
    return { business: null, error: error.message };
  }

  const services = await listServicesForBusiness(businessId, { activeOnly: false });
  return {
    business: sanitizeBusinessRow(/** @type {Record<string, unknown>} */ (data), services),
    error: null,
  };
}

/**
 * Hard-deletes a business; related rows cascade via FK.
 * @param {string} businessId
 */
export async function deleteBusinessAdmin(businessId) {
  if (!businessId) return { ok: false, error: 'ID lipsă' };

  const { error } = await supabase.from('businesses').delete().eq('id', businessId);

  if (error) {
    await logError({
      message: 'deleteBusinessAdmin failed',
      source: 'database',
      severity: 'error',
      businessId,
      error,
    });
    return { ok: false, error: error.message };
  }

  return { ok: true, error: null };
}

/**
 * @param {Object} params
 * @param {string | null} [params.businessId]
 * @param {number} [params.limit]
 * @param {boolean} [params.unresolvedOnly]
 * @param {string | null} [params.severity]
 * @param {string | null} [params.source]
 */
export async function getErrorLogsAdmin({
  businessId = null,
  limit = 50,
  unresolvedOnly = false,
  severity = null,
  source = null,
}) {
  let query = supabase
    .from('error_logs')
    .select(
      'id, business_id, severity, source, message, details, request_id, phone_number, http_status, resolved, created_at',
    )
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 200));

  if (businessId) {
    query = query.eq('business_id', businessId);
  }

  if (unresolvedOnly) {
    query = query.eq('resolved', false);
  }

  if (severity) {
    query = query.eq('severity', severity);
  }

  if (source) {
    query = query.eq('source', source);
  }

  const { data, error } = await query;

  if (error) {
    await logError({
      message: 'getErrorLogsAdmin failed',
      source: 'database',
      severity: 'error',
      businessId,
      error,
    });
    return [];
  }

  return data ?? [];
}

/**
 * Per-business journal: errors + callbacks + recent bookings + SMS campaigns.
 * All data is already in Supabase — Admin UI only; no manual DB access needed.
 *
 * @param {string} businessId
 * @param {{ limit?: number }} [opts]
 */
export async function getBusinessJournalAdmin(businessId, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 40, 1), 100);
  if (!businessId) {
    return { logs: [], callbacks: [], bookings: [], smsCampaigns: [], sessions: [], schemaAlerts: [], stats: {} };
  }

  const [logs, callbacksRes, bookings, smsRes, unresolvedRes, sessionsRes, schema] = await Promise.all([
    getErrorLogsAdmin({ businessId, limit, unresolvedOnly: false }),
    supabase
      .from('callback_requests')
      .select('id, business_id, phone_number, message, reason, status, created_at, resolved_at')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false })
      .limit(limit),
    listRecentDraftsForJournal(businessId, limit),
    supabase
      .from('sms_campaigns')
      .select('id, body, status, target_count, sent_count, failed_count, created_at, completed_at')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false })
      .limit(20),
    supabase
      .from('error_logs')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', businessId)
      .eq('resolved', false),
    supabase
      .from('conversation_states')
      .select('id, client_phone, current_step, context_data, updated_at')
      .eq('business_id', businessId)
      .order('updated_at', { ascending: false })
      .limit(limit),
    getSchemaHealthSnapshot().catch(() => ({ alerts: [], status: 'ok' })),
  ]);

  if (callbacksRes.error) {
    void reportQueryFailure({ table: 'callback_requests', error: callbacksRes.error, op: 'journal.callbacks', businessId });
  }
  if (smsRes.error) {
    void reportQueryFailure({ table: 'sms_campaigns', error: smsRes.error, op: 'journal.sms', businessId });
  }
  if (sessionsRes.error) {
    void reportQueryFailure({ table: 'conversation_states', error: sessionsRes.error, op: 'journal.sessions', businessId });
  }

  const callbacks = callbacksRes.error ? [] : (callbacksRes.data ?? []);
  const smsCampaigns = smsRes.error ? [] : (smsRes.data ?? []);
  const sessions = sessionsRes.error ? [] : (sessionsRes.data ?? []);

  const pendingCallbacks = callbacks.filter((c) => c.status === 'pending').length;
  const openErrors = unresolvedRes.count ?? logs.filter((l) => !l.resolved).length;
  const pendingHolds = bookings.filter((b) => b.state === 'pending_confirmation').length;
  const liveSessions = sessions.filter((s) => s.current_step && s.current_step !== 'IDLE').length;

  const pendingByPhone = new Map(
    bookings
      .filter((b) => b.state === 'pending_confirmation')
      .map((b) => [b.phone_number, b]),
  );
  const sessionsWithHolds = sessions.map((s) => ({
    ...s,
    pending_draft: pendingByPhone.get(s.client_phone) ?? null,
  }));

  return {
    logs,
    callbacks,
    bookings,
    smsCampaigns,
    sessions: sessionsWithHolds,
    schemaAlerts: schema.alerts || [],
    stats: {
      openErrors,
      pendingCallbacks,
      recentBookings: bookings.length,
      smsCampaigns: smsCampaigns.length,
      pendingHolds,
      liveSessions,
      schemaDegraded: schema.status === 'degraded',
    },
  };
}

/**
 * @param {string} logId
 */
export async function resolveErrorLog(logId) {
  const { error } = await supabase
    .from('error_logs')
    .update({
      resolved: true,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', logId);

  return !error;
}
