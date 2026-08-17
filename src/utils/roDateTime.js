import { formatDateKey, localToUtc, getWeekdayInTimezone, addCalendarDays, formatTime } from './datetime.js';

const WEEKDAY_MAP = {
  duminica: 0,
  sunday: 0,
  luni: 1,
  monday: 1,
  marti: 2,
  tuesday: 2,
  miercuri: 3,
  wednesday: 3,
  joi: 4,
  thursday: 4,
  vineri: 5,
  friday: 5,
  sambata: 6,
  saturday: 6,
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
 * @param {number} [minute]
 */
function applyMeridian(hour, meridian, dayHours = null, minute = 0) {
  if (meridian === 'pm' && hour > 0 && hour < 12) return hour + 12;
  if (meridian === 'am' && hour === 12) return 0;
  if (meridian === 'am') return hour;
  if (meridian === 'pm' && hour === 12) return 12;
  return coerceHourToOpenHours(hour, minute, dayHours).hour;
}

/**
 * @param {number} hour
 * @param {number} minute
 * @param {string | null} meridian
 * @param {{ open?: string, close?: string } | null} [dayHours]
 * @returns {string | null}
 */
function formatParsedClock(hour, minute, meridian, dayHours = null) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  const meridiated = applyMeridian(hour, meridian, dayHours, minute);
  if (meridiated > 23) return null;
  const coerced = coerceHourToOpenHours(meridiated, minute, meridian ? null : dayHours);
  return `${pad2(coerced.hour)}:${pad2(coerced.minute)}`;
}

/**
 * "la 11 fara 20" → 10:40; "la 11 fara un sfert" → 10:45.
 * @param {number} hour
 * @param {number} minusMinutes
 * @param {string | null} meridian
 * @param {{ open?: string, close?: string } | null} [dayHours]
 * @returns {string | null}
 */
function clockFromHourMinus(hour, minusMinutes, meridian, dayHours = null) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minusMinutes) || minusMinutes <= 0 || minusMinutes >= 60) return null;
  const named = applyMeridian(hour, meridian, dayHours, 0);
  let total = named * 60 - minusMinutes;
  if (total < 0) total += 24 * 60;
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  const coerced = coerceHourToOpenHours(h, m, meridian ? null : dayHours);
  return `${pad2(coerced.hour)}:${pad2(coerced.minute)}`;
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

function parseDayOfMonth(normalized, timezone, now) {
  const m = normalized.match(/\b(?:pe|data(?:\s+de)?|ziua(?:\s+de)?|on(?:\s+the)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (!m) return null;
  const day = Number(m[1]);
  if (day < 1 || day > 31) return null;
  const today = formatDateKey(now, timezone);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  if (!isValidYmd(year, month, day)) {
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    if (!isValidYmd(nextYear, nextMonth, day)) return null;
    let key = toDateKey(nextYear, nextMonth, day);
    if (key < today) return null;
    return key;
  }
  let key = toDateKey(year, month, day);
  if (key < today) {
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    if (!isValidYmd(nextYear, nextMonth, day)) return null;
    key = toDateKey(nextYear, nextMonth, day);
  }
  return key;
}

/** Romanian count words used in "peste două zile / ore". */
const RO_COUNT_WORDS = {
  o: 1,
  un: 1,
  una: 1,
  doi: 2,
  doua: 2,
  trei: 3,
  patru: 4,
  cinci: 5,
  sase: 6,
  sapte: 7,
  opt: 8,
  noua: 9,
  zece: 10,
};

const RO_COUNT_TOKEN = String.raw`(\d{1,2}|o|un|una|doi|doua|trei|patru|cinci|sase|sapte|opt|noua|zece)`;

/**
 * @param {string} token
 * @returns {number | null}
 */
function parseRoCount(token) {
  const t = String(token || '').toLowerCase();
  if (/^\d{1,2}$/.test(t)) {
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return RO_COUNT_WORDS[t] ?? null;
}

function parseRelativeDate(normalized, timezone, now) {
  const today = formatDateKey(now, timezone);

  // "peste N / două săptămâni"
  const weeks = normalized.match(new RegExp(String.raw`\bpeste\s+${RO_COUNT_TOKEN}\s+saptaman`));
  if (weeks) {
    const n = parseRoCount(weeks[1]);
    if (n != null && n > 0) return addCalendarDays(today, n * 7);
  }
  // "de azi într-o săptămână" / "peste o săptămână" / bare "săptămâna viitoare" — before bare "azi"
  if (
    /\b(?:peste\s+(?:o|1|un|una)\s+saptaman\w*|de\s+azi\s+intr-o\s+saptaman\w*|intr-o\s+saptaman\w*|in\s+o\s+saptaman\w*)\b/.test(
      normalized,
    )
    || /\b(?:in\s+)?saptaman(?:a|ii)\s+(?:viitoare|urmatoare)\b/.test(normalized)
    || /\bnext\s+week\b/.test(normalized)
  ) {
    // Weekday + "săptămâna viitoare" is handled below (joi săptămâna viitoare → specific day).
    const hasWeekday = Object.keys(WEEKDAY_MAP).some((d) => new RegExp(`\\b${d}\\b`).test(normalized));
    if (!hasWeekday) return addCalendarDays(today, 7);
  }

  // "peste N zile" / "în două zile"
  const nDays = normalized.match(new RegExp(String.raw`\b(?:peste|in)\s+${RO_COUNT_TOKEN}\s+zile\b`));
  if (nDays) {
    const n = parseRoCount(nDays[1]);
    if (n != null && n > 0) return addCalendarDays(today, n);
  }
  if (
    /\b(?:peste|in)\s+(?:o|1|un|una)\s+zi\b/.test(normalized)
    || /\bmaine\b/.test(normalized)
    || /\btomorrow\b/.test(normalized)
  ) {
    return addCalendarDays(today, 1);
  }
  if (/\bpoimaine\b/.test(normalized) || /\bday after tomorrow\b/.test(normalized)) {
    return addCalendarDays(today, 2);
  }
  if (/\balaltaieri\b/.test(normalized) || /\bday before yesterday\b/.test(normalized)) {
    return addCalendarDays(today, -2);
  }
  if (/\bieri\b/.test(normalized) || /\byesterday\b/.test(normalized)) return addCalendarDays(today, -1);
  if (/\b(?:astazi|azi)\b/.test(normalized) || /\btoday\b/.test(normalized)) return today;

  const dayName = Object.keys(WEEKDAY_MAP)
    .sort((a, b) => b.length - a.length)
    .find((d) => new RegExp(`\\b${d}\\b`).test(normalized));
  if (!dayName) return null;

  const want = WEEKDAY_MAP[/** @type {keyof typeof WEEKDAY_MAP} */ (dayName)];
  const current = getWeekdayInTimezone(now, timezone);
  if (current == null) return null;
  let add = (want - current + 7) % 7;
  const nextWeek =
    /\bsaptaman(?:a|ii)\s+(?:viitoare|urmatoare)\b/.test(normalized)
    || /\bnext\s+week\b/.test(normalized);
  if (nextWeek) {
    add = add === 0 ? 7 : add + 7;
  }
  return addCalendarDays(today, add);
}

/**
 * "peste 2 ore" / "peste 30 minute" → absolute date+time from now.
 * @returns {{ dateKey: string, timeHHmm: string } | null}
 */
export function parseRelativeDurationFromNow(normalized, timezone, now = new Date()) {
  const n = normalize(normalized);
  const hours = n.match(new RegExp(String.raw`\bpeste\s+${RO_COUNT_TOKEN}\s+(?:de\s+)?(?:ore|ora)\b`));
  if (hours) {
    const count = parseRoCount(hours[1]);
    if (count != null && count > 0) {
      const then = new Date(now.getTime() + count * 3600_000);
      return {
        dateKey: formatDateKey(then, timezone),
        timeHHmm: formatTime(then, timezone),
      };
    }
  }
  const mins = n.match(new RegExp(String.raw`\bpeste\s+${RO_COUNT_TOKEN}\s+(?:de\s+)?(?:minute|minut|min)\b`));
  if (mins) {
    const count = parseRoCount(mins[1]);
    if (count != null && count > 0) {
      const then = new Date(now.getTime() + count * 60_000);
      return {
        dateKey: formatDateKey(then, timezone),
        timeHHmm: formatTime(then, timezone),
      };
    }
  }
  return null;
}

function parseTimeFromText(normalized, meridian, dayHours = null) {
  const clockMeridian = normalized.match(/\b(\d{1,2})(?:[:.,](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/);
  if (clockMeridian) {
    const mer = /p/.test(clockMeridian[3]) ? 'pm' : 'am';
    return formatParsedClock(Number(clockMeridian[1]), Number(clockMeridian[2] || 0), mer, dayHours);
  }

  const clock = normalized.match(/\b(\d{1,2})[:.,](\d{2})\b/);
  if (clock) {
    return formatParsedClock(Number(clock[1]), Number(clock[2]), meridian, dayHours);
  }

  const spacedClock = normalized.match(/\b(?:la|ora|at)\s+(\d{1,2})\s+(\d{2})\b/)
    || normalized.match(/\b(\d{1,2})\s+(\d{2})\b/);
  if (spacedClock && Number(spacedClock[2]) <= 59) {
    return formatParsedClock(Number(spacedClock[1]), Number(spacedClock[2]), meridian, dayHours);
  }

  const faraSfert = normalized.match(/\b(?:la|ora)?\s*(\d{1,2})\s+fara\s+(?:un\s+)?sfert\b/);
  if (faraSfert) {
    return clockFromHourMinus(Number(faraSfert[1]), 15, meridian, dayHours);
  }

  const faraMin = normalized.match(/\b(?:la|ora)?\s*(\d{1,2})\s+fara\s+(\d{1,2})\b/);
  if (faraMin) {
    return clockFromHourMinus(Number(faraMin[1]), Number(faraMin[2]), meridian, dayHours);
  }

  const half = normalized.match(
    /\b(?:la|ora)?\s*(\d{1,2})\s*(?:si\s+)?(?:o\s+)?(?:jumatate|jumate|juma)\b/,
  );
  if (half) {
    return formatParsedClock(Number(half[1]), 30, meridian, dayHours);
  }

  const quarter = normalized.match(
    /\b(?:la|ora)?\s*(\d{1,2})\s*(?:si\s+)?(?:un\s+)?sfer(?:t)?\b/,
  );
  if (quarter) {
    return formatParsedClock(Number(quarter[1]), 15, meridian, dayHours);
  }

  const andMinutes = normalized.match(/\b(?:la|ora)?\s*(\d{1,2})\s+si\s+(\d{1,2})\b/);
  if (andMinutes) {
    return formatParsedClock(Number(andMinutes[1]), Number(andMinutes[2]), meridian, dayHours);
  }

  const withMeridianWord = normalized.match(
    /\b(\d{1,2})\s*(?:dupa[\s-]*amiaza|dimineata|seara|\bpm\b|\bam\b|p\.m\.|a\.m\.)\b/,
  );
  const laOra = normalized.match(/\b(?:la|ora|at)\s+(\d{1,2})\b/);
  const raw = withMeridianWord || laOra;
  if (raw) {
    let hour = Number(raw[1]);
    if (hour > 23) return null;
    const token = String(raw[0] || '');
    let mer = meridian;
    if (/dupa[\s-]*amiaza|\bseara\b|\bpm\b|p\.m\./.test(token)) mer = 'pm';
    else if (/\bdimineata\b|\bam\b|a\.m\./.test(token)) mer = 'am';
    return formatParsedClock(hour, 0, mer, dayHours);
  }

  if (/\b(pranz|amiaza)\b/.test(normalized)) {
    return formatParsedClock(12, 0, meridian, dayHours);
  }

  const bareHour = normalized.match(/^(\d{1,2})$/);
  if (bareHour) {
    return formatParsedClock(Number(bareHour[1]), 0, meridian, dayHours);
  }
  return null;
}

function stripResolvedDateTokens(normalized) {
  let rest = String(normalized || '');
  rest = rest.replace(
    /\b(day after tomorrow|day before yesterday|poimaine|alaltaieri|astazi|maine|ieri|azi|today|tomorrow|yesterday)\b/g,
    ' ',
  );
  const days = Object.keys(WEEKDAY_MAP).sort((a, b) => b.length - a.length).join('|');
  rest = rest.replace(new RegExp(`\\b(?:${days})\\b`, 'g'), ' ');
  rest = rest.replace(/\b(?:pe|data(?:\s+de)?|ziua(?:\s+de)?|on(?:\s+the)?)\s+\d{1,2}(?:st|nd|rd|th)?\b/g, ' ');
  const monthNames = Object.keys(MONTH_MAP).sort((a, b) => b.length - a.length).join('|');
  rest = rest.replace(new RegExp(`\\b\\d{1,2}\\s+(${monthNames})\\.?\\s*(?:\\d{4})?\\b`, 'g'), ' ');
  rest = rest.replace(/\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b/g, ' ');
  rest = rest.replace(/\b20\d{2}-\d{2}-\d{2}\b/g, ' ');
  rest = rest.replace(new RegExp(String.raw`\bpeste\s+${RO_COUNT_TOKEN}\s+saptaman\w*`, 'g'), ' ');
  rest = rest.replace(
    /\b(?:de\s+azi\s+intr-o\s+saptaman|intr-o\s+saptaman|in\s+o\s+saptaman|next\s+week|(?:in\s+)?saptaman(?:a|ii)\s+(?:viitoare|urmatoare))\b/g,
    ' ',
  );
  rest = rest.replace(new RegExp(String.raw`\b(?:peste|in)\s+${RO_COUNT_TOKEN}\s+zile?\b`, 'g'), ' ');
  rest = rest.replace(/\b(?:peste|in)\s+(?:o|1|un|una)\s+zi\b/g, ' ');
  rest = rest.replace(new RegExp(String.raw`\bpeste\s+${RO_COUNT_TOKEN}\s+(?:de\s+)?(?:ore|ora)\b`, 'g'), ' ');
  rest = rest.replace(new RegExp(String.raw`\bpeste\s+${RO_COUNT_TOKEN}\s+(?:de\s+)?(?:minute|minut|min)\b`, 'g'), ' ');
  return rest.replace(/\s+/g, ' ').trim();
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
  const relativeDuration = parseRelativeDurationFromNow(normalized, timezone, now);
  const calendar = extractCalendarDate(normalized, timezone, now);
  let dateKey = relativeDuration?.dateKey
    || calendar.dateKey
    || parseRelativeDate(normalized, timezone, now)
    || parseDayOfMonth(calendar.rest, timezone, now)
    || parseDayOfMonth(normalized, timezone, now);
  const dayHours = options.dayHours ?? null;
  const remainder = stripResolvedDateTokens(calendar.rest);
  const timeHHmm = relativeDuration?.timeHHmm
    || parseTimeFromText(remainder, meridian, dayHours)
    || parseTimeFromText(calendar.rest, meridian, dayHours)
    || parseTimeFromText(normalized, meridian, dayHours);

  /** @type {Date | null} */
  let datetime = null;
  if (dateKey && timeHHmm) {
    datetime = localToUtc(dateKey, timeHHmm, timezone);
    const namedWeekday = Object.keys(WEEKDAY_MAP).some((d) => new RegExp(`\\b${d}\\b`).test(normalized));
    const relativeFixed = /\b(maine|poimaine|ieri|alaltaieri|azi|astazi|today|tomorrow|yesterday)\b/.test(normalized);
    // "sâmbătă la 11" on Saturday afternoon → next Saturday, not a past slot.
    if (
      namedWeekday
      && !relativeFixed
      && datetime.getTime() < now.getTime() - 60_000
    ) {
      dateKey = addCalendarDays(dateKey, 7);
      datetime = localToUtc(dateKey, timeHHmm, timezone);
    }
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
