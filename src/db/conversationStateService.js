import { supabase } from '../config/supabase.js';
import { logError } from './loggerService.js';
import { toE164 } from '../utils/phone.js';

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

/** @type {boolean | null} */
let tableAvailable = null;

const COLUMNS = 'id, business_id, client_phone, current_step, context_data, updated_at';

/**
 * @returns {Promise<boolean>}
 */
async function isTableAvailable() {
  if (tableAvailable !== null) return tableAvailable;

  const { error } = await supabase.from('conversation_states').select('id').limit(1);
  if (!error) {
    tableAvailable = true;
    return true;
  }
  if (/does not exist|PGRST205|Could not find the table/i.test(error.message ?? '') || error.code === '42P01') {
    tableAvailable = false;
    return false;
  }
  tableAvailable = true;
  return true;
}

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

  if (!clientPhone || !(await isTableAvailable())) {
    return idle;
  }

  const { data, error } = await supabase
    .from('conversation_states')
    .select(COLUMNS)
    .eq('business_id', businessId)
    .eq('client_phone', clientPhone)
    .maybeSingle();

  if (error) {
    if (/does not exist|PGRST205/i.test(error.message ?? '')) {
      tableAvailable = false;
      return idle;
    }
    await logError({
      message: 'getOrCreateConversationState read failed',
      source: 'database',
      businessId,
      phoneNumber: clientPhone,
      error,
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
  if (!clientPhone || !(await isTableAvailable())) return null;

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
      details: { step },
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
  if (keepLastIntent) {
    const existing = await getOrCreateConversationState(businessId, rawPhone);
    lastIntent = existing.context_data?.last_booking_intent ?? null;
  }

  return setConversationStep({
    businessId,
    rawPhone,
    step: CONVERSATION_STEPS.IDLE,
    context: lastIntent ? { last_booking_intent: lastIntent } : {},
    mergeContext: false,
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
