/**
 * Welcome / confirmation / GDPR helpers for WhatsApp messaging.
 * Legal URLs + confirmation_message live in booking_settings (zero-migration).
 * Presentation only — facts come from Admin / booking engine.
 */

import { getBusinessContactInfo } from '../services/contactService.js';
import { WA_DIVIDER, waField, waFooter, waJoin, waTitle } from './waCopy.js';
import { t, normalizeUiLang } from './uiI18n.js';

/** @typedef {import('../db/businessService.js').Business} Business */

/** Short Maps CTA — WhatsApp shows only this label, not the full URL. */
export const MAPS_ANCHOR_LABEL = 'Pornește spre locație';

/** Visible link text after the colon — keep tiny so the confirmation stays compact. */
export const MAPS_SHORT_LINK_LABEL = 'hartă';

/**
 * @param {'ro' | 'en'} [lang]
 */
export function mapsAnchorLabel(lang = 'ro') {
  return lang === 'en' ? t('mapsAnchor', 'en') : MAPS_ANCHOR_LABEL;
}

/**
 * @param {'ro' | 'en'} [lang]
 */
export function mapsShortLinkLabel(lang = 'ro') {
  return lang === 'en' ? t('mapsShort', 'en') : MAPS_SHORT_LINK_LABEL;
}

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
export function alreadyDisclosesAi(text) {
  const n = String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return /asistent (virtual|inteligent)|virtual assistant|ai assistant|sunt (un )?ai\b|\bai\b.*asistent|asistent.*\bai\b|speaking with (an )?ai/.test(n);
}

/**
 * Whether this conversation thread still needs the mandatory first-contact
 * AI + GDPR disclosure (cleared only on session TTL / restart session).
 * @param {Record<string, unknown> | null | undefined} ctx
 */
export function needsAiDisclosure(ctx) {
  return ctx?.ai_disclosed !== true;
}

/** Default public privacy policy (WhatsApp markdown link). */
export const DEFAULT_PRIVACY_POLICY_URL = 'https://www.getvidia.ro/confidentialitate';

/**
 * Resolve privacy / terms URL for outbound legal copy.
 * @param {Business} business
 * @returns {string}
 */
export function resolvePrivacyPolicyUrl(business) {
  const { termsUrl, gdprUrl } = getMessagingSettings(business);
  const raw = (gdprUrl || termsUrl || DEFAULT_PRIVACY_POLICY_URL).trim().replace(/\s+/g, '');
  return normalizeHttpUrl(raw) || DEFAULT_PRIVACY_POLICY_URL;
}

/**
 * WhatsApp URL-button label for the privacy policy (keeps the URL off the body
 * so WhatsApp does not unfurl the site OG card / logo preview).
 * @param {'ro' | 'en'} [lang]
 */
export function privacyPolicyButtonTitle(lang = 'ro') {
  return normalizeUiLang(lang) === 'en' ? 'Privacy policy' : 'Confidențialitate';
}

/**
 * Compact mandatory AI + short GDPR note for the first bot reply on a new thread.
 * Intentionally has NO raw URL in the body — callers attach a URL button instead.
 * @param {Business} business
 * @param {'ro' | 'en'} [lang]
 */
export function buildMandatoryAiDisclosure(business, lang = 'ro') {
  const uiLang = normalizeUiLang(lang);
  const name = business?.name || (uiLang === 'en' ? 'this business' : 'această locație');

  if (uiLang === 'en') {
    return waJoin(
      `You are speaking with the *virtual AI assistant* of *${name}*.`,
      'We process your data in line with our *privacy policy*. By continuing, you agree to this.',
    );
  }

  return waJoin(
    `Vorbești cu *asistentul virtual AI* al *${name}*.`,
    'Prelucrăm datele tale în conformitate cu *politica de confidențialitate*. Prin continuarea conversației, ești de acord cu acest lucru.',
  );
}

/**
 * Attach disclosure once at the top of the first outbound reply.
 * @param {string} body
 * @param {Business} business
 * @param {'ro' | 'en'} [lang]
 */
export function withMandatoryAiDisclosure(body, business, lang = 'ro') {
  const text = String(body ?? '').trim();
  const note = buildMandatoryAiDisclosure(business, lang);
  if (!text) return note;
  if (alreadyDisclosesAi(text)) return text;
  return waJoin(note, '', text);
}

/**
 * First-contact welcome with mandatory AI transparency.
 * Uses business.welcome_message and clearly identifies the bot as AI.
 *
 * @param {Business} business
 * @param {'ro' | 'en'} [lang]
 * @returns {string}
 */
export function buildAiTransparencyWelcome(business, lang = 'ro') {
  const uiLang = normalizeUiLang(lang);
  // EN sessions must not reuse a Romanian Admin welcome_message.
  const base = uiLang === 'en'
    ? `Welcome to *${business.name}*.`
    : ((business.welcome_message && business.welcome_message.trim())
      || `Bun venit la *${business.name}*.`);

  const disclosure = buildMandatoryAiDisclosure(business, uiLang);
  const footer = uiLang === 'en'
    ? waFooter(['Booking', 'Hours', 'Contact'])
    : waFooter(['Programări', 'Orar', 'Contact']);

  return waJoin(
    disclosure,
    '',
    base,
    '',
    WA_DIVIDER,
    footer,
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
 * @param {'ro' | 'en'} [lang]
 * @returns {{ url: string; messageLine: string; address: string | null } | null}
 */
export function buildMapsInviteLine(business, lang = 'ro') {
  const uiLang = normalizeUiLang(lang);
  const maps = buildBusinessMapsLink(business);
  if (!maps?.url) return null;

  const url = String(maps.url).trim().replace(/\s+/g, '');
  if (!url) return null;

  const anchor = mapsAnchorLabel(uiLang);
  const short = mapsShortLinkLabel(uiLang);

  return {
    url,
    address: maps.address,
    // Markdown keeps the body short: WhatsApp renders the label, not the long Maps URL.
    messageLine: `${anchor}: [${short}](${url})`,
  };
}

/**
 * Discreet GDPR / privacy note — send as a *separate* WhatsApp message.
 * @param {Business} business
 * @param {'ro' | 'en'} [lang]
 * @returns {string}
 */
export function buildGdprNote(business, lang = 'ro') {
  const uiLang = normalizeUiLang(lang);
  const { termsUrl, gdprUrl } = getMessagingSettings(business);
  const link = (gdprUrl || termsUrl || '').trim().replace(/\s+/g, '');
  const body = waJoin(
    waTitle(t('gdprTitle', uiLang)),
    t('gdprBody', uiLang),
    t('gdprStopSms', uiLang),
  );
  if (link) {
    return waJoin(body, '', `[${t('gdprLink', uiLang)}](${link})`);
  }
  return waJoin(body, '', t('gdprContact', uiLang));
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
 * @param {'ro' | 'en'} [params.lang='ro']
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
  lang = 'ro',
}) {
  const uiLang = normalizeUiLang(lang);
  const { confirmationMessage } = getMessagingSettings(business);
  // Explicit mapsLine (including '') wins — do not auto-append a duplicate Maps markdown.
  const resolvedMapsLine = mapsLine === undefined
    ? (buildMapsInviteLine(business, uiLang)?.messageLine || '')
    : String(mapsLine || '');

  // Admin custom confirmation is usually Romanian — use bilingual default when EN.
  const custom = (confirmationMessage && uiLang !== 'en')
    ? confirmationMessage
      .replace(/\{\{service\}\}/gi, serviceName)
      .replace(/\{\{datetime\}\}/gi, slotLabel)
      .replace(/\{\{name\}\}/gi, clientName || '')
      .replace(/\{\{business\}\}/gi, business.name)
    : waJoin(
      t('bookedSeeYou', uiLang),
      waFooter([t('bookedFooterReschedule', uiLang), t('bookedFooterCancel', uiLang)]),
    );

  const parts = [
    waTitle(t('bookedTitle', uiLang)),
    '',
    waField(t('labelClient', uiLang), clientName || null),
    waField(t('labelService', uiLang), serviceName),
    waField(t('labelWhen', uiLang), slotLabel),
  ].filter(Boolean);

  if (calendarLine || resolvedMapsLine) {
    parts.push('');
    if (calendarLine) parts.push(calendarLine.trim());
    if (resolvedMapsLine) parts.push(resolvedMapsLine.trim());
  }

  parts.push('', WA_DIVIDER, '', custom);
  if (includeGdpr) {
    parts.push('', buildGdprNote(business, uiLang));
  }
  return parts.join('\n');
}
