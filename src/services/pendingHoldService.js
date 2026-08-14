import { CONVERSATION_STEPS, readLastMenu } from '../db/conversationStateService.js';
import { listEmployees, matchEmployeeMention } from '../db/employeeService.js';
import { formatSlotLabel } from '../utils/datetime.js';
import {
  buildConversationTurnContext,
  isOpenAiTemporarilyDown,
} from './aiService.js';
import { runFunctionCallingTurn } from './aiAgentService.js';
import {
  handleBookingInteractiveReply,
  handleClientNameReply,
  handleFreeTextSlotRequest,
  applyPendingEmployeeChange,
} from './bookingFlowService.js';
import {
  handleInfoAction,
  handleCallbackRequest,
  handleContactAction,
} from './menuHandler.js';
import {
  looksLikeDatetimeOrSlot,
  isExplicitConfirmReply,
  triageUserIntent,
} from './intentTriageService.js';
import {
  acceptClarifiedOffer,
  rememberOfferFromAssistant,
  readPendingOffer,
  readClarified,
  historyWithoutResolvedObjections,
} from './pendingOfferService.js';
import {
  resolveNumberedChoice,
  sendTextMessage,
  simulateHumanDelay,
} from './whatsappService.js';

/** @typedef {import('../db/businessService.js').Business} Business */
/** @typedef {import('../db/draftBookingService.js').DraftBooking} DraftBooking */

/**
 * Snapshot of the live pending hold for the LLM (service / slot / staff).
 * @param {Business} business
 * @param {DraftBooking | null | undefined} draft
 * @param {string[]} staffNames
 */
export function describePendingHold(business, draft, staffNames = []) {
  if (!draft) return null;
  const service = draft.selected_service;
  const slotStart = draft.selected_slot_start ? new Date(draft.selected_slot_start) : null;
  const empName =
    (typeof draft.conversation_context?.employee_name === 'string'
      && draft.conversation_context.employee_name)
    || null;
  return {
    serviceName: service && typeof service.name === 'string' ? service.name : '',
    slotLabel: slotStart && !Number.isNaN(slotStart.getTime())
      ? formatSlotLabel(slotStart, business.timezone)
      : '',
    employeeName: empName,
    staffNames,
  };
}

/**
 * Intent-driven pending confirmation: keep the hold, let OpenAI read the
 * full message + history. Only exact 1/da and 2/nu stay as fast shortcuts.
 *
 * @returns {Promise<boolean>} always true when invoked for a live hold
 */
export async function handlePendingHoldTurn({
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
  const step = convState?.current_step;

  // Numbered menus (staff / slots) while the hold is live — not the confirm 1/2
  if (step !== CONVERSATION_STEPS.CONFIRMING) {
    const remembered = readLastMenu(convState);
    if (remembered?.options?.length) {
      const choiceId = resolveNumberedChoice(textBody, remembered.options);
      if (choiceId) {
        const handled = await handleBookingInteractiveReply({
          business,
          recipientPhone,
          replyId: choiceId,
          clientId,
          requestId,
        });
        if (handled) return true;
      }
    }
  }

  // Exact confirm only on the confirm step — not while picking staff or a name
  if (step === CONVERSATION_STEPS.CONFIRMING && isExplicitConfirmReply(textBody)) {
    await handleBookingInteractiveReply({
      business,
      recipientPhone,
      replyId: 'confirm_booking',
      clientId,
      requestId,
    });
    return true;
  }

  if (step === CONVERSATION_STEPS.ASKING_NAME) {
    const handledName = await handleClientNameReply({
      business,
      recipientPhone,
      textBody,
      clientId,
      requestId,
    });
    if (handledName) return true;
  }

  const acceptedOffer = await acceptClarifiedOffer({
    business,
    recipientPhone,
    textBody,
    convState,
    draft: activeDraft,
    clientId,
    requestId,
  });
  if (acceptedOffer) return true;

  const staff = await listEmployees(business.id, { activeOnly: true });
  const staffNames = staff.map((e) => e.name).filter(Boolean);
  const pendingHold = describePendingHold(business, activeDraft, staffNames);
  const recentTurns = historyWithoutResolvedObjections(
    Array.isArray(convState?.context_data?.recent_turns)
      ? convState.context_data.recent_turns
      : [],
    convState,
  );

  const turnContext = buildConversationTurnContext({
    step,
    lastIntent,
    pendingDismissed,
    pendingExpired,
    pendingHold,
    recentTurns,
    pendingOffer: readPendingOffer(convState),
    clarified: readClarified(convState),
  });

  const skipAgent = !process.env.OPENAI_API_KEY || isOpenAiTemporarilyDown();
  if (!skipAgent) {
    const result = await runFunctionCallingTurn({
      business,
      recipientPhone,
      userMessage: textBody,
      clientId,
      requestId,
      turnContext,
      history: recentTurns,
      draft: activeDraft,
      convState,
    });
    if (result.needsCallback) {
      await handleCallbackRequest({
        business,
        recipientPhone,
        userMessage: textBody,
        reason: result.callbackReason || 'ai_tool_callback',
        clientId,
        requestId,
      });
      return true;
    }
    if (result.uiSent) return true;
    if (result.text) {
      await simulateHumanDelay({ business, recipientPhone, requestId });
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text: result.text,
      });
      await rememberOfferFromAssistant({
        business,
        recipientPhone,
        text: result.text,
        requestId,
      });
      return true;
    }
  }

  // OpenAI down / unclear: keep the hold, never restart booking from a template
  return fallbackPendingHoldTurn({
    business,
    recipientPhone,
    textBody,
    clientId,
    requestId,
    activeDraft,
    staff,
    turnContext,
    recentTurns,
  });
}

/**
 * @returns {Promise<boolean>}
 */
async function fallbackPendingHoldTurn({
  business,
  recipientPhone,
  textBody,
  clientId,
  requestId,
  activeDraft,
  staff,
  turnContext,
  recentTurns = [],
}) {
  const mentioned = matchEmployeeMention(textBody, staff);
  if (mentioned) {
    await applyPendingEmployeeChange({
      business,
      recipientPhone,
      draft: activeDraft,
      textBody,
      requestId,
    });
    return true;
  }

  if (activeDraft?.selected_service && looksLikeDatetimeOrSlot(textBody)) {
    const handled = await handleFreeTextSlotRequest({
      business,
      recipientPhone,
      draft: activeDraft,
      textBody,
      requestId,
    });
    if (handled) return true;
  }

  const triage = triageUserIntent(textBody, { businessType: business.business_type });
  if (triage.intent === 'contact') {
    await handleContactAction({ business, recipientPhone, requestId });
    return true;
  }

  await handleInfoAction({
    business,
    recipientPhone,
    userMessage: textBody,
    clientId,
    requestId,
    turnContext,
    history: recentTurns,
  });
  return true;
}
