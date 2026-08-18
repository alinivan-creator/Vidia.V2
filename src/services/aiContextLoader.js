/**
 * Per-request AI tenant isolation.
 *
 * Every OpenAI call must load system_prompt + logic_config from `businesses`
 * using only the current message's business_id. Nothing is cached or reused
 * across requests — even when the tenant is the same as the previous turn.
 */

import { supabase } from '../config/supabase.js';
import { hydrateBusiness, withServices } from '../db/businessService.js';
import { listEmployees } from '../db/employeeService.js';
import { listFaqsForBusiness } from '../db/faqService.js';
import { logError } from '../db/loggerService.js';
import { CALLBACK_SENTINEL, DEFAULT_SYSTEM_PROMPT } from '../config/defaultSystemPrompt.js';
import { getConversationLogic } from '../config/conversationConfig.js';
import {
  getBookingConfig,
  getConfiguredBusinessHours,
  formatBusinessHoursText,
} from '../utils/datetime.js';
import { getBusinessContactInfo } from './contactService.js';
import { isOpenAiTemporarilyDown, markOpenAiUnavailable } from './openaiGate.js';
import {
  completeGeminiChat,
  getOpenAiApiKey,
  isGeminiConfigured,
  isOpenAiConfigured,
} from './llmProvider.js';

/** @typedef {import('../db/businessService.js').Business} Business */

/**
 * @typedef {Object} AiTenantContext
 * @property {string} businessId
 * @property {string} systemPrompt
 * @property {string} logicConfig
 * @property {string} model
 * @property {number} temperature
 * @property {Business} snapshot
 * @property {number} loadedAt
 */

function clampTemperature(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.3;
  return Math.min(2, Math.max(0, n));
}

/**
 * @param {Business} business
 */
export function buildServicesCatalog(business) {
  const { services } = getBookingConfig(business);
  if (!services.length) {
    return (
      '\n\nCATALOG SERVICII: nesetat.\n' +
      'Dacă clientul întreabă de servicii/prețuri/durată, răspunde exact: ' +
      '"Nu dețin această informație, din păcate nu vă pot răspunde la această întrebare." ' +
      'Nu menționa Admin, configurare sau inventare.'
    );
  }

  const lines = services.map((s) => {
    const price = s.price_ron != null ? `${s.price_ron} LEI` : 'preț la cerere';
    return `- ${s.name}: ${price}, durată ${s.duration_minutes} minute`;
  });

  return (
    `\n\nCATALOG SERVICII ȘI PREȚURI (folosește exclusiv aceste date):\n` +
    lines.join('\n')
  );
}

/**
 * @param {Business} business
 */
export function buildBusinessHoursContext(business) {
  const hours = getConfiguredBusinessHours(business);
  if (!hours) {
    return (
      '\n\nPROGRAM DE LUCRU: nesetat.\n' +
      'Dacă clientul întreabă de program/oră de deschidere/închidere, răspunde exact: ' +
      '"Nu dețin această informație, din păcate nu vă pot răspunde la această întrebare." ' +
      'Nu menționa Admin. NU inventa ore.'
    );
  }

  return (
    '\n\nPROGRAM DE LUCRU (singura sursă de adevăr — nu inventa altceva):\n' +
    formatBusinessHoursText(hours)
  );
}

/**
 * @param {Business} business
 */
export function buildContactContext(business) {
  const info = getBusinessContactInfo(business);
  const lines = [];
  if (info.phone) lines.push(`- Telefon: ${info.phone}`);
  if (info.email) lines.push(`- Email: ${info.email}`);
  if (info.address) lines.push(`- Adresă: ${info.address}`);
  if (info.website) lines.push(`- Website: ${info.website}`);
  if (info.mapsUrl) lines.push(`- Hartă: ${info.mapsUrl}`);

  if (!lines.length) {
    return (
      '\n\nCONTACT: nesetat.\n' +
      'Dacă clientul cere telefon/adresă/email, răspunde exact: ' +
      '"Nu dețin această informație, din păcate nu vă pot răspunde la această întrebare." ' +
      'Nu menționa Admin.'
    );
  }

  return '\n\nDATE CONTACT (folosește exclusiv acestea):\n' + lines.join('\n');
}

/**
 * @param {Business} business
 */
function buildFactsContext(business) {
  const faqs = Array.isArray(business.faqs) ? business.faqs : [];
  const faqBlock = faqs.length
    ? (
      '\n\nFAQ / POLITICI LOCAȚIE (singura sursă pentru întrebări de tipul card, parcare, animale, anulare, wifi):\n' +
      faqs.map((row) => `- Î: ${row.question}\n  R: ${row.answer}`).join('\n') +
      '\nDacă întrebarea clientului nu e acoperită de lista de mai sus, spune că nu deții informația. NU inventa politici.'
    )
    : (
      '\n\nFAQ / POLITICI LOCAȚIE: nesetat.\n' +
      'Dacă clientul întreabă de card, parcare, animale, taxe de anulare sau alte politici, răspunde exact: ' +
      '"Nu dețin această informație, din păcate nu vă pot răspunde la această întrebare." ' +
      'Nu menționa Admin. NU inventa.'
    );

  const facts = business.booking_settings?.ai_facts;
  const extra = typeof facts === 'string' && facts.trim()
    ? (
      '\n\nFACTS ADMIN (poți folosi doar aceste fapte suplimentare):\n' +
      facts.trim()
    )
    : '';
  return faqBlock + extra;
}

/**
 * @param {Business} business
 */
export function buildEmployeesContext(business) {
  const employees = Array.isArray(business.employees) ? business.employees : [];
  if (!employees.length) {
    return '\n\nANGAJAȚI: nesetați (programările merg pe calendarul afacerii).';
  }
  return (
    '\n\nANGAJAȚI ACTIVI (folosește exclusiv aceste nume):\n' +
    employees.map((e) => `- ${e.name}`).join('\n')
  );
}

/**
 * @param {Business} business
 */
function buildModeContext(business) {
  if (business.business_type === 'consulting') {
    return `
MOD AFACERE: CONSULTING (fără calendar online).
- Nu oferi sloturi de calendar și nu pretinde că poți programa online.
- Dacă clientul vrea întâlnire cu un specialist, emite exact: ${CALLBACK_SENTINEL}`;
  }

  return `
MOD AFACERE: BOOKING (programări online).
- Programul din Admin este legea absolută. Zilele marcate „închis” sunt închise — spune-o clientului, fără excepții.
- Backend-ul respinge orice oră în afara programului, fără să interogheze Google Calendar.
- Nu oferi și nu inventa ore în zile închise sau în afara intervalului din Admin.
- Durata fiecărui serviciu este cea din catalog. Nu estima durate.
- Nu inventa disponibilitate — sloturile libere vin din backend, doar după filtrul de program.`;
}

/**
 * @param {string | null | undefined} turnContext
 */
function buildTurnContextBlock(turnContext) {
  if (!turnContext || !String(turnContext).trim()) return '';
  return `\n\nSTARE SESIUNE LIVE (adevăr tehnic — nu o contradicta):\n${String(turnContext).trim()}`;
}

/**
 * Fresh SELECT of this tenant. Never reads WhatsApp To-number cache or module state.
 *
 * @param {string | null | undefined} businessId
 * @returns {Promise<AiTenantContext | null>}
 */
export async function loadAiTenantContext(businessId) {
  const id = typeof businessId === 'string' ? businessId.trim() : '';
  if (!id) return null;

  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    await logError({
      message: `Eroare: Context Loader nu a putut citi business ${id}`,
      source: 'ai',
      severity: 'error',
      businessId: id,
      error,
      details: { alert: true, alertKind: 'supabase' },
    });
    return null;
  }

  if (!data || String(data.id) !== id) {
    console.error('[ai-context] tenant isolation mismatch or missing row', {
      requested: id,
      got: data?.id ?? null,
    });
    return null;
  }

  const hydrated = await withServices(hydrateBusiness(/** @type {Record<string, unknown>} */ (data)));
  if (!hydrated || String(hydrated.id) !== id) return null;

  const employees = await listEmployees(id, { activeOnly: true });
  const faqs = await listFaqsForBusiness(id);
  const snapshot = {
    ...hydrated,
    employees,
    faqs,
  };

  const fromAdmin = typeof snapshot.ai_system_prompt === 'string'
    ? snapshot.ai_system_prompt.trim()
    : '';
  const systemPrompt = fromAdmin || DEFAULT_SYSTEM_PROMPT;
  const logicConfig = getConversationLogic(snapshot);
  const model = typeof snapshot.ai_model === 'string' && snapshot.ai_model.trim()
    ? snapshot.ai_model.trim()
    : 'gpt-4o-mini';

  const ctx = Object.freeze({
    businessId: id,
    systemPrompt,
    logicConfig,
    model,
    temperature: clampTemperature(snapshot.ai_temperature),
    snapshot,
    loadedAt: Date.now(),
  });

  console.log('[ai-context] loaded tenant', {
    businessId: id,
    promptChars: systemPrompt.length,
    logicChars: logicConfig.length,
    model,
  });

  return ctx;
}

/**
 * Assemble the system message exclusively from a freshly loaded tenant context.
 *
 * @param {AiTenantContext} ctx
 * @param {{ turnContext?: string | null, routerMode?: boolean }} [opts]
 */
export function buildTenantSystemPrompt(ctx, opts = {}) {
  if (!ctx?.businessId || !ctx.snapshot || String(ctx.snapshot.id) !== ctx.businessId) {
    throw new Error('buildTenantSystemPrompt requires a verified AiTenantContext');
  }

  const business = ctx.snapshot;
  let prompt =
    ctx.systemPrompt +
    `\n\nLOGICA DE CONVERSAȚIE (din Admin — respectă cu prioritate față de obiceiurile implicite):\n${ctx.logicConfig}` +
    `\n\nNume afacere: ${business.name}` +
    buildModeContext(business) +
    buildTurnContextBlock(opts.turnContext) +
    buildServicesCatalog(business) +
    buildBusinessHoursContext(business) +
    buildEmployeesContext(business) +
    buildContactContext(business) +
    buildFactsContext(business) +
    `\n\nPROTOCOL CALLBACK: dacă nu poți răspunde din datele de mai sus, emite exact o linie: ${CALLBACK_SENTINEL}`;

  if (opts.routerMode) {
    prompt +=
      `\n\nSARCINĂ ROUTER — răspunde DOAR cu JSON valid:\n` +
      `{"action":"book|resume|faq|cancel|reschedule|callback|chat|confirm|cancel_pending|change_employee","message":"...","same_slot":false}\n` +
      `- confirm: acceptă hold-ul pending (da / ok / confirmă)\n` +
      `- cancel_pending: renunță la hold-ul neconfirmat (nu mai vreau, anulează rezervarea în curs)\n` +
      `- change_employee: vrea alt angajat (ex. „vreau la Andrei”)\n` +
      `- book: altă zi/oră/serviciu decât hold-ul curent\n` +
      `- resume: vrea aceeași oră reținută după TTL expirat\n` +
      `- faq / chat: răspunsul pentru client stă în "message"; dacă există hold, NU îl elibera\n` +
      `- cancel / reschedule: programare DEJA CONFIRMATĂ (nu hold-ul pending)\n` +
      `- callback: om din echipă\n` +
      `- same_slot=true doar dacă vrea explicit slotul reținut\n` +
      `- Nu inventa ore libere. Nu cere clientului să scrie cuvântul „programare”.\n` +
      `- Dacă Admin zice închis, mesajul către client trebuie să zică închis.\n` +
      `- Dacă ai corectat un angajat/serviciu inexistent și clientul acceptă alternativa (da/ok/bine), avansează. NU reexplica aceeași obiecție.\n` +
      `- Citește mesajul integral + istoricul. Nu ignora textul liber.`;
  }

  return prompt;
}

/**
 * The only OpenAI HTTP gate. Always reloads tenant settings by business_id first.
 *
 * @param {Object} params
 * @param {string} params.businessId
 * @param {string} [params.extraSystem]
 * @param {(ctx: AiTenantContext) => string} [params.buildExtraSystem]
 * @param {boolean} [params.parserMode] — skip conversational prompt; parser-only system
 * @param {object | null} [params.jsonSchema] — OpenAI json_schema (structured outputs)
 * @param {string} [params.userContent]
 * @param {object[]} [params.history]
 * @param {object[] | null} [params.messages]
 * @param {boolean} [params.jsonMode]
 * @param {boolean} [params.routerMode]
 * @param {string | null} [params.turnContext]
 * @param {(ctx: AiTenantContext) => unknown[] | null} [params.buildTools]
 * @param {string} [params.toolChoice]
 * @param {number} [params.maxTokens]
 * @param {number | null} [params.temperature]
 * @param {number} [params.timeoutMs]
 * @param {string | null} [params.requestId]
 */
export async function completeTenantChat({
  businessId,
  extraSystem = '',
  buildExtraSystem = null,
  parserMode = false,
  jsonSchema = null,
  userContent = '',
  history = [],
  messages = null,
  jsonMode = false,
  routerMode = false,
  turnContext = null,
  buildTools = null,
  toolChoice = 'auto',
  maxTokens = null,
  temperature = null,
  timeoutMs = 8000,
  requestId = null,
}) {
  const ctx = await loadAiTenantContext(businessId);
  if (!ctx) {
    return { ok: false, error: 'tenant_context_missing', context: null, message: null, text: null };
  }

  const geminiOk = isGeminiConfigured();
  const openaiOk = isOpenAiConfigured() && !isOpenAiTemporarilyDown();
  if (!geminiOk && !openaiOk) {
    return { ok: false, error: 'llm_unavailable', context: ctx, message: null, text: null };
  }

  let system = '';
  if (parserMode) {
    system = '';
  } else {
    system = buildTenantSystemPrompt(ctx, {
      turnContext,
      routerMode,
    });
  }
  let extra = extraSystem;
  if (typeof buildExtraSystem === 'function') {
    extra = buildExtraSystem(ctx) || extra;
  }
  if (extra && String(extra).trim()) {
    system = parserMode
      ? String(extra).trim()
      : `${system}\n\n${String(extra).trim()}`;
  }
  if (parserMode && !system) {
    return { ok: false, error: 'parser_prompt_missing', context: ctx, message: null, text: null };
  }

  /** @type {Record<string, unknown>[]} */
  let chatMessages;
  if (Array.isArray(messages)) {
    chatMessages = [
      { role: 'system', content: system },
      ...messages.filter((m) => m && m.role !== 'system'),
    ];
  } else {
    const prior = Array.isArray(history)
      ? history
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.text)
          .slice(-8)
          .map((m) => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: String(m.text).slice(0, 240),
          }))
      : [];
    chatMessages = [
      { role: 'system', content: system },
      ...prior,
      { role: 'user', content: String(userContent ?? '') },
    ];
  }

  const tools = typeof buildTools === 'function' ? buildTools(ctx) : null;
  const useTools = Array.isArray(tools) && tools.length > 0;
  const temp = temperature != null
    ? clampTemperature(temperature)
    : jsonMode
      ? Math.min(0.2, ctx.temperature)
      : useTools
        ? Math.min(0.4, ctx.temperature)
        : ctx.temperature;

  const tokenBudget = maxTokens ?? (jsonMode ? 400 : useTools ? 400 : 280);

  if (geminiOk && !useTools) {
    const gemini = await completeGeminiChat({
      system,
      messages: chatMessages,
      jsonMode: Boolean(jsonMode || jsonSchema),
      temperature: temp,
      maxTokens: tokenBudget,
      timeoutMs,
      businessId: ctx.businessId,
      requestId,
    });
    if (gemini.ok && gemini.text) {
      return {
        ok: true,
        error: null,
        context: ctx,
        message: { role: 'assistant', content: gemini.text },
        text: gemini.text,
        provider: 'gemini',
      };
    }
  }

  const apiKey = getOpenAiApiKey();
  if (!apiKey || !openaiOk) {
    return { ok: false, error: 'llm_unavailable', context: ctx, message: null, text: null };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    /** @type {Record<string, unknown>} */
    const body = {
      model: ctx.model,
      temperature: temp,
      max_tokens: tokenBudget,
      messages: chatMessages,
    };
    if (jsonSchema && jsonSchema.schema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: jsonSchema,
      };
    } else if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }
    if (useTools) {
      body.tools = tools;
      body.tool_choice = toolChoice;
    }

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
        message: `Eroare: OpenAI a eșuat (HTTP ${response.status})`,
        source: 'ai',
        severity: 'error',
        businessId: ctx.businessId,
        requestId,
        httpStatus: response.status,
        details: { response: data, alert: true, alertKind: 'openai' },
      });
      return { ok: false, error: `http_${response.status}`, context: ctx, message: null, text: null };
    }

    const message = data?.choices?.[0]?.message || null;
    const text = typeof message?.content === 'string' ? message.content.trim() : '';
    return {
      ok: true,
      error: null,
      context: ctx,
      message,
      text: text || null,
    };
  } catch (error) {
    console.error('Eroare detalii:', error);
    markOpenAiUnavailable();
    const aborted = error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message));
    await logError({
      message: aborted
        ? `Eroare: OpenAI nu a răspuns (timeout ${timeoutMs / 1000}s)`
        : 'Eroare: OpenAI — eroare de rețea',
      source: 'ai',
      severity: 'error',
      businessId: ctx.businessId,
      requestId,
      error,
      details: { alert: true, alertKind: 'openai', timeoutMs },
    });
    return { ok: false, error: aborted ? 'timeout' : 'network', context: ctx, message: null, text: null };
  } finally {
    clearTimeout(timer);
  }
}
