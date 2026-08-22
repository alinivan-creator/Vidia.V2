/**
 * Optional first-contact language picker (RO / EN).
 * Disabled by default — enable with LANGUAGE_GATE_ENABLED=true or
 * booking_settings.language_gate_enabled on a tenant.
 */

/** @typedef {'ro' | 'en'} ClientLanguage */

export const LANGUAGE_BUTTONS = {
  RO: { id: 'lang_ro', title: 'Română' },
  EN: { id: 'lang_en', title: 'English' },
};

/**
 * @param {import('../db/businessService.js').Business | null | undefined} business
 */
export function isLanguageGateEnabled(business) {
  if (process.env.LANGUAGE_GATE_ENABLED === 'true') return true;
  const settings = /** @type {Record<string, unknown>} */ (business?.booking_settings ?? {});
  return settings.language_gate_enabled === true;
}

/**
 * Bilingual welcome + GDPR/SMS consent before language buttons.
 * @param {import('../db/businessService.js').Business} business
 */
export function buildLanguageGateWelcome(business) {
  const name = business?.name ? ` *${business.name}*` : '';
  return (
    `Bună! Sunt asistentul tău bazat pe inteligență artificială${name ? ` al${name}` : ''}.\n\n` +
    'Continuând, ești de acord cu prelucrarea datelor cu caracter personal pentru *programări* ' +
    'și *campanii de marketing prin SMS*.\n\n' +
    'Te rog să alegi limba / Please choose your language:'
  );
}

/**
 * @param {'ro' | 'en'} lang
 */
export function languageConfirmedAck(lang) {
  return lang === 'en'
    ? 'Great! How can I help you — booking, hours, or contact? Just write here.'
    : 'Perfect! Cu ce te pot ajuta — programare, orar sau contact? Scrie-mi aici.';
}

/**
 * Language fields preserved across booking resets / session TTL.
 * @param {Record<string, unknown> | null | undefined} ctx
 */
export function preservedLanguageContext(ctx) {
  if (!ctx || ctx.language_confirmed !== true) return {};
  const lang = ctx.client_language === 'en' ? 'en' : 'ro';
  return {
    client_language: lang,
    language_confirmed: true,
    language_gate_pending: false,
  };
}
