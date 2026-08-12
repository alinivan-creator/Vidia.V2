import { supabase } from '../config/supabase.js';
import { logError } from './loggerService.js';
import { toE164 } from '../utils/phone.js';

/**
 * @typedef {Object} CallbackRequest
 * @property {string} id
 * @property {string} business_id
 * @property {string | null} client_id
 * @property {string} phone_number
 * @property {string} message
 * @property {string | null} reason
 * @property {string} status
 * @property {string} created_at
 */

/**
 * Persists a human-callback request and mirrors it into error_logs for Admin visibility.
 *
 * @param {Object} params
 * @param {string} params.businessId
 * @param {string} params.rawPhone
 * @param {string} params.message
 * @param {string} [params.reason]
 * @param {string | null} [params.clientId]
 * @param {string | null} [params.requestId]
 * @returns {Promise<CallbackRequest | null>}
 */
export async function createCallbackRequest({
  businessId,
  rawPhone,
  message,
  reason = 'out_of_scope',
  clientId = null,
  requestId = null,
}) {
  const phoneNumber = toE164(rawPhone);
  const trimmed = String(message ?? '').trim().slice(0, 2000);

  if (!phoneNumber || !trimmed) {
    return null;
  }

  let row = null;

  try {
    const { data, error } = await supabase
      .from('callback_requests')
      .insert({
        business_id: businessId,
        client_id: clientId,
        phone_number: phoneNumber,
        message: trimmed,
        reason,
        status: 'pending',
        request_id: requestId,
      })
      .select('id, business_id, client_id, phone_number, message, reason, status, created_at')
      .single();

    if (error) {
      // Table may not exist yet (migration pending) — still log for the team
      console.warn('[callbackRequestService] insert failed, falling back to error_logs:', error.message);
    } else {
      row = /** @type {CallbackRequest} */ (data);
    }
  } catch (error) {
    console.error('Eroare detalii:', error);
  }

  await logError({
    message: `Cerere callback: ${trimmed.slice(0, 180)}`,
    source: 'webhook',
    severity: 'info',
    businessId,
    requestId,
    phoneNumber,
    details: {
      type: 'callback_request',
      reason,
      clientId,
      callbackRequestId: row?.id ?? null,
      message: trimmed,
    },
  });

  return row;
}

/**
 * Admin: list callback requests for a business.
 * @param {string} businessId
 * @param {{ status?: string | null; limit?: number }} [opts]
 * @returns {Promise<CallbackRequest[]>}
 */
export async function listCallbackRequestsAdmin(businessId, opts = {}) {
  if (!businessId) return [];

  let query = supabase
    .from('callback_requests')
    .select('id, business_id, client_id, phone_number, message, reason, status, created_at, resolved_at')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Number(opts.limit) || 50, 1), 100));

  if (opts.status) {
    query = query.eq('status', opts.status);
  }

  const { data, error } = await query;
  if (error) {
    if (/does not exist|PGRST205|42P01/i.test(error.message ?? '')) return [];
    console.warn('[callbackRequestService] list failed:', error.message);
    return [];
  }
  return /** @type {CallbackRequest[]} */ (data ?? []);
}

/**
 * Admin: update callback status (pending | contacted | closed).
 * @param {Object} params
 * @param {string} params.businessId
 * @param {string} params.callbackId
 * @param {'pending' | 'contacted' | 'closed'} params.status
 */
export async function updateCallbackRequestStatus({ businessId, callbackId, status }) {
  const allowed = new Set(['pending', 'contacted', 'closed']);
  if (!businessId || !callbackId || !allowed.has(status)) {
    return { callback: null, error: 'Parametri invalizi' };
  }

  /** @type {Record<string, unknown>} */
  const patch = {
    status,
    updated_at: new Date().toISOString(),
    resolved_at: status === 'closed' ? new Date().toISOString() : null,
  };

  const { data, error } = await supabase
    .from('callback_requests')
    .update(patch)
    .eq('id', callbackId)
    .eq('business_id', businessId)
    .select('id, business_id, client_id, phone_number, message, reason, status, created_at, resolved_at')
    .maybeSingle();

  if (error) {
    return { callback: null, error: error.message };
  }
  if (!data) {
    return { callback: null, error: 'Cerere negăsită' };
  }
  return { callback: /** @type {CallbackRequest} */ (data), error: null };
}
