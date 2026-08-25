/**
 * Dual-AI inbound pipeline:
 *   1. Dialogue Agent (Gemini) — extractTurnIntent → intent_actions JSON
 *   2. Execution Agent (backend) — catalog / hours / calendar SSOT, structured JSON
 *   3. Present — WhatsApp templates from Execution JSON only
 */

import { debugLog } from '../utils/debugLog.js';
import { extractTurnIntent } from './turnExtract.js';
import { runExecutionAgent } from './executionAgent.js';
import { presentTurn } from './turnPresent.js';
import { readInboundStamp } from './sessionValidator.js';
import { sessionLanguagePatchFromText, resolveTurnLanguage } from '../utils/uiI18n.js';
import { needsAiDisclosure } from '../utils/businessMessages.js';
import { setConversationStep } from '../db/conversationStateService.js';

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
  buttonTitle = null,
  typedText = null,
  clientId = null,
  requestId = null,
  convState,
  activeDraft = null,
}) {
  const extract = await extractTurnIntent({
    business,
    textBody,
    buttonPayload,
    buttonTitle,
    typedText,
    convState,
    activeDraft,
    requestId,
  });

  debugLog('turn-pipeline extract', {
    requestId,
    action: extract.action,
    source: extract.source,
    service_id: extract.service_id,
    employee_id: extract.employee_id,
    employee_name: extract.employee_name,
    datetime: extract.datetime instanceof Date ? extract.datetime.toISOString() : null,
    date_text: extract.date_text,
    time_text: extract.time_text,
    choice_id: extract.choice_id,
    intent: extract.extraction?.intent ?? null,
    is_ambiguous: extract.extraction?.is_ambiguous ?? null,
  });

  let workingConv = convState;
  const inboundText = String(textBody || typedText || '').trim();
  const langPatch = sessionLanguagePatchFromText(
    inboundText,
    buttonPayload,
    workingConv?.context_data,
  );
  if (langPatch.session_language) {
    workingConv = await setConversationStep({
      businessId: business.id,
      rawPhone: recipientPhone,
      step: workingConv?.current_step || 'IDLE',
      context: langPatch,
      mergeContext: true,
      requestId,
    }) || workingConv;
  }
  const uiLang = resolveTurnLanguage(inboundText, workingConv?.context_data);

  const { handler: result, envelope } = await runExecutionAgent({
    business,
    recipientPhone,
    extract,
    clientId,
    requestId,
    convState: workingConv,
    activeDraft,
    textBody,
    uiLang,
  });

  const attachDisclosure = needsAiDisclosure(workingConv?.context_data);
  const localized = {
    ...result,
    data: {
      ...(result.data || {}),
      ui_language: uiLang,
      attach_ai_disclosure: attachDisclosure,
    },
  };

  debugLog('turn-pipeline execute', {
    requestId,
    status: envelope.status,
    action_performed: envelope.action,
    next_required_step: envelope.next_step,
    machine_action: localized.machine_action ?? null,
    ui_language: uiLang,
    attach_ai_disclosure: attachDisclosure,
  });

  await presentTurn({
    business,
    recipientPhone,
    result: localized,
    requestId,
    turnStamp: readInboundStamp(workingConv),
  });

  if (attachDisclosure) {
    await setConversationStep({
      businessId: business.id,
      rawPhone: recipientPhone,
      step: workingConv?.current_step || 'IDLE',
      context: { ai_disclosed: true },
      mergeContext: true,
      requestId,
    });
  }

  return { extract, result: localized, envelope };
}
