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
 * Extracts contact details from `businesses.booking_settings.contact` (zero-code config).
 * @param {Business} business
 * @returns {BusinessContactInfo}
 */
export function getBusinessContactInfo(business) {
  const contact = /** @type {Record<string, string | undefined>} */ (
    business.booking_settings?.contact ?? {}
  );

  return {
    phone: contact.phone ?? null,
    email: contact.email ?? null,
    address: contact.address ?? null,
    hours: contact.hours ?? null,
    mapsUrl: contact.maps_url ?? contact.mapsUrl ?? null,
    website: contact.website ?? null,
  };
}

/**
 * Formats contact info as a WhatsApp-ready text block.
 * @param {Business} business
 * @returns {string}
 */
export function formatContactMessage(business) {
  const info = getBusinessContactInfo(business);
  const hasAny =
    info.phone || info.email || info.address || info.website || info.mapsUrl || info.hours;

  const structuredHours = getConfiguredBusinessHours(business);
  if (!hasAny && !structuredHours) {
    return waJoin(waTitle(business.name), '', unknownInfoClientMessage());
  }

  const parts = [
    waTitle(business.name),
    '',
    waField('Telefon', info.phone),
    waField('Email', info.email),
    waField('Adresă', info.address),
    waField('Website', info.website),
  ];

  if (structuredHours) {
    parts.push(
      '',
      WA_DIVIDER,
      '',
      waTitle('Program'),
      formatBusinessHoursText(structuredHours).replace(/^- /gm, ''),
    );
  } else if (info.hours) {
    parts.push('', waField('Program', info.hours));
  }

  parts.push('', 'Suntem aici pentru tine.');
  return waJoin(...parts);
}
