/**
 * Admin working hours — the only schedule the booking engine may use.
 * Never invents Mon–Fri 09:00–18:00. Unset hours = no slots, no Google, no confirm.
 */

import {
  formatDateKey,
  getConfiguredBusinessHours,
  getWeekdayInTimezone,
  localToUtc,
  WEEKDAY_LABELS_RO,
  getBookingConfig,
} from './datetime.js';

/** @typedef {import('../db/businessService.js').Business} Business */

/**
 * @param {Business | null | undefined} business
 * @returns {Record<string, { open: string, close: string } | null> | null}
 */
export function getAdminBusinessHours(business) {
  return getConfiguredBusinessHours(business);
}

/**
 * @param {Business | null | undefined} business
 */
export function hasConfiguredOpenDay(business) {
  const hours = getAdminBusinessHours(business);
  if (!hours) return false;
  return Object.values(hours).some((h) => Boolean(h && h.open && h.close));
}

/**
 * @param {Business} business
 * @param {Date} date
 */
export function getHoursForDate(business, date) {
  const hours = getAdminBusinessHours(business);
  const weekday = getWeekdayInTimezone(date, business.timezone);
  const dayName = WEEKDAY_LABELS_RO[/** @type {keyof typeof WEEKDAY_LABELS_RO} */ (String(weekday))]
    || 'ziua aleasă';
  if (!hours) {
    return { configured: false, open: false, dayHours: null, weekday, dayName };
  }
  const dayHours = hours[String(weekday)] ?? null;
  const open = Boolean(dayHours && dayHours.open && dayHours.close);
  return { configured: true, open, dayHours, weekday, dayName };
}

/**
 * Rejects a slot that falls on a closed day or outside Admin hours.
 * Does not touch Google Calendar.
 *
 * @param {Business} business
 * @param {Date | string} start
 * @param {Date | string} end
 * @returns {{ ok: true, reason: null, message: null } | { ok: false, reason: string, message: string }}
 */
export function assertWithinWorkingHours(business, start, end) {
  const startDate = start instanceof Date ? start : new Date(start);
  const endDate = end instanceof Date ? end : new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) {
    return {
      ok: false,
      reason: 'invalid_range',
      message: 'Intervalul de programare este invalid.',
    };
  }

  const info = getHoursForDate(business, startDate);
  if (!info.configured) {
    return {
      ok: false,
      reason: 'hours_unset',
      message:
        'Programul de lucru nu este configurat încă în Admin. Nu pot oferi sau confirma ore.',
    };
  }
  if (!info.open || !info.dayHours) {
    return {
      ok: false,
      reason: 'closed',
      message: `*${info.dayName}* suntem *închiși* (conform programului din Admin).`,
    };
  }

  const tz = business.timezone;
  const dateKey = formatDateKey(startDate, tz);
  const openUtc = localToUtc(dateKey, info.dayHours.open, tz);
  const closeUtc = localToUtc(dateKey, info.dayHours.close, tz);

  if (startDate < openUtc || endDate > closeUtc) {
    return {
      ok: false,
      reason: 'outside_hours',
      message:
        `*${info.dayName}* lucrăm *${info.dayHours.open}–${info.dayHours.close}*. ` +
        `Ora aleasă este în afara programului.`,
    };
  }

  return { ok: true, reason: null, message: null };
}

/**
 * Duration from the Admin catalog for this tenant — never a hardcoded 30 min guess.
 *
 * @param {Business} business
 * @param {{ id?: string, name?: string, duration_minutes?: number } | null | undefined} service
 * @returns {number | null}
 */
export function resolveServiceDurationMinutes(business, service) {
  if (!service) return null;
  const { services } = getBookingConfig(business);
  const match = services.find(
    (s) => (service.id && s.id === service.id) || (service.name && s.name === service.name),
  );
  const raw = match?.duration_minutes ?? service.duration_minutes;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function hoursUnsetClientMessage() {
  return 'Programul de lucru nu este setat în Admin (sau toate zilele sunt închise). Nu pot oferi ore de programare.';
}

/**
 * @param {string | null | undefined} serviceName
 */
export function durationMissingClientMessage(serviceName) {
  const label = serviceName ? `*${serviceName}*` : 'selectat';
  return `Serviciul ${label} nu are o durată validă în Admin. Nu pot genera sau confirma ore.`;
}
