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

const MAX_SMS_RECIPIENTS = 200;
const SMS_SEND_CONCURRENCY = 4;

/**
 * Splits a textarea / CSV blob into unique valid E.164 numbers.
 * Accepts newlines, commas, and semicolons as separators.
 *
 * @param {unknown} raw
 * @returns {{ phones: string[]; invalid: string[] }}
 */
export function parseSmsRecipientList(raw) {
  /** @type {string[]} */
  const tokens = [];

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string' && item.trim()) tokens.push(item.trim());
    }
  } else if (typeof raw === 'string' && raw.trim()) {
    for (const part of raw.split(/[\n\r,;]+/)) {
      const token = part.trim();
      if (token) tokens.push(token);
    }
  }

  const seen = new Set();
  /** @type {string[]} */
  const phones = [];
  /** @type {string[]} */
  const invalid = [];

  for (const token of tokens) {
    const e164 = toE164(token);
    if (!e164 || !/^\+[1-9]\d{7,14}$/.test(e164)) {
      invalid.push(token);
      continue;
    }
    if (seen.has(e164)) continue;
    seen.add(e164);
    phones.push(e164);
  }

  return { phones, invalid };
}

/**
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function runPool(items, concurrency, worker) {
  /** @type {R[]} */
  const results = new Array(items.length);
  let next = 0;

  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => run()));
  return results;
}

/**
 * Resolve Twilio credentials + SMS from-number for a business.
 * Requires booking_settings.sms_from_number (dedicated SMS number) — never WhatsApp SID.
 * @param {Business} business
 */
function resolveSmsCredentials(business, overrides = {}) {
  const accountSid =
    business.twilio_account_sid ||
    business.whatsapp_business_account_id ||
    null;
  const authToken =
    business.twilio_auth_token ||
    business.whatsapp_access_token ||
    null;
  const settings = /** @type {Record<string, unknown>} */ (business.booking_settings ?? {});
  const smsFrom = normalizeSmsFromNumber(
    overrides.smsFromNumber ?? settings.sms_from_number,
  );

  /** @type {string[]} */
  const missing = [];
  if (!accountSid) missing.push('Twilio Account SID (câmpul Twilio pe afacere)');
  if (!authToken) missing.push('Twilio Auth Token');
  if (!smsFrom) {
    missing.push(
      'Număr SMS From (câmpul din Admin → SMS Marketing, format +407… sau 07…, apoi Salvează)',
    );
  }

  if (missing.length) {
    throw new Error(`Credențiale SMS incomplete: ${missing.join(' · ')}`);
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
 * Creates the client row when opting in a phone that is not yet in the DB (Admin manual list).
 * @param {Object} params
 * @param {string} params.businessId
 * @param {string} params.rawPhone
 * @param {boolean} params.optIn
 * @param {string | null} [params.source] — e.g. booking | admin | whatsapp
 */
export async function setClientSmsOptIn({ businessId, rawPhone, optIn, source = null }) {
  const phone = toE164(rawPhone);
  if (!phone || !businessId) return null;

  const now = new Date().toISOString();
  const patch = optIn
    ? { sms_opt_in: true, sms_opt_in_at: now, sms_opt_out_at: null }
    : { sms_opt_in: false, sms_opt_out_at: now };

  const { data: updated, error: updateError } = await supabase
    .from('clients')
    .update(patch)
    .eq('business_id', businessId)
    .eq('phone_number', phone)
    .select('id, phone_number, display_name, sms_opt_in')
    .maybeSingle();

  if (updateError) {
    console.warn('[smsMarketing] setClientSmsOptIn update failed:', updateError.message);
    return null;
  }
  if (updated) return updated;

  if (!optIn) return null;

  const { data: inserted, error: insertError } = await supabase
    .from('clients')
    .insert({
      business_id: businessId,
      phone_number: phone,
      first_contact_at: now,
      last_contact_at: now,
      sms_opt_in: true,
      sms_opt_in_at: now,
    })
    .select('id, phone_number, display_name, sms_opt_in')
    .single();

  if (insertError) {
    // Race: row created between update and insert — retry update
    if (/duplicate|unique/i.test(insertError.message ?? '')) {
      const { data: retry } = await supabase
        .from('clients')
        .update(patch)
        .eq('business_id', businessId)
        .eq('phone_number', phone)
        .select('id, phone_number, display_name, sms_opt_in')
        .maybeSingle();
      return retry ?? null;
    }
    console.warn('[smsMarketing] setClientSmsOptIn insert failed:', insertError.message, source || '');
    return null;
  }
  return inserted;
}

/**
 * Opt-in many phones from Admin (manual list). Invalid numbers are reported, not thrown.
 * @param {Object} params
 * @param {string} params.businessId
 * @param {unknown} params.phones
 * @returns {Promise<{ ok: boolean; added: number; already: number; invalid: string[]; clients: object[] }>}
 */
export async function addSmsOptInPhones({ businessId, phones }) {
  const parsed = parseSmsRecipientList(phones);
  /** @type {object[]} */
  const clients = [];
  let added = 0;
  let already = 0;

  for (const phone of parsed.phones) {
    const before = await supabase
      .from('clients')
      .select('id, sms_opt_in')
      .eq('business_id', businessId)
      .eq('phone_number', phone)
      .maybeSingle();
    const wasIn = before.data?.sms_opt_in === true;
    const row = await setClientSmsOptIn({
      businessId,
      rawPhone: phone,
      optIn: true,
      source: 'admin',
    });
    if (row) {
      clients.push(row);
      if (wasIn) already += 1;
      else added += 1;
    }
  }

  return {
    ok: parsed.phones.length > 0 && (added + already) > 0,
    added,
    already,
    invalid: parsed.invalid,
    clients,
  };
}

/**
 * Revoke SMS opt-in for phones (Admin or WhatsApp stop).
 * @param {Object} params
 * @param {string} params.businessId
 * @param {unknown} params.phones
 */
export async function removeSmsOptInPhones({ businessId, phones }) {
  const parsed = parseSmsRecipientList(phones);
  let removed = 0;
  for (const phone of parsed.phones) {
    const row = await setClientSmsOptIn({
      businessId,
      rawPhone: phone,
      optIn: false,
      source: 'admin',
    });
    if (row && row.sms_opt_in === false) removed += 1;
  }
  return { ok: true, removed, invalid: parsed.invalid };
}

/**
 * After a confirmed booking — client joins the SMS opt-in base automatically.
 * @param {Object} params
 * @param {string} params.businessId
 * @param {string} params.rawPhone
 */
export async function optInClientAfterBooking({ businessId, rawPhone }) {
  return setClientSmsOptIn({
    businessId,
    rawPhone,
    optIn: true,
    source: 'booking',
  });
}

/**
 * Persists SMS From on the business booking_settings (Admin form may send it with the campaign).
 * @param {string} businessId
 * @param {string} smsFrom — already normalized E.164
 */
async function persistSmsFromNumber(businessId, smsFrom) {
  const { data: row } = await supabase
    .from('businesses')
    .select('booking_settings')
    .eq('id', businessId)
    .maybeSingle();
  const prev = row?.booking_settings && typeof row.booking_settings === 'object'
    ? /** @type {Record<string, unknown>} */ (row.booking_settings)
    : {};
  if (prev.sms_from_number === smsFrom) return;
  await supabase
    .from('businesses')
    .update({
      booking_settings: { ...prev, sms_from_number: smsFrom },
      updated_at: new Date().toISOString(),
    })
    .eq('id', businessId);
}

/**
 * Sends a bulk/targeted SMS campaign.
 * `phones` (textarea list) takes priority; otherwise opted-in clients (optionally filtered by clientIds).
 *
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.body
 * @param {string[] | string | null} [params.phones]
 * @param {string[] | null} [params.clientIds] — used only when phones is empty
 * @param {string | null} [params.smsFromNumber] — optional override from Admin form (also persisted)
 * @param {string} [params.createdBy]
 * @param {string | null} [params.requestId]
 */
export async function sendSmsCampaign({
  business,
  body,
  phones = null,
  clientIds = null,
  smsFromNumber = null,
  createdBy = 'admin',
  requestId = null,
}) {
  const text = String(body ?? '').trim();
  if (text.length < 3) {
    return {
      ok: false,
      error: 'Mesajul SMS este prea scurt',
      campaignId: null,
      sent: 0,
      failed: 0,
      skipped: 0,
      invalid: [],
      errors: [],
    };
  }

  const normalizedFrom = normalizeSmsFromNumber(smsFromNumber);
  /** @type {Business} */
  let biz = business;
  if (normalizedFrom) {
    const settings = {
      ...(business.booking_settings && typeof business.booking_settings === 'object'
        ? business.booking_settings
        : {}),
      sms_from_number: normalizedFrom,
    };
    biz = /** @type {Business} */ ({ ...business, booking_settings: settings });
    try {
      await persistSmsFromNumber(business.id, normalizedFrom);
    } catch (err) {
      console.warn('[smsMarketing] persist sms_from_number failed:', err);
    }
  }

  try {
    resolveSmsCredentials(biz);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      campaignId: null,
      sent: 0,
      failed: 0,
      skipped: 0,
      invalid: [],
      errors: [],
    };
  }

  const parsed = parseSmsRecipientList(phones);
  let truncated = false;
  /** @type {{ id: string | null; phone_number: string; sms_opt_in: boolean }[]} */
  let recipients = [];

  if (parsed.phones.length) {
    let list = parsed.phones;
    if (list.length > MAX_SMS_RECIPIENTS) {
      truncated = true;
      list = list.slice(0, MAX_SMS_RECIPIENTS);
    }

    const { data: known } = await supabase
      .from('clients')
      .select('id, phone_number, sms_opt_in')
      .eq('business_id', business.id)
      .in('phone_number', list);

    /** @type {Map<string, { id: string; sms_opt_in: boolean }>} */
    const byPhone = new Map();
    for (const row of known ?? []) {
      const key = toE164(row.phone_number);
      if (key) byPhone.set(key, { id: row.id, sms_opt_in: row.sms_opt_in === true });
    }

    recipients = list.map((phone) => {
      const match = byPhone.get(phone);
      return {
        id: match?.id ?? null,
        phone_number: phone,
        sms_opt_in: match ? match.sms_opt_in : true,
      };
    });
  } else {
    let optedIn = await listSmsOptedInClients(business.id);
    if (Array.isArray(clientIds) && clientIds.length) {
      const allow = new Set(clientIds);
      optedIn = optedIn.filter((c) => allow.has(c.id));
    }
    recipients = optedIn.filter((c) => c.sms_opt_in === true && c.phone_number);
  }

  if (!recipients.length) {
    return {
      ok: false,
      error: parsed.invalid.length
        ? `Niciun număr valid. Invalide: ${parsed.invalid.slice(0, 8).join(', ')}`
        : 'Niciun destinatar valid (adaugă numere în listă sau clienți cu opt-in SMS)',
      campaignId: null,
      sent: 0,
      failed: 0,
      skipped: 0,
      invalid: parsed.invalid,
      errors: [],
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
        details: {
          requestId,
          invalid: parsed.invalid,
          truncated,
          source: parsed.phones.length ? 'manual_list' : 'opt_in',
        },
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
  let skipped = 0;
  /** @type {{ phone: string; error: string }[]} */
  const errors = [];

  await runPool(recipients, SMS_SEND_CONCURRENCY, async (client) => {
    const phone = client.phone_number;

    if (client.id && client.sms_opt_in !== true) {
      skipped += 1;
      errors.push({ phone, error: 'Fără opt-in SMS' });
      if (campaignId) {
        await supabase.from('sms_campaign_sends').insert({
          campaign_id: campaignId,
          client_id: client.id,
          phone_number: phone,
          status: 'skipped',
          twilio_sid: null,
          error_message: 'opt_in_revoked_or_missing',
        });
      }
      return;
    }

    if (client.id) {
      const { data: live, error: liveErr } = await supabase
        .from('clients')
        .select('id, sms_opt_in')
        .eq('id', client.id)
        .eq('business_id', business.id)
        .eq('sms_opt_in', true)
        .maybeSingle();

      if (liveErr || !live || live.sms_opt_in !== true) {
        skipped += 1;
        errors.push({ phone, error: 'Opt-in revocat' });
        if (campaignId) {
          await supabase.from('sms_campaign_sends').insert({
            campaign_id: campaignId,
            client_id: client.id,
            phone_number: phone,
            status: 'skipped',
            twilio_sid: null,
            error_message: 'opt_in_revoked_or_missing',
          });
        }
        return;
      }
    }

    const result = await sendSmsMessage({
      business: biz,
      toPhone: phone,
      body: text,
      requestId,
    });

    if (result.ok) sent += 1;
    else {
      failed += 1;
      errors.push({ phone, error: result.error || 'send_failed' });
    }

    if (campaignId) {
      await supabase.from('sms_campaign_sends').insert({
        campaign_id: campaignId,
        client_id: client.id,
        phone_number: phone,
        status: result.ok ? 'sent' : 'failed',
        twilio_sid: result.sid,
        error_message: result.ok ? null : (result.error || 'send_failed'),
      });
    }
  });

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
    skipped,
    invalid: parsed.invalid,
    truncated,
    errors: errors.slice(0, 25),
    error: sent > 0 ? null : (errors[0]?.error || 'Toate trimiterile au eșuat'),
  };
}
