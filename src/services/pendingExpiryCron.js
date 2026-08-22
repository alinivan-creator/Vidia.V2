/**
 * Background expiry of pending WhatsApp booking holds.
 * Runs independently of inbound messages (Vercel Cron /admin-triggered).
 */

import { getActiveBusinesses } from '../db/businessService.js';
import { logError } from '../db/loggerService.js';
import { expireStalePendingForBusiness } from './pendingExpiryService.js';
import { getPendingTtlMinutes } from '../config/conversationConfig.js';
import {
  CONVERSATION_STEPS,
  resetConversationState,
  getOrCreateConversationState,
} from '../db/conversationStateService.js';
import { cancelActiveDraftsForPhone } from '../db/draftBookingService.js';
import { buildFreshSessionGreeting } from './sessionValidator.js';

/**
 * Fresh-slate greeting after conversation TTL.
 * @param {import('../db/businessService.js').Business} business
 */
export function buildSessionExpiredRestartMessage(business) {
  return buildFreshSessionGreeting(business);
}

/**
 * After TTL expiry on inbound: drop in-flight booking state so the next
 * extract/execute turn has no leftover date, menu, or draft.
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
  void clientId;
  try {
    await cancelActiveDraftsForPhone({
      businessId: business.id,
      rawPhone,
      context: { step: 'cancelled_session_ttl' },
      requestId,
    });
  } catch (error) {
    console.warn('[session-ttl] cancel drafts after expiry failed', error);
  }

  await resetConversationState({
    businessId: business.id,
    rawPhone,
    keepLastIntent: false,
    hardReset: true,
    // Drop language lock so the RO/EN gate can run on a truly fresh session.
    preserveLanguage: false,
    requestId,
  });

  const conv = await getOrCreateConversationState(business.id, rawPhone);
  return {
    draft: null,
    conv: conv?.current_step === CONVERSATION_STEPS.IDLE ? conv : conv,
    message: buildFreshSessionGreeting(business),
  };
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
      await logError({
        message: 'pending expiry cron: tenant sweep failed',
        source: 'cron',
        severity: 'error',
        businessId: business.id,
        requestId,
        error,
      });
    }
  }

  console.log('[pending-cron] done', { ...summary, ms: Date.now() - started, requestId });
  return summary;
}
