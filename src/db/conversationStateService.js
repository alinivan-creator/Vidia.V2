import { supabase } from '../config/supabase.js';
import { logError } from './loggerService.js';
import { toE164 } from '../utils/phone.js';
import { isTableAvailable, reportQueryFailure } from './schemaHealth.js';

/**
 * @typedef {'IDLE' | 'CHOOSING_SERVICE' | 'CHOOSING_EMPLOYEE' | 'SELECTING_SLOT' | 'ASKING_NAME' | 'CONFIRMING' | 'OFFERING_RESUME' | 'MODIFYING' | 'RESCHEDULING' | 'CONFIRMING_CANCEL' | 'MODIFIED'} ConversationStep
 */

/**
 * @typedef {Object} ConversationState
 * @property {string} id
 * @property {string} business_id
 * @property {string} client_phone
 * @property {ConversationStep} current_step
 * @property {Record<string, unknown>} context_data
 * @property {string} updated_at
 */

export const CONVERSATION_STEPS = /** @type {const} */ ({
  IDLE: 'IDLE',
  CHOOSING_SERVICE: 'CHOOSING_SERVICE',
  CHOOSING_EMPLOYEE: 'CHOOSING_EMPLOYEE',
  SELECTING_SLOT: 'SELECTING_SLOT',
  ASKING_NAME: 'ASKING_NAME',
  CONFIRMING: 'CONFIRMING',
  OFFERING_RESUME: 'OFFERING_RESUME',
  MODIFYING: 'MODIFYING',
  RESCHEDULING: 'RESCHEDULING',
  CONFIRMING_CANCEL: 'CONFIRMING_CANCEL',
  MODIFIED: 'MODIFIED',
});

const COLUMNS = 'id, business_id, client_phone, current_step, context_data, updated_at';

/**
 * @param {string} businessId
 * @param {string} rawPhone
 * @returns {Promise<ConversationState>}
 */
export async function getOrCreateConversationState(businessId, rawPhone) {
  const clientPhone = toE164(rawPhone);
  const idle = /** @type {ConversationState} */ ({
    id: 'local',
    business_id: businessId,
    client_phone: clientPhone,
    current_step: CONVERSATION_STEPS.IDLE,
    context_data: {},
    updated_at: new Date().toISOString(),
  });

  if (!clientPhone || !(await isTableAvailable('conversation_states'))) {
    return idle;
  }

  const { data, error } = await supabase
    .from('conversation_states')
    .select(COLUMNS)
    .eq('business_id', businessId)
    .eq('client_phone', clientPhone)
    .maybeSingle();

  if (error) {
    await reportQueryFailure({
      table: 'conversation_states',
      error,
      op: 'getOrCreateConversationState',
      businessId,
    });
    return idle;
  }

  if (data) {
    return /** @type {ConversationState} */ (data);
  }

  const { data: inserted, error: insertError } = await supabase
    .from('conversation_states')
    .insert({
      business_id: businessId,
      client_phone: clientPhone,
      current_step: CONVERSATION_STEPS.IDLE,
      context_data: {},
    })
    .select(COLUMNS)
    .single();

  if (insertError) {
    await logError({
      message: 'getOrCreateConversationState insert failed',
      source: 'database',
      businessId,
      phoneNumber: clientPhone,
      error: insertError,
    });
    return idle;
  }

  return /** @type {ConversationState} */ (inserted);
}

/**
 * @param {Object} params
 * @param {string} params.businessId
 * @param {string} params.rawPhone
 * @param {ConversationStep | string} params.step
 * @param {Record<string, unknown>} [params.context]
 * @param {boolean} [params.mergeContext]
 * @param {string | null} [params.requestId]
 * @returns {Promise<ConversationState | null>}
 */
export async function setConversationStep({
  businessId,
  rawPhone,
  step,
  context = {},
  mergeContext = true,
  requestId = null,
}) {
  const clientPhone = toE164(rawPhone);
  if (!clientPhone || !(await isTableAvailable('conversation_states'))) return null;

  const existing = await getOrCreateConversationState(businessId, clientPhone);
  const nextContext = mergeContext
    ? { ...(existing.context_data ?? {}), ...context }
    : context;

  const { data, error } = await supabase
    .from('conversation_states')
    .upsert(
      {
        business_id: businessId,
        client_phone: clientPhone,
        current_step: step,
        context_data: nextContext,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'business_id,client_phone' },
    )
    .select(COLUMNS)
    .single();

  if (error) {
    await logError({
      message: 'setConversationStep failed',
      source: 'database',
      businessId,
      requestId,
      phoneNumber: clientPhone,
      error,
      details: { step, table: 'conversation_states' },
    });
    return null;
  }

  return /** @type {ConversationState} */ (data);
}

/**
 * Resets conversation to IDLE. Preserves last_booking_intent memory by default.
 * @param {Object} params
 * @param {string} params.businessId
 * @param {string} params.rawPhone
 * @param {boolean} [params.keepLastIntent]
 * @param {string | null} [params.requestId]
 */
export async function resetConversationState({
  businessId,
  rawPhone,
  keepLastIntent = true,
  requestId = null,
}) {
  let lastIntent = null;
  let recentTurns = null;
  if (keepLastIntent) {
    const existing = await getOrCreateConversationState(businessId, rawPhone);
    lastIntent = existing.context_data?.last_booking_intent ?? null;
    recentTurns = existing.context_data?.recent_turns ?? null;
  }

  return setConversationStep({
    businessId,
    rawPhone,
    step: CONVERSATION_STEPS.IDLE,
    context: {
      ...(lastIntent ? { last_booking_intent: lastIntent } : {}),
      ...(Array.isArray(recentTurns) && recentTurns.length ? { recent_turns: recentTurns } : {}),
    },
    mergeContext: false,
    requestId,
  });
}

/**
 * Appends a short turn to conversation memory (last 8 messages).
 */
export async function appendRecentTurn({
  businessId,
  rawPhone,
  role = 'user',
  text,
  requestId = null,
}) {
  const existing = await getOrCreateConversationState(businessId, rawPhone);
  const prev = Array.isArray(existing.context_data?.recent_turns)
    ? existing.context_data.recent_turns
    : [];
  const recent_turns = [
    ...prev,
    { role: role === 'assistant' ? 'assistant' : 'user', text: String(text ?? '').slice(0, 240) },
  ].slice(-8);

  return setConversationStep({
    businessId,
    rawPhone,
    step: existing.current_step,
    context: { recent_turns },
    mergeContext: true,
    requestId,
  });
}

/**
 * @param {string | null | undefined} step
 */
export function isBookingFlowStep(step) {
  return (
    step === CONVERSATION_STEPS.CHOOSING_SERVICE ||
    step === CONVERSATION_STEPS.CHOOSING_EMPLOYEE ||
    step === CONVERSATION_STEPS.SELECTING_SLOT ||
    step === CONVERSATION_STEPS.ASKING_NAME ||
    step === CONVERSATION_STEPS.CONFIRMING
  );
}

/**
 * @param {string | null | undefined} step
 */
export function isModificationFlowStep(step) {
  return (
    step === CONVERSATION_STEPS.MODIFYING ||
    step === CONVERSATION_STEPS.RESCHEDULING ||
    step === CONVERSATION_STEPS.CONFIRMING_CANCEL ||
    step === CONVERSATION_STEPS.MODIFIED
  );
}
