/**
 * Function-calling agent: OpenAI chooses tools, the Guard (aiTools) executes them.
 * The model never writes to the calendar or invents availability.
 */

import { logError } from '../db/loggerService.js';
import { getActiveDraftBooking } from '../db/draftBookingService.js';
import { CALLBACK_SENTINEL, buildSystemPrompt, parseAiCallbackSignal } from './aiService.js';
import { isOpenAiTemporarilyDown, markOpenAiUnavailable } from './aiService.js';
import { loadBusinessContext } from './businessContext.js';
import { executeAgentTool, getAgentTools } from './aiTools.js';
import { rememberOfferFromAssistant } from './pendingOfferService.js';

/** @typedef {import('../db/businessService.js').Business} Business */

const MAX_TOOL_ROUNDS = 4;
const OPENAI_AGENT_TIMEOUT_MS = 12000;

function clampTemperature(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.3;
  return Math.min(2, Math.max(0, n));
}

/**
 * @returns {Promise<{ ok: boolean, message?: Record<string, unknown>, error?: boolean }>}
 */
async function completeAgentChat({
  apiKey,
  live,
  messages,
  tools,
  toolChoice = 'auto',
  requestId = null,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_AGENT_TIMEOUT_MS);
  try {
    /** @type {Record<string, unknown>} */
    const body = {
      model: live.ai_model || 'gpt-4o-mini',
      temperature: Math.min(0.4, clampTemperature(live.ai_temperature)),
      max_tokens: 400,
      messages,
      tools,
      tool_choice: toolChoice,
    };
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) markOpenAiUnavailable();
      await logError({
        message: `Eroare: OpenAI function calling a eșuat (HTTP ${response.status})`,
        source: 'ai',
        severity: 'error',
        businessId: live.id,
        requestId,
        httpStatus: response.status,
        details: { response: data, alert: true, alertKind: 'openai' },
      });
      return { ok: false, error: true };
    }
    return { ok: true, message: data?.choices?.[0]?.message || null };
  } catch (error) {
    console.error('Eroare detalii:', error);
    markOpenAiUnavailable();
    await logError({
      message: 'Eroare: OpenAI function calling — rețea/timeout',
      source: 'ai',
      severity: 'error',
      businessId: live.id,
      requestId,
      error,
      details: { alert: true, alertKind: 'openai' },
    });
    return { ok: false, error: true };
  } finally {
    clearTimeout(timer);
  }
}

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
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || isOpenAiTemporarilyDown()) {
    return { text: null, uiSent: false, mocked: true, needsCallback: false };
  }

  const loaded = await loadBusinessContext(business.id);
  const live = loaded?.business || business;
  const tools = getAgentTools(live);

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
  const messages = [
    {
      role: 'system',
      content: buildSystemPrompt(live, { turnContext, routerMode: false }) + toolsProtocolBlock(),
    },
    ...prior,
    { role: 'user', content: userMessage },
  ];

  let uiSent = false;
  /** @type {string | null} */
  let lastText = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const speech = await completeAgentChat({
      apiKey,
      live,
      messages,
      tools,
      toolChoice: 'auto',
      requestId,
    });
    if (!speech.ok) {
      return { text: lastText, uiSent, mocked: false, needsCallback: false };
    }
    const choice = speech.message;
    if (!choice) {
      return { text: lastText, uiSent, mocked: false, needsCallback: false };
    }

    const toolCalls = Array.isArray(choice.tool_calls) ? choice.tool_calls : [];
    if (toolCalls.length) {
      messages.push(choice);
      for (const call of toolCalls) {
        const fnName = String(call?.function?.name || '');
        let parsed = {};
        try {
          parsed = JSON.parse(call?.function?.arguments || '{}');
        } catch {
          parsed = {};
        }
        console.log('[ai-agent] tool', { fnName, parsed, requestId });
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
        messages.push({
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
    const speech = await completeAgentChat({
      apiKey,
      live,
      messages,
      tools,
      toolChoice: 'none',
      requestId,
    });
    if (speech?.ok && speech.message) {
      lastText = String(speech.message.content ?? '').trim() || lastText;
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

  await rememberOfferFromAssistant({
    business: live,
    recipientPhone,
    text: parsed.cleanText || lastText,
    requestId,
  });

  return {
    text: parsed.cleanText || lastText,
    uiSent: false,
    mocked: false,
    needsCallback: false,
  };
}

export { CALLBACK_SENTINEL };
