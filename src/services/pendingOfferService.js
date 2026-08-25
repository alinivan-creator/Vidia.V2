/**
 * When the AI corrects the client (unknown employee / service) and proposes
 * an alternative, keep that offer in session. An affirmation (da / ok / bine)
 * accepts it and clears the old objection so the model cannot loop.
 */

import {
  CONVERSATION_STEPS,
  getOrCreateConversationState,
  setConversationStep,
} from '../db/conversationStateService.js';
import { listEmployees } from '../db/employeeService.js';
import { getBookingConfig } from '../utils/datetime.js';
import { isAffirmativeReply, looksLikeDatetimeOrSlot } from './intentTriageService.js';

/** @typedef {import('../db/businessService.js').Business} Business */
/** @typedef {import('../db/conversationStateService.js').ConversationState} ConversationState */
/** @typedef {import('../db/draftBookingService.js').DraftBooking} DraftBooking */

/**
 * @typedef {Object} PendingOffer
 * @property {'employee' | 'service'} kind
 * @property {string} id
 * @property {string} name
 * @property {string | null} [rejected]
 */

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {ConversationState | null | undefined} convState
 * @returns {PendingOffer | null}
 */
export function readPendingOffer(convState) {
  const raw = convState?.context_data?.pending_offer;
  if (!raw || typeof raw !== 'object') return null;
  const offer = /** @type {PendingOffer} */ (raw);
  if (!offer.kind || !offer.id || !offer.name) return null;
  return offer;
}

/**
 * @param {ConversationState | null | undefined} convState
 */
export function readClarified(convState) {
  const raw = convState?.context_data?.clarified;
  return Array.isArray(raw) ? raw : [];
}

/**
 * Drop user turns that only repeat an already-rejected name, so the LLM
 * does not treat the old objection as the live request.
 *
 * @param {unknown[]} recentTurns
 * @param {ConversationState | null | undefined} convState
 */
export function historyWithoutResolvedObjections(recentTurns, convState) {
  const turns = Array.isArray(recentTurns) ? recentTurns : [];
  const names = [
    ...readClarified(convState).map((c) => c?.rejected),
    readPendingOffer(convState)?.rejected,
  ]
    .filter(Boolean)
    .map((n) => normalize(n));
  if (!names.length) return turns;

  return turns.filter((turn) => {
    if (!turn || turn.role !== 'user') return true;
    const n = normalize(turn.text);
    const onlyRejected = names.some((name) => {
      if (!name || !n.includes(name)) return false;
      const stripped = n
        .replace(new RegExp(escapeRe(name), 'g'), ' ')
        .replace(/\b(la|cu|pe|vreau|as vrea|programare|te rog|va rog|da|ok|bine)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return stripped.length < 3;
    });
    return !onlyRejected;
  });
}

/**
 * @param {ConversationState | null | undefined} convState
 */
export function lastAssistantText(convState) {
  const turns = Array.isArray(convState?.context_data?.recent_turns)
    ? convState.context_data.recent_turns
    : [];
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]?.role === 'assistant' && turns[i]?.text) {
      return String(turns[i].text);
    }
  }
  return '';
}

/**
 * Pull offered vs rejected catalog names out of an assistant (or user) message.
 *
 * @param {string} text
 * @param {{ id: string, name: string }[]} employees
 * @param {{ id: string, name: string }[]} [services]
 */
export function extractOfferFromText(text, employees, services = []) {
  const n = normalize(text);
  /** @type {{ id: string, name: string } | null} */
  let employee = null;
  /** @type {{ id: string, name: string } | null} */
  let service = null;
  /** @type {string | null} */
  let rejected = null;

  for (const emp of employees) {
    const name = normalize(emp.name);
    if (!name || name.length < 2) continue;
    const first = name.split(/\s+/)[0];
    const token = first.length >= 3 ? first : name;
    if (!n.includes(token)) continue;

    const neg = new RegExp(
      `(nu (avem|exista|lucreaza|e|este).{0,48}${escapeRe(token)}|${escapeRe(token)}.{0,28}(nu (exista|lucreaza|avem)|nu e pe lista|nu lucreaza))`,
    );
    if (neg.test(n)) {
      rejected = emp.name;
      continue;
    }
    employee = emp;
  }

  for (const svc of services) {
    const name = normalize(svc.name);
    if (!name || name.length < 3 || !n.includes(name)) continue;
    const neg = new RegExp(
      `(nu (avem|exista|oferim).{0,48}${escapeRe(name)}|${escapeRe(name)}.{0,20}nu (exista|avem))`,
    );
    if (neg.test(n)) {
      rejected = rejected || svc.name;
      continue;
    }
    service = svc;
  }

  return { employee, service, rejected };
}

/**
 * @param {Object} params
 * @param {ConversationState | null | undefined} params.convState
 * @param {{ id: string, name: string }[]} params.employees
 * @param {{ id: string, name: string }[]} [params.services]
 */
export function resolveAcceptedOffer({ convState, employees, services = [] }) {
  const offer = readPendingOffer(convState);
  const fromAssistant = extractOfferFromText(lastAssistantText(convState), employees, services);
  const suggestedId = convState?.context_data?.suggested_employee_id;

  /** @type {{ id: string, name: string } | null} */
  let employee = null;
  if (offer?.kind === 'employee') {
    employee = employees.find((e) => e.id === offer.id) || null;
  }
  if (!employee && suggestedId) {
    employee = employees.find((e) => e.id === suggestedId) || null;
  }
  if (!employee) employee = fromAssistant.employee;
  // Never silently pick employees[0] — unknown-name flow must wait for an explicit choice.

  /** @type {{ id: string, name: string } | null} */
  let service = null;
  if (offer?.kind === 'service') {
    service = services.find((s) => s.id === offer.id) || null;
  }
  if (!service) service = fromAssistant.service;

  const rejected = offer?.rejected || fromAssistant.rejected || null;
  if (!employee && !service) return null;
  return { employee, service, rejected };
}

/**
 * @param {Object} params
 * @param {string} params.businessId
 * @param {string} params.rawPhone
 * @param {PendingOffer | null} params.offer
 * @param {string | null} [params.requestId]
 * @param {string} [params.step]
 */
export async function persistPendingOffer({
  businessId,
  rawPhone,
  offer,
  requestId = null,
  step,
}) {
  const conv = await getOrCreateConversationState(businessId, rawPhone);
  const clarified = readClarified(conv);
  /** @type {Record<string, unknown>} */
  const context = { pending_offer: offer };
  if (offer?.rejected) {
    context.clarified = [
      ...clarified.filter((c) => c?.rejected !== offer.rejected),
      { rejected: offer.rejected, accepted: offer.name, kind: offer.kind },
    ].slice(-4);
  }
  return setConversationStep({
    businessId,
    rawPhone,
    step: step || conv.current_step,
    context,
    mergeContext: true,
    requestId,
  });
}

/**
 * @param {Object} params
 */
export async function clearPendingOffer({
  businessId,
  rawPhone,
  requestId = null,
  extraContext = {},
}) {
  const conv = await getOrCreateConversationState(businessId, rawPhone);
  return setConversationStep({
    businessId,
    rawPhone,
    step: conv.current_step,
    context: { pending_offer: null, booking_hint: '', ...extraContext },
    mergeContext: true,
    requestId,
  });
}

/**
 * After an outbound assistant message: remember the alternative it proposed.
 *
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {string} params.text
 * @param {string | null} [params.requestId]
 */
export async function rememberOfferFromAssistant({
  business,
  recipientPhone,
  text,
  requestId = null,
}) {
  const employees = await listEmployees(business.id, { activeOnly: true });
  const services = getBookingConfig(business).services || [];
  const extracted = extractOfferFromText(text, employees, services);
  if (!extracted.employee && !extracted.service) return null;

  const offer = extracted.employee
    ? {
        kind: /** @type {'employee'} */ ('employee'),
        id: extracted.employee.id,
        name: extracted.employee.name,
        rejected: extracted.rejected,
      }
    : {
        kind: /** @type {'service'} */ ('service'),
        id: extracted.service.id,
        name: extracted.service.name,
        rejected: extracted.rejected,
      };

  await persistPendingOffer({
    businessId: business.id,
    rawPhone: recipientPhone,
    offer,
    requestId,
  });
  return offer;
}

/**
 * If the client just accepted the last AI alternative, apply it and stop the loop.
 *
 * @returns {Promise<boolean>}
 */
export async function acceptClarifiedOffer({
  business,
  recipientPhone,
  textBody,
  convState,
  draft = null,
  clientId = null,
  requestId = null,
}) {
  if (!isAffirmativeReply(textBody) || looksLikeDatetimeOrSlot(textBody)) {
    return false;
  }

  const employees = await listEmployees(business.id, { activeOnly: true });
  const services = getBookingConfig(business).services || [];
  const resolved = resolveAcceptedOffer({ convState, employees, services });
  if (!resolved) return false;

  const clarified = [
    ...readClarified(convState),
    resolved.rejected
      ? { rejected: resolved.rejected, accepted: resolved.employee?.name || resolved.service?.name, kind: resolved.employee ? 'employee' : 'service' }
      : null,
  ].filter(Boolean).slice(-4);

  await clearPendingOffer({
    businessId: business.id,
    rawPhone: recipientPhone,
    requestId,
    extraContext: { clarified, booking_hint: resolved.employee?.name || resolved.service?.name || '' },
  });

  const {
    applyPendingEmployeeChange,
    handleBookingInteractiveReply,
  } = await import('./bookingFlowService.js');
  const { handleBookingAction } = await import('./menuHandler.js');

  if (resolved.employee && draft) {
    await applyPendingEmployeeChange({
      business,
      recipientPhone,
      draft,
      textBody: resolved.employee.name,
      requestId,
    });
    return true;
  }

  if (resolved.service && draft && !draft.selected_service) {
    const handled = await handleBookingInteractiveReply({
      business,
      recipientPhone,
      replyId: `svc_${resolved.service.id}`,
      clientId,
      requestId,
    });
    if (handled) return true;
  }

  if (resolved.employee && !draft) {
    const hint = [resolved.service?.name, resolved.employee.name].filter(Boolean).join(' ');
    await handleBookingAction({
      business,
      recipientPhone,
      clientId,
      hintText: hint,
      requestId,
    });
    return true;
  }

  if (resolved.service && !draft) {
    await handleBookingAction({
      business,
      recipientPhone,
      clientId,
      hintText: resolved.service.name,
      requestId,
    });
    return true;
  }

  return false;
}
