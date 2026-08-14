/**
 * Layer 3 — WhatsApp text from Layer 2 actions only.
 * Never invents availability, hours, or confirmations.
 */

import { MACHINE_ACTIONS } from '../booking/stateMachine.js';
import { localToUtc } from '../../utils/datetime.js';

const MONTHS_RO = [
  'ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie',
  'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie',
];

const WEEKDAYS_RO = ['duminică', 'luni', 'marți', 'miercuri', 'joi', 'vineri', 'sâmbătă'];

/**
 * @param {string} dateKey YYYY-MM-DD
 * @param {string} [timezone]
 * @returns {string} e.g. "Luni, 17 august"
 */
export function formatRomanianDate(dateKey, timezone = 'Europe/Bucharest') {
  if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return String(dateKey || '');
  const utc = localToUtc(dateKey, '12:00', timezone);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(utc);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const idx = map[/** @type {keyof typeof map} */ (weekday)] ?? 1;
  const day = Number(dateKey.slice(8, 10));
  const month = Number(dateKey.slice(5, 7));
  const weekdayLabel = WEEKDAYS_RO[idx] || '';
  const monthLabel = MONTHS_RO[month - 1] || '';
  const pretty = `${weekdayLabel.charAt(0).toUpperCase()}${weekdayLabel.slice(1)}, ${day} ${monthLabel}`;
  return pretty;
}

function formatTime24(hhmm) {
  if (!hhmm) return '';
  if (/^\d{2}:\d{2}$/.test(hhmm)) return hhmm;
  return String(hhmm);
}

function nearbyHoursLine(alternatives) {
  const labels = (alternatives || [])
    .map((a) => a.label || a.time || a.id)
    .filter(Boolean)
    .slice(0, 6);
  if (!labels.length) return '';
  return `Ore apropiate libere: ${labels.join(', ')}.`;
}

/**
 * @param {Object} params
 * @param {string} params.action
 * @param {{ service_name?: string | null, date?: string | null, time?: string | null }} [params.draft]
 * @param {string | null} [params.clientName]
 * @param {string | null} [params.employeeName]
 * @param {string} [params.timezone]
 * @param {number | null} [params.clarifyValue]
 * @param {string | null} [params.clarifyReason]
 * @param {{ label?: string }[]} [params.alternatives]
 * @param {string | null} [params.occupiedLabel]
 * @param {{ name: string }[]} [params.services]
 */
export function formatMachineAction({
  action,
  draft = {},
  clientName = null,
  employeeName = null,
  timezone = 'Europe/Bucharest',
  clarifyValue = null,
  alternatives = [],
  occupiedLabel = null,
  services = [],
}) {
  const dateLabel = draft.date ? formatRomanianDate(draft.date, timezone) : '';
  const timeLabel = formatTime24(draft.time);
  const service = draft.service_name || 'serviciul ales';

  switch (action) {
    case MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION: {
      const nameLine = clientName ? `👤 *${clientName}*\n` : '';
      const empLine = employeeName ? `💇 cu *${employeeName}*\n` : '';
      return (
        `Confirmi programarea?\n\n` +
        nameLine +
        empLine +
        `📋 *${service}*\n` +
        `📅 ${dateLabel}\n` +
        `🕐 ${timeLabel}`
      );
    }
    case MACHINE_ACTIONS.ACTION_ASK_CLARIFICATION: {
      const n = clarifyValue != null ? String(clarifyValue) : '';
      if (n) {
        return `Scuze, ca să fiu sigur: te referi la data de ${n} sau la ora ${n}:00?`;
      }
      return 'Scuze, ca să fiu sigur: te referi la o dată sau la o oră?';
    }
    case MACHINE_ACTIONS.ACTION_SLOT_UNAVAILABLE: {
      const occupied = occupiedLabel
        ? `Intervalul *${occupiedLabel}* nu e disponibil.`
        : `Ora *${timeLabel}* nu e disponibilă${dateLabel ? ` pe ${dateLabel}` : ''}.`;
      const nearby = nearbyHoursLine(alternatives);
      return nearby
        ? `${occupied} ${nearby} Scrie ora pe care o vrei (ex: *18:00*).`
        : `${occupied} Scrie altă oră (ex: *18:00*).`;
    }
    case MACHINE_ACTIONS.ACTION_ASK_SERVICE: {
      const names = (services || []).map((s) => s.name).filter(Boolean);
      if (names.length) {
        return `Ce serviciu dorești? Avem: ${names.join(', ')}. Scrie numele serviciului.`;
      }
      return 'Ce serviciu dorești? Scrie numele lui (ex: *tuns*).';
    }
    case MACHINE_ACTIONS.ACTION_ASK_DATE:
      return `Pe ce dată vrei${draft.service_name ? ` *${draft.service_name}*` : ''}? Scrie de exemplu *luni* sau *18 aug*.`;
    case MACHINE_ACTIONS.ACTION_ASK_TIME: {
      const nearby = nearbyHoursLine(alternatives);
      const head = `La ce oră vrei${draft.service_name ? ` *${draft.service_name}*` : ''}${dateLabel ? ` pe ${dateLabel}` : ''}?`;
      return nearby
        ? `${head} ${nearby} Poți scrie ora (ex: *17* sau *17:00*).`
        : `${head} Scrie ora (ex: *17* sau *17:00*).`;
    }
    case MACHINE_ACTIONS.ACTION_ASK_DATE_TIME:
      return 'Când vrei programarea? Scrie ziua și ora (ex: *luni la 17*).';
    default:
      return null;
  }
}

/**
 * Cosmetic polish only — facts must already be in `template`.
 *
 * @param {string} template
 * @param {string} action
 */
export function formatterSystemHint(action) {
  if (action === MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION) {
    return (
      'Reformulează cald în română, păstrând EXACT numele clientului, serviciul, data și ora din text. ' +
      'Nu schimba data/ora. Nu spune că e deja confirmată. Nu adăuga ore libere.'
    );
  }
  if (action === MACHINE_ACTIONS.ACTION_ASK_CLARIFICATION) {
    return (
      'Păstrează o singură întrebare scurtă și omenească de lămurire. ' +
      'Nu adăuga meniuri numerotate. Nu ghici dacă e dată sau oră.'
    );
  }
  return (
    'Reformulează politicos în română. NU inventa ore, prețuri, disponibilitate sau confirmări. ' +
    'NU adăuga liste numerotate de tipul „răspunde cu 1”.'
  );
}
