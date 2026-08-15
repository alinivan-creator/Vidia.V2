/**
 * Phone helpers for Meta + Twilio WhatsApp formats.
 */

/**
 * Strips Twilio `whatsapp:` prefix and whitespace.
 * @param {string} value
 * @returns {string}
 */
export function stripWhatsAppPrefix(value) {
  return String(value ?? '')
    .trim()
    .replace(/^whatsapp:\s*/i, '')
    .replace(/\s+/g, '');
}

/**
 * Converts any phone format to E.164 for Supabase.
 * Removes `whatsapp:`, spaces, dashes — keeps digits with leading +.
 * @param {string} rawPhone Digits, +E.164, or whatsapp:+E.164
 * @returns {string} E.164, e.g. "+40712345678"
 */
export function toE164(rawPhone) {
  let digits = stripWhatsAppPrefix(rawPhone).replace(/\D/g, '');
  if (!digits) return '';
  // Romania local mobile: 07xxxxxxxx → 407xxxxxxxx
  if (/^07\d{8}$/.test(digits)) {
    digits = `40${digits.slice(1)}`;
  }
  return `+${digits}`;
}

/**
 * Digits only (legacy Meta format / internal recipient key).
 * @param {string} rawPhone
 * @returns {string}
 */
export function toMetaPhone(rawPhone) {
  return stripWhatsAppPrefix(rawPhone).replace(/\D/g, '');
}

/**
 * Twilio Messaging `from` / `to` format.
 * @param {string} rawPhone
 * @returns {string} e.g. "whatsapp:+40712345678"
 */
export function toTwilioWhatsApp(rawPhone) {
  return `whatsapp:${toE164(rawPhone)}`;
}

/**
 * Normalizes a stored business WhatsApp id / number for comparison.
 * Always digits-only so "whatsapp:+40 721...", "+40721...", "40721..." match.
 * @param {string | null | undefined} value
 * @returns {string}
 */
export function normalizeBusinessPhoneKey(value) {
  return toMetaPhone(value ?? '');
}
