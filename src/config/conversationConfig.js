/** @typedef {import('../db/businessService.js').Business} Business */

export const DEFAULT_PENDING_TTL_MINUTES = 5;

/**
 * Default conversation policy shown in Admin. Admins can replace it anytime;
 * the live DB value is read on every WhatsApp turn.
 */
export const DEFAULT_CONVERSATION_LOGIC = `Când clientul cere o zi sau o oră (ex. „luni la 12”, „vineri 10”), tratează mesajul ca programare nouă pe acel interval — nu îi cere să scrie cuvântul „programare” și nu îl trimiți înapoi la meniu.

Dacă are o oră reținută (hold expirat) și spune da / aceeași / reia, vrea să reia confirmarea pe acel slot.
Dacă cere altă zi/oră, e programare nouă — ignoră hold-ul vechi.

Nu inventa ore libere. Disponibilitatea se verifică în calendar.
Întrebări (preț, program, contact, servicii) → răspunde din datele afacerii.
Anulare/reprogramare a unei programări deja confirmate → anulează / reprogramare.`;

/**
 * @param {Business | null | undefined} business
 * @returns {number} minutes, 1–60
 */
export function getPendingTtlMinutes(business) {
  const n = Number(business?.booking_settings?.pending_ttl_minutes);
  if (!Number.isFinite(n)) return DEFAULT_PENDING_TTL_MINUTES;
  return Math.min(60, Math.max(1, Math.round(n)));
}

/**
 * @param {Business | null | undefined} business
 */
export function getConversationLogic(business) {
  const raw = business?.booking_settings?.conversation_logic;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return DEFAULT_CONVERSATION_LOGIC;
}
