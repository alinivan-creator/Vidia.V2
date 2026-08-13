import { upsertClient } from '../db/clientService.js';
import { createCallbackRequest } from '../db/callbackRequestService.js';
import { logError } from '../db/loggerService.js';
import { sendServicePicker, startBookingFlow, sendSlotPicker, handleFreeTextSlotRequest } from './bookingFlowService.js';
import { getActiveDraftBooking } from '../db/draftBookingService.js';
import { generateAiReply, buildInfoButtonPrompt } from './aiService.js';
import { formatContactMessage } from './contactService.js';
import { buildAiTransparencyWelcome } from '../utils/businessMessages.js';
import {
  sendInteractiveButtons,
  sendTextMessage,
  sendTypingIndicator,
  simulateHumanDelay,
} from './whatsappService.js';

/** @typedef {import('../db/businessService.js').Business} Business */
/** @typedef {import('../db/businessService.js').MenuButton} MenuButton */

/** Known menu actions routed from `menu_buttons.action`. */
const MENU_ACTIONS = {
  START_BOOKING: 'start_booking',
  SHOW_INFO: 'show_info',
  SHOW_CONTACT: 'show_contact',
};

/**
 * @param {Business} business
 * @returns {{ id: string; title: string; action: string }[]}
 */
export function buildInteractiveButtons(business) {
  return (business.menu_buttons ?? []).slice(0, 3).map((btn) => ({
    id: btn.id,
    title: btn.label.slice(0, 20),
    action: btn.action,
  }));
}

/**
 * Resolves a button click to its menu config entry.
 * @param {Business} business
 * @param {string} buttonId
 * @returns {MenuButton | null}
 */
export function resolveMenuButton(business, buttonId) {
  return business.menu_buttons?.find((btn) => btn.id === buttonId) ?? null;
}

/**
 * Sends welcome text + main interactive menu (3 buttons from DB).
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {string | null} [params.requestId]
 */
/**
 * Mandatory AI transparency welcome (first contact or explicit *meniu*).
 * Uses business.welcome_message and clearly identifies the bot as AI.
 */
export async function sendAiTransparencyWelcome({
  business,
  recipientPhone,
  requestId = null,
  withMenu = true,
}) {
  await simulateHumanDelay({ business, recipientPhone, requestId });
  await sendTextMessage({
    business,
    recipientPhone,
    requestId,
    text: buildAiTransparencyWelcome(business),
  });

  if (!withMenu) return;

  const buttons = buildInteractiveButtons(business);
  if (buttons.length === 0) return;

  await simulateHumanDelay({ business, recipientPhone, requestId, delayMs: 800 });
  await sendInteractiveButtons({
    business,
    recipientPhone,
    requestId,
    bodyText: 'Cu ce te putem ajuta? Alege o opțiune:',
    buttons: buttons.map(({ id, title }) => ({ id, title })),
    footerText: business.name,
  });
}

export async function sendEntryMenu({ business, recipientPhone, requestId = null }) {
  await sendAiTransparencyWelcome({
    business,
    recipientPhone,
    requestId,
    withMenu: true,
  });
}

/**
 * Handles [📅 Programare] — creates/refreshes draft_bookings in `browsing` state.
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {string | null} [params.clientId]
 * @param {string | null} [params.requestId]
 */
export async function handleBookingAction({
  business,
  recipientPhone,
  clientId,
  hintText = '',
  requestId = null,
}) {
  if (business.business_type !== 'booking') {
    // Consulting / non-calendar: capture interest as a human callback
    await handleCallbackRequest({
      business,
      recipientPhone,
      userMessage: 'Clientul dorește o discuție / programare (mod consulting).',
      reason: 'consulting_booking_interest',
      clientId,
      requestId,
    });
    return;
  }

  await startBookingFlow({
    business,
    recipientPhone,
    clientId,
    hintText,
    requestId,
  });
}

/**
 * Registers a human callback request and confirms politely to the client.
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {string} params.userMessage
 * @param {string} [params.reason]
 * @param {string | null} [params.clientId]
 * @param {string | null} [params.requestId]
 */
export async function handleCallbackRequest({
  business,
  recipientPhone,
  userMessage,
  reason = 'out_of_scope',
  clientId = null,
  requestId = null,
  skipDelay = false,
}) {
  await createCallbackRequest({
    businessId: business.id,
    rawPhone: recipientPhone,
    message: userMessage,
    reason,
    clientId,
    requestId,
  });

  if (!skipDelay) {
    await simulateHumanDelay({ business, recipientPhone, requestId });
  }
  await sendTextMessage({
    business,
    recipientPhone,
    requestId,
    text:
      `Am înregistrat cererea ta — un coleg de la *${business.name}* te va contacta în curând.\n\n` +
      (business.business_type === 'booking'
        ? 'Între timp poți scrie *programare*, *reprogramare* sau *anulează*.'
        : 'Între timp poți scrie *meniu* pentru opțiuni sau *contact* pentru datele noastre.'),
  });
}

/**
 * Handles [ℹ️ Detalii & Prețuri] — AI reply from `ai_system_prompt`.
 * Out-of-scope AI answers escalate to a callback request (non-blocking).
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {string} [params.userMessage]
 * @param {string | null} [params.clientId]
 * @param {string | null} [params.requestId]
 */
export async function handleInfoAction({
  business,
  recipientPhone,
  userMessage,
  clientId = null,
  requestId = null,
  turnContext = null,
}) {
  const prompt = userMessage?.trim() || buildInfoButtonPrompt(business);

  // Typing… while we prepare / generate the AI reply
  await simulateHumanDelay({ business, recipientPhone, requestId, delayMs: 1200 });
  await sendTypingIndicator({ business, recipientPhone, requestId });

  const aiReply = await generateAiReply({ business, userMessage: prompt, requestId, turnContext });

  if (aiReply.needsCallback) {
    await handleCallbackRequest({
      business,
      recipientPhone,
      userMessage: prompt,
      reason: aiReply.callbackReason || 'ai_out_of_scope',
      clientId,
      requestId,
      skipDelay: true,
    });
    return;
  }

  await sendTextMessage({
    business,
    recipientPhone,
    requestId,
    text: aiReply.text,
  });
}

/**
 * Handles [📞 Contact] — sends contact data from `booking_settings.contact`.
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {string | null} [params.requestId]
 */
export async function handleContactAction({ business, recipientPhone, requestId = null }) {
  await simulateHumanDelay({ business, recipientPhone, requestId });

  await sendTextMessage({
    business,
    recipientPhone,
    requestId,
    text: formatContactMessage(business),
  });
}

/**
 * Handles free-text while user is in `browsing` booking state.
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {string} params.textBody
 * @param {string | null} [params.requestId]
 */
export async function handleBrowsingTextMessage({
  business,
  recipientPhone,
  textBody,
  requestId = null,
}) {
  const draft = await getActiveDraftBooking(business.id, recipientPhone);

  if (!draft) {
    await simulateHumanDelay({ business, recipientPhone, requestId });
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: 'Scrie *programare* pentru a începe o rezervare nouă.',
    });
    return;
  }

  // Service already chosen → try free-text time, else show slot list
  if (draft.selected_service) {
    const handled = await handleFreeTextSlotRequest({
      business,
      recipientPhone,
      draft,
      textBody,
      requestId,
    });
    if (!handled) {
      await sendSlotPicker({ business, recipientPhone, draft, requestId });
    }
    return;
  }

  await sendServicePicker({ business, recipientPhone, draft, requestId });
}

/**
 * Routes an interactive button press to the correct handler.
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {string} params.buttonId
 * @param {string | null} [params.clientId]
 * @param {string | null} [params.requestId]
 */
export async function handleMenuButtonPress({
  business,
  recipientPhone,
  buttonId,
  clientId,
  requestId = null,
}) {
  const menuButton = resolveMenuButton(business, buttonId);

  if (!menuButton) {
    await logError({
      message: `Unknown menu button pressed: ${buttonId}`,
      source: 'webhook',
      severity: 'warning',
      businessId: business.id,
      requestId,
      phoneNumber: recipientPhone ? `+${recipientPhone}` : null,
      details: { buttonId, availableButtons: business.menu_buttons },
    });
    await sendEntryMenu({ business, recipientPhone, requestId });
    return;
  }

  switch (menuButton.action) {
    case MENU_ACTIONS.START_BOOKING:
      await handleBookingAction({ business, recipientPhone, clientId, requestId });
      break;
    case MENU_ACTIONS.SHOW_INFO:
      await handleInfoAction({ business, recipientPhone, requestId });
      break;
    case MENU_ACTIONS.SHOW_CONTACT:
      await handleContactAction({ business, recipientPhone, requestId });
      break;
    default:
      await logError({
        message: `Unhandled menu action: ${menuButton.action}`,
        source: 'webhook',
        severity: 'warning',
        businessId: business.id,
        requestId,
        details: { buttonId, action: menuButton.action },
      });
      await sendEntryMenu({ business, recipientPhone, requestId });
  }
}

/**
 * Ensures client exists in CRM before handling any message.
 * Phone number is captured automatically from WhatsApp.
 *
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {string | null} [params.requestId]
 * @returns {Promise<{ clientId: string | null; client: import('../db/clientService.js').Client | null; isNew: boolean }>}
 */
export async function ensureClient({ business, recipientPhone, requestId = null }) {
  const { client, isNew } = await upsertClient({
    businessId: business.id,
    rawPhone: recipientPhone,
    requestId,
  });
  return {
    clientId: client?.id ?? null,
    client,
    isNew,
  };
}

export { MENU_ACTIONS };
