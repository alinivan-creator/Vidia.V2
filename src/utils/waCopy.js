/**
 * Visual tokens for WhatsApp message templates (presentation only).
 * Keep copy calm, spaced, and brand-neutral — no barber-only icons.
 */

export const WA_DIVIDER = '────────';

/**
 * @param {...(string | null | undefined | false)} parts
 * @returns {string}
 */
export function waJoin(...parts) {
  return parts
    .filter((p) => p != null && p !== false)
    .join('\n');
}

/**
 * Section title: one bold line.
 * @param {string} title
 * @param {string} [emoji]
 */
export function waTitle(title, emoji = '') {
  const e = emoji ? `${emoji} ` : '';
  return `${e}*${title}*`;
}

/**
 * Labeled value block (label bold, value on next line).
 * @param {string} label
 * @param {string | null | undefined} value
 */
export function waField(label, value) {
  const v = value != null ? String(value).trim() : '';
  if (!v) return '';
  return `*${label}*\n${v}`;
}

/**
 * Compact meta line under a service name.
 * @param {{ price_ron?: unknown, duration_minutes?: unknown }} s
 */
export function waServiceMeta(s) {
  const bits = [];
  if (s.price_ron != null && s.price_ron !== '') bits.push(`${s.price_ron} LEI`);
  if (s.duration_minutes) bits.push(`${s.duration_minutes} min`);
  return bits.length ? bits.join(' · ') : '';
}

/**
 * Footer hint row (actions / capabilities).
 * @param {string[]} items
 */
export function waFooter(items) {
  const clean = items.map((i) => String(i).trim()).filter(Boolean);
  if (!clean.length) return '';
  return clean.join('  ·  ');
}
