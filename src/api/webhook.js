import { Router } from 'express';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import {
  getBusinessByWhatsAppPhoneNumberId,
  isBusinessOperational,
} from '../db/businessService.js';
import { getActiveDraftBooking } from '../db/draftBookingService.js';
import { logError } from '../db/loggerService.js';
import { handleBookingInteractiveReply } from '../services/bookingFlowService.js';
import {
  ensureClient,
  handleMenuButtonPress,
  handleBrowsingTextMessage,
  sendEntryMenu,
} from '../services/menuHandler.js';
import { sendTypingIndicator } from '../services/whatsappService.js';
import { toE164 } from '../utils/phone.js';

export const webhookRouter = Router();

webhookRouter.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === env.metaWebhookVerifyToken) {
    console.log('[vidia-v2][webhook] Meta verification successful');
    return res.status(200).send(challenge);
  }

  void logError({
    message: 'Meta webhook verification failed — token mismatch',
    source: 'webhook',
    severity: 'warning',
    details: { mode, tokenReceived: Boolean(token) },
  });

  return res.sendStatus(403);
});

webhookRouter.post('/', async (req, res) => {
  const requestId = crypto.randomUUID();
  res.sendStatus(200);

  try {
    await processWebhookPayload(req.body, requestId);
  } catch (error) {
    await logError({
      message: 'Unhandled webhook processing error',
      source: 'webhook',
      severity: 'critical',
      requestId,
      error,
      details: { body: req.body },
    });
  }
});

async function processWebhookPayload(body, requestId) {
  if (body?.object !== 'whatsapp_business_account') {
    return;
  }

  for (const entry of /** @type {Record<string, unknown>[]} */ (body.entry ?? [])) {
    for (const change of /** @type {Record<string, unknown>[]} */ (entry.changes ?? [])) {
      if (change.field !== 'messages') {
        continue;
      }

      const value = /** @type {Record<string, unknown>} */ (change.value);
      const phoneNumberId = /** @type {string | undefined} */ (
        /** @type {Record<string, unknown>} */ (value.metadata)?.phone_number_id
      );

      if (!phoneNumberId) {
        await logError({
          message: 'Webhook missing phone_number_id in metadata',
          source: 'webhook',
          severity: 'warning',
          requestId,
          details: { value },
        });
        continue;
      }

      const business = await getBusinessByWhatsAppPhoneNumberId(phoneNumberId, {
        includeInactive: true,
      });

      if (!business) {
        await logError({
          message: `No business for phone_number_id: ${phoneNumberId}`,
          source: 'webhook',
          severity: 'warning',
          requestId,
          details: { phoneNumberId },
        });
        continue;
      }

      if (!isBusinessOperational(business)) {
        await logError({
          message: `Business suspended for phone_number_id: ${phoneNumberId}`,
          source: 'webhook',
          severity: 'warning',
          requestId,
          businessId: business.id,
          details: { phoneNumberId, status: business.status },
        });
        continue;
      }

      for (const message of /** @type {Record<string, unknown>[]} */ (value.messages ?? [])) {
        await handleIncomingMessage({ business, message, requestId });
      }
    }
  }
}

async function handleIncomingMessage({ business, message, requestId }) {
  const recipientPhone = /** @type {string} */ (message.from);
  const messageType = /** @type {string} */ (message.type);
  const phoneE164 = toE164(recipientPhone);

  try {
    await sendTypingIndicator({ business, recipientPhone, requestId });

    const { clientId } = await ensureClient({ business, recipientPhone, requestId });

    if (messageType === 'interactive') {
      const interactive = /** @type {Record<string, unknown>} */ (message.interactive);
      const buttonReply = /** @type {{ id?: string }} | undefined} */ (interactive?.button_reply);
      const listReply = /** @type {{ id?: string }} | undefined} */ (interactive?.list_reply);

      const replyId = buttonReply?.id ?? listReply?.id;

      if (replyId) {
        const handledByBooking = await handleBookingInteractiveReply({
          business,
          recipientPhone,
          replyId,
          clientId,
          requestId,
        });

        if (handledByBooking) {
          return;
        }

        await handleMenuButtonPress({
          business,
          recipientPhone,
          buttonId: replyId,
          clientId,
          requestId,
        });
        return;
      }
    }

    if (messageType === 'text') {
      const textBody = /** @type {string} */ (
        /** @type {Record<string, unknown>} */ (message.text)?.body ?? ''
      );

      const activeDraft = await getActiveDraftBooking(business.id, recipientPhone);
      const normalized = textBody.toLowerCase().trim();

      if (['anuleaza', 'anulează', 'cancel'].some((k) => normalized.includes(k))) {
        if (activeDraft) {
          await handleBookingInteractiveReply({
            business,
            recipientPhone,
            replyId: 'cancel_booking',
            clientId,
            requestId,
          });
          return;
        }
      }

      if (activeDraft?.state === 'browsing') {
        await handleBrowsingTextMessage({
          business,
          recipientPhone,
          textBody,
          requestId,
        });
        return;
      }

      if (['programare', 'rezervare', 'book'].some((k) => normalized.includes(k))) {
        await handleMenuButtonPress({
          business,
          recipientPhone,
          buttonId: 'book',
          clientId,
          requestId,
        });
        return;
      }

      if (['contact', 'locatie', 'locație', 'adresa'].some((k) => normalized.includes(k))) {
        await handleMenuButtonPress({
          business,
          recipientPhone,
          buttonId: 'contact',
          clientId,
          requestId,
        });
        return;
      }

      if (['pret', 'preț', 'detalii', 'info', 'price'].some((k) => normalized.includes(k))) {
        await handleMenuButtonPress({
          business,
          recipientPhone,
          buttonId: 'info',
          clientId,
          requestId,
        });
        return;
      }
    }

    await sendEntryMenu({ business, recipientPhone, requestId });
  } catch (error) {
    await logError({
      message: 'Failed to handle incoming WhatsApp message',
      source: 'webhook',
      severity: 'error',
      businessId: business.id,
      requestId,
      phoneNumber: phoneE164,
      error,
      details: { messageType, messageId: message.id },
    });
  }
}
