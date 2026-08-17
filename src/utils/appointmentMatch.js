/**
 * Match a client's confirmed appointments to NLP-extracted date/time/service hints.
 * Prevents cancel/reschedule loops that keep asking which booking when the client
 * already said "azi la 11".
 */

import { formatDateKey, formatTime } from './datetime.js';

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
 * @param {object[]} appointments
 * @param {AppointmentSlotHints} hints
 * @param {string} timezone
 * @param {'cancel' | 'reschedule'} [mode]
 */
export function resolveTargetAppointment(appointments, hints, timezone, mode = 'cancel') {
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

  const hasSlotHint = Boolean(hints.dateKey || hints.timeHHmm || hints.serviceName);
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
