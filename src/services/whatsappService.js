import twilio from 'twilio';
import { logError } from '../db/loggerService.js';
import { persistLastMenu, appendRecentTurn } from '../db/conversationStateService.js';
import { toMetaPhone, toTwilioWhatsApp, toE164 } from '../utils/phone.js';
import { recordFailure, recordSuccess, isCircuitOpen, TECHNICAL_FALLBACK_MESSAGE } from './circuitBreaker.js';
import { CALENDAR_ANCHOR_TEXT } from '../utils/calendarLink.js';

/** @typedef {import('../db/businessService.js').Business} Business */

/**
 * @typedef {Object} SendResult
 * @property {boolean} ok
 * @property {unknown} data
 * @property {number} status
 */

/**
 * Stores the assistant reply in conversation memory so the next turn
 * does not re-argue an objection that was already answered.
 * @param {Business} business
 * @param {string} recipientPhone
 * @param {string} body
 * @param {string | null} [requestId]
 */
async function rememberAssistantTurn(business, recipientPhone, body, requestId = null) {
  const text = String(body ?? '').trim();
  if (!text || !business?.id) return;
  try {
    await appendRecentTurn({
      businessId: business.id,
      rawPhone: recipientPhone,
      role: 'assistant',
      text,
      requestId,
    });
  } catch (error) {
    console.warn('[whatsapp] rememberAssistantTurn failed', error);
  }
}

/**
 * Resolves Twilio credentials exclusively from the business row (Supabase).
 * No TWILIO_* .env fallback — missing fields throw for strict multi-tenant isolation.
 * DB priority: twilio_account_sid / twilio_auth_token, then legacy
 * whatsapp_business_account_id / whatsapp_access_token columns on the same row.
 * @param {Business} business
 */
function resolveTwilioCredentials(business) {
  const accountSid =
    business.twilio_account_sid ||
    business.whatsapp_business_account_id ||
    null;
  const authToken =
    business.twilio_auth_token ||
    business.whatsapp_access_token ||
    null;
  const fromNumber = business.whatsapp_phone_number_id || null;

  /** @type {string[]} */
  const missing = [];
  if (!accountSid) missing.push('twilio_account_sid');
  if (!authToken) missing.push('twilio_auth_token');
  if (!fromNumber) missing.push('whatsapp_phone_number_id');

  if (missing.length) {
    throw new Error(
      `Eroare: Afacerea nu are configurate credențialele Twilio (${missing.join(', ')}).`,
    );
  }

  return {
    accountSid: /** @type {string} */ (accountSid),
    authToken: /** @type {string} */ (authToken),
    fromNumber: /** @type {string} */ (fromNumber),
  };
}

/**
 * @param {Business} business
 * @returns {import('twilio').Twilio}
 */
function createTwilioClient(business) {
  const { accountSid, authToken } = resolveTwilioCredentials(business);
  return twilio(accountSid, authToken);
}

/**
 * Formats interactive options as a numbered WhatsApp-friendly menu.
 * @param {string} bodyText
 * @param {{ id: string; title: string; description?: string }[]} options
 * @param {string | null} [footerText]
 * @returns {string}
 */
export function formatNumberedMenu(bodyText, options, footerText = null) {
  const lines = [bodyText.trim(), ''];

  options.forEach((opt, index) => {
    const n = index + 1;
    const desc = opt.description ? ` — ${opt.description}` : '';
    lines.push(`${n}. ${opt.title}${desc}`);
  });

  lines.push('', 'Poți răspunde cu *numele* sau cu numărul opțiunii.');

  if (footerText) {
    lines.push('', footerText);
  }

  return lines.join('\n');
}

/**
 * Maps a user reply ("1", "2", …) to an option id from the last sent menu.
 * @param {string} body
 * @param {{ id: string }[]} options
 * @returns {string | null}
 */
export function resolveNumberedChoice(body, options) {
  const trimmed = String(body ?? '').trim();
  const match = /^(\d{1,2})$/.exec(trimmed);
  if (!match) return null;

  const index = Number(match[1]) - 1;
  if (index < 0 || index >= options.length) return null;
  return options[index].id;
}

/** In-memory last menu options per business+phone (for numbered replies). */
/** @type {Map<string, { id: string; title: string }[]>} */
const lastMenuOptions = new Map();

/** Last inbound Twilio MessageSid — required for WhatsApp typing indicators. */
/** @type {Map<string, string>} */
const lastInboundMessageSid = new Map();

const TWILIO_TYPING_URL = 'https://messaging.twilio.com/v3/Indicators/Typing.json';

/**
 * @param {string} businessId
 * @param {string} recipientPhone
 */
function menuKey(businessId, recipientPhone) {
  return `${businessId}:${toMetaPhone(recipientPhone)}`;
}

/**
 * @param {string | null | undefined} messageSid
 * @returns {string | null}
 */
function normalizeMessageSid(messageSid) {
  const sid = String(messageSid ?? '').trim();
  if (!sid) return null;
  // Twilio Message SID (SM…) or Media SID (MM…)
  if (!/^(SM|MM)[a-f0-9]{32}$/i.test(sid)) return null;
  return sid;
}

/**
 * Remembers the inbound WhatsApp message SID for typing indicators.
 * @param {string} businessId
 * @param {string} recipientPhone
 * @param {string | null | undefined} messageSid
 */
export function rememberInboundMessageSid(businessId, recipientPhone, messageSid) {
  const sid = normalizeMessageSid(messageSid);
  if (!sid) return;
  lastInboundMessageSid.set(menuKey(businessId, recipientPhone), sid);
}

/**
 * @param {string} businessId
 * @param {string} recipientPhone
 * @returns {string | null}
 */
export function getRememberedInboundMessageSid(businessId, recipientPhone) {
  return lastInboundMessageSid.get(menuKey(businessId, recipientPhone)) ?? null;
}

/**
 * Remembers the last numbered menu (memory cache + Supabase).
 * Must be awaited — Vercel isolates do not share the in-memory Map.
 *
 * @param {string} businessId
 * @param {string} recipientPhone
 * @param {{ id: string; title: string }[]} options
 * @param {string} [kind]
 */
export async function rememberMenuOptions(businessId, recipientPhone, options, kind = 'generic') {
  lastMenuOptions.set(menuKey(businessId, recipientPhone), options);
  await persistLastMenu({
    businessId,
    rawPhone: recipientPhone,
    kind,
    options,
  });
}

/**
 * Drops the last numbered menu so "1"/"2" cannot re-trigger an old confirm card.
 * @param {string} businessId
 * @param {string} recipientPhone
 */
export function clearRememberedMenuOptions(businessId, recipientPhone) {
  lastMenuOptions.delete(menuKey(businessId, recipientPhone));
}

/**
 * @param {string} businessId
 * @param {string} recipientPhone
 * @returns {{ id: string; title: string }[] | null}
 */
export function getRememberedMenuOptions(businessId, recipientPhone) {
  return lastMenuOptions.get(menuKey(businessId, recipientPhone)) ?? null;
}

/**
 * Sends a WhatsApp message via Twilio Messaging API.
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {string} params.body
 * @param {string | null} [params.requestId]
 * @returns {Promise<SendResult>}
 */
async function sendTwilioMessage({ business, recipientPhone, body, requestId = null }) {
  const mockMode = process.env.WHATSAPP_MOCK_MODE === 'true';

  let accountSid;
  let authToken;
  let fromNumber;
  try {
    ({ accountSid, authToken, fromNumber } = resolveTwilioCredentials(business));
  } catch (error) {
    console.error('Eroare detalii:', error);
    await logError({
      message: error instanceof Error ? error.message : 'Missing Twilio credentials on business',
      source: 'webhook',
      severity: 'critical',
      businessId: business.id,
      requestId,
      details: {
        provider: 'twilio',
        multiTenantStrict: true,
      },
      error,
    });
    return { ok: false, data: null, status: 0 };
  }

  const to = toTwilioWhatsApp(recipientPhone);
  const from = toTwilioWhatsApp(fromNumber);

  if (mockMode) {
    console.log('[vidia-v2][whatsapp-mock][twilio]', {
      businessId: business.id,
      from,
      to,
      preview: body.slice(0, 200),
    });
    await rememberAssistantTurn(business, recipientPhone, body, requestId);
    return { ok: true, data: { mocked: true }, status: 200 };
  }

  try {
    if (isCircuitOpen('twilio')) {
      await logError({
        message: 'Twilio circuit open — skip send',
        source: 'webhook',
        severity: 'warning',
        businessId: business.id,
        requestId,
      });
      return { ok: false, data: { circuit: 'twilio' }, status: 0 };
    }

    const client = createTwilioClient(business);

    const message = await Promise.race([
      client.messages.create({
        from,
        to,
        body,
      }),
      new Promise((_, reject) => {
        setTimeout(() => reject(Object.assign(new Error('Twilio send timeout'), { name: 'TimeoutError' })), 10000);
      }),
    ]);

    console.log('[twilio] Message sent:', { sid: message.sid, status: message.status, to });
    recordSuccess('twilio');

    await rememberAssistantTurn(business, recipientPhone, body, requestId);

    return {
      ok: true,
      data: { sid: message.sid, status: message.status },
      status: 201,
    };
  } catch (error) {
    console.error('Eroare detalii:', error);
    recordFailure('twilio');

    const twilioError = /** @type {{ status?: number; code?: number; message?: string }} */ (
      error
    );

    const twilioMsg = typeof twilioError.message === 'string' ? twilioError.message : '';
    const dailyLimit = twilioError.code === 63038 || /daily messages limit/i.test(twilioMsg);
    await logError({
      message: dailyLimit
        ? 'Twilio WhatsApp: s-a atins limita de 50 mesaje/zi (Sandbox). Răspunsurile revin după reset sau după un număr WhatsApp Business.'
        : (twilioMsg
          ? `Twilio WhatsApp send failed: ${twilioMsg.slice(0, 180)}`
          : 'Twilio WhatsApp send failed'),
      source: 'webhook',
      severity: dailyLimit ? 'warning' : 'error',
      businessId: business.id,
      requestId,
      phoneNumber: toE164(recipientPhone),
      httpStatus: twilioError.status ?? null,
      error,
      details: {
        provider: 'twilio',
        code: twilioError.code,
        from,
        to,
        dailyLimit,
      },
    });

    return { ok: false, data: twilioError, status: twilioError.status ?? 0 };
  }
}

/**
 * Shows the WhatsApp "typing…" indicator (3 animated dots) via Twilio Typing API.
 * Requires the inbound MessageSid; marks that message as read and keeps typing
 * visible until the reply is delivered (or ~25s). Soft-fails — never throws.
 *
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {string | null} [params.messageSid] — Twilio SM…/MM… from inbound webhook
 * @param {string | null} [params.requestId]
 * @returns {Promise<SendResult>}
 */
export async function sendTypingIndicator({
  business,
  recipientPhone,
  messageSid = null,
  requestId = null,
}) {
  if (messageSid) {
    rememberInboundMessageSid(business.id, recipientPhone, messageSid);
  }

  const sid =
    normalizeMessageSid(messageSid)
    || getRememberedInboundMessageSid(business.id, recipientPhone);

  const mockMode = process.env.WHATSAPP_MOCK_MODE === 'true';
  if (mockMode) {
    console.log('[vidia-v2][whatsapp-mock][typing]', {
      businessId: business.id,
      to: toE164(recipientPhone) || recipientPhone,
      messageSid: sid,
      requestId,
    });
    return { ok: true, data: { mocked: true, messageSid: sid }, status: 200 };
  }

  if (!sid) {
    // No inbound SID yet — skip quietly (don't spam error_logs)
    return { ok: true, data: { skipped: true, reason: 'missing_message_sid' }, status: 200 };
  }

  let accountSid;
  let authToken;
  try {
    ({ accountSid, authToken } = resolveTwilioCredentials(business));
  } catch (error) {
    console.warn('[typing] credentials missing — skip', {
      businessId: business.id,
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, data: { skipped: true, reason: 'missing_credentials' }, status: 0 };
  }

  try {
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    /**
     * @param {string} channel
     */
    async function postTyping(channel) {
      const response = await fetch(TWILIO_TYPING_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel,
          messageId: sid,
        }),
      });
      const raw = await response.text();
      let data = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        data = { raw: raw.slice(0, 200) };
      }
      return { response, data };
    }

    // Docs curl uses WHATSAPP; some accounts expect lowercase — retry once
    let { response, data } = await postTyping('WHATSAPP');
    if (!response.ok && (response.status === 400 || response.status === 422)) {
      ({ response, data } = await postTyping('whatsapp'));
    }

    if (!response.ok) {
      // Soft-fail: beta API / account flags — never escalate to error_logs
      console.warn('[typing] Twilio Typing API non-OK', {
        businessId: business.id,
        requestId,
        status: response.status,
        messageSid: sid,
        body: data,
      });
      return { ok: false, data, status: response.status };
    }

    return { ok: true, data: data ?? { success: true }, status: response.status };
  } catch (error) {
    console.warn('[typing] request failed', {
      businessId: business.id,
      requestId,
      messageSid: sid,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      data: { error: error instanceof Error ? error.message : String(error) },
      status: 0,
    };
  }
}

/**
 * Sends a plain text WhatsApp message via Twilio.
 */
export async function sendTextMessage({ business, recipientPhone, text, requestId = null }) {
  return sendTwilioMessage({ business, recipientPhone, body: text, requestId });
}

/**
 * Sends a WhatsApp message with a URL call-to-action button (friendly label, URL hidden).
 * Uses Twilio Content API in-session; falls back to markdown anchor text if CTA fails.
 *
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {string} params.text — message body (should NOT include the raw URL)
 * @param {string} params.buttonUrl
 * @param {string} [params.buttonTitle] — max 20 chars for WhatsApp
 * @param {string | null} [params.requestId]
 * @returns {Promise<SendResult>}
 */
export async function sendMessageWithUrlButton({
  business,
  recipientPhone,
  text,
  buttonUrl,
  buttonTitle = 'Adaugă în calendar',
  requestId = null,
}) {
  const title = String(buttonTitle || 'Adaugă în calendar').slice(0, 20);
  const url = String(buttonUrl || '').trim();
  const bodyText = String(text || '').trim();

  if (!url) {
    return sendTextMessage({ business, recipientPhone, text: bodyText, requestId });
  }

  const mockMode = process.env.WHATSAPP_MOCK_MODE === 'true';
  if (mockMode) {
    console.log('[vidia-v2][whatsapp-mock][twilio-cta]', {
      businessId: business.id,
      buttonTitle: title,
      buttonUrl: url.slice(0, 120),
      preview: bodyText.slice(0, 200),
    });
    return { ok: true, data: { mocked: true, cta: true }, status: 200 };
  }

  let fromNumber;
  try {
    ({ fromNumber } = resolveTwilioCredentials(business));
  } catch (error) {
    console.error('Eroare detalii:', error);
    await logError({
      message: error instanceof Error ? error.message : 'Missing Twilio credentials on business',
      source: 'webhook',
      severity: 'critical',
      businessId: business.id,
      requestId,
      error,
    });
    return { ok: false, data: null, status: 0 };
  }

  const to = toTwilioWhatsApp(recipientPhone);
  const from = toTwilioWhatsApp(fromNumber);
  const client = createTwilioClient(business);

  try {
    const content = await client.content.v1.contents.create({
      friendlyName: `vidia_cal_${Date.now().toString(36)}`,
      language: 'ro',
      types: {
        'twilio/call-to-action': {
          body: bodyText,
          actions: [
            {
              type: 'URL',
              title,
              url,
            },
          ],
        },
      },
    });

    const message = await client.messages.create({
      from,
      to,
      contentSid: content.sid,
    });

    console.log('[twilio] CTA message sent:', {
      sid: message.sid,
      contentSid: content.sid,
      status: message.status,
      to,
    });

    return {
      ok: true,
      data: { sid: message.sid, status: message.status, contentSid: content.sid },
      status: 201,
    };
  } catch (error) {
    console.error('Eroare detalii:', error);
    await logError({
      message: 'Twilio CTA calendar button failed — falling back to text anchor',
      source: 'webhook',
      severity: 'warning',
      businessId: business.id,
      requestId,
      phoneNumber: toE164(recipientPhone),
      error,
      details: { provider: 'twilio', buttonTitle: title },
    });

    // Fallback: single contiguous markdown link (no bare URL dump, no duplicate CTA text)
    const calendarMd = `[${CALENDAR_ANCHOR_TEXT}](${url})`;
    const withAnchor = bodyText.includes(url)
      ? bodyText
      : `${bodyText}\n\n${calendarMd}`;

    return sendTwilioMessage({
      business,
      recipientPhone,
      body: withAnchor,
      requestId,
    });
  }
}

/**
 * Sends the .ics as a WhatsApp media document (file attachment), not as inline text.
 * @returns {Promise<SendResult>}
 */
export async function sendIcsDocument({
  business,
  recipientPhone,
  mediaUrl,
  caption = 'Adaugă programarea în calendar (fișier .ics).',
  requestId = null,
}) {
  const url = String(mediaUrl || '').trim();
  if (!url) return { ok: false, data: null, status: 0 };

  const mockMode = process.env.WHATSAPP_MOCK_MODE === 'true';
  if (mockMode) {
    console.log('[vidia-v2][whatsapp-mock][ics]', { url: url.slice(0, 160) });
    return { ok: true, data: { mocked: true, ics: true }, status: 200 };
  }

  if (isCircuitOpen('twilio')) {
    return { ok: false, data: { circuit: 'twilio' }, status: 0 };
  }

  let fromNumber;
  try {
    ({ fromNumber } = resolveTwilioCredentials(business));
  } catch (error) {
    console.error('Eroare detalii:', error);
    return { ok: false, data: null, status: 0 };
  }

  const to = toTwilioWhatsApp(recipientPhone);
  const from = toTwilioWhatsApp(fromNumber);
  const client = createTwilioClient(business);

  try {
    const message = await Promise.race([
      client.messages.create({
        from,
        to,
        body: caption,
        mediaUrl: [url],
      }),
      new Promise((_, reject) => {
        setTimeout(() => reject(Object.assign(new Error('Twilio ICS send timeout'), { name: 'TimeoutError' })), 10000);
      }),
    ]);
    recordSuccess('twilio');
    await rememberAssistantTurn(business, recipientPhone, caption, requestId);
    return {
      ok: true,
      data: { sid: message.sid, status: message.status },
      status: 201,
    };
  } catch (error) {
    console.error('Eroare detalii:', error);
    recordFailure('twilio');
    await logError({
      message: 'Twilio ICS media send failed',
      source: 'webhook',
      severity: 'warning',
      businessId: business.id,
      requestId,
      error,
      details: { mediaUrl: url.slice(0, 180) },
    });
    return { ok: false, data: error, status: 0 };
  }
}

/**
 * Last-resort client message when OpenAI / Twilio / Supabase fail.
 * Never throws.
 */
export async function sendTechnicalFallbackMessage({
  business,
  recipientPhone,
  requestId = null,
}) {
  if (!business || !recipientPhone) return { ok: false, data: null, status: 0 };
  try {
    return await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: TECHNICAL_FALLBACK_MESSAGE,
    });
  } catch (error) {
    console.error('Eroare detalii:', error);
    return { ok: false, data: error, status: 0 };
  }
}

/**
 * @typedef {Object} InteractiveButton
 * @property {string} id
 * @property {string} title
 */

/**
 * Sends interactive options as a numbered menu (Twilio-compatible).
 */
export async function sendInteractiveButtons({
  business,
  recipientPhone,
  bodyText,
  buttons,
  headerText = null,
  footerText = null,
  requestId = null,
  menuKind = 'generic',
}) {
  const options = buttons.slice(0, 10).map((btn) => ({
    id: btn.id,
    title: btn.title,
  }));

  await rememberMenuOptions(business.id, recipientPhone, options, menuKind);

  const header = headerText ? `${headerText}\n\n` : '';
  const body = formatNumberedMenu(`${header}${bodyText}`, options, footerText);

  return sendTwilioMessage({ business, recipientPhone, body, requestId });
}

/**
 * @typedef {Object} InteractiveListRow
 * @property {string} id
 * @property {string} title
 * @property {string} [description]
 */

/**
 * @typedef {Object} InteractiveListSection
 * @property {string} title
 * @property {InteractiveListRow[]} rows
 */

/**
 * Sends list rows as a numbered menu via Twilio.
 */
export async function sendInteractiveList({
  business,
  recipientPhone,
  bodyText,
  buttonText,
  sections,
  headerText = null,
  footerText = null,
  requestId = null,
}) {
  void buttonText;

  const options = sections
    .flatMap((section) =>
      section.rows.map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description,
      })),
    )
    .slice(0, 10);

  await rememberMenuOptions(business.id, recipientPhone, options, 'list');

  const header = headerText ? `${headerText}\n\n` : '';
  const body = formatNumberedMenu(`${header}${bodyText}`, options, footerText);

  return sendTwilioMessage({ business, recipientPhone, body, requestId });
}

/**
 * Shows typing… then waits briefly so the client sees the indicator before the reply.
 * Re-sends typing at the start (refreshes the ~25s WhatsApp window).
 */
export async function simulateHumanDelay({
  business,
  recipientPhone,
  delayMs = 1500,
  requestId = null,
  messageSid = null,
}) {
  await sendTypingIndicator({ business, recipientPhone, messageSid, requestId });
  const wait = Math.max(0, Number(delayMs) || 1500);
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
