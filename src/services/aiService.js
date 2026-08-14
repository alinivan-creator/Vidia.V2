import { getBookingConfig, getConfiguredBusinessHours, formatBusinessHoursText } from '../utils/datetime.js';
import { hasConfiguredOpenDay } from '../utils/workingHours.js';
import { getBusinessContactInfo } from './contactService.js';
import { CALLBACK_SENTINEL, DEFAULT_SYSTEM_PROMPT } from '../config/defaultSystemPrompt.js';
import { getConversationLogic } from '../config/conversationConfig.js';
import {
  completeTenantChat,
  buildTenantSystemPrompt,
  buildServicesCatalog,
  buildBusinessHoursContext,
  buildEmployeesContext,
} from './aiContextLoader.js';
import { markOpenAiUnavailable, isOpenAiTemporarilyDown } from './openaiGate.js';

/** @typedef {import('../db/businessService.js').Business} Business */

export { CALLBACK_SENTINEL, DEFAULT_SYSTEM_PROMPT };
export { markOpenAiUnavailable, isOpenAiTemporarilyDown };
export { buildServicesCatalog, buildBusinessHoursContext, buildEmployeesContext };

/**
 * @typedef {Object} AiResponse
 * @property {string} text
 * @property {boolean} mocked
 * @property {string | null} model
 * @property {boolean} [needsCallback]
 * @property {string} [callbackReason]
 */

/**
 * Admin/preview only. Live OpenAI must use completeTenantChat (fresh DB load).
 *
 * @param {Business} business
 * @param {{ turnContext?: string | null, routerMode?: boolean }} [opts]
 */
export function buildSystemPrompt(business, opts = {}) {
  if (!business?.id) return '';
  const fromAdmin = typeof business.ai_system_prompt === 'string'
    ? business.ai_system_prompt.trim()
    : '';
  return buildTenantSystemPrompt({
    businessId: String(business.id),
    systemPrompt: fromAdmin || DEFAULT_SYSTEM_PROMPT,
    logicConfig: getConversationLogic(business),
    model: typeof business.ai_model === 'string' && business.ai_model.trim()
      ? business.ai_model.trim()
      : 'gpt-4o-mini',
    temperature: Number(business.ai_temperature) || 0.3,
    snapshot: business,
    loadedAt: Date.now(),
  }, opts);
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
  const result = await completeTenantChat({
    businessId: business.id,
    userContent: userMessage,
    history,
    turnContext,
    requestId,
  });

  if (result.ok && result.text) {
    const parsed = parseAiCallbackSignal(result.text);
    return {
      text: parsed.cleanText || result.text,
      mocked: false,
      model: result.context?.model || null,
      needsCallback: parsed.needsCallback,
      callbackReason: parsed.needsCallback ? 'ai_out_of_scope' : undefined,
    };
  }

  const snapshot = result.context?.snapshot;
  if (!snapshot) {
    return {
      text: 'Nu pot răspunde momentan. Te rog încearcă din nou.',
      mocked: true,
      model: null,
      needsCallback: false,
    };
  }

  const factual = factualReply(snapshot, userMessage);
  if (factual) {
    return { text: factual, mocked: false, model: 'rules', needsCallback: false };
  }

  const mockedText = mockAiResponse(snapshot, userMessage);
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
  const result = await completeTenantChat({
    businessId: business.id,
    userContent: userMessage,
    history,
    turnContext,
    jsonMode: true,
    routerMode: true,
    requestId,
  });
  if (!result.ok || !result.text) return null;

  try {
    const raw = result.text.replace(/```json\s*|```/g, '').trim();
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
