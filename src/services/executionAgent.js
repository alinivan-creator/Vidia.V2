/**
 * Execution Agent — backend brain.
 * Consumes Dialogue Agent intent_actions, enforces catalog/hours/calendar SSOT,
 * writes Supabase, and returns structured JSON. Never calls an LLM.
 */

/**
 * @param {import('./handlerResult.js').HandlerResult} result
 */
export function toExecutionEnvelope(result) {
  const status = result?.status === 'SUCCESS'
    ? 'success'
    : result?.status === 'ERROR'
      ? 'error'
      : result?.status === 'MISSING_INFO'
        ? 'missing_info'
        : 'chat';
  return {
    status,
    next_step: result?.next_required_step ?? null,
    action: result?.action_performed ?? null,
    message: typeof result?.data?.client_message === 'string' ? result.data.client_message : null,
    data: result?.data ?? {},
  };
}

/**
 * @param {Parameters<typeof import('./turnExecute.js').executeTurn>[0]} params
 */
export async function runExecutionAgent(params) {
  const { executeTurn } = await import('./turnExecute.js');
  const handler = await executeTurn(params);
  return {
    handler,
    envelope: toExecutionEnvelope(handler),
  };
}
