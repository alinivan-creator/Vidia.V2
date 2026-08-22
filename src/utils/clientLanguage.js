/**
 * Client language from the latest free-text turn. Default Romanian.
 */

/**
 * @param {string} text
 * @param {'ro' | 'en' | null | undefined} [previous]
 * @param {Record<string, unknown> | null | undefined} [context]
 * @returns {'ro' | 'en'}
 */
export function resolveClientLanguage(text, previous = null, context = null) {
  if (context?.language_confirmed === true) {
    return context.client_language === 'en' ? 'en' : 'ro';
  }
  return detectClientLanguage(text, previous);
}

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const EN_HINTS = [
  'hello', 'hi', 'hey', 'please', 'thanks', 'thank', 'want', 'book', 'booking',
  'haircut', 'beard', 'tomorrow', 'today', 'appointment', 'reschedule', 'cancel',
  'hours', 'price', 'prices', 'parking', 'women', 'kids', 'children', 'weather',
  'sorry', 'wrong',
];

const RO_HINTS = [
  'salut', 'buna', 'vreau', 'programare', 'tuns', 'barba', 'maine', 'azi',
  'reprogramare', 'anuleaza', 'orar', 'pret', 'parcare', 'femei', 'copii',
  'scuze', 'gresit', 'va rog', 'multumesc',
];

/**
 * @param {string} text
 * @param {'ro' | 'en' | null} [previous]
 * @returns {'ro' | 'en'}
 */
export function detectClientLanguage(text, previous = null) {
  const n = normalize(text);
  if (!n) return previous === 'en' ? 'en' : 'ro';
  const en = EN_HINTS.filter((w) => new RegExp(`\\b${w}\\b`).test(n)).length;
  const ro = RO_HINTS.filter((w) => new RegExp(`\\b${w}\\b`).test(n)).length;
  if (en > ro) return 'en';
  if (ro > en) return 'ro';
  return previous === 'en' ? 'en' : 'ro';
}
