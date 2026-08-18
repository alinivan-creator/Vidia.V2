/**
 * Match a client's confirmed appointments to NLP-extracted date/time/service hints.
 * Prevents cancel/reschedule loops that keep asking which booking when the client
 * already said "azi la 11".
 *
 * Multiple upcoming bookings + a vague day ("de vineri") never auto-picks —
 * the WhatsApp list picker is the only way to lock a booking_id.
 */

import { formatDateKey, formatTime } from './datetime.js';

const MONTHS_SHORT = ['Ian', 'Feb', 'Mar', 'Apr', 'Mai', 'Iun', 'Iul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** WhatsApp list-picker max rows. */
const LIST_ROW_MAX = 10;

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @typedef {Object} AppointmentSlotHints
 * @property {string | null} [appointmentId]
 * @property {string | null} [dateKey] YYYY-MM-DD
 * @property {string | null} [timeHHmm] HH:mm
 * @property {string | null} [serviceName]
 */

/**
 * @param {{ id: string, selected_slot_start?: string | null, selected_service?: { name?: string } | null }[]} appointments
 * @param {AppointmentSlotHints} hints
 * @param {string} timezone
 */
export function matchAppointmentsBySlotHints(appointments, hints, timezone) {
  const list = (Array.isArray(appointments) ? appointments : []).filter((a) => a?.selected_slot_start);
  if (!list.length) {
    return { match: null, candidates: [], ambiguous: false, none: true };
  }

  let candidates = list;
  const dateKey = hints.dateKey && /^\d{4}-\d{2}-\d{2}$/.test(hints.dateKey) ? hints.dateKey : null;
  const timeHHmm = hints.timeHHmm && /^\d{2}:\d{2}$/.test(hints.timeHHmm) ? hints.timeHHmm : null;
  const serviceName = hints.serviceName ? normalize(hints.serviceName) : '';

  if (dateKey) {
    candidates = candidates.filter(
      (a) => formatDateKey(new Date(/** @type {string} */ (a.selected_slot_start)), timezone) === dateKey,
    );
  }

  if (timeHHmm && candidates.length) {
    const exact = candidates.filter(
      (a) => formatTime(new Date(/** @type {string} */ (a.selected_slot_start)), timezone) === timeHHmm,
    );
    if (exact.length) {
      candidates = exact;
    } else {
      const hour = timeHHmm.slice(0, 2);
      const byHour = candidates.filter((a) =>
        formatTime(new Date(/** @type {string} */ (a.selected_slot_start)), timezone).startsWith(`${hour}:`),
      );
      if (byHour.length) candidates = byHour;
    }
  }

  if (serviceName && candidates.length > 1) {
    const bySvc = candidates.filter((a) => {
      const name = normalize(/** @type {{ name?: string }} */ (a.selected_service ?? {}).name || '');
      return name && (name.includes(serviceName) || serviceName.includes(name));
    });
    if (bySvc.length) candidates = bySvc;
  }

  if (candidates.length === 1) {
    return { match: candidates[0], candidates, ambiguous: false, none: false };
  }
  if (candidates.length > 1) {
    return { match: null, candidates, ambiguous: true, none: false };
  }
  return { match: null, candidates: [], ambiguous: false, none: true };
}

/**
 * Resolve which confirmed appointment the client means.
 *
 * Scenario A: exactly one upcoming booking → lock it (never ask).
 * Scenario B: multiple bookings, or a vague/plural request → never guess.
 *   Only a unique date+time (or an explicit appointmentId from the list) locks.
 *
 * @param {object[]} appointments
 * @param {AppointmentSlotHints} hints
 * @param {string} timezone
 * @param {'cancel' | 'reschedule'} [mode]
 * @param {{ forceChoice?: boolean }} [opts]
 */
export function resolveTargetAppointment(appointments, hints, timezone, mode = 'cancel', opts = {}) {
  const list = Array.isArray(appointments) ? appointments : [];
  if (!list.length) {
    return { appointment: null, reason: 'empty', candidates: [] };
  }

  if (hints.appointmentId) {
    const hit = list.find((a) => a.id === hints.appointmentId);
    if (hit) return { appointment: hit, reason: 'id', candidates: [hit] };
  }

  if (list.length === 1) {
    return { appointment: list[0], reason: 'single', candidates: list };
  }

  // Multiple bookings: do not guess from "anulează tot" / "de vineri" / plurals.
  if (opts.forceChoice) {
    return { appointment: null, reason: 'need_choice', candidates: list };
  }

  const hasTime = Boolean(hints.timeHHmm);
  const hasDate = Boolean(hints.dateKey);
  const hasService = Boolean(hints.serviceName);

  // A bare weekday is generic — show the interactive list instead of auto-picking.
  if (hasDate && !hasTime) {
    const sameDay = list.filter((a) => {
      if (!a?.selected_slot_start) return false;
      return formatDateKey(new Date(a.selected_slot_start), timezone) === hints.dateKey;
    });
    return {
      appointment: null,
      reason: 'need_choice',
      candidates: sameDay.length ? sameDay : list,
    };
  }

  const hasSlotHint = hasDate || hasTime || hasService;
  if (!hasSlotHint) {
    return { appointment: null, reason: 'need_choice', candidates: list };
  }

  const matched = matchAppointmentsBySlotHints(list, hints, timezone);
  if (matched.match) {
    return { appointment: matched.match, reason: 'slot_hint', candidates: matched.candidates };
  }
  if (matched.ambiguous) {
    return { appointment: null, reason: 'ambiguous', candidates: matched.candidates };
  }

  // Reschedule often carries the *new* slot in date/time — do not treat a miss as "not found".
  if (mode === 'reschedule') {
    return { appointment: null, reason: 'need_choice', candidates: list, newSlotHints: true };
  }

  return { appointment: null, reason: 'not_found', candidates: list };
}

/**
 * Twilio list-picker rows for the client's upcoming bookings.
 * Title ≤24 chars (WhatsApp cap); description holds service + weekday.
 *
 * @param {{ id: string, selected_slot_start?: string | null, selected_service?: { name?: string } | null }[]} appointments
 * @param {string} timezone
 * @param {{ includeCancelAll?: boolean, apptPrefix?: string, cancelAllId?: string }} [opts]
 */
export function buildAppointmentChoiceMenu(appointments, timezone, opts = {}) {
  const tz = timezone || 'Europe/Bucharest';
  const list = Array.isArray(appointments) ? appointments : [];
  const includeCancelAll = Boolean(opts.includeCancelAll) && list.length > 1;
  const apptPrefix = opts.apptPrefix || 'mod_appt_';
  const cancelAllId = opts.cancelAllId || 'mod_cancel_all';
  const maxAppts = includeCancelAll ? LIST_ROW_MAX - 1 : LIST_ROW_MAX;

  const items = list.slice(0, maxAppts).map((a) => {
    const service = String(/** @type {{ name?: string }} */ (a.selected_service ?? {}).name || 'Programare');
    const start = a.selected_slot_start ? new Date(a.selected_slot_start) : null;
    let title = 'Programare';
    let description = service.slice(0, 72);
    if (start && !Number.isNaN(start.getTime())) {
      const dateKey = formatDateKey(start, tz);
      const time = formatTime(start, tz);
      const day = Number(dateKey.slice(8, 10));
      const month = Number(dateKey.slice(5, 7));
      const mo = MONTHS_SHORT[month - 1] || '';
      title = `${time} · ${day} ${mo}`.slice(0, 24);
      const weekday = new Intl.DateTimeFormat('ro-RO', { timeZone: tz, weekday: 'long' }).format(start);
      const weekdayCap = weekday.charAt(0).toUpperCase() + weekday.slice(1);
      description = `${service} · ${weekdayCap}`.slice(0, 72);
    }
    return {
      id: `${apptPrefix}${a.id}`,
      title,
      description,
    };
  });

  if (includeCancelAll) {
    items.push({
      id: cancelAllId,
      title: 'Anulează toate'.slice(0, 24),
      description: `${list.length} programări active`.slice(0, 72),
    });
  }
  return items;
}
