/**
 * Outbound ordering guard.
 *
 * A slow turn (LLM, calendar) can finish after the client already sent the next
 * message. Replying then would bleed a stale notice — or an old menu — into a
 * conversation that already moved on. Two layers keep the transcript in order:
 *
 *   1. in-process sequence per (tenant, phone) — covers every send in this isolate
 *   2. session timestamp in Supabase — covers a newer inbound handled elsewhere
 *
 * Both fail open: when nothing is known about a turn, the message is sent.
 */

import { getOrCreateConversationState } from '../db/conversationStateService.js';
import { readInboundStamp } from './sessionValidator.js';
import { toMetaPhone } from '../utils/phone.js';

const MAX_KEYS = 500;
const MAX_REQUESTS_PER_KEY = 8;

/** @type {Map<string, { seq: number, requests: Map<string, number> }>} */
const turns = new Map();

function key(businessId, recipientPhone) {
  return `${businessId}:${toMetaPhone(recipientPhone)}`;
}

function trim(map, max) {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

/**
 * Registers a new inbound turn and supersedes anything older for this client.
 *
 * @param {string} businessId
 * @param {string} recipientPhone
 * @param {string | null | undefined} requestId
 */
export function beginInboundTurn(businessId, recipientPhone, requestId) {
  if (!businessId || !requestId) return;
  const k = key(businessId, recipientPhone);
  const entry = turns.get(k) || { seq: 0, requests: new Map() };
  entry.seq += 1;
  entry.requests.set(String(requestId), entry.seq);
  trim(entry.requests, MAX_REQUESTS_PER_KEY);
  turns.delete(k);
  turns.set(k, entry);
  trim(turns, MAX_KEYS);
}

/**
 * True when a newer inbound turn for the same client was registered in this
 * isolate. Unknown request ids (cron, reminders, Admin sends) are never stale.
 *
 * @param {string} businessId
 * @param {string} recipientPhone
 * @param {string | null | undefined} requestId
 */
export function isStaleOutboundTurn(businessId, recipientPhone, requestId) {
  if (!businessId || !requestId) return false;
  const entry = turns.get(key(businessId, recipientPhone));
  if (!entry) return false;
  const seq = entry.requests.get(String(requestId));
  if (seq === undefined) return false;
  return seq < entry.seq;
}

/**
 * Cross-isolate check: the stored session timestamp moved past the one this turn
 * started from, so the client already sent another message.
 *
 * @param {Object} params
 * @param {import('../db/businessService.js').Business} params.business
 * @param {string} params.recipientPhone
 * @param {number | null} params.turnStamp — session timestamp when this turn started
 */
export async function isSupersededTurn({ business, recipientPhone, turnStamp }) {
  if (!business?.id || !turnStamp) return false;
  try {
    const fresh = await getOrCreateConversationState(business.id, recipientPhone);
    const latest = readInboundStamp(fresh);
    return Boolean(latest && latest > turnStamp);
  } catch (error) {
    console.warn('[turn-order] superseded check failed', error);
    return false;
  }
}

/** Test helper. */
export function resetTurnSequencer() {
  turns.clear();
}
