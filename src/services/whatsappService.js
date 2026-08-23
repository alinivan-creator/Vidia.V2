import twilio from 'twilio';
import { logError } from '../db/loggerService.js';
import { persistLastMenu, appendRecentTurn } from '../db/conversationStateService.js';
import { toMetaPhone, toTwilioWhatsApp, toE164 } from '../utils/phone.js';
import { recordFailure, recordSuccess, isCircuitOpen, TECHNICAL_FALLBACK_MESSAGE } from './circuitBreaker.js';
import { CALENDAR_ANCHOR_TEXT } from '../utils/calendarLink.js';
import { createFlowToken } from './whatsappFlowService.js';
import { isStaleOutboundTurn } from './turnSequencer.js';
import { twilioContentLocale } from '../utils/uiI18n.js';

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
 * Prefer sendInteractiveButtons (native quick-reply) for live UX — this is fallback text.
 * @param {string} bodyText
 * @param {{ id: string; title: string; description?: string }[]} options
 * @param {string | null} [footerText]
 * @returns {string}
 */
export function formatNumberedMenu(bodyText, options, footerText = null, menuKind = 'generic', lang = 'ro') {
  const lines = [bodyText.trim(), ''];
  const kind = String(menuKind || 'generic');
  const en = lang === 'en';

  if (kind === 'day_grid' || kind === 'time_grid') {
    lines.push(en
      ? 'Pick from the list or buttons — do not type free text.'
      : 'Alege din listă sau butoane — nu scrie text.');
  } else {
    options.forEach((opt, index) => {
      const n = index + 1;
      const desc = opt.description ? ` — ${opt.description}` : '';
      lines.push(`${n}. ${opt.title}${desc}`);
    });

    if (kind === 'confirm') {
      lines.push('', en ? 'Tap *Confirm* or *Cancel*.' : 'Atinge *Confirmă* sau *Anulează*.');
    } else if (kind === 'clarify') {
      lines.push('', en ? 'Tap *1* or *2* (button).' : 'Atinge *1* sau *2* (buton).');
    } else if (kind === 'resume') {
      lines.push('', en ? 'Tap *Yes, resume* or *Other times*.' : 'Atinge *Da, reia* sau *Alte ore*.');
    } else {
      lines.push('', en ? 'Tap an option below.' : 'Atinge o opțiune de mai jos.');
    }
  }

  if (footerText) {
    lines.push('', footerText);
  }

  return lines.join('\n');
}

/**
 * Maps inbound Twilio quick-reply / numbered text to a menu option id.
 * @param {string} body
 * @param {string | null | undefined} buttonPayload
 * @param {{ id: string, title?: string }[]} options
 * @returns {string | null}
 */
export function resolveInteractiveChoice(body, buttonPayload, options = []) {
  const payload = String(buttonPayload ?? '').trim();
  if (payload) {
    // Never honor an id that is not on the current last_menu (stale WhatsApp history taps).
    return options.some((o) => o.id === payload) ? payload : null;
  }

  const numbered = resolveNumberedChoice(body, options);
  if (numbered) return numbered;

  const raw = String(body ?? '').trim();
  if (!raw || !options.length) return null;

  const norm = (s) => String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[›»]/g, '>')
    .replace(/[‹«]/g, '<')
    .replace(/\s+/g, ' ')
    .trim();

  const nBody = norm(raw);
  const exact = options.find((o) => norm(o.title) === nBody);
  if (exact) return exact.id;

  // WhatsApp often echoes "16:00 Disponibil" / "Alte opțiuni › Pagina următoare".
  for (const o of options) {
    const nTitle = norm(o.title);
    if (!nTitle) continue;
    if (nBody === nTitle || nBody.startsWith(`${nTitle} `)) return o.id;
  }

  const timeHit = /\b(\d{1,2}:\d{2})\b/.exec(nBody);
  if (timeHit) {
    const byTime = options.find((o) => {
      const t = norm(o.title);
      return t === timeHit[1] || t.startsWith(`${timeHit[1]}`);
    });
    if (byTime) return byTime.id;
  }

  return null;
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
  if (isStaleOutboundTurn(business?.id, recipientPhone, requestId)) {
    console.log('[turn-order] Drop reply from a superseded turn', {
      businessId: business?.id ?? null,
      requestId,
      preview: String(body ?? '').slice(0, 80),
    });
    return { ok: false, data: { superseded: true }, status: 0 };
  }

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
  /** Extra URL buttons (Twilio CTA allows max 2 total). */
  extraButtons = [],
  contentLanguage = 'ro',
}) {
  if (isStaleOutboundTurn(business?.id, recipientPhone, requestId)) {
    console.log('[turn-order] Drop CTA message from a superseded turn', {
      businessId: business?.id ?? null,
      requestId,
    });
    return { ok: false, data: { superseded: true }, status: 0 };
  }

  const title = String(buttonTitle || 'Adaugă în calendar').slice(0, 20);
  const url = String(buttonUrl || '').trim();
  const bodyText = String(text || '').trim();

  const actions = [
    url ? { type: 'URL', title, url } : null,
    ...(Array.isArray(extraButtons) ? extraButtons : []).map((b) => ({
      type: 'URL',
      title: String(b.title || 'Link').slice(0, 20),
      url: String(b.url || '').trim(),
    })),
  ]
    .filter((a) => a && a.url)
    .slice(0, 2);

  if (!actions.length) {
    return sendTextMessage({ business, recipientPhone, text: bodyText, requestId });
  }

  const mockMode = process.env.WHATSAPP_MOCK_MODE === 'true';
  if (mockMode) {
    console.log('[vidia-v2][whatsapp-mock][twilio-cta]', {
      businessId: business.id,
      actions: actions.map((a) => ({ title: a.title, url: String(a.url).slice(0, 120) })),
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
    const content = await Promise.race([
      client.content.v1.contents.create({
        friendlyName: `vidia_cal_${Date.now().toString(36)}`,
        language: twilioContentLocale(contentLanguage),
        types: {
          'twilio/call-to-action': {
            body: bodyText,
            actions,
          },
        },
      }),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(Object.assign(new Error('Twilio Content CTA create timeout'), { name: 'TimeoutError' })),
          8000,
        );
      }),
    ]);

    const message = await Promise.race([
      client.messages.create({
        from,
        to,
        contentSid: content.sid,
      }),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(Object.assign(new Error('Twilio Content CTA send timeout'), { name: 'TimeoutError' })),
          8000,
        );
      }),
    ]);

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
    const first = actions[0];
    const calendarMd = `[${first.title || CALENDAR_ANCHOR_TEXT}](${first.url})`;
    const withAnchor = bodyText.includes(first.url)
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
 * Sends interactive options as Twilio WhatsApp quick-reply buttons (≤3 in-session).
 * Prefer sendInteractiveList for day/time catalogs with many options.
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
  /** Full option catalog to remember (may exceed the 3 visible buttons). */
  rememberOptions = null,
  contentLanguage = 'ro',
}) {
  // Guard before remembering: a stale menu must never overwrite the fresh one.
  if (isStaleOutboundTurn(business?.id, recipientPhone, requestId)) {
    console.log('[turn-order] Drop quick-reply menu from a superseded turn', {
      businessId: business?.id ?? null,
      requestId,
      menuKind,
    });
    return { ok: false, data: { superseded: true }, status: 0 };
  }

  const visible = buttons.slice(0, 3).map((btn) => ({
    id: String(btn.id).slice(0, 200),
    title: String(btn.title).slice(0, 20),
  }));
  const remembered = (rememberOptions || buttons).slice(0, 40).map((btn) => ({
    id: String(btn.id),
    title: String(btn.title).slice(0, 24),
  }));

  await rememberMenuOptions(business.id, recipientPhone, remembered, menuKind);

  const header = headerText ? `${headerText}\n\n` : '';
  const body = `${header}${String(bodyText || '').trim()}`.slice(0, 1024);

  if (!visible.length) {
    return sendTwilioMessage({ business, recipientPhone, body, requestId });
  }

  const mockMode = process.env.WHATSAPP_MOCK_MODE === 'true';
  if (mockMode) {
    console.log('[vidia-v2][whatsapp-mock][quick-reply]', {
      businessId: business.id,
      menuKind,
      actions: visible,
      preview: body.slice(0, 200),
    });
    return { ok: true, data: { mocked: true, quickReply: true }, status: 200 };
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
      friendlyName: `vidia_qr_${Date.now().toString(36)}`,
      language: twilioContentLocale(contentLanguage),
      types: {
        'twilio/quick-reply': {
          body,
          actions: visible.map((btn) => ({
            title: btn.title,
            id: btn.id,
          })),
        },
      },
    });

    const message = await client.messages.create({
      from,
      to,
      contentSid: content.sid,
    });

    console.log('[twilio] quick-reply sent:', {
      sid: message.sid,
      contentSid: content.sid,
      menuKind,
      actions: visible.length,
    });

    return {
      ok: true,
      data: { sid: message.sid, status: message.status, contentSid: content.sid },
      status: 201,
    };
  } catch (error) {
    console.error('Eroare detalii:', error);
    await logError({
      message: 'Twilio quick-reply failed — falling back to text',
      source: 'webhook',
      severity: 'warning',
      businessId: business.id,
      requestId,
      error,
      details: { provider: 'twilio', menuKind },
    });

    const fallback = formatNumberedMenu(body, visible, footerText, menuKind, contentLanguage);
    return sendTwilioMessage({ business, recipientPhone, body: fallback, requestId });
  }
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
 * Native WhatsApp list picker via Twilio Content API (twilio/list-picker).
 * Up to 10 rows; in-session only.
 */
export async function sendInteractiveList({
  business,
  recipientPhone,
  bodyText,
  buttonText = 'Alege',
  sections,
  headerText = null,
  footerText = null,
  requestId = null,
  menuKind = 'list',
  rememberOptions = null,
  contentLanguage = 'ro',
}) {
  if (isStaleOutboundTurn(business?.id, recipientPhone, requestId)) {
    console.log('[turn-order] Drop list picker from a superseded turn', {
      businessId: business?.id ?? null,
      requestId,
      menuKind,
    });
    return { ok: false, data: { superseded: true }, status: 0 };
  }

  const rows = sections
    .flatMap((section) =>
      (section.rows || []).map((row) => ({
        id: String(row.id).slice(0, 200),
        title: String(row.title || row.item || '').slice(0, 24),
        description: String(row.description || section.title || ' ').slice(0, 72) || ' ',
      })),
    )
    .slice(0, 10);

  const remembered = (rememberOptions || rows).slice(0, 80).map((row) => ({
    id: String(row.id),
    title: String(row.title).slice(0, 24),
    description: row.description != null ? String(row.description).slice(0, 72) : undefined,
  }));
  await rememberMenuOptions(business.id, recipientPhone, remembered, menuKind);

  const header = headerText ? `${headerText}\n\n` : '';
  const body = `${header}${String(bodyText || '').trim()}`.slice(0, 1024);
  const button = String(buttonText || 'Alege').slice(0, 20);

  if (!rows.length) {
    return sendTwilioMessage({ business, recipientPhone, body, requestId });
  }

  const mockMode = process.env.WHATSAPP_MOCK_MODE === 'true';
  if (mockMode) {
    console.log('[vidia-v2][whatsapp-mock][list-picker]', {
      businessId: business.id,
      menuKind,
      button,
      items: rows,
      preview: body.slice(0, 200),
    });
    return { ok: true, data: { mocked: true, listPicker: true }, status: 200 };
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
      friendlyName: `vidia_list_${Date.now().toString(36)}`,
      language: twilioContentLocale(contentLanguage),
      types: {
        'twilio/list-picker': {
          body,
          button,
          items: rows.map((row) => ({
            id: row.id,
            item: row.title,
            description: row.description || ' ',
          })),
        },
      },
    });

    const message = await client.messages.create({
      from,
      to,
      contentSid: content.sid,
    });

    console.log('[twilio] list-picker sent:', {
      sid: message.sid,
      contentSid: content.sid,
      menuKind,
      items: rows.length,
    });

    void footerText;

    return {
      ok: true,
      data: { sid: message.sid, status: message.status, contentSid: content.sid },
      status: 201,
    };
  } catch (error) {
    console.error('Eroare detalii:', error);
    await logError({
      message: 'Twilio list-picker failed — falling back to quick-reply/text',
      source: 'webhook',
      severity: 'warning',
      businessId: business.id,
      requestId,
      error,
      details: { provider: 'twilio', menuKind },
    });

    // Fallback: first 3 as quick-reply
    return sendInteractiveButtons({
      business,
      recipientPhone,
      bodyText: body,
      buttons: rows.slice(0, 3),
      requestId,
      menuKind,
      rememberOptions: remembered,
      contentLanguage,
    });
  }
}

/**
 * Launch WhatsApp Flow (Meta DatePicker UI) via Twilio whatsapp/flows Content API.
 * Requires booking_settings.whatsapp_flow_id on the business.
 *
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {string} params.flowId
 * @param {string} params.bodyText
 * @param {string} [params.cta]
 * @param {string | null} [params.requestId]
 * @param {string} [params.flowToken]
 */
export async function sendBookingFlow({
  business,
  recipientPhone,
  flowId,
  bodyText,
  cta = 'Deschide calendarul',
  requestId = null,
  flowToken = null,
  contentLanguage = 'ro',
}) {
  if (isStaleOutboundTurn(business?.id, recipientPhone, requestId)) {
    console.log('[turn-order] Drop booking flow from a superseded turn', {
      businessId: business?.id ?? null,
      requestId,
    });
    return { ok: false, data: { superseded: true }, status: 0 };
  }

  const mockMode = process.env.WHATSAPP_MOCK_MODE === 'true';
  if (mockMode) {
    console.log('[vidia-v2][whatsapp-mock][flow]', { flowId, preview: String(bodyText).slice(0, 120) });
    return { ok: true, data: { mocked: true, flow: true }, status: 200 };
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
  const token = flowToken || createFlowToken(business.id);

  try {
    const en = twilioContentLocale(contentLanguage) === 'en';
    const content = await client.content.v1.contents.create({
      friendlyName: `vidia_flow_${Date.now().toString(36)}`,
      language: twilioContentLocale(contentLanguage),
      types: {
        'whatsapp/flows': {
          body: String(bodyText || (en ? 'Pick a date and time from the calendar.' : 'Alege data și ora din calendar.')).slice(0, 1024),
          button_text: String(cta).slice(0, 20),
          flow_id: String(flowId),
          flow_token: token,
          flow_action: 'data_exchange',
        },
      },
    });

    const message = await client.messages.create({
      from,
      to,
      contentSid: content.sid,
    });

    console.log('[twilio] booking flow sent:', {
      sid: message.sid,
      contentSid: content.sid,
      flowId,
    });

    return {
      ok: true,
      data: { sid: message.sid, contentSid: content.sid, flowToken: token },
      status: 201,
    };
  } catch (error) {
    console.error('Eroare detalii:', error);
    await logError({
      message: 'Twilio whatsapp/flows send failed',
      source: 'webhook',
      severity: 'warning',
      businessId: business.id,
      requestId,
      error,
      details: { flowId },
    });
    return { ok: false, data: error, status: 0 };
  }
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
