/** @typedef {import('../db/businessService.js').Business} Business */

/**
 * @typedef {Object} DayHours
 * @property {string} open  "HH:mm"
 * @property {string} close "HH:mm"
 */

/** Placeholder for the Admin hours editor only — NEVER used to generate live slots. */
export const DEFAULT_BUSINESS_HOURS = /** @type {Record<string, DayHours | null>} */ ({
  '0': null,
  '1': { open: '09:00', close: '18:00' },
  '2': { open: '09:00', close: '18:00' },
  '3': { open: '09:00', close: '18:00' },
  '4': { open: '09:00', close: '18:00' },
  '5': { open: '09:00', close: '18:00' },
  '6': { open: '10:00', close: '14:00' },
});

const ALL_CLOSED_HOURS = /** @type {Record<string, DayHours | null>} */ ({
  '0': null,
  '1': null,
  '2': null,
  '3': null,
  '4': null,
  '5': null,
  '6': null,
});

export const WEEKDAY_LABELS_RO = {
  '0': 'Duminică',
  '1': 'Luni',
  '2': 'Marți',
  '3': 'Miercuri',
  '4': 'Joi',
  '5': 'Vineri',
  '6': 'Sâmbătă',
};

/**
 * Returns explicitly configured hours from Admin, or null if unset.
 * Do NOT use for AI when null — that would invent a schedule.
 * @param {Business} business
 * @returns {Record<string, DayHours | null> | null}
 */
export function getConfiguredBusinessHours(business) {
  const raw = business.booking_settings?.business_hours;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (!keys.length) return null;
  return /** @type {Record<string, DayHours | null>} */ (raw);
}

/**
 * Human-readable schedule for WhatsApp / AI context.
 * @param {Record<string, DayHours | null>} hours
 * @returns {string}
 */
export function formatBusinessHoursText(hours) {
  const lines = [];
  for (const day of ['1', '2', '3', '4', '5', '6', '0']) {
    const label = WEEKDAY_LABELS_RO[/** @type {keyof typeof WEEKDAY_LABELS_RO} */ (day)];
    const h = hours[day];
    if (!h || !h.open || !h.close) {
      lines.push(`- ${label}: închis`);
    } else {
      lines.push(`- ${label}: ${h.open} – ${h.close}`);
    }
  }
  return lines.join('\n');
}

/**
 * Parses booking_settings with sensible defaults.
 * @param {Business} business
 */
export function getBookingConfig(business) {
  const settings = business.booking_settings ?? {};

  const fromBusiness = Array.isArray(business.services) && business.services.length
    ? business.services
    : null;

  const adminHours = getConfiguredBusinessHours(business);

  return {
    slotIntervalMinutes: Number(settings.slot_interval_minutes ?? 30),
    bookingHorizonDays: Number(settings.booking_horizon_days ?? 7),
    bufferMinutes: Number(settings.buffer_minutes ?? 0),
    hoursConfigured: Boolean(adminHours),
    businessHours: /** @type {Record<string, DayHours | null>} */ (adminHours ?? ALL_CLOSED_HOURS),
    services: /** @type {{ id: string; name: string; duration_minutes: number; price_ron?: number | null }[]} */ (
      (fromBusiness ?? settings.services ?? []).filter((s) => Number(s?.duration_minutes) > 0)
    ),
  };
}

/**
 * @param {Date} date
 * @param {string} timezone
 * @returns {number} 0=Sunday … 6=Saturday in business timezone
 */
export function getWeekdayInTimezone(date, timezone) {
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: timezone })
    .format(date)
    .toLowerCase();

  const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  return map[/** @type {keyof typeof map} */ (weekday.slice(0, 3))] ?? 0;
}

/**
 * @param {Date} date
 * @param {string} timezone
 * @returns {string} YYYY-MM-DD
 */
export function formatDateKey(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * @param {Date} date
 * @param {string} timezone
 * @returns {string} HH:mm
 */
export function formatTime(date, timezone) {
  return new Intl.DateTimeFormat('ro-RO', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/**
 * @param {Date} date
 * @param {string} timezone
 * @returns {string} e.g. "Marți, 4 Aug. — Ora 09:00"
 */
export function formatSlotLabel(date, timezone) {
  const weekday = new Intl.DateTimeFormat('ro-RO', {
    timeZone: timezone,
    weekday: 'long',
  }).format(date);

  const day = new Intl.DateTimeFormat('ro-RO', {
    timeZone: timezone,
    day: 'numeric',
  }).format(date);

  const month = new Intl.DateTimeFormat('ro-RO', {
    timeZone: timezone,
    month: 'short',
  }).format(date);

  const time = formatTime(date, timezone);
  const weekdayCap = weekday.charAt(0).toUpperCase() + weekday.slice(1);

  const monthCap = month.charAt(0).toUpperCase() + month.slice(1).replace(/\.$/, '');
  // e.g. "Luni, 10 Aug. — Ora 11:30"
  return `${weekdayCap}, ${day} ${monthCap}. — Ora ${time}`;
}

/**
 * Numbered emoji for WhatsApp lists (1–10).
 * @param {number} indexZeroBased
 */
export function slotNumberEmoji(indexZeroBased) {
  const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  return emojis[indexZeroBased] ?? `${indexZeroBased + 1}.`;
}

/**
 * @param {string} dateKey YYYY-MM-DD
 * @param {number} days
 * @returns {string} YYYY-MM-DD
 */
export function addCalendarDays(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + Number(days || 0)));
  const yyyy = utc.getUTCFullYear();
  const mm = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(utc.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Builds a UTC Date from local date + HH:mm in a given IANA timezone.
 * @param {string} dateKey YYYY-MM-DD
 * @param {string} timeHHmm HH:mm
 * @param {string} timezone
 * @returns {Date}
 */
export function localToUtc(dateKey, timeHHmm, timezone) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = timeHHmm.split(':').map(Number);

  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(utcGuess);

  const read = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const tzAsUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  );

  const offsetMs = tzAsUtc - utcGuess.getTime();
  return new Date(utcGuess.getTime() - offsetMs);
}

/**
 * Encodes slot start for WhatsApp list row id (max 200 chars).
 * @param {Date} start
 * @param {string} timezone
 */
export function encodeSlotId(start, timezone) {
  const key = formatDateKey(start, timezone).replace(/-/g, '');
  const time = formatTime(start, timezone).replace(':', '');
  return `slot_${key}_${time}`;
}

/**
 * @param {string} slotId
 * @param {string} timezone
 * @returns {Date | null}
 */
export function decodeSlotId(slotId, timezone) {
  const match = /^slot_(\d{8})_(\d{4})$/.exec(slotId);
  if (!match) return null;

  const [, ymd, hm] = match;
  const dateKey = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  const time = `${hm.slice(0, 2)}:${hm.slice(2, 4)}`;
  return localToUtc(dateKey, time, timezone);
}

/**
 * @param {Date} aStart
 * @param {Date} aEnd
 * @param {Date} bStart
 * @param {Date} bEnd
 */
export function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}
