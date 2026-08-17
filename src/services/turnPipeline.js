/**
 * 3-layer inbound pipeline:
 *   1. Extractor — structured JSON only (src/lib/ai/extractor.js)
 *   2. State machine — session + slot decisions (src/lib/booking/stateMachine.js)
 *   3. Response formatter — WhatsApp text from Layer 2 actions (src/lib/ai/responseFormatter.js)
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
  buttonPayload = null,
  clientId = null,
  requestId = null,
  convState,
  activeDraft = null,
}) {
  const extract = await extractTurnIntent({
    business,
    textBody,
    buttonPayload,
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
    time_text: extract.time_text,
    choice_id: extract.choice_id,
    intent: extract.extraction?.intent ?? null,
    is_ambiguous: extract.extraction?.is_ambiguous ?? null,
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
    machine_action: result.machine_action ?? null,
  });

  await presentTurn({
    business,
    recipientPhone,
    result,
    requestId,
  });

  return { extract, result };
}
