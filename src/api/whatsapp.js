import { Router } from 'express';
import crypto from 'node:crypto';
import {
  getBusinessByWhatsAppToNumber,
  isBusinessOperational,
} from '../db/businessService.js';
import { getActiveDraftBooking } from '../db/draftBookingService.js';
import {
  isBookingFlowStep,
  isModificationFlowStep,
  CONVERSATION_STEPS,
  setConversationStep,
  resetConversationState,
  appendRecentTurn,
} from '../db/conversationStateService.js';
import { logError } from '../db/loggerService.js';
import {
  handleBookingInteractiveReply,
  offerResumeOrAlternatives,
  handleResumeOfferReply,
} from '../services/bookingFlowService.js';
import { handlePendingHoldTurn } from '../services/pendingHoldService.js';
import {
  handleGlobalModificationIntent,
  handleModificationInteractive,
  handleModificationText,
} from '../services/modificationFlowService.js';
import {
  triageUserIntent,
  looksLikeOutOfScopeRequest,
  looksLikeDatetimeOrSlot,
  isExplicitConfirmReply,
  isExplicitCancelReply,
  wantsSameExpiredBooking,
} from '../services/intentTriageService.js';
import {
  ensureClient,
  handleMenuButtonPress,
  handleBrowsingTextMessage,
  handleBookingAction,
  sendEntryMenu,
  sendAiTransparencyWelcome,
  handleInfoAction,
  handleCallbackRequest,
} from '../services/menuHandler.js';
import { setClientSmsOptIn } from '../services/smsMarketingService.js';
import {
  interpretUserTurn,
  buildConversationTurnContext,
  isOpenAiTemporarilyDown,
} from '../services/aiService.js';
import {
  getRememberedMenuOptions,
  resolveNumberedChoice,
  rememberInboundMessageSid,
  sendTypingIndicator,
  sendTextMessage,
  simulateHumanDelay,
} from '../services/whatsappService.js';
import { toE164, toMetaPhone } from '../utils/phone.js';
import { debugLog } from '../utils/debugLog.js';
import { continueAfterResponse } from '../utils/afterResponse.js';
import {
  sweepStalePendingForPhone,
  resolveLastBookingIntent,
} from '../services/pendingExpiryService.js';

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
      console.error('Eroare detalii:', error);
      debugLog('WEBHOOK FATAL', String(error));
      await logError({
        message: 'Unhandled Twilio WhatsApp webhook error',
        source: 'webhook',
        severity: 'critical',
        requestId,
        error,
        details: { body: sanitizeTwilioBody(req.body) },
      });
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
  };
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} requestId
 */
async function processTwilioWebhook(body, requestId) {
  const fromRaw = String(body?.From ?? '');
  const toRaw = String(body?.To ?? '');
  const textBody = String(body?.Body ?? '').trim();

  const toClean = toE164(toRaw);
  const fromClean = toE164(fromRaw);

  console.log('[webhook] Numbers cleaned:', {
    fromRaw,
    toRaw,
    fromClean,
    toClean,
    body: textBody.slice(0, 120),
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

  const business = await getBusinessByWhatsAppToNumber(toClean, { includeInactive: true });

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

  const recipientPhone = toMetaPhone(fromClean);
  const phoneE164 = fromClean;
  const inboundMessageSid =
    typeof body?.MessageSid === 'string' ? body.MessageSid.trim() : null;

  if (!isBusinessOperational(business)) {
    console.warn('[webhook] Business suspended/paused — blocking bot', {
      businessId: business.id,
      status: business.status,
    });
    try {
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text:
          'Serviciul de programări este temporar inactiv. ' +
          'Te rugăm să revii mai târziu sau să contactezi direct afacerea.',
      });
    } catch (error) {
      console.error('Eroare detalii:', error);
    }
    return;
  }

  try {
    // Typing… as soon as we start processing (needs Twilio MessageSid)
    if (inboundMessageSid) {
      rememberInboundMessageSid(business.id, recipientPhone, inboundMessageSid);
    }
    await sendTypingIndicator({
      business,
      recipientPhone,
      messageSid: inboundMessageSid,
      requestId,
    });

    const { clientId, isNew } = await ensureClient({ business, recipientPhone, requestId });

    // Lazy TTL: expire stale pending / stuck confirm steps before routing.
    const swept = await sweepStalePendingForPhone({
      business,
      rawPhone: recipientPhone,
      requestId,
    });
    let convState = swept.conv;
    let activeDraft = swept.draft;
    const expiry = { expired: swept.expired, lastIntent: swept.lastIntent };

    console.log('[webhook] Conversation state:', {
      step: convState.current_step,
      contextKeys: Object.keys(convState.context_data ?? {}),
      isNewClient: isNew,
      pendingSwept: swept.expired,
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

    const normalized = textBody.toLowerCase().trim();

    // Mandatory AI transparency on first contact — welcome_message + AI disclosure
    if (isNew) {
      console.log('[webhook] New client — AI transparency welcome');
      const earlyTriage = triageUserIntent(textBody, { businessType: business.business_type });
      const actionable = ['book', 'faq', 'contact', 'cancel', 'reschedule', 'callback'].includes(
        earlyTriage.intent,
      );
      await sendAiTransparencyWelcome({
        business,
        recipientPhone,
        requestId,
        withMenu: !actionable,
      });
      // Pure greetings / empty intent → welcome + menu is enough for first touch
      if (!actionable && earlyTriage.intent !== 'menu') {
        const isGreeting = /^(salut|buna|bună|hello|hi|hey|servus|seara buna|buna ziua)[\s!.]*$/i.test(
          normalized,
        );
        if (isGreeting || !textBody.trim()) return;
      }
    }

    const pendingDismissed = Boolean(convState.context_data?.pending_dismissed);
    const lastIntent = pendingDismissed
      ? null
      : (
        convState.context_data?.last_booking_intent
        ?? expiry.lastIntent
        ?? (await resolveLastBookingIntent(business, recipientPhone))
      );

    const isPendingHold =
      activeDraft?.state === 'pending_confirmation'
      || convState.current_step === CONVERSATION_STEPS.CONFIRMING
      || convState.current_step === CONVERSATION_STEPS.ASKING_NAME;

    // "2" / Anulează on a pending hold must wipe the draft before any other routing.
    if (isPendingHold && isExplicitCancelReply(textBody)) {
      await handleBookingInteractiveReply({
        business,
        recipientPhone,
        replyId: 'cancel_booking',
        clientId,
        requestId,
      });
      return;
    }

    if (convState.current_step === CONVERSATION_STEPS.OFFERING_RESUME && lastIntent) {
      if (isExplicitConfirmReply(textBody) || isExplicitCancelReply(textBody)) {
        const handledResume = await handleResumeOfferReply({
          business,
          recipientPhone,
          replyId: isExplicitConfirmReply(textBody) ? 'resume_confirm' : 'resume_other_slots',
          lastIntent,
          clientId,
          requestId,
        });
        if (handledResume) return;
      }
      const rememberedResume = getRememberedMenuOptions(business.id, recipientPhone);
      if (rememberedResume?.length) {
        const choiceId = resolveNumberedChoice(textBody, rememberedResume);
        if (choiceId) {
          const handledResume = await handleResumeOfferReply({
            business,
            recipientPhone,
            replyId: choiceId,
            lastIntent,
            clientId,
            requestId,
          });
          if (handledResume) return;
        }
      }
    }

    // Collect client name before confirm — abort keywords only.
    // Free text (preț, alt angajat, răzgândire) stays on the hold and goes to the LLM.
    if (convState.current_step === CONVERSATION_STEPS.ASKING_NAME) {
      const nameNorm = normalized.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const wantsAbortName =
        isExplicitCancelReply(textBody)
        || ['renunt', 'meniu', 'menu'].some((k) => nameNorm === k || nameNorm.includes(k));

      if (wantsAbortName) {
        await handleBookingInteractiveReply({
          business,
          recipientPhone,
          replyId: 'cancel_booking',
          clientId,
          requestId,
        });
        if (nameNorm.includes('meniu') || nameNorm === 'menu') {
          await sendEntryMenu({ business, recipientPhone, requestId });
        }
        return;
      }
    }

    // Mid modification flow first (confirm/abort cancel, pick reschedule slot)
    if (isModificationFlowStep(convState.current_step)) {
      const rememberedMod = getRememberedMenuOptions(business.id, recipientPhone);
      if (rememberedMod?.length) {
        const choiceId = resolveNumberedChoice(textBody, rememberedMod);
        if (choiceId) {
          const handledMod = await handleModificationInteractive({
            business,
            recipientPhone,
            replyId: choiceId,
            convState,
            requestId,
          });
          if (handledMod) return;
        }
      }

      const handled = await handleModificationText({
        business,
        recipientPhone,
        textBody,
        convState,
        requestId,
      });
      if (handled) return;
    }

    // Instant triage BEFORE booking menus / drafts — cancel/reschedule must not open services.
    // Pending "2"/Anulează is handled above and must not start the confirmed-booking cancel flow.
    const triage = triageUserIntent(textBody, { businessType: business.business_type });
    if (
      !isPendingHold
      && (triage.intent === 'cancel' || triage.intent === 'reschedule')
    ) {
      console.log('[webhook] Modification intent', {
        intent: triage.intent,
        reason: triage.reason,
        preview: textBody.slice(0, 80),
      });
      await handleGlobalModificationIntent({
        business,
        recipientPhone,
        intent: triage.intent,
        activeDraft,
        requestId,
      });
      return;
    }

    if (
      lastIntent
      && !activeDraft
      && !pendingDismissed
      && convState.current_step !== CONVERSATION_STEPS.OFFERING_RESUME
      && wantsSameExpiredBooking(textBody, triage)
    ) {
      const offered = await offerResumeOrAlternatives({
        business,
        recipientPhone,
        lastIntent,
        clientId,
        requestId,
      });
      if (offered) return;
    }

    // Pending hold: exact 1/da and 2/nu stay shortcuts. Any other text goes to OpenAI
    // with history — do not abandon or restart booking from a template.
    if (isPendingHold) {
      await handlePendingHoldTurn({
        business,
        recipientPhone,
        textBody,
        clientId,
        requestId,
        convState,
        activeDraft,
        lastIntent,
        pendingDismissed,
        pendingExpired: expiry.expired,
      });
      return;
    }

    // Numbered menu reply → interactive id (booking / entry menus)
    const remembered = getRememberedMenuOptions(business.id, recipientPhone);
    if (remembered?.length) {
      const choiceId = resolveNumberedChoice(textBody, remembered);
      if (choiceId) {
        const handledMod = await handleModificationInteractive({
          business,
          recipientPhone,
          replyId: choiceId,
          convState,
          requestId,
        });
        if (handledMod) return;

        const handledByBooking = await handleBookingInteractiveReply({
          business,
          recipientPhone,
          replyId: choiceId,
          clientId,
          requestId,
        });
        if (handledByBooking) return;

        await handleMenuButtonPress({
          business,
          recipientPhone,
          buttonId: choiceId,
          clientId,
          requestId,
        });
        return;
      }
    }

    const liveDraft = await getActiveDraftBooking(business.id, recipientPhone);

    if (liveDraft?.state === 'browsing') {
      if (liveDraft.selected_service && convState.current_step === CONVERSATION_STEPS.CHOOSING_SERVICE) {
        await setConversationStep({
          businessId: business.id,
          rawPhone: recipientPhone,
          step: CONVERSATION_STEPS.SELECTING_SLOT,
          context: {
            draft_id: liveDraft.id,
            service: liveDraft.selected_service,
            intent: 'book',
          },
          requestId,
        });
      }

      await handleBrowsingTextMessage({
        business,
        recipientPhone,
        textBody,
        requestId,
      });
      return;
    }

    // Keyword triage for idle conversation (book / FAQ / contact / callback / menu)
    if (triage.intent === 'book' || looksLikeDatetimeOrSlot(textBody)) {
      await handleBookingAction({
        business,
        recipientPhone,
        clientId,
        hintText: textBody,
        requestId,
      });
      return;
    }

    if (triage.intent === 'contact') {
      await handleMenuButtonPress({
        business,
        recipientPhone,
        buttonId: 'contact',
        clientId,
        requestId,
      });
      return;
    }

    if (triage.intent === 'faq') {
      const faqTurns = Array.isArray(convState.context_data?.recent_turns)
        ? convState.context_data.recent_turns
        : [];
      await handleInfoAction({
        business,
        recipientPhone,
        userMessage: textBody,
        clientId,
        requestId,
        turnContext: buildConversationTurnContext({
          step: convState.current_step,
          lastIntent,
          pendingDismissed,
          pendingExpired: expiry.expired,
          recentTurns: faqTurns,
        }),
        history: faqTurns,
      });
      return;
    }

    if (triage.intent === 'menu') {
      await sendEntryMenu({ business, recipientPhone, requestId });
      return;
    }

    if (triage.intent === 'sms_opt_in') {
      await setClientSmsOptIn({
        businessId: business.id,
        rawPhone: recipientPhone,
        optIn: true,
      });
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text:
          '✅ Te-ai abonat la SMS-uri de la *' + business.name + '*.\n' +
          'Poți renunța oricând scriind *stop sms*.',
      });
      return;
    }

    if (triage.intent === 'sms_opt_out') {
      await setClientSmsOptIn({
        businessId: business.id,
        rawPhone: recipientPhone,
        optIn: false,
      });
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text: 'Ok — nu vei mai primi SMS-uri de marketing. Poți reactiva cu *da sms*.',
      });
      return;
    }

    if (triage.intent === 'callback' || looksLikeOutOfScopeRequest(textBody)) {
      console.log('[webhook] Callback triage', {
        intent: triage.intent,
        reason: triage.reason,
        preview: textBody.slice(0, 80),
      });
      await handleCallbackRequest({
        business,
        recipientPhone,
        userMessage: textBody,
        reason: triage.intent === 'callback' ? triage.reason : 'out_of_scope_keyword',
        clientId,
        requestId,
      });
      return;
    }

    // Stuck booking step without an active draft → clear memory and answer with AI
    if (isBookingFlowStep(convState.current_step) && !activeDraft) {
      await resetConversationState({
        businessId: business.id,
        rawPhone: recipientPhone,
        keepLastIntent: !pendingDismissed,
        requestId,
      });
    }

    const recentTurns = Array.isArray(convState.context_data?.recent_turns)
      ? convState.context_data.recent_turns
      : [];
    const turnContext = buildConversationTurnContext({
      step: convState.current_step,
      lastIntent,
      pendingDismissed,
      pendingExpired: expiry.expired,
      recentTurns,
    });

    const skipRouter = !process.env.OPENAI_API_KEY || isOpenAiTemporarilyDown();
    const interpreted = skipRouter
      ? null
      : await interpretUserTurn({
          business,
          userMessage: textBody,
          turnContext,
          history: recentTurns,
          requestId,
        });

    if (interpreted?.action === 'resume' && lastIntent && !pendingDismissed) {
      const offered = await offerResumeOrAlternatives({
        business,
        recipientPhone,
        lastIntent,
        clientId,
        requestId,
      });
      if (offered) return;
    }

    if (interpreted?.action === 'book') {
      await handleBookingAction({
        business,
        recipientPhone,
        clientId,
        hintText: textBody,
        requestId,
      });
      return;
    }

    if (interpreted?.action === 'cancel' || interpreted?.action === 'reschedule') {
      await handleGlobalModificationIntent({
        business,
        recipientPhone,
        intent: interpreted.action,
        activeDraft,
        requestId,
      });
      return;
    }

    if (interpreted?.action === 'callback') {
      await handleCallbackRequest({
        business,
        recipientPhone,
        userMessage: textBody,
        reason: 'ai_router_callback',
        clientId,
        requestId,
      });
      return;
    }

    if (interpreted?.message && (interpreted.action === 'faq' || interpreted.action === 'chat')) {
      await simulateHumanDelay({ business, recipientPhone, requestId });
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text: interpreted.message,
      });
      return;
    }

    console.log('[webhook] Routing free-text to AI', {
      preview: textBody.slice(0, 80),
      triage: triage.reason,
    });
    await handleInfoAction({
      business,
      recipientPhone,
      userMessage: textBody,
      clientId,
      requestId,
      turnContext,
      history: recentTurns,
    });
  } catch (error) {
    console.error('Eroare detalii:', error);
    await logError({
      message: 'Failed to handle Twilio WhatsApp message',
      source: 'webhook',
      severity: 'error',
      businessId: business.id,
      requestId,
      phoneNumber: phoneE164,
      error,
      details: {
        from: fromRaw,
        to: toRaw,
        toClean,
        bodyPreview: textBody.slice(0, 200),
        messageSid: body?.MessageSid,
        alert: true,
      },
    });
    try {
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text: 'Momentan nu pot finaliza această acțiune. Te rog încearcă din nou în câteva minute.',
      });
    } catch (sendError) {
      console.error('Eroare detalii:', sendError);
    }
  }
}
