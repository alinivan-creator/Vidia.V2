/** @typedef {import('../db/businessService.js').Business} Business */

/** WhatsApp caps quick-reply button titles at 20 characters. */
export const ENTRY_BUTTON_TITLE_MAX = 20;

/**
 * Strip leading emoji / pictographs and normalize for label matching.
 * @param {string} title
 */
export function normalizeEntryMenuLabel(title) {
  return String(title || '')
    .replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[›»‹«]/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {Business} business
 * @returns {{ id: string, label?: string, action?: string }[]}
 */
export function getEntryMenuButtons(business) {
  return Array.isArray(business?.menu_buttons) ? business.menu_buttons : [];
}

/**
 * True when the id belongs to the tenant entry menu (always valid, even after last_menu was cleared).
 * @param {Business} business
 * @param {string | null | undefined} choiceId
 */
export function isEntryMenuChoiceId(business, choiceId) {
  const id = String(choiceId ?? '').trim();
  if (!id) return false;
  return getEntryMenuButtons(business).some((btn) => btn.id === id);
}

/**
 * Resolve an entry-menu button id from a tap payload and/or the visible label WhatsApp echoed in Body.
 * @param {Business} business
 * @param {{ choiceId?: string | null, textBody?: string | null }} params
 * @returns {string | null}
 */
export function resolveEntryMenuChoiceId(business, { choiceId = null, textBody = null } = {}) {
  const buttons = getEntryMenuButtons(business);
  if (!buttons.length) return null;

  const id = String(choiceId ?? '').trim();
  if (id && buttons.some((btn) => btn.id === id)) return id;

  const raw = String(textBody ?? '').trim();
  if (!raw) return null;

  const nBody = normalizeEntryMenuLabel(raw);

  for (const btn of buttons) {
    const label = String(btn.label || '');
    const nLabel = normalizeEntryMenuLabel(label);
    const nSent = normalizeEntryMenuLabel(label.slice(0, ENTRY_BUTTON_TITLE_MAX));
    if (!nLabel && !nSent) continue;
    if (nBody === nLabel || nBody === nSent) return btn.id;
    if (nLabel && (nBody.startsWith(nLabel) || nLabel.startsWith(nBody))) return btn.id;
    if (nSent && (nBody.startsWith(nSent) || nSent.startsWith(nBody))) return btn.id;
  }

  return null;
}

/**
 * Entry menu options as sent to WhatsApp (title truncated to 20 chars).
 * @param {Business} business
 */
export function entryMenuSendOptions(business) {
  return getEntryMenuButtons(business).slice(0, 3).map((btn) => ({
    id: btn.id,
    title: String(btn.label || '').slice(0, ENTRY_BUTTON_TITLE_MAX),
  }));
}
