/**
 * Backend-first inbound pipeline:
 *   1. Extract intent + entities (no availability)
 *   2. Execute business logic in backend / DB
 *   3. Present the HandlerResult as WhatsApp text
 */

import { debugLog } from '../utils/debugLog.js';
import { extractTurnIntent } from './turnExtract.js';
import { executeTurn } from './turnExecute.js';
import { presentTurn } from './turnPresent.js';

/** @typedef {import('../db/businessService.js').Business} Business */

/**
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {string} params.textBody
 * @param {string | null} [params.clientId]
 * @param {string | null} [params.requestId]
 * @param {import('../db/conversationStateService.js').ConversationState} params.convState
 * @param {import('../db/draftBookingService.js').DraftBooking | null} [params.activeDraft]
 */
export async function processTurnPipeline({
  business,
  recipientPhone,
  textBody,
  clientId = null,
  requestId = null,
  convState,
  activeDraft = null,
}) {
  const extract = await extractTurnIntent({
    business,
    textBody,
    convState,
    activeDraft,
    requestId,
  });

  debugLog('turn-pipeline extract', {
    requestId,
    action: extract.action,
    source: extract.source,
    service_id: extract.service_id,
    datetime: extract.datetime instanceof Date ? extract.datetime.toISOString() : null,
    date_text: extract.date_text,
  });

  const result = await executeTurn({
    business,
    recipientPhone,
    extract,
    clientId,
    requestId,
    convState,
    activeDraft,
    textBody,
  });

  debugLog('turn-pipeline execute', {
    requestId,
    status: result.status,
    action_performed: result.action_performed,
    next_required_step: result.next_required_step,
    template: result.user_message_template_key,
  });

  await presentTurn({
    business,
    recipientPhone,
    result,
    requestId,
  });

  return { extract, result };
}
