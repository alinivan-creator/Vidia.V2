/**
 * Optional pre-booking language gate — isolated from the booking state machine.
 * Feature-flagged OFF by default (see config/languageGate.js).
 */

import {
  getOrCreateConversationState,
  setConversationStep,
  CONVERSATION_STEPS,
  appendRecentTurn,
} from '../db/conversationStateService.js';
import {
  buildLanguageGateWelcome,
  isLanguageGateEnabled,
  languageConfirmedAck,
  LANGUAGE_BUTTONS,
} from '../config/languageGate.js';

/** @typedef {import('../db/businessService.js').Business} Business */
/** @typedef {import('../db/conversationStateService.js').ConversationState} ConversationState */

const MODIFY_INTENTS = new Set(['reschedule', 'cancel']);

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {ConversationState | null | undefined} convState
 */
export function hasConfirmedLanguage(convState) {
  const ctx = convState?.context_data || {};
  const lang = ctx.client_language;
  return ctx.language_confirmed === true && (lang === 'ro' || lang === 'en');
}

/**
 * @param {ConversationState | null | undefined} convState
 */
export function isAwaitingLanguageChoice(convState) {
  return convState?.context_data?.language_gate_pending === true;
}

/**
 * @param {Object} params
 * @param {Business} params.business
 * @param {ConversationState} params.convState
 * @param {import('../db/draftBookingService.js').DraftBooking | null} [params.activeDraft]
 */
export async function shouldRunLanguageGate({ business, convState, activeDraft = null }) {
  if (!isLanguageGateEnabled(business)) return false;
  if (hasConfirmedLanguage(convState)) return false;

  const step = convState?.current_step;
  const ctx = convState?.context_data || {};
  if (MODIFY_INTENTS.has(String(ctx.intent || ''))) return false;
  if (step === CONVERSATION_STEPS.RESCHEDULING
    || step === CONVERSATION_STEPS.MODIFYING
    || step === CONVERSATION_STEPS.CONFIRMING_CANCEL) {
    return false;
  }

  if (isAwaitingLanguageChoice(convState)) return true;

  return shouldRunLanguageGateInFlight({ step, convState, activeDraft, ctx });
}

async function shouldRunLanguageGateInFlight({ step, convState, activeDraft, ctx }) {
  const { isInFlightBookingContext } = await import('./inFlightBookingSession.js');
  const { getBookingWait } = await import('./bookingWaitState.js');
  if (isInFlightBookingContext({
    step,
    wait: getBookingWait(convState),
    activeDraft,
    context: ctx,
  })) {
    return false;
  }
  return true;
}

/**
 * @param {Object} params
 * @param {string | null | undefined} params.textBody
 * @param {string | null | undefined} params.buttonPayload
 * @returns {'ro' | 'en' | null}
 */
export function resolveLanguageChoice({ textBody, buttonPayload }) {
  const tap = String(buttonPayload ?? '').trim();
  if (tap === LANGUAGE_BUTTONS.RO.id) return 'ro';
  if (tap === LANGUAGE_BUTTONS.EN.id) return 'en';

  const n = normalize(textBody);
  if (!n) return null;
  if (/^(romana|română|romana|ro)$/.test(n)) return 'ro';
  if (/^(english|engleza|engleză|en)$/.test(n)) return 'en';
  if (/\bromana\b|\bromână\b/.test(n) && !/\benglish\b/.test(n)) return 'ro';
  if (/\benglish\b|\bengleza\b|\bengleză\b/.test(n)) return 'en';
  return null;
}

/**
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {string | null} [params.requestId]
 * @param {string | null} [params.deferredText]
 */
async function sendLanguagePrompt({ business, recipientPhone, requestId, deferredText = null }) {
  const { sendInteractiveButtons } = await import('./whatsappService.js');
  const welcome = buildLanguageGateWelcome(business);
  const options = [LANGUAGE_BUTTONS.RO, LANGUAGE_BUTTONS.EN];

  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: CONVERSATION_STEPS.IDLE,
    context: {
      language_gate_pending: true,
      ...(deferredText ? { deferred_inbound: deferredText.slice(0, 500) } : {}),
      last_menu: {
        kind: 'language',
        options: options.map((o) => ({ id: o.id, title: o.title })),
      },
    },
    mergeContext: true,
    requestId,
  });

  await sendInteractiveButtons({
    business,
    recipientPhone,
    bodyText: welcome,
    buttons: options,
    menuKind: 'language',
    rememberOptions: options,
    requestId,
  });

  await appendRecentTurn({
    businessId: business.id,
    rawPhone: recipientPhone,
    role: 'assistant',
    text: welcome,
    requestId,
  });
}

/**
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {'ro' | 'en'} params.lang
 * @param {string | null} [params.requestId]
 * @param {string | null} [params.deferredText]
 */
async function confirmLanguageChoice({
  business,
  recipientPhone,
  lang,
  requestId,
  deferredText = null,
}) {
  const { sendTextMessage } = await import('./whatsappService.js');
  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: CONVERSATION_STEPS.IDLE,
    context: {
      client_language: lang,
      language_confirmed: true,
      language_gate_pending: false,
      deferred_inbound: null,
      last_menu: null,
    },
    mergeContext: true,
    requestId,
  });

  const ack = languageConfirmedAck(lang);
  await sendTextMessage({
    business,
    recipientPhone,
    requestId,
    text: ack,
  });
  await appendRecentTurn({
    businessId: business.id,
    rawPhone: recipientPhone,
    role: 'assistant',
    text: ack,
    requestId,
  });

  return deferredText?.trim() || null;
}

/**
 * Runs before the booking pipeline when the language gate is enabled.
 *
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {string} params.textBody
 * @param {string | null} [params.buttonPayload]
 * @param {string | null} [params.requestId]
 * @param {ConversationState} params.convState
 * @param {import('../db/draftBookingService.js').DraftBooking | null} [params.activeDraft]
 * @returns {Promise<{ handled: boolean, replayText?: string | null }>}
 */
export async function handleLanguageOnboarding({
  business,
  recipientPhone,
  textBody,
  buttonPayload = null,
  requestId = null,
  convState,
  activeDraft = null,
}) {
  const gateOpen = await shouldRunLanguageGate({ business, convState, activeDraft });
  if (!gateOpen) {
    return { handled: false };
  }

  const deferredFromCtx = typeof convState?.context_data?.deferred_inbound === 'string'
    ? convState.context_data.deferred_inbound
    : null;
  const chosen = resolveLanguageChoice({ textBody, buttonPayload });

  if (chosen) {
    const replay = await confirmLanguageChoice({
      business,
      recipientPhone,
      lang: chosen,
      requestId,
      deferredText: deferredFromCtx,
    });
    return { handled: true, languageChosen: true, replayText: replay };
  }

  if (isAwaitingLanguageChoice(convState)) {
    const { sendTextMessage } = await import('./whatsappService.js');
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: 'Te rog apasă *Română* sau *English* mai jos.\nPlease tap *Română* or *English* below.',
    });
    return { handled: true, languageChosen: false };
  }

  const raw = String(textBody || '').trim();
  const deferForLater = raw && !resolveLanguageChoice({ textBody: raw, buttonPayload: null })
    ? raw
    : null;
  await sendLanguagePrompt({
    business,
    recipientPhone,
    requestId,
    deferredText: deferForLater,
  });
  return { handled: true, languageChosen: false };
}

/**
 * Reload conversation state after language confirmation (for pipeline replay).
 * @param {Business} business
 * @param {string} recipientPhone
 */
export async function reloadConversationState(business, recipientPhone) {
  return getOrCreateConversationState(business.id, recipientPhone);
}
