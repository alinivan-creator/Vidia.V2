/**
 * Explicit pending_action per conversation — foundation for context-aware replies.
 * Derives from current_step / pending_offer / booking_wait and can be persisted
 * on context_data.pending_action so the next turn is interpreted against that ask.
 */

import { CONVERSATION_STEPS, setConversationStep, readLastMenu } from '../db/conversationStateService.js';
import { BOOKING_WAIT, getBookingWait } from './bookingWaitState.js';
import { readPendingOffer } from './pendingOfferService.js';
import { resolveStaffMentionFromText } from '../db/employeeService.js';
import { isAffirmativeReply, isExplicitCancelReply } from './intentTriageService.js';
import { BOOKING_PREFIXES } from './flowIds.js';

/**
 * "Care listă?", "ce listă?", "which list?", "unde e lista?"
 * @param {string} text
 */
export function looksLikeListClarification(text) {
  const n = String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!n) return false;
  if (/\b(care|ce|unde|which|where|show|arata|afiiseaza|afiseaza)\b/.test(n)
    && /\b(lista|list|optiuni|options|alegeri)\b/.test(n)) {
    return true;
  }
  if (/^(lista|list|optiunile|the list)[\s?!.]*$/i.test(n)) return true;
  return false;
}

/**
 * @param {string} text
 * @param {{ id: string }[]} options
 */
function resolveNumberedOption(text, options) {
  const match = /^(\d{1,2})$/.exec(String(text ?? '').trim());
  if (!match || !options?.length) return null;
  const index = Number(match[1]) - 1;
  if (index < 0 || index >= options.length) return null;
  return options[index].id;
}

/** @typedef {'awaiting_employee_confirmation' | 'awaiting_employee_selection' | 'awaiting_service_selection' | 'awaiting_date' | 'awaiting_time' | 'awaiting_date_time' | 'awaiting_confirmation' | 'awaiting_reschedule_time' | 'awaiting_clarification' | null} PendingActionKind */

export const PENDING_ACTIONS = {
  EMPLOYEE_CONFIRM: 'awaiting_employee_confirmation',
  EMPLOYEE_SELECT: 'awaiting_employee_selection',
  SERVICE: 'awaiting_service_selection',
  DATE: 'awaiting_date',
  TIME: 'awaiting_time',
  DATE_TIME: 'awaiting_date_time',
  CONFIRM: 'awaiting_confirmation',
  RESCHEDULE: 'awaiting_reschedule_time',
  CLARIFY: 'awaiting_clarification',
};

/** Actions where unknown-staff grounding is meaningful. */
const BOOKING_GROUNDED_ACTIONS = new Set([
  'book',
  'select_service',
  'select_employee',
  'select_slot',
  'accept_offer',
  'revise_draft',
  'unknown_service',
  'show_services',
]);

/**
 * @param {string | null | undefined} action
 */
export function isBookingGroundedAction(action) {
  return BOOKING_GROUNDED_ACTIONS.has(String(action || ''));
}

/**
 * Actions that must never inherit a free-text "la X" employee guess.
 * @param {string | null | undefined} action
 */
export function shouldSkipStaffRebind(action) {
  const a = String(action || '');
  return [
    'missing_info', 'hours', 'services', 'hours_and_services', 'thanks', 'chat',
    'off_topic', 'menu', 'contact', 'callback', 'language_info', 'faq',
  ].includes(a);
}

/**
 * @param {import('../db/conversationStateService.js').ConversationState | null | undefined} convState
 * @returns {{ kind: PendingActionKind, prompt?: string, options?: string[], offered?: { id?: string, name?: string }, rejected?: string | null, at?: string } | null}
 */
export function readPendingAction(convState) {
  const ctx = convState?.context_data || {};
  const stored = ctx.pending_action;
  if (stored && typeof stored === 'object' && stored.kind) {
    return /** @type {{ kind: PendingActionKind, prompt?: string, options?: string[], offered?: { id?: string, name?: string }, rejected?: string | null, at?: string }} */ (stored);
  }

  const step = convState?.current_step;
  const offer = readPendingOffer(convState);
  const wait = getBookingWait(convState);

  if (step === CONVERSATION_STEPS.CHOOSING_EMPLOYEE || wait === BOOKING_WAIT.EMPLOYEE) {
    if (offer?.kind === 'employee' || ctx.suggested_employee_id) {
      return {
        kind: PENDING_ACTIONS.EMPLOYEE_CONFIRM,
        offered: offer?.kind === 'employee'
          ? { id: offer.id, name: offer.name }
          : { id: String(ctx.suggested_employee_id), name: undefined },
        rejected: offer?.rejected ? String(offer.rejected) : (ctx.rejected_employee_name ? String(ctx.rejected_employee_name) : null),
        options: Array.isArray(ctx.available_employees) ? ctx.available_employees.map(String) : undefined,
        prompt: 'Confirmă specialistul sugerat (da) sau alege alt nume din echipă.',
      };
    }
    return {
      kind: PENDING_ACTIONS.EMPLOYEE_SELECT,
      options: Array.isArray(ctx.available_employees) ? ctx.available_employees.map(String) : undefined,
      prompt: 'Alege un specialist din echipă.',
    };
  }

  if (step === CONVERSATION_STEPS.RESCHEDULING || ctx.intent === 'reschedule') {
    return {
      kind: PENDING_ACTIONS.RESCHEDULE,
      prompt: 'Alege noua oră / dată pentru reprogramare.',
    };
  }

  if (wait === BOOKING_WAIT.SERVICE
    || step === CONVERSATION_STEPS.CHOOSING_SERVICE
    || step === CONVERSATION_STEPS.WAITING_FOR_SERVICE) {
    return { kind: PENDING_ACTIONS.SERVICE, prompt: 'Alege un serviciu din listă sau scrie numele.' };
  }
  if (wait === BOOKING_WAIT.DATE || step === CONVERSATION_STEPS.WAITING_FOR_DATE) {
    return { kind: PENDING_ACTIONS.DATE, prompt: 'Alege o zi disponibilă.' };
  }
  if (wait === BOOKING_WAIT.TIME || step === CONVERSATION_STEPS.WAITING_FOR_TIME) {
    return { kind: PENDING_ACTIONS.TIME, prompt: 'Alege o oră liberă.' };
  }
  if (wait === BOOKING_WAIT.DATE_TIME || step === CONVERSATION_STEPS.WAITING_FOR_DATE_TIME) {
    return { kind: PENDING_ACTIONS.DATE_TIME, prompt: 'Alege ziua și ora.' };
  }
  if (wait === BOOKING_WAIT.CONFIRMATION
    || step === CONVERSATION_STEPS.CONFIRMING
    || step === CONVERSATION_STEPS.WAITING_FOR_CONFIRMATION) {
    return { kind: PENDING_ACTIONS.CONFIRM, prompt: 'Confirmă sau anulează programarea.' };
  }
  if (wait === BOOKING_WAIT.CLARIFICATION || step === CONVERSATION_STEPS.WAITING_FOR_CLARIFICATION) {
    return { kind: PENDING_ACTIONS.CLARIFY, prompt: 'Clarifică data sau ora.' };
  }

  return null;
}

/**
 * @param {Object} params
 */
export async function persistPendingAction({
  businessId,
  rawPhone,
  pending,
  step = null,
  extraContext = {},
  requestId = null,
}) {
  return setConversationStep({
    businessId,
    rawPhone,
    step: step || undefined,
    context: {
      ...extraContext,
      pending_action: pending
        ? { ...pending, at: new Date().toISOString() }
        : null,
    },
    mergeContext: true,
    requestId,
  });
}

/**
 * Deterministic interpretation of a reply while a pending_action is open.
 * Returns a partial TurnExtract-shaped object, or null to fall through.
 *
 * @param {Object} params
 * @param {string} params.textBody
 * @param {import('../db/conversationStateService.js').ConversationState | null | undefined} params.convState
 * @param {import('../db/employeeService.js').Employee[]} params.employees
 * @param {Array<{ id?: string, name?: string }>} [params.services]
 * @returns {{ action: string, employee_id?: string | null, employee_name?: string | null, service_id?: string | null, service_name?: string | null, confidence: string, source: string } | null}
 */
export function interpretPendingActionReply({
  textBody,
  convState,
  employees,
  services = [],
}) {
  const pending = readPendingAction(convState);
  if (!pending?.kind) return null;

  const text = String(textBody || '').trim();
  if (!text) return null;

  if (
    pending.kind === PENDING_ACTIONS.EMPLOYEE_CONFIRM
    || pending.kind === PENDING_ACTIONS.EMPLOYEE_SELECT
  ) {
    if (isExplicitCancelReply(text)) {
      return { action: 'abort', confidence: 'high', source: 'pending_action' };
    }

    // "Care listă?" while awaiting staff — re-send employee picker, never services FAQ.
    if (looksLikeListClarification(text)) {
      return { action: 'reprompt_employee', confidence: 'high', source: 'pending_action' };
    }

    // Merge offered / option names so alternate picks resolve even if the
    // live catalog query is briefly empty (still prefer real employee rows).
    const catalog = [...employees];
    const seen = new Set(catalog.map((e) => e.id));
    if (pending.offered?.id && !seen.has(pending.offered.id)) {
      catalog.push({
        id: pending.offered.id,
        name: pending.offered.name || 'Specialist',
        active: true,
      });
      seen.add(pending.offered.id);
    }
    for (const name of pending.options || []) {
      if (!name || catalog.some((e) => String(e.name).toLowerCase() === String(name).toLowerCase())) {
        continue;
      }
      catalog.push({ id: `name:${String(name).toLowerCase()}`, name: String(name), active: true });
    }

    // Numeric pick against the employee last_menu (1 = first specialist).
    const lastMenu = readLastMenu(convState);
    if (lastMenu?.kind === 'employee' && lastMenu.options?.length) {
      const choiceId = resolveNumberedOption(text, lastMenu.options);
      if (choiceId === BOOKING_PREFIXES.ANY_EMPLOYEE) {
        return {
          action: 'select_employee',
          employee_id: 'any',
          employee_name: null,
          confidence: 'high',
          source: 'pending_action',
        };
      }
      if (choiceId?.startsWith(BOOKING_PREFIXES.EMPLOYEE)) {
        const id = choiceId.slice(BOOKING_PREFIXES.EMPLOYEE.length);
        const emp = catalog.find((e) => e.id === id);
        return {
          action: 'select_employee',
          employee_id: id,
          employee_name: emp?.name || null,
          confidence: 'high',
          source: 'pending_action',
        };
      }
    }

    if (
      pending.kind === PENDING_ACTIONS.EMPLOYEE_CONFIRM
      && isAffirmativeReply(text)
      && !/\b(?:la|cu)\s+[a-zăâîșț]{2,}/i.test(text)
    ) {
      const offered = pending.offered;
      const emp = offered?.id
        ? catalog.find((e) => e.id === offered.id)
        : (offered?.name
          ? catalog.find((e) => String(e.name).toLowerCase() === String(offered.name).toLowerCase())
          : null);
      if (emp && !String(emp.id).startsWith('name:')) {
        return {
          action: 'accept_offer',
          employee_id: emp.id,
          employee_name: emp.name,
          confidence: 'high',
          source: 'pending_action',
        };
      }
    }

    const staff = resolveStaffMentionFromText(text, catalog, services);
    if (staff.employee_id && !String(staff.employee_id).startsWith('name:')) {
      return {
        action: 'select_employee',
        employee_id: staff.employee_id,
        employee_name: staff.employee_name,
        confidence: 'high',
        source: 'pending_action',
      };
    }
    if (staff.employee_name) {
      const byName = catalog.find(
        (e) => String(e.name).toLowerCase() === String(staff.employee_name).toLowerCase()
          && !String(e.id).startsWith('name:'),
      );
      if (byName) {
        return {
          action: 'select_employee',
          employee_id: byName.id,
          employee_name: byName.name,
          confidence: 'high',
          source: 'pending_action',
        };
      }
      // Alternate name not in catalog — execute grounding will refuse politely.
      return {
        action: 'book',
        employee_id: null,
        employee_name: staff.employee_name,
        confidence: 'high',
        source: 'pending_action',
      };
    }

    // Short "Stefan" without la/cu while awaiting employee choice.
    const bare = text.replace(/^[\s.,!?:;-]+|[\s.,!?:;-]+$/g, '');
    if (/^[A-Za-zăâîșțĂÂÎȘȚ-]{2,40}$/.test(bare)) {
      const byBare = resolveStaffMentionFromText(`la ${bare}`, catalog, services);
      if (byBare.employee_id && !String(byBare.employee_id).startsWith('name:')) {
        return {
          action: 'select_employee',
          employee_id: byBare.employee_id,
          employee_name: byBare.employee_name,
          confidence: 'high',
          source: 'pending_action',
        };
      }
      if (byBare.employee_name) {
        const hit = catalog.find(
          (e) => String(e.name).toLowerCase() === String(byBare.employee_name).toLowerCase()
            && !String(e.id).startsWith('name:'),
        );
        if (hit) {
          return {
            action: 'select_employee',
            employee_id: hit.id,
            employee_name: hit.name,
            confidence: 'high',
            source: 'pending_action',
          };
        }
        return {
          action: 'book',
          employee_id: null,
          employee_name: byBare.employee_name,
          confidence: 'high',
          source: 'pending_action',
        };
      }
    }
  }

  return null;
}
