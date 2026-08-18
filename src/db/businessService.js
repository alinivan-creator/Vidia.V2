import { supabase } from '../config/supabase.js';
import { normalizeBusinessPhoneKey } from '../utils/phone.js';
import { reportQueryFailure } from './schemaHealth.js';
import { isJwtClockSkewError } from './schemaErrors.js';
import { listServicesForBusiness } from './serviceCatalog.js';

/** @typedef {'booking' | 'consulting'} BusinessType */
/** @typedef {'active' | 'paused'} BusinessStatus */

/**
 * @typedef {Object} MenuButton
 * @property {string} id
 * @property {string} label
 * @property {string} action
 */

/**
 * @typedef {Object} BusinessServiceItem
 * @property {string} id
 * @property {string} name
 * @property {number | null} [price_ron]
 * @property {number} duration_minutes
 */

/**
 * @typedef {Object} Business
 * @property {string} id
 * @property {string} name
 * @property {string} slug
 * @property {string | null} logo_url
 * @property {string} timezone
 * @property {BusinessType} business_type
 * @property {BusinessStatus} status
 * @property {string} welcome_message
 * @property {string} [confirmation_message]
 * @property {string | null} [terms_url]
 * @property {string | null} [gdpr_url]
 * @property {MenuButton[]} menu_buttons
 * @property {string | null} whatsapp_phone_number_id
 * @property {string | null} whatsapp_business_account_id
 * @property {string | null} whatsapp_access_token
 * @property {string | null} whatsapp_webhook_verify_token
 * @property {string | null} google_calendar_id
 * @property {boolean} [google_calendar_mock_mode]
 * @property {string | null} [twilio_account_sid]
 * @property {string | null} [twilio_auth_token]
 * @property {string} ai_system_prompt
 * @property {string} ai_model
 * @property {number} ai_temperature
 * @property {Record<string, unknown>} booking_settings
 * @property {BusinessServiceItem[]} [services]
 * @property {string} created_at
 * @property {string} updated_at
 */

/** select * — resilient to optional migration columns */
const BUSINESS_COLUMNS = '*';

/**
 * Fills Twilio fields from DB columns or booking_settings bridges.
 * Google Calendar uses Calendar Share: only google_calendar_id + mock_mode on the business.
 * @param {Record<string, unknown> | null} row
 * @returns {Business | null}
 */
export function hydrateBusiness(row) {
  if (!row) return null;

  const settings = /** @type {Record<string, unknown>} */ (row.booking_settings ?? {});
  const g = /** @type {Record<string, unknown>} */ (settings.google ?? {});
  const tw = /** @type {Record<string, unknown>} */ (settings.twilio ?? {});

  return /** @type {Business} */ ({
    ...row,
    google_calendar_mock_mode:
      row.google_calendar_mock_mode ??
      (typeof g.mock_mode === 'boolean' ? g.mock_mode : undefined),
    twilio_account_sid:
      row.twilio_account_sid ?? tw.account_sid ?? null,
    twilio_auth_token:
      row.twilio_auth_token ?? tw.auth_token ?? null,
    services: Array.isArray(row.services) ? row.services : undefined,
  });
}

/**
 * Loads `services` table rows onto the business (fallback: booking_settings.services).
 * @param {Business | null} business
 * @returns {Promise<Business | null>}
 */
export async function withServices(business) {
  if (!business) return null;

  const fromTable = await listServicesForBusiness(business.id);
  if (fromTable.length) {
    return { ...business, services: fromTable };
  }

  const fromJson = /** @type {BusinessServiceItem[]} */ (
    business.booking_settings?.services ?? []
  );
  return { ...business, services: fromJson };
}

/**
 * @param {import('@supabase/supabase-js').PostgrestError} dbError
 * @param {string} context
 * @param {string | null} [businessId]
 * @returns {null}
 */
function handleQueryError(dbError, context, businessId = null) {
  void reportQueryFailure({
    table: 'businesses',
    error: dbError,
    op: context,
    businessId,
    critical: true,
  });
  return null;
}

/**
 * @param {string} businessId
 * @returns {Promise<Business | null>}
 */
export async function getBusinessById(businessId) {
  const { data, error } = await supabase
    .from('businesses')
    .select(BUSINESS_COLUMNS)
    .eq('id', businessId)
    .maybeSingle();

  if (error) {
    return handleQueryError(error, `getBusinessById failed for ${businessId}`, businessId);
  }

  return withServices(hydrateBusiness(/** @type {Record<string, unknown> | null} */ (data)));
}

/**
 * @param {string} phoneNumberId
 * @returns {Promise<Business | null>}
 */
export async function getBusinessByWhatsAppPhoneNumberId(phoneNumberId, options = {}) {
  const includeInactive = options.includeInactive === true;
  let query = supabase
    .from('businesses')
    .select(BUSINESS_COLUMNS)
    .eq('whatsapp_phone_number_id', phoneNumberId);

  if (!includeInactive) {
    query = query.eq('status', 'active');
  }

  const { data, error } = await query.limit(2);

  if (error) {
    return handleQueryError(
      error,
      `getBusinessByWhatsAppPhoneNumberId failed for ${phoneNumberId}`,
    );
  }

  const rows = Array.isArray(data) ? data : [];
  if (rows.length !== 1) {
    if (rows.length > 1) {
      console.error('[db] Duplicate whatsapp_phone_number_id — fail closed', {
        phoneNumberId,
        count: rows.length,
      });
    }
    return null;
  }

  return withServices(hydrateBusiness(/** @type {Record<string, unknown>} */ (rows[0])));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @type {Map<string, { business: Business, cachedAt: number }>} */
const businessByToCache = new Map();
const BUSINESS_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Twilio fallback cache: routing + send credentials only.
 * Never stores ai_system_prompt or conversation_logic.
 * @param {Business} business
 * @returns {Business}
 */
function toTransportCacheBusiness(business) {
  const settings =
    business.booking_settings && typeof business.booking_settings === 'object'
      ? { ...business.booking_settings }
      : {};
  delete settings.conversation_logic;
  return {
    ...business,
    ai_system_prompt: '',
    booking_settings: settings,
  };
}

/**
 * @param {string} toKey
 * @param {Business} business
 */
export function cacheBusinessForWhatsAppTo(toKey, business) {
  const key = normalizeBusinessPhoneKey(toKey);
  if (!key || !business) return;
  businessByToCache.set(key, {
    business: toTransportCacheBusiness(business),
    cachedAt: Date.now(),
  });
}

/**
 * @param {string} toKey
 * @returns {Business | null}
 */
export function getCachedBusinessForWhatsAppTo(toKey) {
  const key = normalizeBusinessPhoneKey(toKey);
  if (!key) return null;
  const hit = businessByToCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.cachedAt > BUSINESS_CACHE_TTL_MS) {
    businessByToCache.delete(key);
    return null;
  }
  return hit.business;
}

/**
 * Drop the To-number cache after a successful miss or Admin number change.
 * @param {string | null | undefined} toKey
 */
export function invalidateBusinessCacheForWhatsAppTo(toKey) {
  const key = normalizeBusinessPhoneKey(toKey);
  if (key) businessByToCache.delete(key);
}

/**
 * Pick the tenant for a normalized WhatsApp To key.
 * Duplicates fail closed — never pick "first match".
 *
 * @template {{ whatsapp_phone_number_id?: string | null }} T
 * @param {T[]} rows
 * @param {string} targetKey
 * @returns {{ kind: 'one', row: T } | { kind: 'none' } | { kind: 'duplicate', count: number }}
 */
export function matchBusinessRowsByPhoneKey(rows, targetKey) {
  if (!targetKey) return { kind: 'none' };
  const matches = (rows || []).filter(
    (row) => normalizeBusinessPhoneKey(row.whatsapp_phone_number_id) === targetKey,
  );
  if (matches.length === 1) return { kind: 'one', row: matches[0] };
  if (matches.length === 0) return { kind: 'none' };
  return { kind: 'duplicate', count: matches.length };
}

/**
 * @param {string} toNumber e.g. "whatsapp:+407..." or "+407..."
 * @param {{ includeInactive?: boolean }} [options]
 * @returns {Promise<Business | null>}
 */
export async function getBusinessByWhatsAppToNumber(toNumber, options = {}) {
  const includeInactive = options.includeInactive === true;
  const targetKey = normalizeBusinessPhoneKey(toNumber);

  console.log('[db] Looking up business by To:', {
    raw: toNumber,
    cleanedDigits: targetKey,
    e164: targetKey ? `+${targetKey}` : null,
    includeInactive,
  });

  if (!targetKey) {
    console.error('Eroare detalii:', { reason: 'Empty To number after cleaning', toNumber });
    return null;
  }

  const rows = await loadBusinessRowsForPhoneLookup(includeInactive, toNumber);
  if (!rows) {
    const cached = getCachedBusinessForWhatsAppTo(toNumber);
    if (cached) {
      console.warn('[db] Business lookup failed — using cached tenant', { targetKey });
      return cached;
    }
    return null;
  }

  const picked = matchBusinessRowsByPhoneKey(rows, targetKey);

  if (picked.kind !== 'one') {
    invalidateBusinessCacheForWhatsAppTo(toNumber);
    if (picked.kind === 'duplicate') {
      console.error('[db] Duplicate WhatsApp To numbers across tenants — fail closed', {
        targetKey,
        count: picked.count,
      });
    } else {
      console.log('[db] No business matched. Candidates:',
        rows.map((row) => ({
          name: row.name,
          status: row.status,
          stored: row.whatsapp_phone_number_id,
          cleaned: normalizeBusinessPhoneKey(row.whatsapp_phone_number_id),
        })),
      );
    }
    return null;
  }

  const match = picked.row;

  const hydrated = await withServices(hydrateBusiness(/** @type {Record<string, unknown>} */ (match)));
  if (hydrated) cacheBusinessForWhatsAppTo(toNumber, hydrated);
  return hydrated;
}

/**
 * @param {boolean} includeInactive
 * @param {string} toNumber
 * @returns {Promise<Record<string, unknown>[] | null>}
 */
async function loadBusinessRowsForPhoneLookup(includeInactive, toNumber) {
  const run = () => {
    let query = supabase
      .from('businesses')
      .select(BUSINESS_COLUMNS)
      .not('whatsapp_phone_number_id', 'is', null);
    if (!includeInactive) query = query.eq('status', 'active');
    return query;
  };

  let { data, error } = await run();

  if (error && isJwtClockSkewError(error)) {
    console.warn('[db] PGRST303 JWT clock skew — retrying business lookup');
    await sleep(900);
    ({ data, error } = await run());
  }

  if (error && isJwtClockSkewError(error)) {
    const lean = supabase
      .from('businesses')
      .select('id, name, status, whatsapp_phone_number_id')
      .not('whatsapp_phone_number_id', 'is', null);
    const second = includeInactive ? lean : lean.eq('status', 'active');
    await sleep(600);
    ({ data, error } = await second);
  }

  if (error) {
    console.error('Eroare detalii:', error);
    return handleQueryError(error, `getBusinessByWhatsAppToNumber failed for ${toNumber}`);
  }

  return /** @type {Record<string, unknown>[]} */ (data ?? []);
}

/**
 * @returns {Promise<Business[]>}
 */
export async function getActiveBusinesses() {
  const { data, error } = await supabase
    .from('businesses')
    .select(BUSINESS_COLUMNS)
    .eq('status', 'active')
    .order('name', { ascending: true });

  if (error) {
    handleQueryError(error, 'getActiveBusinesses failed');
    return [];
  }

  const hydrated = (data ?? [])
    .map((row) => hydrateBusiness(/** @type {Record<string, unknown>} */ (row)))
    .filter(Boolean);

  return Promise.all(hydrated.map((b) => withServices(b)));
}

/**
 * @param {Business | null | undefined} business
 * @returns {boolean}
 */
export function isBusinessOperational(business) {
  return Boolean(business && business.status === 'active');
}

/**
 * @param {Object} params
 * @param {string} params.channelId
 * @param {string} params.resourceId
 * @returns {Promise<Business | null>}
 */
export async function getBusinessByGoogleWebhookChannel({ channelId, resourceId }) {
  let query = supabase.from('businesses').select(BUSINESS_COLUMNS).eq('status', 'active');

  if (channelId) {
    query = query.eq('google_webhook_channel_id', channelId);
  } else if (resourceId) {
    query = query.eq('google_webhook_resource_id', resourceId);
  } else {
    return null;
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    return handleQueryError(error, 'getBusinessByGoogleWebhookChannel failed');
  }

  return withServices(hydrateBusiness(/** @type {Record<string, unknown> | null} */ (data)));
}
