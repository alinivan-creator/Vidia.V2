import { formatDateKey, localToUtc, getWeekdayInTimezone, addCalendarDays } from './datetime.js';

const WEEKDAY_MAP = {
  duminica: 0,
  luni: 1,
  marti: 2,
  miercuri: 3,
  joi: 4,
  vineri: 5,
  sambata: 6,
};

const MONTH_MAP = {
  ianuarie: 1,
  ian: 1,
  februarie: 2,
  feb: 2,
  martie: 3,
  mar: 3,
  aprilie: 4,
  apr: 4,
  mai: 5,
  iunie: 6,
  iun: 6,
  iulie: 7,
  iul: 7,
  august: 8,
  aug: 8,
  septembrie: 9,
  sept: 9,
  sep: 9,
  octombrie: 10,
  oct: 10,
  noiembrie: 11,
  nov: 11,
  decembrie: 12,
  dec: 12,
};

/**
 * @typedef {Object} ParsedDateTime
 * @property {string | null} dateKey
 * @property {string | null} timeHHmm
 * @property {Date | null} datetime
 * @property {boolean} hasDate
 * @property {boolean} hasTime
 */

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isValidYmd(year, month, day) {
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

function toDateKey(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function detectMeridian(normalized) {
  if (
    normalized.includes('dupa-amiaza')
    || normalized.includes('dupa amiaza')
    || normalized.includes('dupaamiaza')
    || /\b(seara|noaptea|\bpm\b|p\.m\.)\b/.test(normalized)
  ) {
    return 'pm';
  }
  if (normalized.includes('dimineata') || /\ba\.m\.\b/.test(normalized) || /\b\d{1,2}\s+am\b/.test(normalized)) {
    return 'am';
  }
  return null;
}

function hhmmToMinutes(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/**
 * @param {string} hhmm
 * @param {{ open?: string, close?: string } | null | undefined} dayHours
 */
export function isClockWithinDayHours(hhmm, dayHours) {
  if (!dayHours?.open || !dayHours?.close) return false;
  const t = hhmmToMinutes(hhmm);
  const open = hhmmToMinutes(dayHours.open);
  const close = hhmmToMinutes(dayHours.close);
  if (t == null || open == null || close == null) return false;
  return t >= open && t < close;
}

/**
 * 12h clock vs Admin hours. "la 5" with 09:00–18:00 → 17:00 because 05:00 is closed.
 *
 * @param {number} hour
 * @param {number} [minute]
 * @param {{ open?: string, close?: string } | null} [dayHours]
 * @returns {{ hour: number, minute: number }}
 */
export function coerceHourToOpenHours(hour, minute = 0, dayHours = null) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return { hour, minute };
  }
  if (hour >= 13) return { hour, minute };

  const amHour = hour === 12 ? 12 : hour;
  const pmHour = hour === 12 ? 12 : hour + 12;
  const am = `${pad2(amHour)}:${pad2(minute)}`;
  const pm = `${pad2(pmHour)}:${pad2(minute)}`;

  if (!dayHours?.open || !dayHours?.close) {
    if (hour >= 1 && hour <= 7) return { hour: hour + 12, minute };
    return { hour, minute };
  }

  const amOk = isClockWithinDayHours(am, dayHours);
  const pmOk = pmHour <= 23 && isClockWithinDayHours(pm, dayHours);
  if (!amOk && pmOk) return { hour: pmHour, minute };
  if (amOk && !pmOk) return { hour: amHour, minute };
  if (!amOk && !pmOk && pmHour <= 23 && pmHour !== amHour) return { hour: pmHour, minute };
  return { hour: amHour, minute };
}

/**
 * @param {string | null | undefined} hhmm
 * @param {{ open?: string, close?: string } | null} [dayHours]
 * @returns {string | null}
 */
export function coerceHHmmToOpenHours(hhmm, dayHours = null) {
  if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) return hhmm ?? null;
  const hour = Number(hhmm.slice(0, 2));
  const minute = Number(hhmm.slice(3, 5));
  const coerced = coerceHourToOpenHours(hour, minute, dayHours);
  return `${pad2(coerced.hour)}:${pad2(coerced.minute)}`;
}

/**
 * Explicit am/pm first; otherwise Admin hours; else 1–7 → afternoon.
 * @param {number} hour
 * @param {string | null} meridian
 * @param {{ open?: string, close?: string } | null} [dayHours]
 */
function applyMeridian(hour, meridian, dayHours = null) {
  if (meridian === 'pm' && hour > 0 && hour < 12) return hour + 12;
  if (meridian === 'am' && hour === 12) return 0;
  if (meridian === 'am') return hour;
  if (meridian === 'pm' && hour === 12) return 12;
  return coerceHourToOpenHours(hour, 0, dayHours).hour;
}

/**
 * Pull calendar dates like "17 aug" / "17.08" out before digits can be read as hours.
 * @returns {{ dateKey: string | null, rest: string }}
 */
function extractCalendarDate(normalized, timezone, now) {
  const today = formatDateKey(now, timezone);
  const thisYear = Number(today.slice(0, 4));

  const iso = normalized.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) {
    return { dateKey: iso[1], rest: normalized.replace(iso[1], ' ') };
  }

  const monthNames = Object.keys(MONTH_MAP).sort((a, b) => b.length - a.length).join('|');

  const named = normalized.match(
    new RegExp(`\\b(\\d{1,2})\\s+(${monthNames})\\.?\\s*(\\d{4})?\\b`),
  );
  if (named) {
    const day = Number(named[1]);
    const month = MONTH_MAP[named[2]];
    let year = named[3] ? Number(named[3]) : thisYear;
    if (isValidYmd(year, month, day)) {
      let dateKey = toDateKey(year, month, day);
      if (!named[3] && dateKey < today) {
        dateKey = toDateKey(year + 1, month, day);
      }
      return { dateKey, rest: normalized.replace(named[0], ' ') };
    }
  }

  const dmy = normalized.match(/\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    let year = dmy[3]
      ? (dmy[3].length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3]))
      : thisYear;
    if (isValidYmd(year, month, day)) {
      let dateKey = toDateKey(year, month, day);
      if (!dmy[3] && dateKey < today) {
        dateKey = toDateKey(year + 1, month, day);
      }
      return { dateKey, rest: normalized.replace(dmy[0], ' ') };
    }
  }

  return { dateKey: null, rest: normalized };
}

function parseRelativeDate(normalized, timezone, now) {
  const today = formatDateKey(now, timezone);
  if (/\bpoimaine\b/.test(normalized)) return addCalendarDays(today, 2);
  if (/\bmaine\b/.test(normalized)) return addCalendarDays(today, 1);
  if (/\bazi\b/.test(normalized)) return today;

  const dayName = Object.keys(WEEKDAY_MAP)
    .sort((a, b) => b.length - a.length)
    .find((d) => new RegExp(`\\b${d}\\b`).test(normalized));
  if (!dayName) return null;

  const want = WEEKDAY_MAP[/** @type {keyof typeof WEEKDAY_MAP} */ (dayName)];
  const current = getWeekdayInTimezone(now, timezone);
  if (current == null) return null;
  let add = (want - current + 7) % 7;
  if (add === 0 && !/\bazi\b/.test(normalized)) add = 7;
  return addCalendarDays(today, add);
}

function parseTimeFromText(normalized, meridian, dayHours = null) {
  const clock = normalized.match(/\b(\d{1,2})[:\.](\d{2})\b/);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (hour > 23 || minute > 59) return null;
    hour = applyMeridian(hour, meridian, dayHours);
    if (hour > 23) return null;
    const coerced = coerceHourToOpenHours(hour, minute, meridian ? null : dayHours);
    return `${pad2(coerced.hour)}:${pad2(coerced.minute)}`;
  }

  const withMeridianWord = normalized.match(
    /\b(\d{1,2})\s*(?:dupa[\s-]*amiaza|dimineata|seara|\bpm\b|\bam\b|p\.m\.|a\.m\.)\b/,
  );
  const laOra = normalized.match(/\b(?:la|ora)\s+(\d{1,2})\b/);
  const raw = withMeridianWord || laOra;
  if (!raw) return null;

  let hour = Number(raw[1]);
  if (hour > 23) return null;
  const token = String(raw[0] || '');
  let mer = meridian;
  if (/dupa[\s-]*amiaza|\bseara\b|\bpm\b|p\.m\./.test(token)) mer = 'pm';
  else if (/\bdimineata\b|\bam\b|a\.m\./.test(token)) mer = 'am';
  hour = applyMeridian(hour, mer, dayHours);
  if (hour > 23) return null;
  return `${pad2(hour)}:00`;
}

/**
 * Parse Romanian date/time without treating calendar days as hours
 * and without defaulting an unspecified day to "today" when only a time is present.
 *
 * @param {string} text
 * @param {string} timezone
 * @param {Date} [now]
 * @param {{ dayHours?: { open?: string, close?: string } | null }} [options]
 * @returns {ParsedDateTime}
 */
export function parseRomanianDateTimeParts(text, timezone, now = new Date(), options = {}) {
  const normalized = normalize(text);
  if (!normalized) {
    return { dateKey: null, timeHHmm: null, datetime: null, hasDate: false, hasTime: false };
  }

  const meridian = detectMeridian(normalized);
  const calendar = extractCalendarDate(normalized, timezone, now);
  const dateKey = calendar.dateKey || parseRelativeDate(normalized, timezone, now);
  const dayHours = options.dayHours ?? null;
  const timeHHmm = parseTimeFromText(calendar.rest, meridian, dayHours)
    || parseTimeFromText(normalized, meridian, dayHours);

  /** @type {Date | null} */
  let datetime = null;
  if (dateKey && timeHHmm) {
    datetime = localToUtc(dateKey, timeHHmm, timezone);
  }

  return {
    dateKey,
    timeHHmm,
    datetime,
    hasDate: Boolean(dateKey),
    hasTime: Boolean(timeHHmm),
  };
}

/**
 * @param {string} text
 * @param {string} timezone
 * @returns {Date | null}
 */
export function parseRomanianDateTime(text, timezone) {
  return parseRomanianDateTimeParts(text, timezone).datetime;
}

/**
 * @param {string} text
 * @param {string} timezone
 * @returns {string | null}
 */
export function extractDateKey(text, timezone) {
  return parseRomanianDateTimeParts(text, timezone).dateKey;
}

/**
 * @param {string} text
 * @param {string} [timezone]
 * @returns {string | null}
 */
export function extractTimeText(text, timezone = 'Europe/Bucharest') {
  return parseRomanianDateTimeParts(text, timezone).timeHHmm;
}
