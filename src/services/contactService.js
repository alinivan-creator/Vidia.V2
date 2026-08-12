import { getConfiguredBusinessHours, formatBusinessHoursText } from '../utils/datetime.js';

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
  const lines = [`📞 *Contact — ${business.name}*`, ''];

  if (info.phone) lines.push(`Telefon: ${info.phone}`);
  if (info.email) lines.push(`Email: ${info.email}`);
  if (info.address) lines.push(`Adresă: ${info.address}`);
  if (info.website) lines.push(`Website: ${info.website}`);
  if (info.mapsUrl) lines.push(`Hartă: ${info.mapsUrl}`);

  const structuredHours = getConfiguredBusinessHours(business);
  if (structuredHours) {
    lines.push('', '*Program:*');
    lines.push(
      formatBusinessHoursText(structuredHours).replace(/^- /gm, ''),
    );
  } else if (info.hours) {
    lines.push(`Program: ${info.hours}`);
  }

  if (lines.length <= 2) {
    return (
      `📞 *Contact — ${business.name}*\n\n` +
      'Datele de contact nu sunt configurate încă. Te rugăm să revii în curând.'
    );
  }

  lines.push('', 'Suntem aici să te ajutăm!');
  return lines.join('\n');
}
