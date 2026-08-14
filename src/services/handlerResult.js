/**
 * Unified backend handler envelope — the only facts the UI/AI may present.
 *
 * @typedef {'SUCCESS' | 'MISSING_INFO' | 'ERROR' | 'CHAT'} HandlerStatus
 *
 * @typedef {Object} HandlerResult
 * @property {HandlerStatus} status
 * @property {string | null} action_performed
 * @property {Record<string, unknown>} data
 * @property {string | null} next_required_step
 * @property {string} user_message_template_key
 * @property {{ kind: string, options: { id: string, title: string }[] } | null} [menu]
 * @property {{ url: string, title: string } | null} [calendar_cta]
 */

/**
 * @param {Partial<HandlerResult> & { status: HandlerStatus, user_message_template_key: string }} partial
 * @returns {HandlerResult}
 */
export function handlerResult(partial) {
  return {
    status: partial.status,
    action_performed: partial.action_performed ?? null,
    data: partial.data ?? {},
    next_required_step: partial.next_required_step ?? null,
    user_message_template_key: partial.user_message_template_key,
    menu: partial.menu ?? null,
    calendar_cta: partial.calendar_cta ?? null,
  };
}
