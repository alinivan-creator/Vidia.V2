/**
 * Layer 3 — WhatsApp text from Layer 2 actions only.
 * Never invents availability, hours, or confirmations.
 * Presentation polish only — same facts, calmer layout.
 */

import { MACHINE_ACTIONS } from '../booking/stateMachine.js';
import { localToUtc } from '../../utils/datetime.js';
import { formatServiceAskMessage } from '../../utils/serviceMatch.js';
import { waField, waJoin, waTitle } from '../../utils/waCopy.js';

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

function nearbyHoursLine(alternatives, en = false) {
  const labels = (alternatives || [])
    .map((a) => a.label || a.time || a.id)
    .filter(Boolean)
    .slice(0, 8);
  if (!labels.length) return '';
  return waField(en ? 'Available' : 'Disponibil', labels.join('\n'));
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
 * @param {{ name: string, duration_minutes?: number }[]} [params.services]
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
  lang = 'ro',
}) {
  const dateLabel = draft.date ? formatRomanianDate(draft.date, timezone) : '';
  const timeLabel = formatTime24(draft.time);
  const service = draft.service_name || (lang === 'en' ? 'the service' : 'serviciul ales');
  const en = lang === 'en';

  switch (action) {
    case MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION: {
      return waJoin(
        waTitle(en ? 'Confirm this booking?' : 'Confirmi programarea?'),
        '',
        waField(en ? 'Guest' : 'Client', clientName),
        waField(en ? 'Specialist' : 'Specialist', employeeName),
        waField(en ? 'Service' : 'Serviciu', service),
        waField(en ? 'Date' : 'Data', dateLabel),
        waField(en ? 'Time' : 'Ora', timeLabel),
      );
    }
    case MACHINE_ACTIONS.ACTION_ASK_CLARIFICATION: {
      const n = clarifyValue != null ? String(clarifyValue) : '';
      if (n) {
        return en
          ? waJoin(waTitle('Quick check'), `Is *${n}* the date or the time *${n}:00*?`)
          : waJoin(waTitle('Lămurire'), `*${n}* e data sau ora *${n}:00*?`);
      }
      return en
        ? waJoin(waTitle('Quick check'), 'Is that a *date* or a *time*?')
        : waJoin(waTitle('Lămurire'), 'E vorba de o *dată* sau de o *oră*?');
    }
    case MACHINE_ACTIONS.ACTION_SLOT_UNAVAILABLE: {
      const occupied = occupiedLabel
        ? (en ? `*${occupiedLabel}* is not available.` : `*${occupiedLabel}* nu e disponibil.`)
        : (en
          ? `*${timeLabel}* is not available${dateLabel ? ` — ${dateLabel}` : ''}.`
          : `*${timeLabel}* nu e disponibil${dateLabel ? ` — ${dateLabel}` : ''}.`);
      return waJoin(
        waTitle(en ? 'Unavailable' : 'Indisponibil'),
        occupied,
        '',
        en ? 'Pick another day from the list.' : 'Alege altă zi din listă.',
      );
    }
    case MACHINE_ACTIONS.ACTION_ASK_SERVICE:
      return formatServiceAskMessage(services);
    case MACHINE_ACTIONS.ACTION_ASK_DATE:
      return en
        ? waJoin(
          waTitle(draft.service_name ? `Pick a day — ${draft.service_name}` : 'Pick a day'),
          'Tap *Available days* and choose a date.',
        )
        : waJoin(
          waTitle(draft.service_name ? `Alege ziua — ${draft.service_name}` : 'Alege ziua'),
          'Apasă *Zile disponibile* și selectează data.',
        );
    case MACHINE_ACTIONS.ACTION_ASK_TIME: {
      const head = en
        ? waJoin(
          waTitle(draft.service_name ? `Pick a time — ${draft.service_name}` : 'Pick a time'),
          dateLabel ? waField('Date', dateLabel) : null,
        )
        : waJoin(
          waTitle(draft.service_name ? `Alege ora — ${draft.service_name}` : 'Alege ora'),
          dateLabel ? waField('Data', dateLabel) : null,
        );
      return waJoin(
        head,
        '',
        en ? 'Tap the time you want below.' : 'Atinge ora dorită mai jos.',
      );
    }
    case MACHINE_ACTIONS.ACTION_ASK_DATE_TIME:
      return en
        ? waJoin(
          waTitle('When do you want the appointment?'),
          'Choose a day from the list, then a time.',
        )
        : waJoin(
          waTitle('Când vrei programarea?'),
          'Alege o zi din listă, apoi o oră.',
        );
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
      'Reformulează cald și natural în română (ton de recepție prietenoasă), păstrând EXACT numele clientului, serviciul, data și ora din text. ' +
      'Nu schimba data/ora. Nu spune că e deja confirmată. Nu adăuga ore libere. ' +
      'Păstrează structura clară pe câmpuri (Client / Serviciu / Data / Ora). Fără engleză, fără formulări robotice.'
    );
  }
  if (action === MACHINE_ACTIONS.ACTION_ASK_CLARIFICATION || action === 'CLARIFY') {
    return (
      'Păstrează o singură întrebare scurtă, caldă și omenească de lămurire. ' +
      'Nu adăuga meniuri numerotate. Nu ghici dacă e dată sau oră.'
    );
  }
  if (action === 'CONFIRMATION_RESCHEDULE') {
    return (
      'Reformulează cald în română: confirmă că AI MUTAT programarea existentă (nu că ai creat una nouă). ' +
      'Păstrează EXACT serviciul și noul interval din text. Nu inventa ore. Ton natural, 1–3 propoziții.'
    );
  }
  if (action === 'CONFIRMATION_BOOKED' || action === 'CONFIRMATION_CANCELLED') {
    return (
      'Reformulează cald și natural în română, păstrând EXACT faptele din text (serviciu, dată, oră). ' +
      'Nu inventa detalii. Evită tonul robotic sau imperativ.'
    );
  }
  return (
    'Reformulează politicos și natural în română (ca un recepționer amabil). ' +
    'NU inventa ore, prețuri, disponibilitate sau confirmări. ' +
    'NU adăuga liste numerotate de tipul „răspunde cu 1”. Corectează gramatica; păstrează toate faptele din text.'
  );
}
