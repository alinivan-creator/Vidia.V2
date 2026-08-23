/**
 * Client UI language — ephemeral session only (no permanent lock).
 *
 * - Default / corrupt / unknown → Romanian (`ro`)
 * - Active choice lives in `context_data.session_language` for the conversation TTL
 * - Free-text English can set/keep `en` when no explicit choice exists yet
 * - Legacy language-gate fields are scrubbed and never block booking
 */

import {
  normalizeUiLang,
  resolveTurnLanguage,
} from './uiI18n.js';

/**
 * @param {unknown} value
 * @returns {'ro' | 'en'}
 */
export function normalizeClientLanguage(value) {
  return normalizeUiLang(value);
}

/**
 * Resolve UI language for this turn — inbound message language wins over session default.
 * @param {string} [text]
 * @param {unknown} [_previous]
 * @param {Record<string, unknown> | null | undefined} [context]
 * @returns {'ro' | 'en'}
 */
export function resolveClientLanguage(text = '', _previous = null, context = null) {
  return resolveTurnLanguage(text, context);
}

/**
 * @param {string} [text]
 * @param {unknown} [_previous]
 * @param {Record<string, unknown> | null | undefined} [context]
 * @returns {'ro' | 'en'}
 */
export function detectClientLanguage(text = '', _previous = null, context = null) {
  return resolveClientLanguage(text, _previous, context);
}

/**
 * Clear rolled-back permanent language-gate residue. Does not clear
 * `session_language` (ephemeral choice for the active conversation).
 *
 * @param {Record<string, unknown> | null | undefined} ctx
 * @returns {Record<string, unknown>}
 */
export function languageScrubPatch(ctx) {
  const hasSticky =
    ctx?.language_confirmed != null
    || ctx?.language_gate_pending != null
    || ctx?.deferred_inbound != null
    || (ctx?.client_language != null
      && ctx.client_language !== 'ro'
      && ctx.client_language !== 'en'
      && ctx.client_language !== null);

  if (!hasSticky) return {};

  return {
    language_confirmed: null,
    language_gate_pending: null,
    deferred_inbound: null,
    client_language: null,
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} ctx
 */
export function needsLanguageScrub(ctx) {
  return Object.keys(languageScrubPatch(ctx)).length > 0;
}
