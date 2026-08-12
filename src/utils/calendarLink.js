import { googleEnv } from '../config/google.js';

/**
 * @typedef {Object} CalendarEventInput
 * @property {string} title
 * @property {string | Date} startIso
 * @property {string | Date} endIso
 * @property {string} [description]
 * @property {string} [location]
 */

/**
 * Lightweight contact read (avoids importing services from utils).
 * @param {import('../db/businessService.js').Business} business
 */
function readContact(business) {
  const contact = /** @type {Record<string, string | undefined>} */ (
    business.booking_settings?.contact ?? {}
  );
  return {
    phone: contact.phone ?? null,
    address: contact.address ?? null,
    website: contact.website ?? null,
  };
}

/**
 * @param {string | Date} value
 * @returns {Date}
 */
function toDate(value) {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Compact UTC stamp for Google Calendar `dates` param: YYYYMMDDTHHmmssZ
 * @param {string | Date} value
 * @returns {string}
 */
export function toGoogleCalendarUtc(value) {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return '';
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/**
 * Escape text for iCalendar property values.
 * @param {string} text
 * @returns {string}
 */
function escapeIcsText(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\n|\r/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

/**
 * Fold long ICS lines per RFC 5545 (§3.1).
 * @param {string} line
 * @returns {string}
 */
function foldIcsLine(line) {
  const limit = 75;
  if (line.length <= limit) return line;
  const parts = [];
  parts.push(line.slice(0, limit));
  let rest = line.slice(limit);
  while (rest.length > 0) {
    parts.push(` ${rest.slice(0, limit - 1)}`);
    rest = rest.slice(limit - 1);
  }
  return parts.join('\r\n');
}

/**
 * Google Calendar “Add event” template URL (works on Android; usable on iOS via browser).
 * @param {CalendarEventInput} event
 * @returns {string}
 */
export function buildGoogleCalendarUrl(event) {
  const start = toGoogleCalendarUtc(event.startIso);
  const end = toGoogleCalendarUtc(event.endIso);
  if (!start || !end) return '';

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title || 'Programare',
    dates: `${start}/${end}`,
  });

  if (event.description) params.set('details', event.description);
  if (event.location) params.set('location', event.location);

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * Builds a VEVENT / VCALENDAR body for Apple Calendar & most calendar apps.
 * @param {CalendarEventInput} event
 * @returns {string}
 */
export function buildIcsContent(event) {
  const start = toDate(event.startIso);
  const end = toDate(event.endIso);
  const stamp = new Date();
  const uid = `vidia-${start.getTime()}-${Math.abs(hashString(event.title || 'event'))}@vidia`;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//VIDIA//Booking//RO',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${toGoogleCalendarUtc(stamp)}`,
    `DTSTART:${toGoogleCalendarUtc(start)}`,
    `DTEND:${toGoogleCalendarUtc(end)}`,
    `SUMMARY:${escapeIcsText(event.title || 'Programare')}`,
  ];

  if (event.description) {
    lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  }
  if (event.location) {
    lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

/**
 * Public HTTPS URL that serves a downloadable .ics (best for Apple Calendar).
 * @param {CalendarEventInput & { baseUrl: string }} params
 * @returns {string}
 */
export function buildIcsDownloadUrl({ baseUrl, title, startIso, endIso, description = '', location = '' }) {
  const root = String(baseUrl || '').replace(/\/$/, '');
  if (!root) return '';

  const params = new URLSearchParams({
    title: title || 'Programare',
    start: toDate(startIso).toISOString(),
    end: toDate(endIso).toISOString(),
  });
  if (description) params.set('details', description);
  if (location) params.set('location', location);

  return `${root}/calendar/event.ics?${params.toString()}`;
}

/**
 * Prefer hosted .ics (universal / Apple) when PUBLIC_WEBHOOK_BASE_URL is set;
 * otherwise Google Calendar template URL.
 * @param {CalendarEventInput} event
 * @returns {{ url: string; kind: 'ics' | 'google' }}
 */
export function buildAddToCalendarLink(event) {
  const baseUrl = googleEnv.webhookBaseUrl;
  if (baseUrl) {
    const icsUrl = buildIcsDownloadUrl({ baseUrl, ...event });
    if (icsUrl) return { url: icsUrl, kind: 'ics' };
  }

  return { url: buildGoogleCalendarUrl(event), kind: 'google' };
}

/** Label text inside markdown brackets (no surrounding []). */
export const CALENDAR_ANCHOR_TEXT = '📅 Adaugă în calendar';

/** @deprecated use CALENDAR_ANCHOR_TEXT — kept for older call sites */
export const CALENDAR_ANCHOR_LABEL = `[${CALENDAR_ANCHOR_TEXT}]`;

/** Twilio WhatsApp URL button title — max 20 characters. */
export const CALENDAR_CTA_BUTTON_TITLE = 'Adaugă în calendar';

/**
 * Contiguous markdown calendar link: [📅 Adaugă în calendar](url)
 * @param {string} url
 * @returns {string}
 */
export function formatCalendarAnchorMarkdown(url) {
  const clean = String(url ?? '').trim().replace(/\s+/g, '');
  if (!clean) return '';
  return `[${CALENDAR_ANCHOR_TEXT}](${clean})`;
}

/**
 * Builds calendar event fields + WhatsApp-ready invite from a booking.
 *
 * Prefer Twilio CTA button for calendar (no body duplicate).
 * `markdownLine` is for text-only fallback: [📅 Adaugă în calendar](url)
 *
 * @param {Object} params
 * @param {import('../db/businessService.js').Business} params.business
 * @param {string} params.serviceName
 * @param {string | Date} params.startIso
 * @param {string | Date} params.endIso
 * @returns {{
 *   url: string;
 *   kind: 'ics' | 'google';
 *   title: string;
 *   anchorLabel: string;
 *   buttonTitle: string;
 *   messageLine: string;
 *   markdownLine: string;
 * }}
 */
export function buildBookingCalendarInvite({ business, serviceName, startIso, endIso }) {
  const contact = readContact(business);
  const title = `${serviceName || 'Programare'} — ${business.name}`;
  const description = [
    `Programare la ${business.name}`,
    `Serviciu: ${serviceName || 'Programare'}`,
    contact.phone ? `Telefon: ${contact.phone}` : null,
    contact.website ? `Website: ${contact.website}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const event = {
    title,
    startIso,
    endIso,
    description,
    location: contact.address || '',
  };

  const { url, kind } = buildAddToCalendarLink(event);
  const cleanUrl = String(url || '').trim().replace(/\s+/g, '');
  // Empty messageLine when using CTA — avoids duplicate "Adaugă în calendar" in body + button
  const markdownLine = cleanUrl ? formatCalendarAnchorMarkdown(cleanUrl) : '';

  return {
    url: cleanUrl,
    kind,
    title,
    anchorLabel: CALENDAR_ANCHOR_LABEL,
    buttonTitle: CALENDAR_CTA_BUTTON_TITLE,
    messageLine: '',
    markdownLine,
  };
}

/**
 * Simple stable hash for ICS UID uniqueness (not cryptographic).
 * @param {string} text
 * @returns {number}
 */
function hashString(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  }
  return h;
}
