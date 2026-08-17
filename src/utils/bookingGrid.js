/**
 * Visual "window / grid" layouts for WhatsApp date & time selection.
 * Rich calendar body + Twilio card / quick-reply (max 3 in-session).
 * Occupied slots are omitted — only free windows appear.
 */

import { addCalendarDays, formatDateKey, formatTime, getBookingConfig, getWeekdayInTimezone, localToUtc } from './datetime.js';
import { formatRomanianDate } from '../lib/ai/responseFormatter.js';

/** @typedef {import('../db/businessService.js').Business} Business */

/** In-session WhatsApp quick-reply / card button cap. */
export const GRID_PAGE_SIZE = 3;

export const GRID_PREFIX = {
  DAY: 'day_',
  NEXT: 'grid_next',
  PREV: 'grid_prev',
};

const WEEKDAY_SHORT = ['Du', 'Lu', 'Ma', 'Mi', 'Jo', 'Vi', 'Sâ'];
const MONTHS_RO = [
  'ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie',
  'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie',
];

/**
 * Open calendar days in the booking horizon (Admin hours). Closed days omitted.
 *
 * @param {Business} business
 * @param {{ now?: Date, limit?: number }} [opts]
 * @returns {{ dateKey: string, id: string, title: string, weekdayShort: string }[]}
 */
export function listOpenDayWindows(business, opts = {}) {
  const now = opts.now || new Date();
  const config = getBookingConfig(business);
  const tz = business.timezone || 'Europe/Bucharest';
  const limit = Math.min(Number(opts.limit) || 14, config.bookingHorizonDays || 14);
  const today = formatDateKey(now, tz);
  /** @type {{ dateKey: string, id: string, title: string, weekdayShort: string }[]} */
  const days = [];

  for (let i = 0; i < config.bookingHorizonDays && days.length < limit; i++) {
    const dateKey = addCalendarDays(today, i);
    const probe = localToUtc(dateKey, '12:00', tz);
    const weekday = getWeekdayInTimezone(probe, tz);
    if (weekday == null) continue;
    const hours = config.businessHours[String(weekday)];
    if (!hours?.open || !hours?.close) continue;
    const short = WEEKDAY_SHORT[weekday];
    const dayNum = String(Number(dateKey.slice(8, 10)));
    days.push({
      dateKey,
      id: `${GRID_PREFIX.DAY}${dateKey}`,
      title: `${short} ${dayNum}`.slice(0, 20),
      weekdayShort: short,
    });
  }
  return days;
}

/**
 * Free slot windows only (busy slots never appear).
 *
 * @param {{ id: string, start: Date, title?: string }[]} slots
 * @param {string} timezone
 * @returns {{ id: string, title: string, time: string }[]}
 */
export function listTimeWindows(slots, timezone) {
  return (slots || []).map((s) => {
    const time = formatTime(s.start, timezone);
    return {
      id: s.id,
      title: time.slice(0, 20),
      time,
    };
  });
}

/**
 * @template {{ id: string, title: string }} T
 * @param {T[]} all
 * @param {number} page zero-based
 * @param {number} [pageSize]
 */
export function pageGridOptions(all, page = 0, pageSize = GRID_PAGE_SIZE) {
  const size = Math.max(1, pageSize);
  const total = all.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(Math.max(0, Number(page) || 0), pageCount - 1);
  const slice = all.slice(safePage * size, safePage * size + size);
  return {
    page: safePage,
    pageCount,
    options: slice,
    hasPrev: safePage > 0,
    hasNext: safePage < pageCount - 1,
    total,
  };
}

/**
 * Quick-reply actions for one page (≤3).
 *
 * @param {{ id: string, title: string }[]} all
 * @param {number} page
 */
export function buildQuickReplyPage(all, page = 0) {
  if (!all.length) {
    return { actions: /** @type {{ id: string, title: string }[]} */ ([]), page: 0, pageCount: 0, visualIds: [] };
  }
  const pageCount = Math.ceil(all.length / GRID_PAGE_SIZE);
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const start = safePage * GRID_PAGE_SIZE;
  let windowOpts = all.slice(start, start + GRID_PAGE_SIZE);
  /** @type {{ id: string, title: string }[]} */
  const actions = [];

  if (pageCount > 1 && safePage < pageCount - 1) {
    windowOpts = all.slice(start, start + (GRID_PAGE_SIZE - 1));
    for (const opt of windowOpts) {
      actions.push({ id: opt.id, title: String(opt.title).slice(0, 20) });
    }
    actions.push({ id: GRID_PREFIX.NEXT, title: 'Alte ›' });
  } else {
    for (const opt of windowOpts) {
      actions.push({ id: opt.id, title: String(opt.title).slice(0, 20) });
    }
    if (safePage > 0 && actions.length < GRID_PAGE_SIZE) {
      actions.push({ id: GRID_PREFIX.PREV, title: '‹ Înapoi' });
    }
  }

  if (safePage > 0 && !actions.some((a) => a.id === GRID_PREFIX.PREV) && actions.length < GRID_PAGE_SIZE) {
    actions.push({ id: GRID_PREFIX.PREV, title: '‹ Înapoi' });
  }

  return {
    actions,
    page: safePage,
    pageCount,
    visualIds: all.map((o) => o.id),
  };
}

/**
 * Multi-column floating time windows.
 *
 * @param {{ title: string }[]} cells
 * @param {{ columns?: number, caption?: string }} [opts]
 */
export function formatWindowGrid(cells, opts = {}) {
  const cols = Math.min(3, Math.max(1, opts.columns || 3));
  const list = cells || [];
  if (!list.length) {
    return opts.caption || 'Nu sunt ferestre disponibile.';
  }

  const pad = (s) => {
    const t = String(s || '').slice(0, 6);
    return t.padStart(6, ' ').slice(0, 6);
  };

  const lines = [];
  for (let i = 0; i < list.length; i += cols) {
    const chunk = list.slice(i, i + cols);
    const top = chunk.map(() => '┌────────┐').join(' ');
    const mid = chunk.map((c) => `│ ${pad(c.title)} │`).join(' ');
    const bot = chunk.map(() => '└────────┘').join(' ');
    lines.push(top, mid, bot);
    if (i + cols < list.length) lines.push('');
  }

  const caption = opts.caption || 'Atinge o fereastră de mai jos.';
  return caption ? `${lines.join('\n')}\n\n${caption}` : lines.join('\n');
}

/**
 * Month calendar board — open days marked ▢, closed/out ·
 *
 * @param {{ dateKey: string }[]} openDays
 * @param {string} timezone
 * @param {Date} [now]
 */
export function formatMonthCalendarBoard(openDays, timezone, now = new Date()) {
  const open = new Set((openDays || []).map((d) => d.dateKey));
  if (!open.size) return 'Nu sunt zile deschise în orizont.';

  const keys = [...open].sort();
  const first = keys[0];
  const year = Number(first.slice(0, 4));
  const month = Number(first.slice(5, 7));
  const monthLabel = MONTHS_RO[month - 1] || first.slice(5, 7);
  const title = `📅  *${monthLabel.charAt(0).toUpperCase()}${monthLabel.slice(1)} ${year}*`;

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  /** @type {(string | null)[]} */
  const cells = [];
  const firstOfMonth = `${year}-${String(month).padStart(2, '0')}-01`;
  const firstProbe = localToUtc(firstOfMonth, '12:00', timezone);
  const firstWeekday = getWeekdayInTimezone(firstProbe, timezone) ?? 1;
  // Calendar rows start Monday
  const mondayIndex = firstWeekday === 0 ? 6 : firstWeekday - 1;
  for (let i = 0; i < mondayIndex; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push(dateKey);
  }

  const header = ' Lu  Ma  Mi  Jo  Vi  Sâ  Du';
  const lines = [title, '', header, '─── ─── ─── ─── ─── ─── ───'];
  const today = formatDateKey(now, timezone);

  for (let i = 0; i < cells.length; i += 7) {
    const row = cells.slice(i, i + 7);
    while (row.length < 7) row.push(null);
    const nums = row.map((key) => {
      if (!key) return '   ';
      const n = String(Number(key.slice(8, 10))).padStart(2, ' ');
      if (open.has(key)) {
        return key === today ? `*${n.trim()}*`.padEnd(3, ' ').slice(0, 3) : `[${n.trim()}]`.slice(0, 3).padStart(3, ' ');
      }
      return ` ${n} `;
    });
    const marks = row.map((key) => {
      if (!key) return '   ';
      if (open.has(key)) return ' ▢ ';
      return ' · ';
    });
    lines.push(nums.join(' '));
    lines.push(marks.join(' '));
  }

  lines.push('', '▢ zi deschisă   · închis / indisponibil');
  return lines.join('\n');
}

/**
 * @param {{ dateKey: string, title: string, weekdayShort: string }[]} days
 * @param {string} timezone
 * @param {string} [serviceName]
 */
export function formatDayGridMessage(days, timezone, serviceName = null) {
  const head = serviceName
    ? `🗓️  *Alege ziua — ${serviceName}*`
    : '🗓️  *Alege ziua*';
  const board = formatMonthCalendarBoard(days, timezone);
  const chips = formatWindowGrid(
    days.slice(0, 9).map((d) => ({ title: d.title })),
    { columns: 3, caption: '' },
  );
  return [
    head,
    '',
    board,
    '',
    '*Ferestre rapide*',
    chips.trim(),
    '',
    '_Atinge o fereastră (buton) de mai jos — nu scrie text._',
  ].join('\n');
}

/**
 * @param {{ title: string, time: string }[]} times
 * @param {string} dateKey
 * @param {string} timezone
 * @param {string} [serviceName]
 */
export function formatTimeGridMessage(times, dateKey, timezone, serviceName = null) {
  const pretty = dateKey ? formatRomanianDate(dateKey, timezone) : '';
  const head = serviceName
    ? `🕐  *Alege ora — ${serviceName}*`
    : '🕐  *Alege ora*';
  const dateLine = pretty ? `*Data*\n${pretty}` : null;
  const grid = formatWindowGrid(
    times.map((t) => ({ title: t.time || t.title })),
    {
      columns: 3,
      caption: '_Doar orele libere apar ca ferestre. Atinge una mai jos._',
    },
  );
  return [head, dateLine, '', grid].filter(Boolean).join('\n');
}

/**
 * Card header (bold) for Twilio twilio/card — keep short.
 * @param {'day' | 'time'} kind
 * @param {string} [serviceName]
 */
export function cardHeaderForGrid(kind, serviceName = null) {
  if (kind === 'time') {
    return serviceName ? `🕐 Ore — ${serviceName}`.slice(0, 60) : '🕐 Alege ora';
  }
  return serviceName ? `🗓️ Zile — ${serviceName}`.slice(0, 60) : '🗓️ Alege ziua';
}
