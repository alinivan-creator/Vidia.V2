import { logError } from '../db/loggerService.js';
import { getBookingConfig, getConfiguredBusinessHours, formatBusinessHoursText } from '../utils/datetime.js';
import { hasConfiguredOpenDay } from '../utils/workingHours.js';
import { getBusinessContactInfo } from './contactService.js';
import { CALLBACK_SENTINEL, DEFAULT_SYSTEM_PROMPT } from '../config/defaultSystemPrompt.js';
import { loadBusinessContext } from './businessContext.js';
import { getConversationLogic } from '../config/conversationConfig.js';

/** @typedef {import('../db/businessService.js').Business} Business */

export { CALLBACK_SENTINEL, DEFAULT_SYSTEM_PROMPT };

/**
 * @typedef {Object} AiResponse
 * @property {string} text
 * @property {boolean} mocked
 * @property {string | null} model
 * @property {boolean} [needsCallback]
 * @property {string} [callbackReason]
 */

/**
 * @param {unknown} value
 * @returns {number}
 */
function clampTemperature(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.3;
  return Math.min(2, Math.max(0, n));
}

/**
 * Builds a services catalog block for the AI system prompt.
 * @param {Business} business
 * @returns {string}
 */
export function buildServicesCatalog(business) {
  const { services } = getBookingConfig(business);
  if (!services.length) {
    return (
      '\n\nCATALOG SERVICII: nesetat.\n' +
      'Dacă clientul întreabă de servicii/prețuri/durată, spune clar că nu ai aceste date configurate încă.'
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
 * @returns {string}
 */
export function buildBusinessHoursContext(business) {
  const hours = getConfiguredBusinessHours(business);
  if (!hours) {
    return (
      '\n\nPROGRAM DE LUCRU: nesetat în Admin.\n' +
      'Dacă clientul întreabă de program/oră de deschidere/închidere, ' +
      'spune că nu ai programul configurat încă și oferă datele de contact. NU inventa ore.'
    );
  }

  return (
    '\n\nPROGRAM DE LUCRU (singura sursă de adevăr — nu inventa altceva):\n' +
    formatBusinessHoursText(hours)
  );
}

/**
 * @param {Business} business
 * @returns {string}
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
      '\n\nCONTACT: nesetat în Admin.\n' +
      'Dacă clientul cere telefon/adresă/email și nu apar mai sus, spune că nu ai datele.'
    );
  }

  return '\n\nDATE CONTACT (folosește exclusiv acestea):\n' + lines.join('\n');
}

/**
 * @param {Business} business
 * @returns {string}
 */
function buildFactsContext(business) {
  const facts = business.booking_settings?.ai_facts;
  if (typeof facts !== 'string' || !facts.trim()) return '';
  return (
    '\n\nFACTS ADMIN (poți folosi doar aceste fapte suplimentare):\n' +
    facts.trim()
  );
}

/**
 * @param {Business} business
 * @returns {string}
 */
export function buildEmployeesContext(business) {
  const employees = Array.isArray(business.employees) ? business.employees : [];
  if (!employees.length) {
    return '\n\nANGAJAȚI: nesetați în Admin (programările merg pe calendarul afacerii).';
  }
  return (
    '\n\nANGAJAȚI ACTIVI (folosește exclusiv aceste nume):\n' +
    employees.map((e) => `- ${e.name}`).join('\n')
  );
}

/**
 * @param {Business} business
 * @returns {string}
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
 * System prompt = live Admin instructions + conversation logic + catalog/hours/contact.
 * Hardcoded routing slogans do not override the Admin prompt.
 *
 * @param {Business} business
 * @param {{ turnContext?: string | null, routerMode?: boolean }} [opts]
 */
export function buildSystemPrompt(business, opts = {}) {
  const fromAdmin = typeof business.ai_system_prompt === 'string'
    ? business.ai_system_prompt.trim()
    : '';
  const instructions = fromAdmin || DEFAULT_SYSTEM_PROMPT;
  const logic = getConversationLogic(business);

  let prompt =
    instructions +
    `\n\nLOGICA DE CONVERSAȚIE (din Admin — respectă cu prioritate față de obiceiurile implicite):\n${logic}` +
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
 * Deterministic replies for common factual questions (no LLM).
 * @param {Business} business
 * @param {string} userMessage
 * @returns {string | null}
 */
function factualReply(business, userMessage) {
  const q = userMessage
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const asksHours = /program|orar|orele|deschid|inchid|cand sunteti|la ce ora/.test(q);
  const asksPrice = /pret|cost|cat costa|tarif|lei|cat e/.test(q);
  const asksDuration = /durata|minute|cat dureaza|timp/.test(q);
  const asksServices = /servici|detali|info|informat|lista|ce oferi|ce faceti/.test(q);
  const asksContact = /contact|telefon|adresa|email|unde sunteti|locatie|harta|cum ajung/.test(q);

  if (asksHours) {
    const hours = getConfiguredBusinessHours(business);
    if (!hours) {
      return `Nu am programul de lucru configurat încă pentru *${business.name}*.`;
    }
    if (!hasConfiguredOpenDay(business)) {
      return `*${business.name}* are toate zilele marcate ca închise în programul din Admin.`;
    }
    return (
      `*Program de lucru — ${business.name}*\n\n` +
      formatBusinessHoursText(hours).replace(/^- /gm, '• ')
    );
  }

  if (asksContact) {
    const info = getBusinessContactInfo(business);
    const lines = [`*Contact — ${business.name}*`, ''];
    if (info.phone) lines.push(`• Telefon: ${info.phone}`);
    if (info.email) lines.push(`• Email: ${info.email}`);
    if (info.address) lines.push(`• Adresă: ${info.address}`);
    if (info.website) lines.push(`• Website: ${info.website}`);
    if (info.mapsUrl) lines.push(`• Hartă: ${info.mapsUrl}`);
    if (lines.length === 2) {
      return `Nu am datele de contact configurate încă pentru *${business.name}*.`;
    }
    return lines.join('\n');
  }

  if (asksPrice || asksDuration || asksServices) {
    const { services } = getBookingConfig(business);
    if (!services.length) {
      return `Nu am lista de servicii/prețuri configurată încă pentru *${business.name}*.`;
    }
    const lines = [`*Servicii — ${business.name}*`, ''];
    for (const s of services) {
      const price = s.price_ron != null ? `${s.price_ron} LEI` : 'la cerere';
      lines.push(`• *${s.name}* — ${price} · ${s.duration_minutes} min`);
    }
    return lines.join('\n');
  }

  return null;
}

/**
 * @param {string} text
 * @returns {{ needsCallback: boolean; cleanText: string }}
 */
export function parseAiCallbackSignal(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { needsCallback: false, cleanText: '' };

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hasSentinel = lines.some((l) => {
    const upper = l.toUpperCase();
    return upper === CALLBACK_SENTINEL || upper.startsWith(`${CALLBACK_SENTINEL}:`);
  });
  if (hasSentinel) {
    return { needsCallback: true, cleanText: '' };
  }

  return { needsCallback: false, cleanText: raw };
}

/**
 * @param {Business} business
 * @param {string} userMessage
 * @returns {string}
 */
function mockAiResponse(business, userMessage) {
  const factual = factualReply(business, userMessage);
  if (factual) return factual;

  if (business.business_type === 'consulting') {
    return CALLBACK_SENTINEL;
  }

  return `Bună! Sunt asistentul *${business.name}*. Cu ce te pot ajuta?`;
}

const OPENAI_TIMEOUT_MS = 8000;
let openaiUnavailableUntil = 0;

function markOpenAiDown() {
  openaiUnavailableUntil = Date.now() + 30_000;
}

export function markOpenAiUnavailable() {
  markOpenAiDown();
}

export function isOpenAiTemporarilyDown() {
  return Date.now() < openaiUnavailableUntil;
}

/**
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.userMessage
 * @param {string | null} [params.requestId]
 * @returns {Promise<AiResponse | null>}
 */
async function callOpenAi({
  business,
  userMessage,
  requestId = null,
  turnContext = null,
  jsonMode = false,
  history = [],
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }
  if (isOpenAiTemporarilyDown()) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const prior = Array.isArray(history)
      ? history
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.text)
          .slice(-8)
          .map((m) => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: String(m.text).slice(0, 240),
          }))
      : [];

    /** @type {Record<string, unknown>} */
    const body = {
      model: business.ai_model || 'gpt-4o-mini',
      temperature: jsonMode ? Math.min(0.2, clampTemperature(business.ai_temperature)) : clampTemperature(business.ai_temperature),
      max_tokens: jsonMode ? 400 : 280,
      messages: [
        { role: 'system', content: buildSystemPrompt(business, { turnContext, routerMode: jsonMode }) },
        ...prior,
        { role: 'user', content: userMessage },
      ],
    };
    if (jsonMode) {
      body.response_format = { type: 'json_object' };
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
      if (response.status === 429 || response.status >= 500) {
        markOpenAiDown();
      }
      await logError({
        message: `Eroare: OpenAI a eșuat (HTTP ${response.status})`,
        source: 'ai',
        severity: 'error',
        businessId: business.id,
        requestId,
        httpStatus: response.status,
        details: { response: data, alert: true, alertKind: 'openai' },
      });
      return null;
    }

    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) {
      return null;
    }

    const parsed = parseAiCallbackSignal(text);
    return {
      text: parsed.cleanText || text,
      mocked: false,
      model: business.ai_model,
      needsCallback: parsed.needsCallback,
      callbackReason: parsed.needsCallback ? 'ai_out_of_scope' : undefined,
    };
  } catch (error) {
    console.error('Eroare detalii:', error);
    const aborted = error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message));
    markOpenAiDown();
    await logError({
      message: aborted
        ? `Eroare: OpenAI nu a răspuns (timeout ${OPENAI_TIMEOUT_MS / 1000}s)`
        : 'Eroare: OpenAI — eroare de rețea',
      source: 'ai',
      severity: 'error',
      businessId: business.id,
      requestId,
      error,
      details: { alert: true, alertKind: 'openai', timeoutMs: OPENAI_TIMEOUT_MS },
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.userMessage
 * @param {string | null} [params.requestId]
 * @returns {Promise<AiResponse>}
 */
export async function generateAiReply({
  business,
  userMessage,
  requestId = null,
  turnContext = null,
  history = [],
}) {
  const ctx = await loadBusinessContext(business.id);
  const fresh = ctx?.business || business;

  const live = await callOpenAi({
    business: fresh,
    userMessage,
    requestId,
    turnContext,
    history,
  });
  if (live) {
    return live;
  }

  const factual = factualReply(fresh, userMessage);
  if (factual) {
    return { text: factual, mocked: false, model: 'rules', needsCallback: false };
  }

  const mockedText = mockAiResponse(fresh, userMessage);
  const parsed = parseAiCallbackSignal(mockedText);
  return {
    text: parsed.cleanText || mockedText,
    mocked: true,
    model: null,
    needsCallback: parsed.needsCallback,
    callbackReason: parsed.needsCallback ? 'ai_fallback_out_of_scope' : undefined,
  };
}

/**
 * Snapshot of the WhatsApp session for the LLM (memory without locking the calendar).
 * @param {Object} params
 * @param {string} [params.step]
 * @param {object | null} [params.lastIntent]
 * @param {boolean} [params.pendingDismissed]
 * @param {boolean} [params.pendingExpired]
 */
export function buildConversationTurnContext({
  step = 'IDLE',
  lastIntent = null,
  pendingDismissed = false,
  pendingExpired = false,
  pendingHold = null,
  recentTurns = [],
  pendingOffer = null,
  clarified = [],
}) {
  const lines = [`- pas conversație: ${step || 'IDLE'}`];
  if (step === 'CHOOSING_SERVICE') {
    lines.push('- alege serviciul; un număr valid e procesat de backend; NU retrimite lista de servicii');
  } else if (step === 'CHOOSING_EMPLOYEE') {
    lines.push('- alege angajatul; NU retrimite lista de staff');
  } else if (step === 'SELECTING_SLOT') {
    lines.push('- alege ora; NU retrimite lista de sloturi decât dacă cere explicit alte ore');
  }
  if (pendingOffer?.name) {
    lines.push(
      `- OFERTĂ ACTIVĂ: ai propus ${pendingOffer.kind === 'service' ? 'serviciul' : 'angajatul'} ${pendingOffer.name}. ` +
      'Dacă clientul zice da/ok/bine, action=change_employee sau book pe ACEASTĂ alternativă. NU reexplica obiecția.',
    );
    if (pendingOffer.rejected) {
      lines.push(`- Clarificat: ${pendingOffer.rejected} nu e pe listă. NU mai menționa ca problemă.`);
    }
  }
  if (Array.isArray(clarified) && clarified.length) {
    for (const item of clarified.slice(-3)) {
      if (item?.rejected) {
        lines.push(
          `- Deja clarificat: ${item.rejected} nu e disponibil` +
          (item.accepted ? `; clientul a acceptat ${item.accepted}` : '') +
          '. NU repeta avertismentul.',
        );
      }
    }
  }
  if (pendingHold) {
    lines.push('- HOLD ACTIV (pending_confirmation): NU elibera slotul pentru o întrebare sau o schimbare de preferință');
    if (pendingHold.serviceName) lines.push(`- serviciu reținut: ${pendingHold.serviceName}`);
    if (pendingHold.slotLabel) lines.push(`- oră reținută: ${pendingHold.slotLabel}`);
    if (pendingHold.employeeName) lines.push(`- angajat actual: ${pendingHold.employeeName}`);
    if (Array.isArray(pendingHold.staffNames) && pendingHold.staffNames.length) {
      lines.push(`- angajați disponibili: ${pendingHold.staffNames.join(', ')}`);
    }
    lines.push('- dacă confirmă hold-ul → action=confirm');
    lines.push('- dacă renunță la hold → action=cancel_pending');
    lines.push('- dacă vrea alt angajat → action=change_employee');
    lines.push('- dacă cere altă zi/oră → action=book');
    lines.push('- dacă întreabă (preț, program, servicii) → action=faq și PĂSTREAZĂ hold-ul');
  } else if (pendingDismissed) {
    lines.push('- clientul a anulat explicit hold-ul pending — NU reia slotul vechi');
  } else if (lastIntent?.slot_start) {
    const svc = lastIntent.service?.name ? String(lastIntent.service.name) : 'serviciu';
    const label = lastIntent.slot_label ? String(lastIntent.slot_label) : lastIntent.slot_start;
    lines.push(
      `- ultima intenție reținută (slot eliberat în calendar${pendingExpired ? ', TTL expirat' : ''}): ${svc} · ${label}`,
    );
    lines.push('- dacă vrea aceeași oră → action=resume; dacă cere altă zi/oră → action=book');
  } else {
    lines.push('- nicio oră reținută');
  }
  if (Array.isArray(recentTurns) && recentTurns.length) {
    lines.push('- istoric recent (ultimele mesaje):');
    for (const turn of recentTurns.slice(-6)) {
      const role = turn?.role === 'assistant' ? 'asistent' : 'client';
      const text = String(turn?.text ?? '').slice(0, 160);
      if (text) lines.push(`  • ${role}: ${text}`);
    }
  }
  return lines.join('\n');
}

/**
 * Admin-driven router: decides what the backend should do next.
 * Calendar writes still happen only in bookingFlowService.
 *
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.userMessage
 * @param {string} [params.turnContext]
 * @param {string | null} [params.requestId]
 * @returns {Promise<{ action: string, message: string, sameSlot: boolean } | null>}
 */
export async function interpretUserTurn({
  business,
  userMessage,
  turnContext = '',
  history = [],
  requestId = null,
}) {
  const ctx = await loadBusinessContext(business.id);
  const fresh = ctx?.business || business;

  const live = await callOpenAi({
    business: fresh,
    userMessage,
    requestId,
    turnContext,
    history,
    jsonMode: true,
  });
  if (!live?.text) return null;

  try {
    const raw = live.text.replace(/```json\s*|```/g, '').trim();
    const parsed = JSON.parse(raw);
    const action = String(parsed.action || 'chat').toLowerCase();
    const allowed = new Set([
      'book',
      'resume',
      'faq',
      'cancel',
      'reschedule',
      'callback',
      'chat',
      'confirm',
      'cancel_pending',
      'change_employee',
    ]);
    return {
      action: allowed.has(action) ? action : 'chat',
      message: typeof parsed.message === 'string' ? parsed.message.trim() : '',
      sameSlot: Boolean(parsed.same_slot),
    };
  } catch {
    return null;
  }
}

/**
 * @param {Business} business
 * @returns {string}
 */
export function buildInfoButtonPrompt(business) {
  return `Vreau lista de servicii cu prețuri (în LEI) și durata fiecăruia pentru ${business.name}.`;
}
