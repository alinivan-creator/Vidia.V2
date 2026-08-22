/**
 * Client UI language helpers.
 *
 * Bilingual gate/i18n was rolled back for stability. Templates stay Romanian.
 * These helpers only normalize / scrub leftover session fields so old Supabase
 * rows never crash or lock the booking flow.
 */

/**
 * @param {unknown} value
 * @returns {'ro' | 'en'}
 */
export function normalizeClientLanguage(value) {
  if (value === 'en' || value === 'EN') return 'en';
  if (value === 'ro' || value === 'RO') return 'ro';
  return 'ro';
}

/**
 * Resolve presentation language. Always Romanian until a clean bilingual layer ships.
 * Corrupt / null / unknown session values must never block the flow.
 *
 * @param {string} [_text]
 * @param {unknown} [_previous]
 * @param {Record<string, unknown> | null | undefined} [_context]
 * @returns {'ro'}
 */
export function resolveClientLanguage(_text = '', _previous = null, _context = null) {
  return 'ro';
}

/**
 * @param {string} _text
 * @param {unknown} [_previous]
 * @returns {'ro'}
 */
export function detectClientLanguage(_text, _previous = null) {
  return 'ro';
}

/**
 * Fields left by the rolled-back language gate. Clearing them on inbound
 * unsticks numbers that tested English / got language_confirmed stuck.
 *
 * @param {Record<string, unknown> | null | undefined} ctx
 * @returns {Record<string, unknown>}
 */
export function languageScrubPatch(ctx) {
  const hasSticky =
    ctx?.language_confirmed != null
    || ctx?.language_gate_pending != null
    || ctx?.deferred_inbound != null
    || (ctx?.client_language != null && ctx.client_language !== 'ro' && ctx.client_language !== 'en');

  if (!hasSticky && (ctx?.client_language === 'ro' || ctx?.client_language == null)) {
    return {};
  }

  return {
    language_confirmed: null,
    language_gate_pending: null,
    deferred_inbound: null,
    client_language: 'ro',
  };
}

/**
 * True when context still carries experimental language-gate residue.
 * @param {Record<string, unknown> | null | undefined} ctx
 */
export function needsLanguageScrub(ctx) {
  return Object.keys(languageScrubPatch(ctx)).length > 0;
}
