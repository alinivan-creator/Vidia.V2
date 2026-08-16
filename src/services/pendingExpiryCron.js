/**
 * Background expiry of pending WhatsApp booking holds.
 * Runs independently of inbound messages (Vercel Cron /admin-triggered).
 */

import { getActiveBusinesses } from '../db/businessService.js';
import { logError } from '../db/loggerService.js';
import { expireStalePendingForBusiness } from './pendingExpiryService.js';
import { getPendingTtlMinutes } from '../config/conversationConfig.js';
import { formatServiceAskMessage } from '../utils/serviceMatch.js';
import { getBookingConfig } from '../utils/datetime.js';
import {
  CONVERSATION_STEPS,
  setConversationStep,
} from '../db/conversationStateService.js';
import { startBrowsingFlow } from '../db/draftBookingService.js';
import { BOOKING_WAIT } from './bookingWaitState.js';

/**
 * Friendly copy when the client returns after TTL cancelled their session.
 * @param {import('../db/businessService.js').Business} business
 */
export function buildSessionExpiredRestartMessage(business) {
  const services = getBookingConfig(business).services;
  const ask = formatServiceAskMessage(services);
  return (
    `Sesiunea ta a expirat din motive de inactivitate. Hai să o luăm de la început.\n\n` +
    ask
  );
}

/**
 * After TTL expiry on inbound: reset to service choice and prepare draft.
 *
 * @param {Object} params
 * @param {import('../db/businessService.js').Business} params.business
 * @param {string} params.rawPhone
 * @param {string | null} [params.clientId]
 * @param {string | null} [params.requestId]
 */
export async function resetExpiredSessionForRestart({
  business,
  rawPhone,
  clientId = null,
  requestId = null,
}) {
  let draft = null;
  try {
    if (clientId) {
      draft = await startBrowsingFlow({
        businessId: business.id,
        clientId,
        rawPhone,
        requestId,
      });
    }
  } catch (error) {
    console.warn('[pending-cron] startBrowsingFlow after expiry failed', error);
  }

  await setConversationStep({
    businessId: business.id,
    rawPhone,
    step: CONVERSATION_STEPS.WAITING_FOR_SERVICE,
    context: {
      draft_id: draft?.id ?? null,
      intent: 'book',
      booking_wait: BOOKING_WAIT.SERVICE,
      last_menu: null,
      session_restart_after_expiry: true,
    },
    mergeContext: false,
    requestId,
  });

  return { draft, message: buildSessionExpiredRestartMessage(business) };
}

/**
 * Sweep every active tenant — releases overdue pending_confirmation holds
 * (calendar soft-lock + draft state → expired) using each business Admin TTL.
 *
 * @param {Object} [opts]
 * @param {string | null} [opts.requestId]
 * @returns {Promise<{ businesses: number; expired: number; errors: number }>}
 */
export async function runPendingExpiryCron({ requestId = null } = {}) {
  const started = Date.now();
  /** @type {{ businesses: number; expired: number; errors: number }} */
  const summary = { businesses: 0, expired: 0, errors: 0 };

  let businesses = [];
  try {
    businesses = await getActiveBusinesses();
  } catch (error) {
    await logError({
      message: 'pending expiry cron: failed to list businesses',
      source: 'cron',
      severity: 'error',
      requestId,
      error,
    });
    return { ...summary, errors: 1 };
  }

  summary.businesses = businesses.length;

  for (const business of businesses) {
    try {
      const ttl = getPendingTtlMinutes(business);
      const count = await expireStalePendingForBusiness(business, requestId);
      summary.expired += count;
      if (count > 0) {
        console.log('[pending-cron] Expired holds', {
          businessId: business.id,
          name: business.name,
          count,
          ttlMinutes: ttl,
          requestId,
        });
      }
    } catch (error) {
      summary.errors += 1;
      console.error('[pending-cron] business sweep failed', {
        businessId: business?.id,
        error,
      });
      await logError({
        message: `pending expiry cron failed for business ${business?.id}`,
        source: 'cron',
        severity: 'warning',
        businessId: business?.id ?? null,
        requestId,
        error,
      });
    }
  }

  console.log('[pending-cron] Done', {
    ...summary,
    durationMs: Date.now() - started,
    requestId,
  });

  return summary;
}
