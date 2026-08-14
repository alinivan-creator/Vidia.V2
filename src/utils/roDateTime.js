import { formatDateKey, localToUtc, getWeekdayInTimezone } from './datetime.js';

/**
 * Very light RO date/time parser: "maine la 10:30", "azi 14:00", "10:30".
 * @param {string} text
 * @param {string} timezone
 * @returns {Date | null}
 */
export function parseRomanianDateTime(text, timezone) {
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

  const timeMatch = normalized.match(/\b(\d{1,2})[:\.](\d{2})\b/) || normalized.match(/\b(\d{1,2})\s*(?:am|pm)?\b/);
  if (!timeMatch) return null;

  let hour = Number(timeMatch[1]);
  const minute = timeMatch[2] !== undefined ? Number(timeMatch[2]) : 0;
  if (hour > 23 || minute > 59) return null;

  const now = new Date();
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');

  const weekdayMap = {
    duminica: 0,
    luni: 1,
    marti: 2,
    miercuri: 3,
    joi: 4,
    vineri: 5,
    sambata: 6,
  };
  const dayName = Object.keys(weekdayMap).find((d) => new RegExp(`\\b${d}\\b`).test(normalized));

  let target = now;
  if (dayName) {
    const want = weekdayMap[/** @type {keyof typeof weekdayMap} */ (dayName)];
    const current = getWeekdayInTimezone(now, timezone);
    let add = (want - current + 7) % 7;
    const dateKeyToday = formatDateKey(now, timezone);
    const todayAt = localToUtc(dateKeyToday, `${hh}:${mm}`, timezone);
    if (add === 0 && todayAt && todayAt.getTime() <= now.getTime()) add = 7;
    target = new Date(now.getTime() + add * 24 * 60 * 60 * 1000);
  } else {
    let dayOffset = 0;
    if (/\bmaine\b/.test(normalized)) dayOffset = 1;
    else if (/\bazi\b/.test(normalized)) dayOffset = 0;
    else if (/\bpoimaine\b/.test(normalized)) dayOffset = 2;
    target = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
  }

  const dateKey = formatDateKey(target, timezone);
  return localToUtc(dateKey, `${hh}:${mm}`, timezone);
}
