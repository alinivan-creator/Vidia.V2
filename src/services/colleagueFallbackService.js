/**
 * Preferred-employee busy → nearest own slots + optional colleague at exact time.
 * Pure helpers + FreeBusy-backed builders used by turnExecute.
 */

import { listEmployeesForService, resolveEmployeeCalendarId } from '../db/employeeService.js';
import { getAvailableSlots } from '../db/cacheService.js';
import { encodeSlotId, formatDateKey, formatTime, formatSlotLabel } from '../utils/datetime.js';
import { queryFreeBusyBatch, isIntervalFreeInBusyBlocks } from './googleCalendarService.js';
import { BOOKING_PREFIXES } from './flowIds.js';

/** @typedef {import('../db/businessService.js').Business} Business */
/** @typedef {import('../db/employeeService.js').Employee} Employee */

/**
 * @typedef {Object} StaffSlotOption
 * @property {string} id
 * @property {string} title
 * @property {string} employee_id
 * @property {string} employee_name
 * @property {string} date_key
 * @property {string} time_hhmm
 * @property {string} slot_id
 * @property {'preferred_alt' | 'colleague_exact'} kind
 */

/**
 * Choice id: staffslot_<employeeId>_<YYYYMMDD>_<HHMM>
 * @param {string} employeeId
 * @param {Date} slotStart
 * @param {string} timezone
 */
export function encodeStaffSlotChoiceId(employeeId, slotStart, timezone) {
  const slotId = encodeSlotId(slotStart, timezone);
  const parts = slotId.replace(/^slot_/, '');
  return `${BOOKING_PREFIXES.STAFF_SLOT}${employeeId}_${parts}`;
}

/**
 * @param {string} choiceId
 * @returns {{ employeeId: string, slotId: string } | null}
 */
export function decodeStaffSlotChoiceId(choiceId) {
  const prefix = BOOKING_PREFIXES.STAFF_SLOT;
  if (!choiceId?.startsWith(prefix)) return null;
  const rest = choiceId.slice(prefix.length);
  const match = /^([0-9a-f-]{36})_(\d{8}_\d{4})$/i.exec(rest);
  if (!match) return null;
  return { employeeId: match[1], slotId: `slot_${match[2]}` };
}

/**
 * @param {Object} params
 * @param {Employee} params.preferred
 * @param {Date[]} params.preferredAlts
 * @param {Employee | null} params.colleague
 * @param {Date | null} params.requestedStart
 * @param {string} params.timezone
 * @param {'ro' | 'en'} [params.lang]
 */
export function formatColleagueFallbackMessage({
  preferred,
  preferredAlts,
  colleague,
  requestedStart,
  timezone,
  lang = 'ro',
}) {
  const dayLabel = requestedStart
    ? formatSlotLabel(requestedStart, timezone).split(' ').slice(0, -1).join(' ')
      || formatDateKey(requestedStart, timezone)
    : '';
  const timeLabel = requestedStart ? formatTime(requestedStart, timezone) : '';

  /** @type {StaffSlotOption[]} */
  const options = [];
  for (const start of preferredAlts.slice(0, 2)) {
    options.push({
      id: encodeStaffSlotChoiceId(preferred.id, start, timezone),
      title: `${preferred.name} — ${formatSlotLabel(start, timezone)}`,
      employee_id: preferred.id,
      employee_name: preferred.name,
      date_key: formatDateKey(start, timezone),
      time_hhmm: formatTime(start, timezone),
      slot_id: encodeSlotId(start, timezone),
      kind: 'preferred_alt',
    });
  }

  if (colleague && requestedStart) {
    options.push({
      id: encodeStaffSlotChoiceId(colleague.id, requestedStart, timezone),
      title: `${colleague.name} — ${formatSlotLabel(requestedStart, timezone)}`,
      employee_id: colleague.id,
      employee_name: colleague.name,
      date_key: formatDateKey(requestedStart, timezone),
      time_hhmm: formatTime(requestedStart, timezone),
      slot_id: encodeSlotId(requestedStart, timezone),
      kind: 'colleague_exact',
    });
  }

  if (!options.length) return { text: null, options: [] };

  const lines = [];
  if (lang === 'en') {
    lines.push(
      `*${preferred.name}* has no opening ${dayLabel ? `on ${dayLabel} ` : ''}at ${timeLabel || 'that time'}.`,
    );
    if (preferredAlts.length) {
      const alts = preferredAlts.slice(0, 2).map((s) => formatTime(s, timezone)).join(' or ');
      lines.push(`They are free at ${alts}.`);
    }
    if (colleague && requestedStart) {
      lines.push(
        `Alternatively, *${colleague.name}* is free ${dayLabel ? `on ${dayLabel} ` : ''}at ${timeLabel}, if you prefer.`,
      );
    }
  } else {
    lines.push(
      `*${preferred.name}* nu are loc${dayLabel ? ` ${dayLabel}` : ''} la ${timeLabel || 'ora cerută'}.`,
    );
    if (preferredAlts.length) {
      const alts = preferredAlts.slice(0, 2).map((s) => formatTime(s, timezone)).join(' sau ');
      lines.push(`Are liber la ${alts}.`);
    }
    if (colleague && requestedStart) {
      lines.push(
        `Alternativ, *${colleague.name}* e liber${dayLabel ? ` ${dayLabel}` : ''} chiar la ${timeLabel}, dacă vrei să mergem la el/ea.`,
      );
    }
  }

  lines.push('');
  options.forEach((opt, i) => {
    lines.push(`${i + 1}️⃣ ${opt.title}`);
  });

  return { text: lines.join('\n'), options };
}

/**
 * Build fallback when preferred staff is busy at the exact requested time.
 * Single-employee / no-colleague guard: omit colleague section when empty.
 *
 * @param {Object} params
 * @param {Business} params.business
 * @param {{ id: string, name?: string, duration_minutes?: number }} params.service
 * @param {string} params.preferredEmployeeId
 * @param {Date} params.requestedStart
 * @param {Date} params.requestedEnd
 * @param {string | null} [params.draftId]
 * @param {string | null} [params.requestId]
 * @param {'ro' | 'en'} [params.lang]
 */
export async function buildColleagueFallbackOffer({
  business,
  service,
  preferredEmployeeId,
  requestedStart,
  requestedEnd,
  draftId = null,
  requestId = null,
  lang = 'ro',
}) {
  const compatible = await listEmployeesForService(business.id, service.id, { activeOnly: true });
  const preferred = compatible.find((e) => e.id === preferredEmployeeId)
    || (await listEmployeesForService(business.id, null, { activeOnly: true }))
      .find((e) => e.id === preferredEmployeeId);
  if (!preferred) return null;

  const dateKey = formatDateKey(requestedStart, business.timezone || 'Europe/Bucharest');
  const dayStart = new Date(`${dateKey}T00:00:00.000Z`);
  // Broad window for FreeBusy — local midnight-ish coverage via ±1 day UTC pad
  const timeMin = new Date(requestedStart.getTime() - 12 * 3600_000).toISOString();
  const timeMax = new Date(requestedStart.getTime() + 36 * 3600_000).toISOString();

  const calendarItems = compatible
    .map((emp) => ({
      employee: emp,
      calendarId: resolveEmployeeCalendarId(business, emp, { allowBusinessFallback: false }),
    }))
    .filter((row) => row.calendarId);

  const batch = calendarItems.length
    ? await queryFreeBusyBatch({
      business,
      timeMinIso: timeMin,
      timeMaxIso: timeMax,
      calendarIds: calendarItems.map((r) => /** @type {string} */ (r.calendarId)),
      requestId,
    })
    : { ok: true, calendars: {} };

  /** @type {Employee | null} */
  let colleague = null;
  if (compatible.length > 1 && batch.ok) {
    for (const row of calendarItems) {
      if (row.employee.id === preferred.id) continue;
      const busy = batch.calendars[/** @type {string} */ (row.calendarId)]?.busy || [];
      if (isIntervalFreeInBusyBlocks(requestedStart, requestedEnd, busy)) {
        colleague = row.employee;
        break;
      }
    }
  }

  const duration = Number(service.duration_minutes) || 30;
  const preferredSlots = await getAvailableSlots({
    business,
    durationMinutes: duration,
    limit: 8,
    excludeDraftId: draftId,
    employeeId: preferred.id,
    dateKey,
  });
  const preferredAlts = preferredSlots
    .map((s) => s.start)
    .filter((start) => Math.abs(start.getTime() - requestedStart.getTime()) > 60_000)
    .slice(0, 2);

  // Guard: nothing useful to offer
  if (!preferredAlts.length && !colleague) return null;

  const formatted = formatColleagueFallbackMessage({
    preferred,
    preferredAlts,
    colleague,
    requestedStart,
    timezone: business.timezone || 'Europe/Bucharest',
    lang,
  });

  if (!formatted.options.length || !formatted.text) return null;

  return {
    preferred,
    colleague,
    preferredAlts,
    text: formatted.text,
    options: formatted.options,
  };
}
