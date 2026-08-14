/** @typedef {import('../db/businessService.js').Business} Business */

export const DEFAULT_PENDING_TTL_MINUTES = 5;

/**
 * Default conversation policy shown in Admin. Admins can replace it anytime;
 * the live DB value is read on every WhatsApp turn.
 */
export const DEFAULT_CONVERSATION_LOGIC = `Backend-ul decide tot: disponibilitate, program Admin, rezervări, reprogramări. AI-ul și șabloanele doar formatează JSON-ul returnat de backend. Nu confirma programări, nu inventa ore libere și nu evalua disponibilitatea din cap.

Când clientul dă serviciu + dată/oră, backend-ul execută direct (fără meniuri intermediare). Dacă lipsește ceva sau slotul e ocupat, backend-ul cere doar ce lipsește sau oferă alternative reale din calendar.`;

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
 * Live AI must call this only after loadAiTenantContext (fresh row by business_id).
 */
export function getConversationLogic(business) {
  const raw = business?.booking_settings?.conversation_logic;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return DEFAULT_CONVERSATION_LOGIC;
}
