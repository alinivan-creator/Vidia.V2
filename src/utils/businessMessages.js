/**
 * Welcome / confirmation / GDPR helpers for WhatsApp messaging.
 * Legal URLs + confirmation_message live in booking_settings (zero-migration).
 * Presentation only — facts come from Admin / booking engine.
 */

import { getBusinessContactInfo } from '../services/contactService.js';
import { WA_DIVIDER, waField, waFooter, waJoin, waTitle } from './waCopy.js';

/** @typedef {import('../db/businessService.js').Business} Business */

/** Short Maps CTA — WhatsApp shows only this label, not the full URL. */
export const MAPS_ANCHOR_LABEL = 'Pornește spre locație';

/** Visible link text after the colon — keep tiny so the confirmation stays compact. */
export const MAPS_SHORT_LINK_LABEL = 'hartă';

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
      || `Bun venit la *${business.name}*.`;

  const disclosure = alreadyDisclosesAi(base)
    ? ''
    : `Sunt *asistentul virtual* al *${business.name}*.`;

  const { termsUrl, gdprUrl } = getMessagingSettings(business);
  const legalLink = (gdprUrl || termsUrl || '').trim().replace(/\s+/g, '');
  const policyBit = legalLink
    ? ` în conformitate cu [politica de confidențialitate](${legalLink})`
    : ' în conformitate cu politica de confidențialitate';

  const privacyBlock = waJoin(
    waTitle('Confidențialitate'),
    `Prelucrăm datele tale${policyBit}.`,
    'Prin continuarea conversației și trimiterea detaliilor, ești de acord cu acest lucru.',
  );

  return waJoin(
    privacyBlock,
    '',
    disclosure || null,
    disclosure ? '' : null,
    base,
    '',
    WA_DIVIDER,
    waFooter(['Programări', 'Orar', 'Contact']),
  );
}

/**
 * HTTPS URL suitable for WhatsApp CTA buttons (no javascript:, no bare host).
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
export function normalizeHttpUrl(raw) {
  const trimmed = String(raw || '').trim().replace(/\s+/g, '');
  if (!trimmed) return null;
  const withProto = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed.replace(/^\/\//, '')}`;
  try {
    const u = new URL(withProto);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Compact URL buttons from Admin contact fields (maps + website). Max 2.
 * URLs stay off the message body so WhatsApp does not unfurl a huge preview.
 *
 * @param {Business} business
 * @returns {{ title: string, url: string }[]}
 */
export function buildContactLinkButtons(business) {
  const info = getBusinessContactInfo(business);
  /** @type {{ title: string, url: string }[]} */
  const buttons = [];

  const maps = buildBusinessMapsLink(business);
  const mapsUrl = normalizeHttpUrl(maps?.url);
  if (mapsUrl) {
    buttons.push({ title: 'Vezi locația', url: mapsUrl });
  }

  const website = normalizeHttpUrl(info.website);
  if (website && website !== mapsUrl) {
    buttons.push({ title: 'Website', url: website });
  }

  return buttons.slice(0, 2);
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
  const configured = normalizeHttpUrl(info.mapsUrl);

  if (configured) {
    return { url: configured, address };
  }

  if (!address) return null;

  const query = encodeURIComponent(address);
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

  const url = String(maps.url).trim().replace(/\s+/g, '');
  if (!url) return null;

  return {
    url,
    address: maps.address,
    // Markdown keeps the body short: WhatsApp renders the label, not the long Maps URL.
    messageLine: `${MAPS_ANCHOR_LABEL}: [${MAPS_SHORT_LINK_LABEL}](${url})`,
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
  const body = waJoin(
    waTitle('Confidențialitate'),
    'Folosim datele pentru această programare și pentru comunicări utile (inclusiv SMS).',
    'Poți opri SMS-urile scriind *stop sms*.',
  );
  if (link) {
    return waJoin(body, '', `[Detalii termeni / GDPR](${link})`);
  }
  return waJoin(body, '', 'Pentru detalii, scrie *contact*.');
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
 * @param {string} [params.calendarLine]
 * @param {string} [params.mapsLine]
 * @param {boolean} [params.includeGdpr=false]
 * @returns {string}
 */
export function buildBookingConfirmationMessage({
  business,
  serviceName,
  slotLabel,
  clientName = '',
  calendarLine = '',
  mapsLine = undefined,
  includeGdpr = false,
}) {
  const { confirmationMessage } = getMessagingSettings(business);
  // Explicit mapsLine (including '') wins — do not auto-append a duplicate Maps markdown.
  const resolvedMapsLine = mapsLine === undefined
    ? (buildMapsInviteLine(business)?.messageLine || '')
    : String(mapsLine || '');

  const custom = confirmationMessage
    ? confirmationMessage
      .replace(/\{\{service\}\}/gi, serviceName)
      .replace(/\{\{datetime\}\}/gi, slotLabel)
      .replace(/\{\{name\}\}/gi, clientName || '')
      .replace(/\{\{business\}\}/gi, business.name)
    : waJoin(
      'Ne vedem curând.',
      waFooter(['*reprogramare*', '*anulează*']),
    );

  const parts = [
    waTitle('Programare confirmată'),
    '',
    waField('Client', clientName || null),
    waField('Serviciu', serviceName),
    waField('Când', slotLabel),
  ].filter(Boolean);

  if (calendarLine || resolvedMapsLine) {
    parts.push('');
    if (calendarLine) parts.push(calendarLine.trim());
    if (resolvedMapsLine) parts.push(resolvedMapsLine.trim());
  }

  parts.push('', WA_DIVIDER, '', custom);
  if (includeGdpr) {
    parts.push('', buildGdprNote(business));
  }
  return parts.join('\n');
}
