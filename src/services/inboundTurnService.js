/**
 * WhatsApp inbound turn router.
 *
 * Backend-first pipeline: extract → execute (SSOT) → present.
 * SMS opt-in/out stays outside the booking state machine.
 */

import { processTurnPipeline } from './turnPipeline.js';
import { setClientSmsOptIn } from './smsMarketingService.js';
import {
  sendTextMessage,
  sendInteractiveButtons,
  clearRememberedMenuOptions,
  simulateHumanDelay,
} from './whatsappService.js';
import { triageUserIntent } from './intentTriageService.js';
import { getBookingConfig } from '../utils/datetime.js';
import { setConversationStep } from '../db/conversationStateService.js';
import {
  parseLanguageChoice,
  isRestartSessionCommand,
  hasExplicitSessionLanguage,
  detectSessionLanguageFromText,
  entryMenuBodyText,
  withEnglishSwitchOption,
  localizeMenuOptions,
} from '../utils/uiI18n.js';
import {
  needsAiDisclosure,
  buildMandatoryAiDisclosure,
  buildAiTransparencyWelcome,
} from '../utils/businessMessages.js';
import { resetExpiredSessionForRestart } from './pendingExpiryCron.js';

/** @typedef {import('../db/businessService.js').Business} Business */

/**
 * @param {Business} business
 */
function entryMenuButtons(business) {
  return (business.menu_buttons ?? []).slice(0, 3).map((btn) => ({
    id: btn.id,
    title: String(btn.label || '').slice(0, 20),
  }));
}

/**
 * @param {Object} params
 * @param {string} params.businessId
 * @param {string} params.rawPhone
 * @param {string} params.step
 * @param {string | null} [params.requestId]
 */
async function markAiDisclosed({ businessId, rawPhone, step, requestId = null }) {
  await setConversationStep({
    businessId,
    rawPhone,
    step: step || 'IDLE',
    context: { ai_disclosed: true },
    mergeContext: true,
    requestId,
  });
}

/**
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {string | null} [params.requestId]
 * @param {'ro' | 'en'} [params.lang]
 * @param {string} [params.bodyText]
 */
async function sendFreshEntryMenu({
  business,
  recipientPhone,
  requestId = null,
  lang = 'ro',
  bodyText = null,
}) {
  const options = withEnglishSwitchOption(entryMenuButtons(business), lang);
  if (!options.length) return;
  const buttons = localizeMenuOptions(options, lang);
  await simulateHumanDelay({ business, recipientPhone, requestId, delayMs: 600 });
  await sendInteractiveButtons({
    business,
    recipientPhone,
    requestId,
    bodyText: bodyText || entryMenuBodyText(lang),
    buttons,
    footerText: business.name,
    menuKind: 'entry',
    rememberOptions: buttons,
  });
}

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

  // Universal hard reset — clears stuck mid-flow state during tests or for clients.
  if (isRestartSessionCommand(textBody) || isRestartSessionCommand(typedText)) {
    clearRememberedMenuOptions(business.id, recipientPhone);
    const restarted = await resetExpiredSessionForRestart({
      business,
      rawPhone: recipientPhone,
      clientId,
      requestId,
    });
    // New thread → mandatory AI + GDPR disclosure on the first reply.
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: buildAiTransparencyWelcome(business, 'en'),
    });
    await sendFreshEntryMenu({
      business,
      recipientPhone,
      requestId,
      lang: 'en',
      bodyText: entryMenuBodyText('en'),
    });
    await markAiDisclosed({
      businessId: business.id,
      rawPhone: recipientPhone,
      step: 'IDLE',
      requestId,
    });
    console.log('[session] restart session — hard reset to entry menu', {
      businessId: business.id,
      requestId,
      message: restarted.message,
    });
    return;
  }

  let nextConv = convState;

  // Soft language pick — only when the whole message is a language word / button.
  const langPick = parseLanguageChoice({ textBody, buttonPayload });
  if (langPick) {
    const step = nextConv?.current_step || 'IDLE';
    const mustDisclose = needsAiDisclosure(nextConv?.context_data);
    nextConv = await setConversationStep({
      businessId: business.id,
      rawPhone: recipientPhone,
      step,
      context: {
        session_language: langPick,
        ...(mustDisclose ? { ai_disclosed: true } : {}),
      },
      mergeContext: true,
      requestId,
    }) || nextConv;

    // Once per session, right after language choice — never the old "Great! We will…".
    if (mustDisclose) {
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text: buildMandatoryAiDisclosure(business, langPick),
      });
    }
    // Always refresh the entry menu in the chosen language when idle.
    if (step === 'IDLE' || step === 'idle') {
      await sendFreshEntryMenu({
        business,
        recipientPhone,
        requestId,
        lang: langPick,
        bodyText: entryMenuBodyText(langPick),
      });
    }
    return;
  }

  // First free-text on a fresh session: auto-detect English and continue the same turn.
  if (!hasExplicitSessionLanguage(nextConv?.context_data)) {
    const guessed = detectSessionLanguageFromText(textBody || typedText);
    if (guessed === 'en') {
      nextConv = await setConversationStep({
        businessId: business.id,
        rawPhone: recipientPhone,
        step: nextConv?.current_step || 'IDLE',
        context: { session_language: 'en' },
        mergeContext: true,
        requestId,
      }) || nextConv;
      console.log('[session] Smart language detection → en', { requestId });
    }
  }

  // Direct request (booking etc.) continues through the pipeline — disclosure is
  // attached on the first presentTurn when ai_disclosed is not set yet.
  await processTurnPipeline({
    business,
    recipientPhone,
    textBody,
    buttonPayload,
    buttonTitle: buttonText,
    typedText,
    clientId,
    requestId,
    convState: nextConv,
    activeDraft,
  });
}
