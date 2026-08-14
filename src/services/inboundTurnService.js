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
  const triage = triageUserIntent(textBody, { businessType: business.business_type });

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

  await processTurnPipeline({
    business,
    recipientPhone,
    textBody,
    clientId,
    requestId,
    convState,
    activeDraft,
  });
}
