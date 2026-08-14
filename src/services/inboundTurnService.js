/**
 * WhatsApp inbound turn router.
 *
 * State first (current step + valid numbered/name selection), then intent (OpenAI).
 * Never re-sends the service/entry menu just because the text was not an exact digit.
 */

import {
  CONVERSATION_STEPS,
  isBookingFlowStep,
  isModificationFlowStep,
  resetConversationState,
  readLastMenu,
} from '../db/conversationStateService.js';
import {
  interpretUserTurn,
  buildConversationTurnContext,
  isOpenAiTemporarilyDown,
} from './aiService.js';
import {
  handleBookingInteractiveReply,
  handleResumeOfferReply,
  offerResumeOrAlternatives,
  tryApplyBookingStepReply,
  handleFreeTextSlotRequest,
  applyPendingEmployeeChange,
} from './bookingFlowService.js';
import { handlePendingHoldTurn } from './pendingHoldService.js';
import { acceptClarifiedOffer, rememberOfferFromAssistant, readPendingOffer, readClarified, historyWithoutResolvedObjections } from './pendingOfferService.js';
import {
  handleGlobalModificationIntent,
  handleModificationInteractive,
  handleModificationText,
} from './modificationFlowService.js';
import {
  triageUserIntent,
  looksLikeOutOfScopeRequest,
  looksLikeDatetimeOrSlot,
  isExplicitConfirmReply,
  isExplicitCancelReply,
  wantsSameExpiredBooking,
} from './intentTriageService.js';
import {
  handleMenuButtonPress,
  handleBookingAction,
  sendEntryMenu,
  handleInfoAction,
  handleCallbackRequest,
} from './menuHandler.js';
import { setClientSmsOptIn } from './smsMarketingService.js';
import {
  resolveNumberedChoice,
  sendTextMessage,
  simulateHumanDelay,
} from './whatsappService.js';

/** @typedef {import('../db/businessService.js').Business} Business */

/**
 * @param {Object} ctx
 * @param {Business} ctx.business
 * @param {string} ctx.recipientPhone
 * @param {string} ctx.textBody
 * @param {string | null} ctx.clientId
 * @param {string | null} ctx.requestId
 * @param {import('../db/conversationStateService.js').ConversationState} ctx.convState
 * @param {import('../db/draftBookingService.js').DraftBooking | null} ctx.activeDraft
 * @param {object | null} ctx.lastIntent
 * @param {boolean} ctx.pendingDismissed
 * @param {boolean} ctx.pendingExpired
 */
export async function routeInboundTurn({
  business,
  recipientPhone,
  textBody,
  clientId = null,
  requestId = null,
  convState,
  activeDraft,
  lastIntent = null,
  pendingDismissed = false,
  pendingExpired = false,
}) {
  const step = convState.current_step;
  const lastMenu = readLastMenu(convState);
  const recentTurns = historyWithoutResolvedObjections(
    Array.isArray(convState.context_data?.recent_turns)
      ? convState.context_data.recent_turns
      : [],
    convState,
  );
  const triage = triageUserIntent(textBody, { businessType: business.business_type });

  const isPendingHold =
    activeDraft?.state === 'pending_confirmation'
    || step === CONVERSATION_STEPS.CONFIRMING
    || step === CONVERSATION_STEPS.ASKING_NAME;

  const inBooking =
    isBookingFlowStep(step)
    || ['browsing', 'pending_confirmation'].includes(String(activeDraft?.state || ''));

  if (triage.intent === 'sms_opt_in') {
    await setClientSmsOptIn({ businessId: business.id, rawPhone: recipientPhone, optIn: true });
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
    await setClientSmsOptIn({ businessId: business.id, rawPhone: recipientPhone, optIn: false });
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: 'Ok — nu vei mai primi SMS-uri de marketing. Poți reactiva cu *da sms*.',
    });
    return;
  }

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

  if (step === CONVERSATION_STEPS.ASKING_NAME) {
    const nameNorm = String(textBody || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    const wantsAbort =
      isExplicitCancelReply(textBody)
      || ['renunt', 'meniu', 'menu'].some((k) => nameNorm === k || nameNorm.includes(k));
    if (wantsAbort) {
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

  // STATE: valid selection for the current picker (1 → first service, even after a cold start)
  const appliedStep = await tryApplyBookingStepReply({
    business,
    recipientPhone,
    textBody,
    convState,
    draft: activeDraft,
    clientId,
    requestId,
  });
  if (appliedStep) return;

  const acceptedOffer = await acceptClarifiedOffer({
    business,
    recipientPhone,
    textBody,
    convState,
    draft: activeDraft,
    clientId,
    requestId,
  });
  if (acceptedOffer) return;

  if (step === CONVERSATION_STEPS.OFFERING_RESUME && lastIntent) {
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
    const resumeOptions = lastMenu?.kind === 'resume' ? lastMenu.options : null;
    if (resumeOptions?.length) {
      const choiceId = resolveNumberedChoice(textBody, resumeOptions);
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

  if (isModificationFlowStep(step)) {
    const modOptions = lastMenu && ['modify', 'slot', 'confirm'].includes(lastMenu.kind)
      ? lastMenu.options
      : [];
    if (modOptions.length) {
      const choiceId = resolveNumberedChoice(textBody, modOptions);
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

  if (
    !inBooking
    && (triage.intent === 'cancel' || triage.intent === 'reschedule')
  ) {
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
    && step !== CONVERSATION_STEPS.OFFERING_RESUME
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
      pendingExpired,
    });
    return;
  }

  // IDLE numbered entry menu (Programare / Prețuri / Contact) — not while booking
  if (!inBooking && lastMenu?.kind === 'entry' && lastMenu.options.length) {
    const choiceId = resolveNumberedChoice(textBody, lastMenu.options);
    if (choiceId) {
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

  if (triage.intent === 'menu') {
    await sendEntryMenu({ business, recipientPhone, requestId });
    return;
  }

  // New booking only from idle — never restart the service list mid-flow
  if (!inBooking && (triage.intent === 'book' || looksLikeDatetimeOrSlot(textBody))) {
    await handleBookingAction({
      business,
      recipientPhone,
      clientId,
      hintText: textBody,
      requestId,
    });
    return;
  }

  if (!inBooking && triage.intent === 'contact') {
    await handleMenuButtonPress({
      business,
      recipientPhone,
      buttonId: 'contact',
      clientId,
      requestId,
    });
    return;
  }

  if (inBooking && activeDraft?.selected_service && looksLikeDatetimeOrSlot(textBody)) {
    const handled = await handleFreeTextSlotRequest({
      business,
      recipientPhone,
      draft: activeDraft,
      textBody,
      requestId,
    });
    if (handled) return;
  }

  if (isBookingFlowStep(step) && !activeDraft) {
    await resetConversationState({
      businessId: business.id,
      rawPhone: recipientPhone,
      keepLastIntent: !pendingDismissed,
      requestId,
    });
  }

  const turnContext = buildConversationTurnContext({
    step,
    lastIntent,
    pendingDismissed,
    pendingExpired,
    recentTurns,
    pendingHold: null,
    pendingOffer: readPendingOffer(convState),
    clarified: readClarified(convState),
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

  if (interpreted?.action === 'change_employee') {
    if (activeDraft) {
      await applyPendingEmployeeChange({
        business,
        recipientPhone,
        draft: activeDraft,
        textBody: readPendingOffer(convState)?.name || textBody,
        requestId,
      });
    } else {
      await handleBookingAction({
        business,
        recipientPhone,
        clientId,
        hintText: readPendingOffer(convState)?.name || textBody,
        requestId,
      });
    }
    return;
  }

  if (interpreted?.action === 'book') {
    if (inBooking && activeDraft?.selected_service && looksLikeDatetimeOrSlot(textBody)) {
      const handled = await handleFreeTextSlotRequest({
        business,
        recipientPhone,
        draft: activeDraft,
        textBody,
        requestId,
      });
      if (handled) return;
    }
    if (inBooking) {
      // Already in a booking step — do not restart the service picker.
      await handleInfoAction({
        business,
        recipientPhone,
        userMessage: textBody,
        clientId,
        requestId,
        turnContext,
        history: recentTurns,
      });
      return;
    }
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
    if (isPendingHold) {
      await handleBookingInteractiveReply({
        business,
        recipientPhone,
        replyId: 'cancel_booking',
        clientId,
        requestId,
      });
      return;
    }
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
    await rememberOfferFromAssistant({
      business,
      recipientPhone,
      text: interpreted.message,
      requestId,
    });
    return;
  }

  if (!inBooking && (triage.intent === 'callback' || looksLikeOutOfScopeRequest(textBody))) {
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

  await handleInfoAction({
    business,
    recipientPhone,
    userMessage: textBody,
    clientId,
    requestId,
    turnContext,
    history: recentTurns,
  });
}
