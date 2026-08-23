/**
 * Match a client's confirmed appointments to NLP-extracted date/time/service hints.
 * Prevents cancel/reschedule loops that keep asking which booking when the client
 * already said "azi la 11".
 *
 * Multiple upcoming bookings + a vague day ("de vineri") never auto-picks —
 * the WhatsApp list picker is the only way to lock a booking_id.
 */

import { svcDisplay } from '../services/serviceDisplayI18n.js';
import { formatDateKey, formatTime } from './datetime.js';

const MONTHS_SHORT_RO = ['Ian', 'Feb', 'Mar', 'Apr', 'Mai', 'Iun', 'Iul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_SHORT_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Soft cap for cancel/reschedule lists (paginated in WhatsApp; DB may return more). */
const APPOINTMENT_LIST_SOFT_CAP = 50;

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
 * After the booking to move is locked, decide the next reschedule UI.
 * Date/time that identified the *existing* booking must not skip the new-day picker.
 *
 * @param {object} params
 * @param {string} [params.resolvedReason]
 * @param {string | null} [params.extractDate]
 * @param {string | null} [params.extractTime]
 * @param {string | null} [params.pendingDate]
 * @param {string | null} [params.pendingTime]
 * @returns {{ kind: 'apply', date: string, time: string } | { kind: 'ask_time', date: string } | { kind: 'ask_date' }}
 */
export function nextRescheduleSlotStep({
  resolvedReason = '',
  extractDate = null,
  extractTime = null,
  pendingDate = null,
  pendingTime = null,
}) {
  if (resolvedReason === 'slot_hint') {
    return { kind: 'ask_date' };
  }
  const date = (extractDate && /^\d{4}-\d{2}-\d{2}$/.test(extractDate) ? extractDate : null)
    || (pendingDate && /^\d{4}-\d{2}-\d{2}$/.test(pendingDate) ? pendingDate : null);
  const time = (extractTime && /^\d{2}:\d{2}$/.test(extractTime) ? extractTime : null)
    || (pendingTime && /^\d{2}:\d{2}$/.test(pendingTime) ? pendingTime : null);
  if (date && time) return { kind: 'apply', date, time };
  if (date) return { kind: 'ask_time', date };
  return { kind: 'ask_date' };
}

/**
 * Twilio list-picker rows for the client's upcoming bookings.
 * Title ≤24 chars (WhatsApp cap); description holds service + weekday.
 * Returns the full catalog — callers paginate with buildListPickerPage.
 *
 * @param {{ id: string, selected_slot_start?: string | null, selected_service?: { name?: string } | null }[]} appointments
 * @param {string} timezone
 * @param {{ includeCancelAll?: boolean, apptPrefix?: string, cancelAllId?: string, lang?: 'ro' | 'en' }} [opts]
 */
export function buildAppointmentChoiceMenu(appointments, timezone, opts = {}) {
  const tz = timezone || 'Europe/Bucharest';
  const lang = opts.lang === 'en' ? 'en' : 'ro';
  const months = lang === 'en' ? MONTHS_SHORT_EN : MONTHS_SHORT_RO;
  const list = Array.isArray(appointments) ? appointments : [];
  const includeCancelAll = Boolean(opts.includeCancelAll) && list.length > 1;
  const apptPrefix = opts.apptPrefix || 'mod_appt_';
  const cancelAllId = opts.cancelAllId || 'mod_cancel_all';
  const defaultService = lang === 'en' ? 'Appointment' : 'Programare';
  const locale = lang === 'en' ? 'en-GB' : 'ro-RO';

  const items = list.slice(0, APPOINTMENT_LIST_SOFT_CAP).map((a) => {
    const svcRow = /** @type {{ id?: string, name?: string }} */ (a.selected_service ?? {});
    const service = String(svcDisplay(svcRow.name, svcRow.id, lang) || defaultService);
    const start = a.selected_slot_start ? new Date(a.selected_slot_start) : null;
    let title = defaultService;
    let description = service.slice(0, 72);
    if (start && !Number.isNaN(start.getTime())) {
      const dateKey = formatDateKey(start, tz);
      const time = formatTime(start, tz);
      const day = Number(dateKey.slice(8, 10));
      const month = Number(dateKey.slice(5, 7));
      const mo = months[month - 1] || '';
      title = `${time} · ${day} ${mo}`.slice(0, 24);
      const weekday = new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: 'long' }).format(start);
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
      title: (lang === 'en' ? 'Cancel all' : 'Anulează toate').slice(0, 24),
      description: (lang === 'en'
        ? `${list.length} active appointments`
        : `${list.length} programări active`).slice(0, 72),
    });
  }
  return items;
}
