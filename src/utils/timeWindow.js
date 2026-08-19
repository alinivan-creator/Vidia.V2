/**
 * Soft time-of-day windows for free-text availability
 * ("mai pe seară", "dimineața", "după-amiază") — presentation + slot filters only.
 */

/** @typedef {'morning' | 'afternoon' | 'evening'} TimeWindow */

/** @type {Record<TimeWindow, { startHour: number, endHour: number, labelRo: string, labelEn: string }>} */
export const TIME_WINDOW_HOURS = {
  morning: { startHour: 6, endHour: 12, labelRo: 'dimineața', labelEn: 'the morning' },
  afternoon: { startHour: 12, endHour: 17, labelRo: 'după-amiază', labelEn: 'the afternoon' },
  evening: { startHour: 17, endHour: 23, labelRo: 'seara', labelEn: 'the evening' },
};

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string | null | undefined} raw
 * @returns {TimeWindow | null}
 */
export function normalizeTimeWindow(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'morning' || v === 'afternoon' || v === 'evening') return v;
  return null;
}

/**
 * Detect soft day-part from free text (no clock required).
 * @param {string} text
 * @returns {TimeWindow | null}
 */
export function detectTimeWindowFromText(text) {
  const n = normalize(text);
  if (!n) return null;
  // Explicit clock wins — caller should prefer extracted_time.
  if (/\b\d{1,2}([:.,]\d{2})?\b/.test(n) && /\b(la|ora|at|am|pm)\b/.test(n)) {
    return null;
  }
  if (/\b\d{1,2}[:.,]\d{2}\b/.test(n)) return null;

  if (/\b(seara|seara asta|in seara|pe seara|mai pe seara|tonight|evening)\b/.test(n)) {
    return 'evening';
  }
  if (/\b(dupa[\s-]*amiaza|dupa amiaza|afternoon|pm\b)\b/.test(n) && !/\bdimineata\b/.test(n)) {
    return 'afternoon';
  }
  if (/\b(dimineata|dimineata|morning)\b/.test(n)) {
    return 'morning';
  }
  if (/\b(amiaza)\b/.test(n) && !/\b(dupa|seara)\b/.test(n)) {
    return 'afternoon';
  }
  return null;
}

/**
 * Soft availability / "do you have free slots" phrasing.
 * @param {string} text
 */
export function looksLikeAvailabilityQuestion(text) {
  const n = normalize(text);
  if (!n) return false;
  if (detectTimeWindowFromText(n)) {
    if (/\b(liber|libere|disponibil|disponibile|aveti|avem|gasiti|gasiti|putem|puteti|mai\b)\b/.test(n)) {
      return true;
    }
    if (/[?]/.test(String(text ?? ''))) return true;
  }
  if (/\b(aveti|avem|mai)\b/.test(n) && /\b(liber|libere|disponibil|disponibile|loc|locuri)\b/.test(n)) {
    return true;
  }
  if (/\b(ce ore|ce intervale|cand aveti|cand sunteti liberi)\b/.test(n)) return true;
  return false;
}

/**
 * @param {TimeWindow | null | undefined} window
 * @returns {{ startHour: number, endHour: number, labelRo: string } | null}
 */
export function timeWindowBounds(window) {
  const key = normalizeTimeWindow(window);
  return key ? TIME_WINDOW_HOURS[key] : null;
}

/**
 * Client-facing name of a day-part — never leak the internal key ("evening").
 * @param {TimeWindow | string | null | undefined} window
 * @param {'ro' | 'en'} [lang]
 * @returns {string | null}
 */
export function timeWindowLabel(window, lang = 'ro') {
  const bounds = timeWindowBounds(window);
  if (!bounds) return null;
  return lang === 'en' ? bounds.labelEn : bounds.labelRo;
}

/**
 * Local hour 0–23 of a Date in timezone.
 * @param {Date} date
 * @param {string} timezone
 */
export function localHourInTimezone(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone || 'Europe/Bucharest',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  return Number.isFinite(hour) ? hour : date.getUTCHours();
}

/**
 * @param {Date} start
 * @param {string} timezone
 * @param {TimeWindow | null | undefined} window
 */
export function slotMatchesTimeWindow(start, timezone, window) {
  const bounds = timeWindowBounds(window);
  if (!bounds) return true;
  const hour = localHourInTimezone(start, timezone);
  return hour >= bounds.startHour && hour < bounds.endHour;
}
