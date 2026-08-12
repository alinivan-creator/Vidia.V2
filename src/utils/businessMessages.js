/**
 * Welcome / confirmation / GDPR helpers for WhatsApp messaging.
 * Legal URLs + confirmation_message live in booking_settings (zero-migration).
 */

import { getBusinessContactInfo } from '../services/contactService.js';

/** @typedef {import('../db/businessService.js').Business} Business */

/** Friendly Maps CTA label (without brackets) — used inside markdown `[…](url)`. */
export const MAPS_ANCHOR_LABEL = '🚗 Pornește spre locație';

/**
 * @param {Business} business
 * @returns {{ confirmationMessage: string; termsUrl: string | null; gdprUrl: string | null }}
 */
export function getMessagingSettings(business) {
  const settings = /** @type {Record<string, unknown>} */ (business.booking_settings ?? {});
  const confirmationMessage =
    (typeof business.confirmation_message === 'string' && business.confirmation_message.trim())
      ? business.confirmation_message.trim()
      : (typeof settings.confirmation_message === 'string' ? settings.confirmation_message.trim() : '');

  const termsUrl =
    (typeof business.terms_url === 'string' && business.terms_url.trim())
      ? business.terms_url.trim()
      : (typeof settings.terms_url === 'string' ? settings.terms_url.trim() : null);

  const gdprUrl =
    (typeof business.gdpr_url === 'string' && business.gdpr_url.trim())
      ? business.gdpr_url.trim()
      : (typeof settings.gdpr_url === 'string' ? settings.gdpr_url.trim() : null)
        || (typeof settings.privacy_url === 'string' ? settings.privacy_url.trim() : null);

  return {
    confirmationMessage: confirmationMessage || '',
    termsUrl: termsUrl || null,
    gdprUrl: gdprUrl || null,
  };
}

/**
 * True if text already discloses AI / virtual assistant.
 * @param {string} text
 */
function alreadyDisclosesAi(text) {
  const n = String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return /asistent (virtual|inteligent)|sunt (un )?ai\b|\bai\b.*asistent|asistent.*\bai\b|virtual assistant/.test(n);
}

/**
 * First-contact welcome with mandatory AI transparency.
 * Uses business.welcome_message and clearly identifies the bot as AI.
 *
 * @param {Business} business
 * @returns {string}
 */
export function buildAiTransparencyWelcome(business) {
  const base =
    (business.welcome_message && business.welcome_message.trim())
      || `Bun venit la *${business.name}*!`;

  const disclosure = alreadyDisclosesAi(base)
    ? ''
    : `👋 Sunt *asistentul virtual inteligent (AI)* al *${business.name}*.\n\n`;

  const { termsUrl, gdprUrl } = getMessagingSettings(business);
  const legalLink = gdprUrl || termsUrl;
  const legalLine = legalLink
    ? `\n\n_Continuând conversația, ești de acord cu prelucrarea datelor pentru programări. Detalii: ${legalLink}_`
    : '';

  return (
    `${disclosure}${base}` +
    `\n\nTe pot ajuta cu programări, reprogramări, anulări și informații.` +
    legalLine
  );
}

/**
 * Universal Google Maps URL for the business location.
 * Prefers Admin `maps_url`; otherwise builds a search link from the address.
 *
 * @param {Business} business
 * @returns {{ url: string; address: string | null } | null}
 */
export function buildBusinessMapsLink(business) {
  const info = getBusinessContactInfo(business);
  const address = info.address?.trim() || null;
  const configured = info.mapsUrl?.trim() || null;

  if (configured) {
    // Already a maps / geo URL from Admin
    return { url: configured, address };
  }

  if (!address) return null;

  const query = encodeURIComponent(address);
  // Works on Android (Google Maps) and iOS (Maps / browser → open in Maps)
  return {
    url: `https://www.google.com/maps/search/?api=1&query=${query}`,
    address,
  };
}

/**
 * WhatsApp line with masked Maps anchor (markdown link — no bare long URL dump).
 * @param {Business} business
 * @returns {{ url: string; messageLine: string; address: string | null } | null}
 */
export function buildMapsInviteLine(business) {
  const maps = buildBusinessMapsLink(business);
  if (!maps?.url) return null;

  // Keep URL on one line, no spaces/newlines between ] and (
  const url = String(maps.url).trim().replace(/\s+/g, '');
  if (!url) return null;

  return {
    url,
    address: maps.address,
    // WhatsApp markdown: [label](url) must be contiguous for a single blue link
    messageLine: `[${MAPS_ANCHOR_LABEL}](${url})`,
  };
}

/**
 * Discreet GDPR / privacy note — send as a *separate* WhatsApp message.
 * @param {Business} business
 * @returns {string}
 */
export function buildGdprNote(business) {
  const { termsUrl, gdprUrl } = getMessagingSettings(business);
  const link = (gdprUrl || termsUrl || '').trim().replace(/\s+/g, '');
  if (link) {
    // Mask legal URL — never dump bare URL alone under the note
    return (
      '_🔒 Confidențialitate (GDPR): folosim numele și telefonul doar pentru această programare._\n' +
      `[Detalii termeni / GDPR](${link})`
    );
  }
  return (
    '_🔒 Confidențialitate (GDPR): folosim numele și telefonul doar pentru această programare. ' +
    'Pentru detalii, scrie *contact*._'
  );
}

/**
 * Full WhatsApp confirmation body after a successful booking.
 * Keep focused on the appointment — GDPR is sent separately.
 *
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.serviceName
 * @param {string} params.slotLabel
 * @param {string} [params.clientName]
 * @param {string} [params.calendarLine] — optional `[📅 Adaugă în calendar](url)` (omit if CTA button used)
 * @param {string} [params.mapsLine] — `[🚗 Pornește spre locație](url)` single contiguous line
 * @param {boolean} [params.includeGdpr=false] — prefer false; send GDPR as its own message *before* confirmation
 * @returns {string}
 */
export function buildBookingConfirmationMessage({
  business,
  serviceName,
  slotLabel,
  clientName = '',
  calendarLine = '',
  mapsLine = '',
  includeGdpr = false,
}) {
  const { confirmationMessage } = getMessagingSettings(business);
  const nameLine = clientName ? `👤 ${clientName}\n` : '';
  const resolvedMapsLine = mapsLine || buildMapsInviteLine(business)?.messageLine || '';

  const custom = confirmationMessage
    ? confirmationMessage
      .replace(/\{\{service\}\}/gi, serviceName)
      .replace(/\{\{datetime\}\}/gi, slotLabel)
      .replace(/\{\{name\}\}/gi, clientName || '')
      .replace(/\{\{business\}\}/gi, business.name)
    : 'Ne vedem curând! Pentru modificare scrie *reprogramare*, pentru anulare *anulează*.';

  const parts = [
    '✅ *Programare confirmată!*',
    '',
    nameLine + `📋 ${serviceName}`,
    `🕐 ${slotLabel}`,
  ];

  // Links: calendar (if not using CTA) then maps — each on its own clean line
  if (calendarLine || resolvedMapsLine) {
    parts.push('');
    if (calendarLine) parts.push(calendarLine.trim());
    if (resolvedMapsLine) parts.push(resolvedMapsLine.trim());
  }

  parts.push('', custom);
  if (includeGdpr) {
    parts.push('', buildGdprNote(business));
  }
  return parts.join('\n');
}
