import { getConfiguredBusinessHours, formatBusinessHoursText } from '../utils/datetime.js';
import { unknownInfoClientMessage } from '../utils/workingHours.js';
import { WA_DIVIDER, waField, waJoin, waTitle } from '../utils/waCopy.js';
import { t } from '../utils/uiI18n.js';

/** @typedef {import('../db/businessService.js').Business} Business */

/**
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
function normalizeHttpUrl(raw) {
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
 * @typedef {Object} BusinessContactInfo
 * @property {string | null} phone
 * @property {string | null} email
 * @property {string | null} address
 * @property {string | null} hours
 * @property {string | null} mapsUrl
 * @property {string | null} website
 */

/**
 * First non-empty string among Admin contact fields.
 * @param {...unknown} values
 * @returns {string | null}
 */
function pickStr(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Extracts contact details from `businesses.booking_settings.contact` (zero-code config).
 * @param {Business} business
 * @returns {BusinessContactInfo}
 */
export function getBusinessContactInfo(business) {
  const settings = /** @type {Record<string, unknown>} */ (business.booking_settings ?? {});
  const contact = /** @type {Record<string, string | undefined>} */ (settings.contact ?? {});

  return {
    phone: pickStr(contact.phone),
    email: pickStr(contact.email),
    address: pickStr(contact.address),
    hours: pickStr(contact.hours),
    mapsUrl: pickStr(
      contact.maps_url,
      contact.mapsUrl,
      contact.location_link,
      contact.link_locatie,
      contact.link_locație,
      contact.google_maps_url,
      settings.maps_url,
      settings.mapsUrl,
      settings.location_link,
    ),
    website: pickStr(
      contact.website,
      contact.website_url,
      contact.url,
      contact.link,
      contact.custom_url,
      settings.website,
      settings.website_url,
      settings.custom_url,
    ),
  };
}

/**
 * Formats contact info as a WhatsApp-ready text block.
 * @param {Business} business
 * @param {'ro' | 'en'} [lang]
 * @returns {string}
 */
export function formatContactMessage(business, lang = 'ro') {
  const uiLang = lang === 'en' ? 'en' : 'ro';
  const info = getBusinessContactInfo(business);
  const hasAny =
    info.phone || info.email || info.address || info.website || info.mapsUrl || info.hours;

  const structuredHours = getConfiguredBusinessHours(business);
  if (!hasAny && !structuredHours) {
    return waJoin(waTitle(business.name), '', unknownInfoClientMessage(uiLang));
  }

  const parts = [
    waTitle(business.name),
    '',
    waField(t('contactPhone', uiLang), info.phone),
    waField('Email', info.email),
    waField(t('contactAddress', uiLang), info.address),
  ];

  if (structuredHours) {
    parts.push(
      '',
      WA_DIVIDER,
      '',
      waTitle(t('contactHours', uiLang)),
      formatBusinessHoursText(structuredHours, uiLang).replace(/^- /gm, ''),
    );
  } else if (info.hours) {
    parts.push('', waField(t('contactHours', uiLang), info.hours));
  }

  // Maps / website as markdown in the body — never depend on Twilio Content CTA
  // (Content API create has hung in production and left Contact silent).
  const mapsUrl = normalizeHttpUrl(info.mapsUrl)
    || (info.address
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(info.address)}`
      : null);
  const website = normalizeHttpUrl(info.website);
  if (mapsUrl || website) {
    parts.push('', WA_DIVIDER, '');
    if (mapsUrl) {
      parts.push(`${t('seeLocation', uiLang)}: [${t('mapsAnchor', uiLang)}](${mapsUrl})`);
    }
    if (website && website !== mapsUrl) {
      parts.push(`Website: [link](${website})`);
    }
  }

  parts.push('', t('contactFooter', uiLang));
  return waJoin(...parts);
}
