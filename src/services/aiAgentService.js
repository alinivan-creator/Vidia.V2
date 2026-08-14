/**
 * Function-calling agent: OpenAI chooses tools, the Guard (aiTools) executes them.
 * The model never writes to the calendar or invents availability.
 *
 * Every OpenAI round reloads tenant system_prompt + logic_config by business_id.
 */

import { getActiveDraftBooking } from '../db/draftBookingService.js';
import { CALLBACK_SENTINEL, parseAiCallbackSignal } from './aiService.js';
import { isOpenAiTemporarilyDown } from './openaiGate.js';
import { completeTenantChat } from './aiContextLoader.js';
import { executeAgentTool, getAgentTools } from './aiTools.js';
import { rememberOfferFromAssistant } from './pendingOfferService.js';

/** @typedef {import('../db/businessService.js').Business} Business */

const MAX_TOOL_ROUNDS = 4;
const OPENAI_AGENT_TIMEOUT_MS = 12000;

function toolsProtocolBlock() {
  return `
PROTOCOL FUNCTION CALLING (obligatoriu):
- Tu ești creierul: înțelegi limbajul natural și DECIZI ce tool să apelezi.
- Backend-ul este garda: el verifică programul din Admin, calendarul și scrie în baza de date.
- NU inventa disponibilitate, prețuri sau angajați. NU spune că o oră e liberă fără check_availability sau list_available_slots.
- Pentru programare (zi/oră/serviciu/angajat/confirmare/anulare) TREBUIE să apelezi tool-urile. Nu „rezolva” tu validarea.
- check_availability interoghează Google Calendar DOAR dacă Admin zice că ziua e deschisă. Dacă tool-ul returnează closed / outside_hours / occupied, spune-i clientului exact asta, politicos.
- confirm_booking este singurul drum spre scrierea în calendar. Nu pretinde că ai confirmat fără acest tool.
- Dacă un tool are ui_sent=true, NU mai genera mesaj către client (backend-ul a răspuns deja).
- Chat general (salut, glume, injurii, conversație): răspunde politicos, scurt, fără tool-uri și fără a programa.
- Dacă cererea e în afara atribuțiilor, apelează request_human_callback.`;
}

/**
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {string} params.userMessage
 * @param {string | null} [params.clientId]
 * @param {string | null} [params.requestId]
 * @param {string} [params.turnContext]
 * @param {object[]} [params.history]
 * @param {import('../db/draftBookingService.js').DraftBooking | null} [params.draft]
 * @param {import('../db/conversationStateService.js').ConversationState | null} [params.convState]
 */
export async function runFunctionCallingTurn({
  business,
  recipientPhone,
  userMessage,
  clientId = null,
  requestId = null,
  turnContext = '',
  history = [],
  draft = null,
  convState = null,
}) {
  if (!business?.id || isOpenAiTemporarilyDown()) {
    return { text: null, uiSent: false, mocked: true, needsCallback: false };
  }

  const prior = Array.isArray(history)
    ? history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.text)
        .slice(-8)
        .map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: String(m.text).slice(0, 240),
        }))
    : [];

  /** @type {Record<string, unknown>[]} */
  const transcript = [
    ...prior,
    { role: 'user', content: userMessage },
  ];

  let uiSent = false;
  /** @type {string | null} */
  let lastText = null;
  /** @type {Business | null} */
  let live = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const speech = await completeTenantChat({
      businessId: business.id,
      extraSystem: toolsProtocolBlock(),
      turnContext,
      messages: transcript,
      buildTools: (ctx) => getAgentTools(ctx.snapshot),
      toolChoice: 'auto',
      timeoutMs: OPENAI_AGENT_TIMEOUT_MS,
      requestId,
    });
    if (!speech.ok || !speech.message) {
      return { text: lastText, uiSent, mocked: false, needsCallback: false };
    }

    live = speech.context.snapshot;
    const choice = speech.message;
    const toolCalls = Array.isArray(choice.tool_calls) ? choice.tool_calls : [];
    if (toolCalls.length) {
      transcript.push(choice);
      for (const call of toolCalls) {
        const fnName = String(call?.function?.name || '');
        let parsed = {};
        try {
          parsed = JSON.parse(call?.function?.arguments || '{}');
        } catch {
          parsed = {};
        }
        console.log('[ai-agent] tool', { fnName, parsed, requestId, businessId: live.id });
        const result = await executeAgentTool(fnName, parsed, {
          business: live,
          recipientPhone,
          clientId,
          requestId,
          userMessage,
          convState,
          draft,
        });
        if (result?.ui_sent) uiSent = true;
        draft = (await getActiveDraftBooking(live.id, recipientPhone)) || draft;
        transcript.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 3500),
        });
      }
      continue;
    }

    const raw = String(choice.content ?? '').trim();
    lastText = raw || lastText;
    break;
  }

  if (!uiSent && !lastText) {
    const speech = await completeTenantChat({
      businessId: business.id,
      extraSystem: toolsProtocolBlock(),
      turnContext,
      messages: transcript,
      buildTools: (ctx) => getAgentTools(ctx.snapshot),
      toolChoice: 'none',
      timeoutMs: OPENAI_AGENT_TIMEOUT_MS,
      requestId,
    });
    if (speech.ok) {
      live = speech.context?.snapshot || live;
      if (speech.message) {
        lastText = String(speech.message.content ?? '').trim() || lastText;
      }
    }
  }

  if (uiSent) {
    return { text: null, uiSent: true, mocked: false, needsCallback: false };
  }

  if (!lastText) {
    return { text: null, uiSent: false, mocked: false, needsCallback: false };
  }

  const parsed = parseAiCallbackSignal(lastText);
  if (parsed.needsCallback) {
    return {
      text: '',
      uiSent: false,
      mocked: false,
      needsCallback: true,
      callbackReason: 'ai_out_of_scope',
    };
  }

  if (live) {
    await rememberOfferFromAssistant({
      business: live,
      recipientPhone,
      text: parsed.cleanText || lastText,
      requestId,
    });
  }

  return {
    text: parsed.cleanText || lastText,
    uiSent: false,
    mocked: false,
    needsCallback: false,
  };
}

export { CALLBACK_SENTINEL };
