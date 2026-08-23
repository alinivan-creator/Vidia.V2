import { getConfiguredBusinessHours, formatBusinessHoursText } from '../utils/datetime.js';
import { unknownInfoClientMessage } from '../utils/workingHours.js';
import { WA_DIVIDER, waField, waJoin, waTitle } from '../utils/waCopy.js';

/** @typedef {import('../db/businessService.js').Business} Business */

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
  const en = lang === 'en';
  const info = getBusinessContactInfo(business);
  const hasAny =
    info.phone || info.email || info.address || info.website || info.mapsUrl || info.hours;

  const structuredHours = getConfiguredBusinessHours(business);
  if (!hasAny && !structuredHours) {
    return waJoin(waTitle(business.name), '', unknownInfoClientMessage(lang));
  }

  const parts = [
    waTitle(business.name),
    '',
    waField(en ? 'Phone' : 'Telefon', info.phone),
    waField('Email', info.email),
    waField(en ? 'Address' : 'Adresă', info.address),
  ];

  if (structuredHours) {
    parts.push(
      '',
      WA_DIVIDER,
      '',
      waTitle(en ? 'Hours' : 'Program'),
      formatBusinessHoursText(structuredHours).replace(/^- /gm, ''),
    );
  } else if (info.hours) {
    parts.push('', waField(en ? 'Hours' : 'Program', info.hours));
  }

  parts.push('', en ? 'We are here for you.' : 'Suntem aici pentru tine.');
  return waJoin(...parts);
}
