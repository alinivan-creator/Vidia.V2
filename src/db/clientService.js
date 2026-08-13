import { supabase } from '../config/supabase.js';
import { logError } from './loggerService.js';
import { toE164 } from '../utils/phone.js';

/**
 * @typedef {Object} Client
 * @property {string} id
 * @property {string} business_id
 * @property {string} phone_number
 * @property {string | null} display_name
 * @property {string | null} email
 * @property {string} first_contact_at
 * @property {string} last_contact_at
 */

/**
 * @typedef {Object} UpsertClientResult
 * @property {Client | null} client
 * @property {boolean} isNew — true when this WhatsApp phone was just created for the business
 */

const CLIENT_COLUMNS =
  'id, business_id, phone_number, display_name, email, first_contact_at, last_contact_at';

/**
 * Creates or updates a client record and refreshes last_contact_at.
 * Phone is captured automatically from WhatsApp (E.164).
 *
 * @param {Object} params
 * @param {string} params.businessId
 * @param {string} params.rawPhone Meta `from` field (digits)
 * @param {string | null} [params.requestId]
 * @returns {Promise<UpsertClientResult>}
 */
export async function upsertClient({ businessId, rawPhone, requestId = null }) {
  const phoneNumber = toE164(rawPhone);
  const now = new Date().toISOString();

  if (!phoneNumber) {
    return { client: null, isNew: false };
  }

  const { data: existing, error: readError } = await supabase
    .from('clients')
    .select(CLIENT_COLUMNS)
    .eq('business_id', businessId)
    .eq('phone_number', phoneNumber)
    .maybeSingle();

  if (readError) {
    await logError({
      message: 'upsertClient read failed',
      source: 'database',
      businessId,
      requestId,
      phoneNumber,
      error: readError,
    });
    return { client: null, isNew: false };
  }

  if (existing) {
    const { data, error } = await supabase
      .from('clients')
      .update({ last_contact_at: now })
      .eq('id', existing.id)
      .select(CLIENT_COLUMNS)
      .single();

    if (error) {
      await logError({
        message: 'upsertClient update failed',
        source: 'database',
        businessId,
        requestId,
        phoneNumber,
        error,
      });
      return { client: null, isNew: false };
    }

    return { client: /** @type {Client} */ (data), isNew: false };
  }

  const { data, error } = await supabase
    .from('clients')
    .insert({
      business_id: businessId,
      phone_number: phoneNumber,
      last_contact_at: now,
      first_contact_at: now,
    })
    .select(CLIENT_COLUMNS)
    .single();

  if (error) {
    await logError({
      message: 'upsertClient insert failed',
      source: 'database',
      businessId,
      requestId,
      phoneNumber,
      error,
    });
    return { client: null, isNew: false };
  }

  return { client: /** @type {Client} */ (data), isNew: true };
}

/**
 * @param {Object} params
 * @param {string} params.businessId
 * @param {string} params.rawPhone
 * @param {string | null} [params.requestId]
 * @returns {Promise<Client | null>}
 */
export async function getClientByPhone({ businessId, rawPhone, requestId = null }) {
  const phoneNumber = toE164(rawPhone);
  if (!phoneNumber) return null;

  const { data, error } = await supabase
    .from('clients')
    .select(CLIENT_COLUMNS)
    .eq('business_id', businessId)
    .eq('phone_number', phoneNumber)
    .maybeSingle();

  if (error) {
    await logError({
      message: 'getClientByPhone failed',
      source: 'database',
      businessId,
      requestId,
      phoneNumber,
      error,
    });
    return null;
  }

  return /** @type {Client | null} */ (data);
}

/**
 * Saves the client's display name collected during booking.
 *
 * @param {Object} params
 * @param {string} params.clientId
 * @param {string} params.displayName
 * @param {string | null} [params.businessId]
 * @param {string | null} [params.requestId]
 * @returns {Promise<Client | null>}
 */
export async function updateClientDisplayName({
  clientId,
  displayName,
  businessId = null,
  requestId = null,
}) {
  const cleaned = String(displayName ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

  if (!clientId || cleaned.length < 2) return null;

  const { data, error } = await supabase
    .from('clients')
    .update({ display_name: cleaned })
    .eq('id', clientId)
    .select(CLIENT_COLUMNS)
    .single();

  if (error) {
    await logError({
      message: 'updateClientDisplayName failed',
      source: 'database',
      businessId,
      requestId,
      error,
      details: { clientId },
    });
    return null;
  }

  return /** @type {Client} */ (data);
}

/**
 * Validates a free-text name reply (rejects menu keywords / pure digits).
 * @param {string} text
 * @returns {string | null} cleaned name or null if invalid
 */
export function parseClientNameReply(text) {
  const cleaned = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

  if (cleaned.length < 2) return null;
  if (/^\d{1,2}$/.test(cleaned)) return null;

  const n = cleaned
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const blocked = [
    'programare', 'reprogramare', 'anuleaza', 'anulez', 'meniu', 'menu',
    'contact', 'pret', 'info', 'da', 'nu', 'ok', 'confirm', 'callback',
  ];
  if (blocked.some((k) => n === k)) return null;

  const dayHints = [
    'luni', 'marti', 'miercuri', 'joi', 'vineri', 'sambata', 'duminica',
    'maine', 'azi', 'poimaine',
  ];
  if (dayHints.some((d) => n.includes(d))) return null;
  if (/\b\d{1,2}([:.]h?\d{2})?\b/.test(n) && /\b(la|ora|pe)\b/.test(n)) return null;

  // Reject obvious non-names (URLs, emails)
  if (/https?:\/\//i.test(cleaned) || /@/.test(cleaned)) return null;

  return cleaned;
}
