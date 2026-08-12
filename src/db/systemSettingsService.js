import { supabase } from '../config/supabase.js';
import { logError } from './loggerService.js';

/**
 * @typedef {Object} GoogleServiceAccountSettings
 * @property {string | null} google_service_account_email
 * @property {string | null} google_service_account_private_key
 */

/** @deprecated alias kept for older callers */
export const GOOGLE_MASTER_KEY = 'google_master';

/** @type {{ settings: GoogleServiceAccountSettings; loadedAt: number } | null} */
let cache = null;
const CACHE_TTL_MS = 60_000;

/**
 * Normalizes a pasted Google SA private key into usable PEM.
 * Handles JSON escapes, wrapping quotes, and Windows line endings.
 * Never invents a key; returns null only when empty / non-string.
 * @param {string | null | undefined} key
 */
function normalizePrivateKey(key) {
  if (!key || typeof key !== 'string') return null;

  let k = key.trim();
  if (!k) return null;

  // Strip wrapping quotes from JSON copy-paste
  if (
    (k.startsWith('"') && k.endsWith('"'))
    || (k.startsWith("'") && k.endsWith("'"))
  ) {
    k = k.slice(1, -1).trim();
  }

  // Unescape JSON-style newlines (possibly double-escaped)
  k = k
    .replace(/\\\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();

  const isRsa = k.includes('BEGIN RSA PRIVATE KEY');
  const begin = isRsa ? '-----BEGIN RSA PRIVATE KEY-----' : '-----BEGIN PRIVATE KEY-----';
  const end = isRsa ? '-----END RSA PRIVATE KEY-----' : '-----END PRIVATE KEY-----';
  const hasPemHeader = k.includes('BEGIN PRIVATE KEY') || k.includes('BEGIN RSA PRIVATE KEY');
  const hasPemFooter = k.includes('END PRIVATE KEY') || k.includes('END RSA PRIVATE KEY');

  // If the PEM is a single line (common when pasting JSON private_key), rebuild wrapping
  if (hasPemHeader && hasPemFooter && (k.match(/\n/g) || []).length < 2) {
    const body = k
      .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/g, '')
      .replace(/-----END (RSA )?PRIVATE KEY-----/g, '')
      .replace(/\s+/g, '');
    const lines = body.match(/.{1,64}/g) || [];
    k = `${begin}\n${lines.join('\n')}\n${end}\n`;
  }

  return k || null;
}

/**
 * Accepts both new field names and legacy service_account_* keys from DB.
 * @param {Record<string, unknown>} [raw]
 * @returns {GoogleServiceAccountSettings}
 */
export function normalizeGoogleMasterSettings(raw = {}) {
  const email =
    (typeof raw.google_service_account_email === 'string' && raw.google_service_account_email.trim())
    || (typeof raw.service_account_email === 'string' && raw.service_account_email.trim())
    || null;

  const privateKey = normalizePrivateKey(
    (typeof raw.google_service_account_private_key === 'string'
      && raw.google_service_account_private_key)
    || (typeof raw.service_account_private_key === 'string' && raw.service_account_private_key)
    || null,
  );

  return {
    google_service_account_email: email,
    google_service_account_private_key: privateKey,
  };
}

/**
 * @param {GoogleServiceAccountSettings} settings
 */
/**
 * @param {string | null | undefined} key
 */
function looksLikePemPrivateKey(key) {
  if (!key || typeof key !== 'string') return false;
  return (
    (key.includes('BEGIN PRIVATE KEY') || key.includes('BEGIN RSA PRIVATE KEY'))
    && (key.includes('END PRIVATE KEY') || key.includes('END RSA PRIVATE KEY'))
    && key.length > 200
  );
}

export function isGoogleServiceAccountConfigured(settings) {
  const s = normalizeGoogleMasterSettings(settings);
  return Boolean(
    s.google_service_account_email && looksLikePemPrivateKey(s.google_service_account_private_key),
  );
}

/**
 * @param {GoogleServiceAccountSettings} settings
 * @deprecated use isGoogleServiceAccountConfigured
 */
export function resolveAuthModeFromSettings(settings) {
  const s = normalizeGoogleMasterSettings(settings);
  if (isGoogleServiceAccountConfigured(s)) {
    return {
      mode: /** @type {'service_account'} */ ('service_account'),
      detail: s.google_service_account_email,
    };
  }
  return { mode: null, detail: 'none' };
}

/**
 * @param {GoogleServiceAccountSettings} settings
 */
export function maskGoogleMasterSettings(settings) {
  const s = normalizeGoogleMasterSettings(settings);
  const mask = (val) =>
    typeof val === 'string' && val.length
      ? `${'*'.repeat(Math.max(0, Math.min(val.length - 4, 24)))}${val.slice(-4)}`
      : null;

  return {
    google_service_account_email: s.google_service_account_email,
    // legacy aliases for older admin UI briefly
    service_account_email: s.google_service_account_email,
    has_google_service_account_private_key: Boolean(s.google_service_account_private_key),
    has_service_account_private_key: Boolean(s.google_service_account_private_key),
    google_service_account_private_key: mask(s.google_service_account_private_key),
    service_account_private_key: mask(s.google_service_account_private_key),
    configured: isGoogleServiceAccountConfigured(s),
  };
}

/**
 * @param {boolean} [forceRefresh]
 * @returns {Promise<GoogleServiceAccountSettings>}
 */
export async function getGoogleMasterSettings(forceRefresh = false) {
  if (!forceRefresh && cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.settings;
  }

  const { data, error } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', GOOGLE_MASTER_KEY)
    .maybeSingle();

  if (error) {
    if (!/does not exist|PGRST205|42P01/i.test(error.message)) {
      await logError({
        message: 'getGoogleMasterSettings failed',
        source: 'database',
        severity: 'warning',
        error,
      });
    }
    cache = { settings: normalizeGoogleMasterSettings({}), loadedAt: Date.now() };
    return cache.settings;
  }

  const settings = normalizeGoogleMasterSettings(
    /** @type {Record<string, unknown>} */ (data?.value ?? {}),
  );
  cache = { settings, loadedAt: Date.now() };
  return settings;
}

export function invalidateGoogleMasterSettingsCache() {
  cache = null;
}

/**
 * @param {Record<string, unknown>} input
 * @returns {Promise<{ settings: ReturnType<typeof maskGoogleMasterSettings> | null; error: string | null }>}
 */
export async function updateGoogleMasterSettings(input) {
  // Read raw row so keep-existing does not depend on normalize returning null
  const { data: rawRow } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', GOOGLE_MASTER_KEY)
    .maybeSingle();
  const rawExisting = /** @type {Record<string, unknown>} */ (rawRow?.value ?? {});
  const existing = normalizeGoogleMasterSettings(rawExisting);

  const keepIfMasked = (incoming, current) => {
    if (incoming === undefined || incoming === null || incoming === '') return current;
    if (typeof incoming === 'string' && incoming.includes('***')) return current;
    return incoming;
  };

  const emailIncoming = input.google_service_account_email ?? input.service_account_email;
  const keyIncoming = input.google_service_account_private_key ?? input.service_account_private_key;

  const emailKept = keepIfMasked(
    emailIncoming,
    existing.google_service_account_email
      || (typeof rawExisting.google_service_account_email === 'string'
        ? rawExisting.google_service_account_email
        : null)
      || (typeof rawExisting.service_account_email === 'string'
        ? rawExisting.service_account_email
        : null),
  );

  // Prefer raw DB key when keeping, so a failed normalize cannot wipe a saved key
  const rawKey =
    (typeof rawExisting.google_service_account_private_key === 'string'
      && rawExisting.google_service_account_private_key)
    || (typeof rawExisting.service_account_private_key === 'string'
      && rawExisting.service_account_private_key)
    || existing.google_service_account_private_key
    || null;

  const keyKept = keepIfMasked(keyIncoming, rawKey);

  // Reject common mistake: pasting private_key_id (~40 hex chars) instead of PEM private_key
  if (
    typeof keyIncoming === 'string'
    && keyIncoming.trim()
    && !String(keyIncoming).includes('***')
    && !looksLikePemPrivateKey(normalizePrivateKey(keyIncoming))
  ) {
    return {
      settings: null,
      error:
        'Private key invalidă. Copiază din JSON câmpul „private_key” complet ' +
        '(începe cu -----BEGIN PRIVATE KEY----- și se termină cu -----END PRIVATE KEY-----), ' +
        'nu „private_key_id”.',
    };
  }

  const next = normalizeGoogleMasterSettings({
    google_service_account_email: emailKept,
    google_service_account_private_key: keyKept,
  });

  // Persist normalized SA fields; if normalize somehow fails, keep raw kept key
  const valueToStore = {
    google_service_account_email: next.google_service_account_email || emailKept || null,
    google_service_account_private_key:
      next.google_service_account_private_key || keyKept || null,
  };

  const { data, error } = await supabase
    .from('system_settings')
    .upsert(
      {
        key: GOOGLE_MASTER_KEY,
        value: valueToStore,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'key' },
    )
    .select('value')
    .single();

  if (error) {
    await logError({
      message: 'updateGoogleMasterSettings failed',
      source: 'database',
      severity: 'error',
      error,
    });
    return { settings: null, error: error.message };
  }

  const saved = normalizeGoogleMasterSettings(
    /** @type {Record<string, unknown>} */ (data?.value ?? valueToStore),
  );
  cache = { settings: saved, loadedAt: Date.now() };
  return { settings: maskGoogleMasterSettings(saved), error: null };
}
