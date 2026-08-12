import twilio from 'twilio';
import { supabase } from '../config/supabase.js';
import { logError } from '../db/loggerService.js';
import { toE164 } from '../utils/phone.js';

/** @typedef {import('../db/businessService.js').Business} Business */

/**
 * Validates a dedicated SMS From number (E.164 phone only).
 * Rejects WhatsApp SIDs, Messaging Service SIDs, and empty values.
 * @param {unknown} value
 * @returns {string | null} E.164 or null
 */
export function normalizeSmsFromNumber(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;

  // Twilio resource SIDs are never valid SMS From phones
  if (/^(PN|MG|XE|WA|SM|AC)[a-f0-9]{32}$/i.test(raw)) return null;
  if (/^whatsapp:/i.test(raw)) return null;

  const e164 = toE164(raw);
  if (!e164 || !/^\+[1-9]\d{7,14}$/.test(e164)) return null;
  return e164;
}

/**
 * Resolve Twilio credentials + SMS from-number for a business.
 * Requires booking_settings.sms_from_number (dedicated SMS number) — never WhatsApp SID.
 * @param {Business} business
 */
function resolveSmsCredentials(business) {
  const accountSid =
    business.twilio_account_sid ||
    business.whatsapp_business_account_id ||
    null;
  const authToken =
    business.twilio_auth_token ||
    business.whatsapp_access_token ||
    null;
  const settings = /** @type {Record<string, unknown>} */ (business.booking_settings ?? {});
  const smsFrom = normalizeSmsFromNumber(settings.sms_from_number);

  /** @type {string[]} */
  const missing = [];
  if (!accountSid) missing.push('twilio_account_sid');
  if (!authToken) missing.push('twilio_auth_token');
  if (!smsFrom) {
    missing.push('booking_settings.sms_from_number (E.164 dedicat, ex. +407xxxxxxxx)');
  }

  if (missing.length) {
    throw new Error(`Credențiale SMS incomplete: ${missing.join(', ')}`);
  }

  return {
    accountSid: /** @type {string} */ (accountSid),
    authToken: /** @type {string} */ (authToken),
    fromNumber: /** @type {string} */ (smsFrom),
  };
}

/**
 * Sends a single SMS via Twilio (not WhatsApp).
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.toPhone — E.164
 * @param {string} params.body
 * @param {string | null} [params.requestId]
 */
export async function sendSmsMessage({ business, toPhone, body, requestId = null }) {
  const mockMode = process.env.WHATSAPP_MOCK_MODE === 'true';
  const to = toE164(toPhone);
  if (!to) {
    return { ok: false, error: 'Invalid destination phone', sid: null };
  }

  let creds;
  try {
    creds = resolveSmsCredentials(business);
  } catch (error) {
    await logError({
      message: error instanceof Error ? error.message : 'SMS credentials missing',
      source: 'webhook',
      severity: 'error',
      businessId: business.id,
      requestId,
      error,
    });
    return { ok: false, error: String(error), sid: null };
  }

  if (mockMode) {
    console.log('[vidia-v2][sms-mock]', {
      businessId: business.id,
      from: creds.fromNumber,
      to,
      preview: body.slice(0, 160),
    });
    return { ok: true, sid: `mock_sms_${Date.now()}`, mocked: true };
  }

  try {
    const client = twilio(creds.accountSid, creds.authToken);
    const message = await client.messages.create({
      from: creds.fromNumber,
      to,
      body: String(body).slice(0, 1600),
    });
    return { ok: true, sid: message.sid, mocked: false };
  } catch (error) {
    console.error('Eroare detalii:', error);
    await logError({
      message: 'Twilio SMS send failed',
      source: 'webhook',
      severity: 'error',
      businessId: business.id,
      requestId,
      phoneNumber: to,
      error,
    });
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      sid: null,
    };
  }
}

/**
 * Lists clients with validated SMS opt-in for a business.
 * @param {string} businessId
 * @returns {Promise<{ id: string; phone_number: string; display_name: string | null; sms_opt_in: boolean }[]>}
 */
export async function listSmsOptedInClients(businessId) {
  const { data, error } = await supabase
    .from('clients')
    .select('id, phone_number, display_name, sms_opt_in')
    .eq('business_id', businessId)
    .eq('sms_opt_in', true)
    .order('last_contact_at', { ascending: false });

  if (error) {
    // Pre-migration fallback: no opt-in column → empty (never blast without consent)
    if (/sms_opt_in|PGRST204/i.test(error.message ?? '')) {
      console.warn('[smsMarketing] sms_opt_in column missing — refusing campaign');
      return [];
    }
    await logError({
      message: 'listSmsOptedInClients failed',
      source: 'database',
      businessId,
      error,
    });
    return [];
  }

  // Defense in depth: never trust a row without explicit true
  return /** @type {{ id: string; phone_number: string; display_name: string | null; sms_opt_in: boolean }[]} */ (
    (data ?? []).filter((row) => row.sms_opt_in === true)
  );
}

/**
 * Sets marketing SMS opt-in / opt-out for a client.
 * @param {Object} params
 * @param {string} params.businessId
 * @param {string} params.rawPhone
 * @param {boolean} params.optIn
 */
export async function setClientSmsOptIn({ businessId, rawPhone, optIn }) {
  const phone = toE164(rawPhone);
  if (!phone) return null;

  const patch = optIn
    ? { sms_opt_in: true, sms_opt_in_at: new Date().toISOString(), sms_opt_out_at: null }
    : { sms_opt_in: false, sms_opt_out_at: new Date().toISOString() };

  const { data, error } = await supabase
    .from('clients')
    .update(patch)
    .eq('business_id', businessId)
    .eq('phone_number', phone)
    .select('id, phone_number, sms_opt_in')
    .maybeSingle();

  if (error) {
    console.warn('[smsMarketing] setClientSmsOptIn failed:', error.message);
    return null;
  }
  return data;
}

/**
 * Sends a bulk/targeted SMS campaign to opted-in clients only.
 *
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.body
 * @param {string[] | null} [params.clientIds] — null = all opted-in
 * @param {string} [params.createdBy]
 * @param {string | null} [params.requestId]
 */
export async function sendSmsCampaign({
  business,
  body,
  clientIds = null,
  createdBy = 'admin',
  requestId = null,
}) {
  const text = String(body ?? '').trim();
  if (text.length < 3) {
    return { ok: false, error: 'Mesajul SMS este prea scurt', campaignId: null };
  }

  // Fail fast if From number is missing/invalid — never fall back to WhatsApp SID
  try {
    resolveSmsCredentials(business);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      campaignId: null,
      sent: 0,
      failed: 0,
    };
  }

  let recipients = await listSmsOptedInClients(business.id);
  if (Array.isArray(clientIds) && clientIds.length) {
    const allow = new Set(clientIds);
    recipients = recipients.filter((c) => allow.has(c.id));
  }

  // Strict opt-in gate before any send
  recipients = recipients.filter((c) => c.sms_opt_in === true && c.phone_number);

  if (!recipients.length) {
    return {
      ok: false,
      error: 'Niciun client cu opt-in SMS validat',
      campaignId: null,
      sent: 0,
      failed: 0,
    };
  }

  let campaignId = null;
  try {
    const { data: campaign, error } = await supabase
      .from('sms_campaigns')
      .insert({
        business_id: business.id,
        body: text,
        status: 'sending',
        target_count: recipients.length,
        created_by: createdBy,
        details: { requestId },
      })
      .select('id')
      .single();

    if (!error && campaign) {
      campaignId = campaign.id;
    }
  } catch {
    // Table may be missing — continue sending with in-memory stats
  }

  let sent = 0;
  let failed = 0;

  for (const client of recipients) {
    // Re-check opt-in immediately before each Twilio call
    if (client.sms_opt_in !== true) {
      failed += 1;
      continue;
    }

    const { data: live, error: liveErr } = await supabase
      .from('clients')
      .select('id, sms_opt_in')
      .eq('id', client.id)
      .eq('business_id', business.id)
      .eq('sms_opt_in', true)
      .maybeSingle();

    if (liveErr || !live || live.sms_opt_in !== true) {
      failed += 1;
      if (campaignId) {
        await supabase.from('sms_campaign_sends').insert({
          campaign_id: campaignId,
          client_id: client.id,
          phone_number: client.phone_number,
          status: 'failed',
          twilio_sid: null,
          error_message: 'opt_in_revoked_or_missing',
        });
      }
      continue;
    }

    const result = await sendSmsMessage({
      business,
      toPhone: client.phone_number,
      body: text,
      requestId,
    });

    if (result.ok) sent += 1;
    else failed += 1;

    if (campaignId) {
      await supabase.from('sms_campaign_sends').insert({
        campaign_id: campaignId,
        client_id: client.id,
        phone_number: client.phone_number,
        status: result.ok ? 'sent' : 'failed',
        twilio_sid: result.sid,
        error_message: result.ok ? null : (result.error || 'send_failed'),
      });
    }

    // Soft rate-limit to stay under Twilio burst limits
    await new Promise((r) => setTimeout(r, 80));
  }

  if (campaignId) {
    await supabase
      .from('sms_campaigns')
      .update({
        status: failed && !sent ? 'failed' : 'completed',
        sent_count: sent,
        failed_count: failed,
        completed_at: new Date().toISOString(),
      })
      .eq('id', campaignId);
  }

  return {
    ok: sent > 0,
    campaignId,
    targetCount: recipients.length,
    sent,
    failed,
    error: sent > 0 ? null : 'Toate trimiterile au eșuat',
  };
}
