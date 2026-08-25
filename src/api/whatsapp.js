import { Router } from 'express';
import crypto from 'node:crypto';
import {
  getBusinessByWhatsAppToNumber,
  isBusinessOperational,
  getCachedBusinessForWhatsAppTo,
} from '../db/businessService.js';
import { appendRecentTurn, touchSessionTimestamp, setConversationStep, getOrCreateConversationState } from '../db/conversationStateService.js';
import { logError } from '../db/loggerService.js';
import { loadBusinessContext } from '../services/businessContext.js';
import { routeInboundTurn } from '../services/inboundTurnService.js';
import { ensureClient } from '../services/menuHandler.js';
import {
  rememberInboundMessageSid,
  sendTypingIndicator,
  sendTextMessage,
  sendTechnicalFallbackMessage,
  clearRememberedMenuOptions,
} from '../services/whatsappService.js';
import { classifyInboundMessage } from '../utils/inboundPayload.js';
import { toE164, toMetaPhone } from '../utils/phone.js';
import { debugLog } from '../utils/debugLog.js';
import { continueAfterResponse } from '../utils/afterResponse.js';
import {
  sweepStalePendingForPhone,
  resolveLastBookingIntent,
  expireStalePendingForBusiness,
} from '../services/pendingExpiryService.js';
import { resetExpiredSessionForRestart } from '../services/pendingExpiryCron.js';
import {
  getSessionTtlMinutes,
  isConversationSessionExpired,
} from '../services/sessionValidator.js';
import { beginInboundTurn } from '../services/turnSequencer.js';
import { languageScrubPatch, needsLanguageScrub } from '../utils/clientLanguage.js';
import { bm } from '../utils/bookingI18n.js';
import { readSessionLanguage } from '../utils/uiI18n.js';

/**
 * Twilio WhatsApp inbound webhook.
 * Expects application/x-www-form-urlencoded: From, To, Body.
 */
export const whatsappRouter = Router();

/**
 * Health / ping for Twilio console configuration checks.
 */
whatsappRouter.get('/', (_req, res) => {
  res.status(200).json({
    ok: true,
    provider: 'twilio',
    endpoint: '/webhook/whatsapp',
    expects: 'POST application/x-www-form-urlencoded (From, To, Body)',
  });
});

/**
 * Twilio Messaging webhook (WhatsApp).
 * Process in-request first (Vercel Express can freeze the isolate after 200).
 * If we exceed ~12s, ack Twilio and finish via waitUntil.
 */
whatsappRouter.post('/', async (req, res) => {
  const requestId = crypto.randomUUID();
  const from = String(req.body?.From ?? '');
  const to = String(req.body?.To ?? '');

  debugLog('--- WEBHOOK INCOMING ---', {
    From: from,
    To: to,
    Body: req.body?.Body,
    MessageSid: req.body?.MessageSid,
    requestId,
  });

  void logError({
    message: from && to
      ? 'WhatsApp inbound primit'
      : 'WhatsApp inbound fără From/To (body gol sau webhook greșit)',
    source: 'webhook',
    severity: from && to ? 'info' : 'warning',
    requestId,
    details: {
      hasFrom: Boolean(from),
      hasTo: Boolean(to),
      bodyLen: String(req.body?.Body ?? '').length,
      contentType: String(req.headers['content-type'] ?? ''),
    },
  });

  const work = (async () => {
    try {
      await processTwilioWebhook(req.body, requestId);
    } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : null;
    console.error('[webhook] Unhandled Twilio WhatsApp webhook error', {
      requestId,
      message: errMsg,
      stack: errStack,
      inboundPreview: String(req.body?.Body ?? '').slice(0, 200),
    });
    debugLog('WEBHOOK FATAL', String(error));
    await logError({
      message: 'Unhandled Twilio WhatsApp webhook error',
      source: 'webhook',
      severity: 'critical',
      requestId,
      error,
      details: {
        body: sanitizeTwilioBody(req.body),
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: errMsg,
        errorStack: errStack,
        inboundText: String(req.body?.Body ?? '').slice(0, 500),
        alert: true,
      },
    });
    try {
      const fromClean = toE164(String(req.body?.From ?? ''));
      const toClean = toE164(String(req.body?.To ?? ''));
      const { getCachedBusinessForWhatsAppTo } = await import('../db/businessService.js');
      const cached = getCachedBusinessForWhatsAppTo(toClean);
      if (cached && fromClean) {
        await sendTechnicalFallbackMessage({
          business: cached,
          recipientPhone: toMetaPhone(fromClean),
          requestId,
        });
      }
    } catch (fallbackError) {
      console.error('[webhook] Failed to send technical fallback', fallbackError);
    }
  }
  })();

  const raced = await Promise.race([
    work.then(() => 'done'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 12000)),
  ]);

  if (!res.headersSent) {
    res.type('text/xml').status(200).send('<Response></Response>');
  }

  if (raced === 'timeout') {
    await continueAfterResponse(work);
  }
});

/**
 * @param {Record<string, unknown>} body
 * @returns {Record<string, unknown>}
 */
function sanitizeTwilioBody(body) {
  return {
    From: body?.From,
    To: body?.To,
    Body: body?.Body,
    MessageSid: body?.MessageSid,
    AccountSid: body?.AccountSid,
    ProfileName: body?.ProfileName,
    ButtonPayload: body?.ButtonPayload,
    ButtonText: body?.ButtonText,
    ListId: body?.ListId,
    InteractiveData: body?.InteractiveData ? '[present]' : undefined,
    FlowData: body?.FlowData ? '[present]' : undefined,
  };
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} requestId
 */
async function processTwilioWebhook(body, requestId) {
  const fromRaw = String(body?.From ?? '');
  const toRaw = String(body?.To ?? '');
  const flowSubmission = body?.InteractiveData || body?.FlowData || null;
  // Quick-reply taps: ButtonPayload is the stable id; Body/ButtonText are the visible title.
  // Flow complete: InteractiveData carries appointment_date + appointment_slot.
  // A typed sentence keeps its own text even when a payload rides along, so free text
  // never lands on the stale-option path.
  const inbound = classifyInboundMessage({
    body: body?.Body,
    buttonPayload: body?.ButtonPayload ?? body?.ListId,
    buttonText: body?.ButtonText ?? body?.ListTitle,
    flowSubmission: Boolean(flowSubmission),
  });
  const buttonPayload = inbound.buttonPayload;
  const buttonText = String(body?.ButtonText ?? body?.ListTitle ?? '').trim() || null;
  let textBody = inbound.textBody;
  if (flowSubmission) {
    try {
      const { parseFlowSubmission } = await import('../services/whatsappFlowService.js');
      const parsed = parseFlowSubmission(flowSubmission);
      if (parsed?.slotId) textBody = parsed.slotId;
      else if (parsed?.dateKey) textBody = `day_${parsed.dateKey}`;
    } catch (error) {
      console.error('Eroare detalii:', error);
    }
  }
  const profileName = String(body?.ProfileName ?? '').trim() || null;

  const toClean = toE164(toRaw);
  const fromClean = toE164(fromRaw);

  console.log('[webhook] Numbers cleaned:', {
    fromRaw,
    toRaw,
    fromClean,
    toClean,
    body: textBody.slice(0, 120),
    inboundKind: inbound.kind,
    buttonPayload: buttonPayload?.slice(0, 80) || null,
    buttonText: buttonText?.slice(0, 40) || null,
  });

  if (!fromRaw || !toRaw) {
    await logError({
      message: 'Twilio webhook missing From or To',
      source: 'webhook',
      severity: 'warning',
      requestId,
      details: sanitizeTwilioBody(body),
    });
    return;
  }

  /** @type {import('../db/businessService.js').Business | null} */
  let business = null;
  const recipientPhone = toMetaPhone(fromClean);
  const phoneE164 = fromClean;
  /** @type {import('../db/conversationStateService.js').ConversationState | null} */
  let convStateForLog = null;

  try {
    const matched = await getBusinessByWhatsAppToNumber(toClean, { includeInactive: true });
    const ctx = matched ? await loadBusinessContext(matched.id) : null;
    business = ctx?.business ?? matched;

    console.log('[webhook] Business match:', {
      toClean,
      found: Boolean(business),
      businessId: business?.id ?? null,
      businessName: business?.name ?? null,
      status: business?.status ?? null,
    });

    if (!business) {
      console.error('Eroare detalii:', {
        reason: 'No business for Twilio To',
        toRaw,
        toClean,
      });
      await logError({
        message: `No business for Twilio To: ${toClean}`,
        source: 'webhook',
        severity: 'warning',
        requestId,
        details: { to: toRaw, toClean, from: fromRaw },
      });
      return;
    }

    const inboundMessageSid =
      typeof body?.MessageSid === 'string' ? body.MessageSid.trim() : null;

    if (!isBusinessOperational(business)) {
      console.warn('[webhook] Business suspended/paused — blocking bot', {
        businessId: business.id,
        status: business.status,
      });
      try {
        const convForLang = await getOrCreateConversationState(business.id, recipientPhone);
        const uiLang = readSessionLanguage(convForLang?.context_data);
        await sendTextMessage({
          business,
          recipientPhone,
          requestId,
          text: bm('businessSuspended', uiLang),
        });
      } catch (error) {
        console.error('Eroare detalii:', error);
      }
      return;
    }

    if (inboundMessageSid) {
      rememberInboundMessageSid(business.id, recipientPhone, inboundMessageSid);
    }
    // Anything still running for an earlier message must stop replying now.
    beginInboundTurn(business.id, recipientPhone, requestId);
    await sendTypingIndicator({
      business,
      recipientPhone,
      messageSid: inboundMessageSid,
      requestId,
    });

    const { clientId, isNew } = await ensureClient({
      business,
      recipientPhone,
      displayName: profileName,
      requestId,
    });

    const swept = await sweepStalePendingForPhone({
      business,
      rawPhone: recipientPhone,
      requestId,
    });
    // Safety net when Vercel cron is misconfigured — expire ALL overdue holds for this tenant.
    try {
      await expireStalePendingForBusiness(business, requestId);
    } catch (expiryError) {
      console.warn('[webhook] business-wide pending expiry sweep failed', expiryError);
    }
    let convState = swept.conv;
    let activeDraft = swept.draft;
    convStateForLog = convState;
    const expiry = { expired: swept.expired, lastIntent: swept.lastIntent };
    const sessionTtl = getSessionTtlMinutes(business);
    const sessionExpired = Boolean(swept.idleExpired)
      || isConversationSessionExpired(convState, sessionTtl);

    if (sessionExpired) {
      clearRememberedMenuOptions(business.id, recipientPhone);
      const restarted = await resetExpiredSessionForRestart({
        business,
        rawPhone: recipientPhone,
        clientId,
        requestId,
      });
      convState = restarted.conv || convState;
      activeDraft = restarted.draft;
      console.log('[webhook] Session TTL reset — silently purged active draft and reset to IDLE', {
        sessionTtl,
        idleExpired: Boolean(swept.idleExpired),
        pendingExpired: Boolean(swept.expired),
      });
    }

    // Unstick rolled-back language-gate fields left in Supabase from EN tests.
    if (needsLanguageScrub(convState?.context_data)) {
      const scrubbed = await setConversationStep({
        businessId: business.id,
        rawPhone: recipientPhone,
        step: convState.current_step || 'IDLE',
        context: languageScrubPatch(convState.context_data),
        mergeContext: true,
        requestId,
      });
      if (scrubbed) convState = scrubbed;
    }

    convState = await touchSessionTimestamp({
      businessId: business.id,
      rawPhone: recipientPhone,
      requestId,
    }) || convState;

    console.log('[webhook] Conversation state:', {
      step: convState.current_step,
      contextKeys: Object.keys(convState.context_data ?? {}),
      isNewClient: isNew,
      pendingSwept: swept.expired,
      idleExpired: Boolean(swept.idleExpired),
      sessionExpired,
    });

    if (textBody.trim()) {
      await appendRecentTurn({
        businessId: business.id,
        rawPhone: recipientPhone,
        role: 'user',
        text: textBody,
        requestId,
      });
    }

    const pendingDismissed = Boolean(convState.context_data?.pending_dismissed);
    const lastIntent = pendingDismissed
      ? null
      : (
        convState.context_data?.last_booking_intent
        ?? expiry.lastIntent
        ?? (await resolveLastBookingIntent(business, recipientPhone))
      );

    await routeInboundTurn({
      business,
      recipientPhone,
      textBody,
      buttonPayload,
      buttonText,
      typedText: String(body?.Body ?? '').trim() || null,
      clientId,
      requestId,
      convState,
      activeDraft,
      lastIntent,
      pendingDismissed,
      pendingExpired: expiry.expired,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : null;
    console.error('[webhook] Failed to handle Twilio WhatsApp message', {
      requestId,
      businessId: business?.id ?? null,
      message: errMsg,
      stack: errStack,
      inboundPreview: textBody.slice(0, 200),
      step: convStateForLog?.current_step ?? null,
      pendingAction: convStateForLog?.context_data?.pending_action?.kind ?? null,
    });
    await logError({
      message: 'Failed to handle Twilio WhatsApp message',
      source: 'webhook',
      severity: 'error',
      businessId: business?.id ?? null,
      requestId,
      phoneNumber: phoneE164,
      error,
      details: {
        from: fromRaw,
        to: toRaw,
        toClean,
        bodyPreview: textBody.slice(0, 200),
        inboundText: String(body?.Body ?? '').slice(0, 500),
        messageSid: body?.MessageSid,
        conversationStep: convStateForLog?.current_step ?? null,
        pendingAction: convStateForLog?.context_data?.pending_action ?? null,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: errMsg,
        errorStack: errStack,
        alert: true,
      },
    });
    const tenant = business;
    if (tenant) {
      await sendTechnicalFallbackMessage({
        business: tenant,
        recipientPhone,
        requestId,
      });
    }
  }
}

