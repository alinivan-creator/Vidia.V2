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
  WEEKDAY_LABELS_EN,
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
  if (weekday == null) {
    return { configured: Boolean(hours), open: false, dayHours: null, weekday: null, dayName: 'ziua aleasă' };
  }
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
export function assertWithinWorkingHours(business, start, end, lang = 'ro', now = new Date()) {
  const startDate = start instanceof Date ? start : new Date(start);
  const endDate = end instanceof Date ? end : new Date(end);
  const en = lang === 'en';
  const clock = now instanceof Date ? now : new Date();
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) {
    return {
      ok: false,
      reason: 'invalid_range',
      message: en ? 'That time range is not valid.' : 'Intervalul de programare este invalid.',
    };
  }

  const info = getHoursForDate(business, startDate);
  const weekdayKey = info.weekday != null ? String(info.weekday) : null;
  const dayName = en && weekdayKey
    ? (WEEKDAY_LABELS_EN[/** @type {keyof typeof WEEKDAY_LABELS_EN} */ (weekdayKey)] || info.dayName)
    : info.dayName;
  if (startDate.getTime() < clock.getTime() - 60_000) {
    return {
      ok: false,
      reason: 'past',
      message: en
        ? 'That time is in the past. Please choose a future day and time.'
        : 'Ora aleasă a trecut. Alege o zi și o oră din *viitor* — ex: *luni la 12:30*.',
    };
  }
  if (!info.configured) {
    return {
      ok: false,
      reason: 'hours_unset',
      message: en
        ? 'Unfortunately I cannot offer booking hours right now.'
        : 'Din păcate nu vă pot oferi ore de programare momentan.',
    };
  }
  if (!info.open || !info.dayHours) {
    return {
      ok: false,
      reason: 'closed',
      message: en ? `*${dayName}* we are *closed*.` : `*${dayName}* suntem *închiși*.`,
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
      message: en
        ? `*${dayName}* we are open *${info.dayHours.open}–${info.dayHours.close}*. That time is outside working hours.`
        : `*${dayName}* lucrăm *${info.dayHours.open}–${info.dayHours.close}*. Ora aleasă este în afara programului.`,
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
  return 'Din păcate nu vă pot oferi ore de programare momentan.';
}

/**
 * Unknown business fact (parking, prices extras, etc.). Never mentions Admin.
 */
export function unknownInfoClientMessage() {
  return 'Nu dețin această informație, din păcate nu vă pot răspunde la această întrebare.';
}

/**
 * @param {string | null | undefined} serviceName
 */
export function durationMissingClientMessage(serviceName) {
  return 'Din păcate nu pot confirma această programare momentan.';
}
