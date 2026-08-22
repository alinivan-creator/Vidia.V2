/**
 * WhatsApp inbound turn router.
 *
 * Backend-first pipeline: extract → execute (SSOT) → present.
 * SMS opt-in/out stays outside the booking state machine.
 */

import { processTurnPipeline } from './turnPipeline.js';
import { setClientSmsOptIn } from './smsMarketingService.js';
import { sendTextMessage } from './whatsappService.js';
import { triageUserIntent } from './intentTriageService.js';
import { getBookingConfig } from '../utils/datetime.js';
import {
  handleLanguageOnboarding,
  reloadConversationState,
} from './languageOnboardingService.js';

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
  buttonPayload = null,
  buttonText = null,
  typedText = null,
  clientId = null,
  requestId = null,
  convState,
  activeDraft,
  lastIntent = null,
  pendingDismissed = false,
  pendingExpired = false,
}) {
  const triage = triageUserIntent(textBody, {
    businessType: business.business_type,
    services: getBookingConfig(business).services,
  });

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

  void lastIntent;
  void pendingDismissed;
  void pendingExpired;

  const langGate = await handleLanguageOnboarding({
    business,
    recipientPhone,
    textBody,
    buttonPayload,
    requestId,
    convState,
    activeDraft,
  });
  if (langGate.handled) {
    if (!langGate.languageChosen) return;

    const freshConv = await reloadConversationState(business, recipientPhone);
    if (langGate.replayText) {
      await processTurnPipeline({
        business,
        recipientPhone,
        textBody: langGate.replayText,
        buttonPayload: null,
        buttonTitle: null,
        typedText: langGate.replayText,
        clientId,
        requestId,
        convState: freshConv,
        activeDraft,
      });
    } else {
      // Language chosen with nothing deferred — show the entry menu in that language.
      const { executeTurn } = await import('./turnExecute.js');
      const { presentTurn } = await import('./turnPresent.js');
      const { stampResultLanguage } = await import('../utils/bookingI18n.js');
      const { resolveClientLanguage } = await import('../utils/clientLanguage.js');
      const result = await executeTurn({
        business,
        recipientPhone,
        extract: {
          action: 'menu',
          source: 'language_gate',
          extraction: { intent: 'menu' },
        },
        clientId,
        requestId,
        convState: freshConv,
        activeDraft: null,
        textBody: '',
      });
      const lang = resolveClientLanguage('', freshConv?.context_data?.client_language, freshConv?.context_data);
      await presentTurn({
        business,
        recipientPhone,
        result: stampResultLanguage(result, lang),
        requestId,
      });
    }
    return;
  }

  await processTurnPipeline({
    business,
    recipientPhone,
    textBody,
    buttonPayload,
    buttonTitle: buttonText,
    typedText,
    clientId,
    requestId,
    convState,
    activeDraft,
  });
}
