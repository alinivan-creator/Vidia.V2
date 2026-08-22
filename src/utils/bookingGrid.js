/**
 * Day/time picker labels for WhatsApp List / Quick Reply (no ASCII calendars).
 */

import { addCalendarDays, formatDateKey, formatTime, getBookingConfig, getWeekdayInTimezone, localToUtc } from './datetime.js';
import { formatRomanianDate, formatLocalizedDate } from '../lib/ai/responseFormatter.js';

/** @typedef {import('../db/businessService.js').Business} Business */

/** WhatsApp list-picker max rows. */
export const LIST_PAGE_SIZE = 10;
/** In-session quick-reply max buttons. */
export const QUICK_REPLY_MAX = 3;

export const GRID_PREFIX = {
  DAY: 'day_',
  NEXT: 'grid_next',
  PREV: 'grid_prev',
};

/**
 * Merge the page actually sent to WhatsApp (may include grid_next / grid_prev)
 * with the full catalog so taps from any page of this picker stay valid.
 *
 * @param {{ id: string, title?: string, description?: string }[]} pageItems
 * @param {{ id: string, title?: string, description?: string }[]} catalog
 * @returns {{ id: string, title?: string, description?: string }[]}
 */
export function mergeMenuOptions(pageItems = [], catalog = []) {
  /** @type {Map<string, { id: string, title?: string, description?: string }>} */
  const byId = new Map();
  for (const row of [...(pageItems || []), ...(catalog || [])]) {
    if (!row?.id) continue;
    const id = String(row.id);
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        title: row.title != null ? String(row.title) : undefined,
        description: row.description != null ? String(row.description) : undefined,
      });
    }
  }
  return [...byId.values()];
}

/**
 * True when this id is a grid pager control (never treat as stale history).
 * @param {string | null | undefined} id
 */
export function isGridNavChoiceId(id) {
  const value = String(id ?? '').trim();
  return value === GRID_PREFIX.NEXT || value === GRID_PREFIX.PREV;
}

const WEEKDAY_SHORT_RO = ['Du', 'Lu', 'Ma', 'Mi', 'Jo', 'Vi', 'Sâ'];
const WEEKDAY_SHORT_EN = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const WEEKDAY_LONG_RO = ['Duminică', 'Luni', 'Marți', 'Miercuri', 'Joi', 'Vineri', 'Sâmbătă'];
const WEEKDAY_LONG_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_SHORT_RO = ['Ian', 'Feb', 'Mar', 'Apr', 'Mai', 'Iun', 'Iul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_SHORT_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "Luni, 17 Aug" / "Monday, 17 Aug" — fits WhatsApp list item (≤24 chars).
 * @param {string} dateKey
 * @param {string} timezone
 * @param {'ro' | 'en'} [lang]
 */
export function formatDayListLabel(dateKey, timezone, lang = 'ro') {
  if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return String(dateKey || '');
  const noon = localToUtc(dateKey, '12:00', timezone);
  const weekday = getWeekdayInTimezone(noon, timezone);
  const day = Number(dateKey.slice(8, 10));
  const month = Number(dateKey.slice(5, 7));
  const long = lang === 'en' ? WEEKDAY_LONG_EN : WEEKDAY_LONG_RO;
  const months = lang === 'en' ? MONTHS_SHORT_EN : MONTHS_SHORT_RO;
  const wd = weekday == null ? '' : long[weekday];
  const mo = months[month - 1] || '';
  return `${wd}, ${day} ${mo}`.slice(0, 24);
}

/**
 * Open calendar days in the booking horizon (Admin hours). Closed days omitted.
 *
 * @param {Business} business
 * @param {{ now?: Date, limit?: number, lang?: 'ro' | 'en' }} [opts]
 * @returns {{ dateKey: string, id: string, title: string, description: string, weekdayShort: string }[]}
 */
export function listOpenDayWindows(business, opts = {}) {
  const now = opts.now || new Date();
  const lang = opts.lang === 'en' ? 'en' : 'ro';
  const config = getBookingConfig(business);
  const tz = business.timezone || 'Europe/Bucharest';
  // Product: always offer up to 14 open days (2 weeks), even if Admin horizon was left at 7.
  const horizonDays = Math.max(14, Number(config.bookingHorizonDays) || 14);
  const limit = Math.min(Number(opts.limit) || 14, horizonDays);
  const today = formatDateKey(now, tz);
  const shortDays = lang === 'en' ? WEEKDAY_SHORT_EN : WEEKDAY_SHORT_RO;
  /** @type {{ dateKey: string, id: string, title: string, description: string, weekdayShort: string }[]} */
  const days = [];

  for (let i = 0; i < horizonDays && days.length < limit; i++) {
    const dateKey = addCalendarDays(today, i);
    const probe = localToUtc(dateKey, '12:00', tz);
    const weekday = getWeekdayInTimezone(probe, tz);
    if (weekday == null) continue;
    const hours = config.businessHours[String(weekday)];
    if (!hours?.open || !hours?.close) continue;
    const short = shortDays[weekday];
    const label = formatDayListLabel(dateKey, tz, lang);
    const desc = dateKey === today
      ? (lang === 'en' ? 'Today' : 'Astăzi')
      : formatLocalizedDate(dateKey, tz, lang);
    days.push({
      dateKey,
      id: `${GRID_PREFIX.DAY}${dateKey}`,
      title: label,
      description: String(desc).slice(0, 72),
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
 * @returns {{ id: string, title: string, time: string, description: string }[]}
 */
export function listTimeWindows(slots, timezone) {
  return (slots || []).map((s) => {
    const time = formatTime(s.start, timezone);
    return {
      id: s.id,
      title: time.slice(0, 24),
      time,
      description: 'Disponibil',
    };
  });
}

/**
 * Page list options for WhatsApp list-picker (max 10), with Alte › / ‹ Înapoi when needed.
 *
 * @template {{ id: string, title: string, description?: string }} T
 * @param {T[]} all
 * @param {number} page
 * @param {number} [pageSize]
 * @param {{ lang?: 'ro' | 'en', nextTitle?: string, prevTitle?: string, nextDesc?: string, prevDesc?: string }} [opts]
 */
export function buildListPickerPage(all, page = 0, pageSize = LIST_PAGE_SIZE, opts = {}) {
  if (!all.length) {
    return { items: /** @type {T[]} */ ([]), page: 0, pageCount: 0 };
  }
  const size = Math.max(1, Math.min(10, pageSize));
  const lang = opts.lang === 'en' ? 'en' : 'ro';
  const nextTitle = String(opts.nextTitle || (lang === 'en' ? 'More options ›' : 'Alte opțiuni ›')).slice(0, 24);
  const prevTitle = String(opts.prevTitle || (lang === 'en' ? '‹ Back' : '‹ Înapoi')).slice(0, 24);
  const nextDesc = String(opts.nextDesc || (lang === 'en' ? 'Next page' : 'Pagina următoare')).slice(0, 72);
  const prevDesc = String(opts.prevDesc || (lang === 'en' ? 'Previous page' : 'Pagina anterioară')).slice(0, 72);

  // Everything fits — no nav rows.
  if (all.length <= size) {
    return {
      items: all.map((o) => ({
        id: o.id,
        title: String(o.title).slice(0, 24),
        description: String(o.description || '').slice(0, 72),
      })),
      page: 0,
      pageCount: 1,
    };
  }

  // Multi-page: reserve up to 2 slots for ‹ Back / More ›.
  const contentPerPage = Math.max(1, size - 2);
  const pageCount = Math.ceil(all.length / contentPerPage);
  const safePage = Math.min(Math.max(0, Number(page) || 0), pageCount - 1);
  const slice = all.slice(safePage * contentPerPage, safePage * contentPerPage + contentPerPage);

  /** @type {{ id: string, title: string, description?: string }[]} */
  const items = slice.map((o) => ({
    id: o.id,
    title: String(o.title).slice(0, 24),
    description: String(o.description || '').slice(0, 72),
  }));

  if (safePage > 0) {
    items.push({
      id: GRID_PREFIX.PREV,
      title: prevTitle,
      description: prevDesc,
    });
  }
  if (safePage < pageCount - 1) {
    items.push({
      id: GRID_PREFIX.NEXT,
      title: nextTitle,
      description: nextDesc,
    });
  }

  return { items, page: safePage, pageCount };
}

/** @deprecated use buildListPickerPage */
export function buildQuickReplyPage(all, page = 0) {
  const { items, page: p, pageCount } = buildListPickerPage(all, page, QUICK_REPLY_MAX);
  return {
    actions: items.map((i) => ({ id: i.id, title: i.title })),
    page: p,
    pageCount,
    visualIds: all.map((o) => o.id),
  };
}

/**
 * Clean body for day list (no ASCII art).
 * @param {unknown} _days
 * @param {string} [_timezone]
 * @param {string} [serviceName]
 * @param {'ro' | 'en'} [lang]
 */
export function formatDayGridMessage(_days, _timezone, serviceName = null, lang = 'ro') {
  if (lang === 'en') {
    const head = serviceName
      ? `*Choose a day — ${serviceName}*`
      : '*Choose a day*';
    return `${head}\n\nTap *Available days* (next 14 open days) or type, e.g. *tomorrow at 10*.`;
  }
  const head = serviceName
    ? `*Alege ziua — ${serviceName}*`
    : '*Alege ziua*';
  return `${head}\n\nApasă *Zile disponibile* (următoarele 14 zile cu locuri libere) sau scrie, ex: *mâine la 10*.`;
}

/**
 * Clean body for time list / buttons.
 * @param {{ title: string, time: string }[]} _times
 * @param {string} dateKey
 * @param {string} timezone
 * @param {string} [serviceName]
 * @param {'ro' | 'en'} [lang]
 */
export function formatTimeGridMessage(_times, dateKey, timezone, serviceName = null, lang = 'ro') {
  const pretty = dateKey ? formatRomanianDate(dateKey, timezone) : '';
  if (lang === 'en') {
    const head = serviceName
      ? `*Choose a time — ${serviceName}*`
      : '*Choose a time*';
    const dateLine = pretty ? `*Date:* ${pretty}` : null;
    const hint = _times?.length && _times.length <= QUICK_REPLY_MAX
      ? 'Tap your preferred time below.'
      : 'Tap *Free times* and pick a slot.';
    return [head, dateLine, '', hint].filter(Boolean).join('\n');
  }
  const head = serviceName
    ? `*Alege ora — ${serviceName}*`
    : '*Alege ora*';
  const dateLine = pretty ? `*Data:* ${pretty}` : null;
  const hint = _times?.length && _times.length <= QUICK_REPLY_MAX
    ? 'Atinge ora dorită mai jos.'
    : 'Apasă *Ore libere* și selectează intervalul.';
  return [head, dateLine, '', hint].filter(Boolean).join('\n');
}

export function cardHeaderForGrid(kind, serviceName = null) {
  if (kind === 'time') {
    return serviceName ? `Ore — ${serviceName}`.slice(0, 60) : 'Alege ora';
  }
  return serviceName ? `Zile — ${serviceName}`.slice(0, 60) : 'Alege ziua';
}

/** Kept for tests that imported old helpers — returns empty (ASCII removed). */
export function formatWindowGrid() {
  return '';
}

/** @deprecated ASCII calendar removed */
export function formatMonthCalendarBoard() {
  return '';
}

export const GRID_PAGE_SIZE = LIST_PAGE_SIZE;
