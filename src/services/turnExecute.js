/**
 * Step 2 — Backend execution / single source of truth.
 * Hours, catalog duration, calendar and DB writes happen here.
 * Returns a HandlerResult; never sends WhatsApp.
 */

import { getAvailableSlots, isSlotAvailable } from '../db/cacheService.js';
import {
  getActiveDraftBooking,
  setSelectedService,
  setDraftEmployee,
  claimSlotForDraft,
  confirmDraftBooking,
  cancelActiveDraftsForPhone,
  startBrowsingFlow,
  listUpcomingConfirmedBookings,
  getDraftBookingById,
  cancelOrResetDraft,
  rescheduleConfirmedBookingAtomic,
  cancelConfirmedBookingAtomic,
} from '../db/draftBookingService.js';
import {
  CONVERSATION_STEPS,
  setConversationStep,
  resetConversationState,
  getOrCreateConversationState,
  readLastMenu,
} from '../db/conversationStateService.js';
import {
  getClientByPhone,
  updateClientDisplayName,
  parseClientNameReply,
} from '../db/clientService.js';
import {
  listEmployees,
  getEmployeeById,
  resolveEmployeeCalendarId,
} from '../db/employeeService.js';
import {
  formatSlotLabel,
  encodeSlotId,
  decodeSlotId,
  getBookingConfig,
  formatBusinessHoursText,
  getConfiguredBusinessHours,
  formatDateKey,
  formatTime,
  localToUtc,
} from '../utils/datetime.js';
import { formatRomanianDate } from '../lib/ai/responseFormatter.js';
import {
  listOpenDayWindows,
  listTimeWindows,
  buildListPickerPage,
  formatDayGridMessage,
  formatTimeGridMessage,
  GRID_PREFIX,
  QUICK_REPLY_MAX,
  mergeMenuOptions,
} from '../utils/bookingGrid.js';
import { createFlowToken, flowsEnabled, getConfiguredFlowId } from './whatsappFlowService.js';
import {
  assertWithinWorkingHours,
  durationMissingClientMessage,
  hasConfiguredOpenDay,
  hoursUnsetClientMessage,
  outOfHoursNotice,
  pickAnotherDayNotice,
  resolveServiceDurationMinutes,
  timeWindowFullNotice,
  timeWindowForDate,
  timeWindowOutsideHoursNotice,
  unknownInfoClientMessage,
  getHoursForDate,
} from '../utils/workingHours.js';
import { normalizeTimeWindow, timeWindowLabel } from '../utils/timeWindow.js';
import {
  lookupBusinessInfo,
  formatBusinessInfoReply,
  missingBusinessInfoMessage,
} from '../utils/businessInfoLookup.js';
import { detectClientLanguage } from '../utils/clientLanguage.js';
import {
  detectModificationIntent,
  refersToSavedAppointments,
  looksLikeCancelAll,
  looksLikeExplicitSavedReschedule,
  looksLikeInFlightRevision,
  looksLikeTimeOnlyRevision,
} from './intentTriageService.js';
import {
  isInFlightBookingContext,
  serviceFromInFlightContext,
} from './inFlightBookingSession.js';
import { getPendingTtlMinutes } from '../config/conversationConfig.js';
import { buildBookingCalendarInvite } from '../utils/calendarLink.js';
import { buildContactLinkButtons } from '../utils/businessMessages.js';
import { waServiceMeta } from '../utils/waCopy.js';
import { getBusinessContactInfo } from './contactService.js';
import { createCallbackRequest } from '../db/callbackRequestService.js';
import { optInClientAfterBooking } from './smsMarketingService.js';
import { expirePendingIfNeeded } from './pendingExpiryService.js';
import { clearPendingOffer } from './pendingOfferService.js';
import { BOOKING_PREFIXES, MOD_PREFIX } from './flowIds.js';
import {
  lazySyncCalendar,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  resolveCalendarEventId,
  isBusinessMockMode,
  isMockEventId,
} from './googleCalendarService.js';
import { handlerResult } from './handlerResult.js';
import {
  BOOKING_WAIT,
  CLARIFY_IDS,
  clarificationPrompt,
  dateKeyFromDayNumber,
  getBookingWait,
  timeFromHourNumber,
} from './bookingWaitState.js';
import { resolveTargetAppointment, buildAppointmentChoiceMenu, nextRescheduleSlotStep } from '../utils/appointmentMatch.js';
import {
  MACHINE_ACTIONS,
  hydrateCatalogService,
  mapSessionState,
  nextActionFromDraft,
  persistSessionDraft,
  readDraftBooking,
  reduceBookingTurn,
  sessionKeepsChosenService,
  sessionAllowsPendingWhen,
} from '../lib/booking/stateMachine.js';

/** @typedef {import('../db/businessService.js').Business} Business */
/** @typedef {import('./turnExtract.js').TurnExtract} TurnExtract */
/** @typedef {import('./handlerResult.js').HandlerResult} HandlerResult */

const PREFIX = BOOKING_PREFIXES;

function draftEmployeeId(draft) {
  if (!draft) return null;
  if (draft.employee_id) return draft.employee_id;
  const ctxEmp = draft.conversation_context?.employee_id;
  return typeof ctxEmp === 'string' ? ctxEmp : null;
}

function catalogDuration(business, service) {
  return resolveServiceDurationMinutes(business, service);
}

export function isFreshMenuStart(extract) {
  return extract?.source === 'menu'
    && !extract.date_text
    && !extract.time_text
    && !extract.datetime
    && !extract.slot_id
    && !extract.service_id
    && !extract.service_name;
}

/**
 * Cold "programare" / keyword book with no when — wipe leftovers, never glue Feb onto a new ask.
 * @param {object} extract
 */
export function isCleanSlateBooking(extract) {
  if (isFreshMenuStart(extract)) return true;
  if (extract?.action !== 'book') return false;
  if (extract.date_text || extract.time_text || extract.datetime || extract.slot_id) return false;
  // Naming a service is not a wipe — mid-flow service change must keep the chosen day.
  if (extract.service_id || extract.service_name) return false;
  const src = extract?.source;
  return src === 'keyword' || src === 'nlu' || src === 'parser' || src === 'menu';
}

/** Absolute calendar day from a list row (day_YYYY-MM-DD) — must beat leftover draft_booking. */
export function isStructuredDayPick(extract) {
  return extract?.source === 'menu'
    && typeof extract?.date_text === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(extract.date_text)
    && !extract.slot_id
    && !extract.time_text;
}

/** Absolute slot tap (slot_YYYYMMDD_HHMM) — encodes its own date+time. */
export function isStructuredSlotPick(extract) {
  return extract?.source === 'menu' && typeof extract?.slot_id === 'string' && extract.slot_id.startsWith('slot_');
}

/** Ephemeral booking fields that must not survive a clean slate / reset. */
export function bookingEphemeralContextNulls() {
  return {
    pending_date_text: null,
    pending_time_text: null,
    pending_time_window: null,
    pending_datetime: null,
    pending_slot_id: null,
    last_menu: null,
    grid_kind: null,
    grid_page: null,
    booking_wait: null,
    clarification: null,
    clarified: null,
  };
}

export function hydrateExtract(extract, convState, timezone) {
  const ctx = convState?.context_data || {};
  const next = { ...extract };
  const sessionState = mapSessionState(convState?.current_step);
  const keepService = sessionKeepsChosenService(sessionState);
  const allowPendingWhen = sessionAllowsPendingWhen(sessionState);

  if (isCleanSlateBooking(extract)) {
    next.date_text = null;
    next.time_text = null;
    next.time_window = null;
    next.datetime = null;
    next.slot_id = null;
    // Fresh "programare" never reuses an abandoned service either.
    if (!keepService) {
      next.service_id = null;
      next.service_name = null;
    }
    return next;
  }

  // Slot list taps are absolute — never paste a leftover pending_date (e.g. 9 Feb)
  // on top of a newly chosen day/slot (e.g. 2 Sep). That caused confirmations on the wrong month.
  if (next.slot_id && timezone) {
    const decoded = decodeSlotId(next.slot_id, timezone);
    if (decoded && !Number.isNaN(decoded.getTime())) {
      next.datetime = decoded;
      next.date_text = formatDateKey(decoded, timezone);
      next.time_text = formatTime(decoded, timezone);
      next.time_window = null;
    }
    if (!next.service_id && keepService && typeof ctx.pending_service_id === 'string') {
      next.service_id = ctx.pending_service_id;
    }
    if (!next.employee_id && typeof ctx.pending_employee_id === 'string') {
      next.employee_id = ctx.pending_employee_id;
    }
    if (!next.appointment_id && typeof ctx.appointment_id === 'string') {
      next.appointment_id = ctx.appointment_id;
    }
    return next;
  }

  // Structured day row — keep the tapped date; do not revive an old pending_slot / time.
  if (isStructuredDayPick(next)) {
    next.time_text = null;
    next.time_window = null;
    next.datetime = null;
    next.slot_id = null;
    if (!next.service_id && keepService && typeof ctx.pending_service_id === 'string') {
      next.service_id = ctx.pending_service_id;
    }
    if (!next.employee_id && typeof ctx.pending_employee_id === 'string') {
      next.employee_id = ctx.pending_employee_id;
    }
    return next;
  }

  const turnHasDate = Boolean(extract.date_text);
  const turnHasTime = Boolean(extract.time_text);
  const turnHasWindow = Boolean(extract.time_window);

  // Explicit free-text when ("mâine la 13" / "15 octombrie la 10") — ignore leftover when/slot.
  if (turnHasDate && turnHasTime) {
    next.slot_id = null;
    next.time_window = null;
    if (!next.service_id && keepService && typeof ctx.pending_service_id === 'string') {
      next.service_id = ctx.pending_service_id;
    }
    if (!next.employee_id && typeof ctx.pending_employee_id === 'string') {
      next.employee_id = ctx.pending_employee_id;
    }
    if (timezone) {
      next.datetime = localToUtc(next.date_text, next.time_text, timezone);
    }
    return next;
  }

  // Only mid-flight waits inherit pending day/time — never IDLE leftovers.
  if (allowPendingWhen && !turnHasDate && typeof ctx.pending_date_text === 'string' && ctx.pending_date_text) {
    next.date_text = ctx.pending_date_text;
  }
  if (allowPendingWhen && !turnHasTime && typeof ctx.pending_time_text === 'string' && ctx.pending_time_text) {
    const dateChanged = turnHasDate && typeof ctx.pending_date_text === 'string' && extract.date_text !== ctx.pending_date_text;
    if (!dateChanged) {
      next.time_text = ctx.pending_time_text;
    }
  }
  if (allowPendingWhen && !turnHasWindow && !next.time_text && typeof ctx.pending_time_window === 'string') {
    const dateChanged = turnHasDate && typeof ctx.pending_date_text === 'string' && extract.date_text !== ctx.pending_date_text;
    if (!dateChanged) {
      next.time_window = ctx.pending_time_window;
    }
  }
  if (next.time_text) next.time_window = null;
  if (!next.service_id && keepService && typeof ctx.pending_service_id === 'string') {
    next.service_id = ctx.pending_service_id;
  }
  if (!next.employee_id && typeof ctx.pending_employee_id === 'string') next.employee_id = ctx.pending_employee_id;
  // Never hydrate pending_slot_id — a stale slot from another day (Feb) must not ride along.
  if (!next.appointment_id && typeof ctx.appointment_id === 'string') next.appointment_id = ctx.appointment_id;

  if (next.date_text && next.time_text && timezone) {
    next.datetime = localToUtc(next.date_text, next.time_text, timezone);
  } else if (
    allowPendingWhen
    && !turnHasDate
    && !turnHasTime
    && typeof ctx.pending_datetime === 'string'
  ) {
    const d = new Date(ctx.pending_datetime);
    if (!Number.isNaN(d.getTime())) next.datetime = d;
  } else if (!next.date_text || !next.time_text) {
    next.datetime = null;
  }
  return next;
}

async function persistPendingExtract({ business, recipientPhone, extract, requestId }) {
  /** @type {Record<string, unknown>} */
  const context = {};
  const cleanSlate = isCleanSlateBooking(extract);
  if (cleanSlate) {
    Object.assign(context, bookingEphemeralContextNulls(), {
      pending_service_id: extract.service_id || null,
      draft_booking: extract.service_id
        ? {
          service_id: extract.service_id,
          service_name: extract.service_name || null,
          date: null,
          time: null,
          duration: null,
        }
        : null,
    });
  }
  if (extract.date_text) context.pending_date_text = extract.date_text;
  if (extract.time_text) {
    context.pending_time_text = extract.time_text;
    context.pending_time_window = null;
  }
  if (extract.time_window && !extract.time_text) {
    context.pending_time_window = extract.time_window;
  }
  if (extract.service_id) context.pending_service_id = extract.service_id;
  if (extract.employee_id) context.pending_employee_id = extract.employee_id;
  if (extract.slot_id) context.pending_slot_id = extract.slot_id;
  if (extract.date_text && extract.time_text && extract.datetime instanceof Date) {
    context.pending_datetime = extract.datetime.toISOString();
  } else if (extract.date_text && !extract.time_text) {
    // New day chosen (tap or free text) — drop leftover time/slot/menu from another day.
    context.pending_datetime = null;
    context.pending_time_text = null;
    context.pending_slot_id = null;
    context.pending_time_window = null;
    context.last_menu = null;
    context.grid_kind = null;
    context.grid_page = null;
  } else if (extract.date_text && extract.time_text) {
    // Explicit free-text slot — drop stale list so old Ore libere rows cannot rematch.
    context.pending_slot_id = null;
    context.last_menu = null;
  }
  if (cleanSlate || extract.service_id || extract.service_name || extract.date_text || extract.time_text || extract.slot_id) {
    const latestDraft = await getOrCreateConversationState(business.id, recipientPhone);
    const prevDraft = latestDraft.context_data?.draft_booking && typeof latestDraft.context_data.draft_booking === 'object'
      ? /** @type {Record<string, unknown>} */ (latestDraft.context_data.draft_booking)
      : {};
    const keepService = Boolean(extract.service_id || extract.service_name)
      || sessionKeepsChosenService(mapSessionState(latestDraft.current_step));
    context.draft_booking = {
      ...prevDraft,
      ...(extract.service_id ? { service_id: extract.service_id } : {}),
      ...(extract.service_name ? { service_name: extract.service_name } : {}),
      ...(extract.date_text ? { date: extract.date_text } : {}),
      ...(extract.time_text ? { time: extract.time_text } : {}),
      // Day-only pick must wipe leftover clock time from another day.
      ...(extract.date_text && !extract.time_text && !extract.slot_id ? { time: null } : {}),
      ...((cleanSlate || !keepService)
        ? { service_id: extract.service_id || null, service_name: extract.service_name || null, duration: null }
        : {}),
      ...(cleanSlate && !extract.date_text ? { date: null, time: null } : {}),
    };
  }
  if (!Object.keys(context).length) return;

  const latest = await getOrCreateConversationState(business.id, recipientPhone);
  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: latest.current_step,
    context,
    mergeContext: true,
    requestId,
  });
}

function serviceMenu(business) {
  return {
    kind: 'service',
    options: getBookingConfig(business).services.slice(0, 10).map((s) => {
      const meta = waServiceMeta(s);
      return {
        id: `${PREFIX.SERVICE}${s.id}`,
        title: String(s.name || 'Serviciu').slice(0, 24),
        description: (meta || 'Disponibil').slice(0, 72),
      };
    }),
  };
}

/** Quick-replies after an unknown service: catalog again + human callback. */
function unknownServiceOfferMenu(business) {
  return {
    kind: 'unknown_service',
    options: [
      { id: 'show_services', title: 'Vezi servicii' },
      { id: 'offer_callback', title: 'Contactează-mă' },
    ],
    catalog: [
      ...serviceMenu(business).options,
      { id: 'show_services', title: 'Vezi servicii' },
      { id: 'offer_callback', title: 'Contactează-mă' },
    ],
  };
}

function slotMenu(slots, timezone) {
  return {
    kind: 'slot',
    options: slots.slice(0, 10).map((s) => ({
      id: s.id,
      title: formatSlotLabel(s.start, timezone),
    })),
  };
}

function employeeMenu(employees) {
  return {
    kind: 'employee',
    options: [
      ...employees.slice(0, 9).map((e) => ({ id: `${PREFIX.EMPLOYEE}${e.id}`, title: e.name })),
      { id: PREFIX.ANY_EMPLOYEE, title: 'Primul disponibil' },
    ],
  };
}

function confirmMenu() {
  return {
    kind: 'confirm',
    options: [
      { id: PREFIX.CONFIRM, title: 'Confirmă' },
      { id: PREFIX.CANCEL, title: 'Anulează' },
    ],
  };
}

function entryMenu(business) {
  const buttons = (business.menu_buttons ?? []).slice(0, 3).map((btn) => ({
    id: btn.id,
    title: String(btn.label || '').slice(0, 20),
  }));
  return buttons.length
    ? { kind: 'entry', options: buttons.map(({ id, title }) => ({ id, title })) }
    : null;
}

function calendarCta(business, serviceName, start, end) {
  const invite = buildBookingCalendarInvite({
    business,
    serviceName: serviceName || 'Programare',
    startIso: start,
    endIso: end,
  });
  if (!invite?.url) return null;
  return { url: invite.url, title: invite.buttonTitle || 'Adaugă în calendar' };
}

/**
 * Prefixes a recovery notice to a grid body, without duplicating it.
 * @param {string | null} notice
 * @param {string} body
 */
function withNotice(notice, body) {
  const head = String(notice ?? '').trim();
  const text = String(body ?? '').trim();
  if (!head) return text;
  if (!text || text.startsWith(head)) return head || text;
  return `${head}\n\n${text}`;
}

/**
 * Terminal hours error — only for cases the client cannot recover from
 * (hours not configured, invalid range).
 */
function hoursError(hoursCheck) {
  return handlerResult({
    status: 'ERROR',
    action_performed: null,
    next_required_step: null,
    user_message_template_key: 'CLOSED_HOURS',
    data: {
      reason: hoursCheck.reason,
      client_message: hoursCheck.message,
    },
  });
}

/**
 * Out-of-hours / closed-day recovery.
 *
 * Keeps the draft (service + day) and pins the conversation on the sub-step the
 * client is on, then re-offers valid times for that day — or valid days when the
 * day itself is closed. Never falls back to the main menu.
 *
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {Record<string, unknown> | null} params.draft
 * @param {{ id?: string, name?: string, duration_minutes?: number } | null} params.service
 * @param {Date} params.slotStart
 * @param {{ ok: boolean, reason: string | null, message: string | null }} params.hoursCheck
 * @param {string | null} [params.employeeId]
 * @param {'book' | 'reschedule'} [params.intent]
 * @param {Record<string, unknown>} [params.extraContext]
 * @param {string | null} [params.requestId]
 * @returns {Promise<HandlerResult>}
 */
async function hoursRecoveryResult({
  business,
  recipientPhone,
  draft,
  service,
  slotStart,
  hoursCheck,
  employeeId = null,
  intent = 'book',
  extraContext = {},
  requestId = null,
}) {
  const reason = String(hoursCheck?.reason ?? '');
  if (reason === 'hours_unset' || reason === 'invalid_range' || !slotStart) {
    return hoursError(hoursCheck);
  }

  const isReschedule = intent === 'reschedule';
  const dateKey = formatDateKey(slotStart, business.timezone);
  const notice = reason === 'outside_hours'
    ? outOfHoursNotice(business, slotStart)
    : null;

  // The rejected hour must not replay on the next turn, otherwise the client
  // gets the same notice for any reply. The service stays chosen.
  const keptService = {
    service_id: service?.id ?? null,
    service_name: service?.name ?? null,
    duration: service?.duration_minutes ?? null,
  };

  if (notice) {
    return missingSlotsResult({
      business,
      recipientPhone,
      draft,
      service,
      employeeId,
      dateKey,
      requestId,
      reasonKey: 'ASK_TIME',
      conversationStep: isReschedule
        ? CONVERSATION_STEPS.RESCHEDULING
        : CONVERSATION_STEPS.WAITING_FOR_TIME,
      extraContext: {
        ...extraContext,
        intent,
        draft_booking: { ...keptService, date: dateKey, time: null },
        pending_time_text: null,
        pending_service_id: keptService.service_id,
      },
      notice,
    });
  }

  return askDateGridResult({
    business,
    recipientPhone,
    draft,
    service,
    requestId,
    conversationStep: isReschedule
      ? CONVERSATION_STEPS.RESCHEDULING
      : CONVERSATION_STEPS.WAITING_FOR_DATE,
    extraContext: {
      ...extraContext,
      intent,
      draft_booking: { ...keptService, date: null, time: null },
      pending_date_text: null,
      pending_time_text: null,
      pending_service_id: keptService.service_id,
    },
    notice:
      pickAnotherDayNotice(business, slotStart, reason)
      || hoursCheck.message
      || null,
  });
}

async function listActionableAppointments(business, recipientPhone, requestId) {
  const appointments = await listUpcomingConfirmedBookings(business.id, recipientPhone);
  if (isBusinessMockMode(business)) return appointments;
  /** @type {typeof appointments} */
  const actionable = [];
  for (const appointment of appointments) {
    if (appointment.google_event_id && !isMockEventId(appointment.google_event_id)) {
      actionable.push(appointment);
      continue;
    }
    await cancelOrResetDraft({
      draftId: appointment.id,
      businessId: business.id,
      state: 'cancelled',
      context: {
        ...appointment.conversation_context,
        step: 'auto_cancelled_orphan_mock',
      },
      requestId,
    });
  }
  return actionable;
}

/**
 * Pick the appointment the client means (id / single / date-time NLP hint).
 * @param {object[]} appointments
 * @param {TurnExtract} extract
 * @param {import('../db/conversationStateService.js').ConversationState} convState
 * @param {Business} business
 * @param {'cancel' | 'reschedule'} mode
 */
function resolveAppointmentForModify(appointments, extract, convState, business, mode) {
  return resolveTargetAppointment(
    appointments,
    {
      appointmentId: extract.appointment_id || convState.context_data?.appointment_id || null,
      dateKey: extract.date_text,
      timeHHmm: extract.time_text,
      serviceName: extract.service_name,
    },
    business.timezone || 'Europe/Bucharest',
    mode,
    {
      forceChoice: Boolean(extract.cancel_all || extract.vague_choice || extract.action === 'cancel_all'),
    },
  );
}

function appointmentChoiceMenu(appointments, business, { includeCancelAll = false } = {}) {
  return buildAppointmentChoiceMenu(appointments, business.timezone, {
    includeCancelAll,
    apptPrefix: MOD_PREFIX.APPT,
    cancelAllId: MOD_PREFIX.CANCEL_ALL,
  });
}

/**
 * Persist the interactive appointment picker and lock the conversation on CHOOSE_APPOINTMENT.
 * last_menu is stored here so a numbered reply still works if the Twilio list is not tapped.
 */
async function askWhichAppointment({
  business,
  recipientPhone,
  appointments,
  intent,
  requestId,
  clientMessage = null,
  includeCancelAll = false,
  extraContext = {},
}) {
  const options = appointmentChoiceMenu(appointments, business, { includeCancelAll });
  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: CONVERSATION_STEPS.MODIFYING,
    context: {
      intent,
      appointment_ids: appointments.map((a) => a.id),
      last_menu: { kind: 'modify', options },
      ...extraContext,
    },
    mergeContext: false,
    requestId,
  });
  return handlerResult({
    status: 'MISSING_INFO',
    next_required_step: 'CHOOSE_APPOINTMENT',
    user_message_template_key: 'MISSING_APPOINTMENT',
    data: {
      intent,
      appointments: options,
      client_message: clientMessage,
      list_button: 'Programările tale',
    },
    menu: { kind: 'modify', options, catalog: options },
  });
}

async function resolveStaff(business, draftOrAppt) {
  const empId = draftEmployeeId(draftOrAppt);
  const employee = empId ? await getEmployeeById(empId, business.id) : null;
  return {
    employeeId: empId,
    employee,
    calendarId: resolveEmployeeCalendarId(business, employee),
  };
}

async function ensureDraft({ business, recipientPhone, clientId, requestId, activeDraft, convState = null }) {
  if (activeDraft && ['browsing', 'pending_confirmation'].includes(activeDraft.state)) {
    return activeDraft;
  }
  const draftId = typeof convState?.context_data?.draft_id === 'string'
    ? convState.context_data.draft_id
    : null;
  if (draftId) {
    const byId = await getDraftBookingById(draftId, business.id);
    if (byId && ['browsing', 'pending_confirmation'].includes(String(byId.state || ''))) {
      return byId;
    }
  }
  const live = await getActiveDraftBooking(business.id, recipientPhone);
  if (live && ['browsing', 'pending_confirmation'].includes(String(live.state || ''))) {
    return live;
  }
  return startBrowsingFlow({
    businessId: business.id,
    clientId,
    rawPhone: recipientPhone,
    requestId,
  });
}

/**
 * Service for the in-progress booking — draft row, then conversation context.
 * Never ask "Ce serviciu dorești?" again while context still holds the chosen service.
 *
 * @param {Business} business
 * @param {Object} params
 * @param {Record<string, unknown> | null | undefined} [params.extract]
 * @param {{ selected_service?: unknown } | null} [params.activeDraft]
 * @param {{ selected_service?: unknown } | null} [params.draft]
 * @param {import('../db/conversationStateService.js').ConversationState | null | undefined} [params.convState]
 */
function resolveServiceForBooking(business, { extract, activeDraft, draft, convState }) {
  const catalog = getBookingConfig(business).services;
  if (extract?.service_id) {
    const hit = catalog.find((s) => s.id === extract.service_id);
    if (hit) return hit;
  }
  if (extract?.service_name) {
    const hit = catalog.find((s) => String(s.name || '').toLowerCase() === String(extract.service_name).toLowerCase());
    if (hit) return hit;
  }

  const asService = (value) => {
    if (!value || typeof value !== 'object') return null;
    const row = /** @type {{ id?: string, name?: string, duration_minutes?: number, service_id?: string, service_name?: string, duration?: number }} */ (value);
    const id = row.id || row.service_id || null;
    const name = row.name || row.service_name || null;
    if (!id && !name) return null;
    if (id) {
      const hit = catalog.find((s) => s.id === id);
      if (hit) return hit;
    }
    if (name) {
      const hit = catalog.find((s) => String(s.name || '').toLowerCase() === String(name).toLowerCase());
      if (hit) return hit;
    }
    return {
      id: id || undefined,
      name: name || 'Serviciu',
      duration_minutes: row.duration_minutes ?? row.duration ?? 30,
    };
  };

  return asService(activeDraft?.selected_service)
    || asService(draft?.selected_service)
    || asService(convState?.context_data?.service)
    || asService(convState?.context_data?.draft_booking);
}

async function listSlotsForService({
  business,
  service,
  draftId,
  employeeId,
  requestId,
  dateKey = null,
  timeWindow = null,
  /** Per-day: fetch the full free day (not a short preview). */
  limit = 8,
  excludeGoogleEventIds = null,
}) {
  if (!hasConfiguredOpenDay(business)) return { error: hoursUnsetClientMessage(), slots: [] };
  const duration = catalogDuration(business, service);
  if (!duration) return { error: durationMissingClientMessage(service?.name), slots: [] };

  const employee = employeeId ? await getEmployeeById(employeeId, business.id) : null;
  await lazySyncCalendar({
    business,
    requestId,
    calendarId: resolveEmployeeCalendarId(business, employee),
    employeeId,
  });
  // A full open day at 15-min steps can exceed 30 slots — never truncate early.
  const fetchLimit = dateKey ? Math.max(Number(limit) || 0, 64) : Math.max(Number(limit) || 8, 12);
  const slots = await getAvailableSlots({
    business,
    durationMinutes: duration,
    limit: fetchLimit,
    excludeDraftId: draftId,
    employeeId,
    dateKey: dateKey || null,
    timeWindow: timeWindow || null,
    excludeGoogleEventIds,
  });
  return { error: null, slots: slots.slice(0, fetchLimit), duration };
}

/**
 * Open days in the 14-day horizon that still have ≥1 free slot for this service.
 * Fully booked (or closed) days are omitted from the picker.
 */
async function listBookableDayWindows({
  business,
  service,
  draftId = null,
  employeeId = null,
  requestId = null,
}) {
  const openDays = listOpenDayWindows(business, { limit: 14 });
  if (!openDays.length) return [];
  const duration = catalogDuration(business, service);
  if (!duration) return openDays;

  const employee = employeeId ? await getEmployeeById(employeeId, business.id) : null;
  await lazySyncCalendar({
    business,
    requestId,
    calendarId: resolveEmployeeCalendarId(business, employee),
    employeeId,
  });

  const checks = await Promise.all(openDays.map(async (day) => {
    const slots = await getAvailableSlots({
      business,
      durationMinutes: duration,
      limit: 1,
      excludeDraftId: draftId,
      employeeId,
      dateKey: day.dateKey,
    });
    return slots.length > 0 ? day : null;
  }));
  return checks.filter(Boolean);
}

async function missingService(business, recipientPhone, draft, requestId) {
  const services = getBookingConfig(business).services;
  if (!services.length) {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_GENERIC',
      data: { client_message: unknownInfoClientMessage() },
    });
  }
  const menu = serviceMenu(business);
  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: CONVERSATION_STEPS.WAITING_FOR_SERVICE,
    context: {
      draft_id: draft?.id,
      intent: 'book',
      booking_wait: BOOKING_WAIT.SERVICE,
      last_menu: menu,
    },
    requestId,
  });
  return handlerResult({
    status: 'MISSING_INFO',
    action_performed: null,
    next_required_step: 'CHOOSE_SERVICE',
    user_message_template_key: 'MISSING_SERVICE',
    data: {
      services: services.slice(0, 10).map((s) => ({
        id: s.id,
        name: s.name,
        duration_minutes: s.duration_minutes,
        price_ron: s.price_ron ?? null,
      })),
      list_button: 'Servicii',
      ui: 'list_picker',
    },
    menu,
    machine_action: MACHINE_ACTIONS.ACTION_ASK_SERVICE,
  });
}

async function askDateGridResult({
  business,
  recipientPhone,
  draft,
  service,
  requestId,
  page = 0,
  clientMessage = null,
  conversationStep = CONVERSATION_STEPS.WAITING_FOR_DATE,
  extraContext = {},
  notice = null,
}) {
  const intent = extraContext.intent || 'book';
  // Richer Meta Flow UI when the tenant has published a WhatsApp Flow.
  // A notice must stay visible, so keep the text grid in that case.
  if (flowsEnabled(business) && page === 0 && !clientMessage && !notice && intent !== 'reschedule') {
    const flowId = getConfiguredFlowId(business);
    const body = service?.name
      ? `🗓️ Deschide calendarul pentru *${service.name}* — alege ziua și ora liberă.`
      : '🗓️ Deschide calendarul — alege ziua și ora liberă.';
    await setConversationStep({
      businessId: business.id,
      rawPhone: recipientPhone,
      step: CONVERSATION_STEPS.WAITING_FOR_DATE,
      context: {
        draft_id: draft?.id,
        intent: 'book',
        service,
        booking_wait: BOOKING_WAIT.DATE,
        grid_kind: 'flow',
        flow_id: flowId,
      },
      requestId,
    });
    return handlerResult({
      status: 'MISSING_INFO',
      next_required_step: 'CHOOSE_DATE',
      user_message_template_key: 'ASK_DATE',
      data: {
        service_name: service?.name,
        client_message: body,
        ui: 'whatsapp_flow',
        flow_id: flowId,
        flow_token: createFlowToken(business.id),
      },
      menu: null,
      machine_action: MACHINE_ACTIONS.ACTION_ASK_DATE,
    });
  }

  const days = await listBookableDayWindows({
    business,
    service,
    draftId: draft?.id,
    employeeId: draftEmployeeId(draft),
    requestId,
  });
  if (!days.length) {
    return handlerResult({
      status: 'MISSING_INFO',
      next_required_step: 'CHOOSE_DATE',
      user_message_template_key: 'ASK_DATE',
      data: {
        service_name: service?.name,
        client_message: withNotice(
          notice,
          `Nu am zile cu ore libere în următoarele 14 zile. Contactează ${business.name || 'locația'} sau încearcă mai târziu.`,
        ),
      },
      machine_action: MACHINE_ACTIONS.ACTION_ASK_DATE,
    });
  }
  const listPage = buildListPickerPage(days, page);
  const body = withNotice(
    notice,
    clientMessage || formatDayGridMessage(days, business.timezone, service?.name),
  );
  const pageOptions = listPage.items.map((i) => ({
    id: i.id,
    title: i.title,
    description: i.description,
  }));
  const catalog = days.map((d) => ({ id: d.id, title: d.title, description: d.description }));
  const menuOptions = mergeMenuOptions(pageOptions, catalog);
  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: conversationStep,
    context: {
      ...extraContext,
      draft_id: draft?.id,
      service,
      booking_wait: BOOKING_WAIT.DATE,
      grid_kind: 'day',
      grid_page: listPage.page,
      intent,
      last_menu: {
        kind: 'day_grid',
        options: menuOptions,
      },
    },
    requestId,
  });
  return handlerResult({
    status: 'MISSING_INFO',
    next_required_step: 'CHOOSE_DATE',
    user_message_template_key: 'ASK_DATE',
    data: {
      service_name: service?.name,
      client_message: body,
      grid_page: listPage.page,
      ui: 'list_picker',
      list_button: 'Zile disponibile',
    },
    menu: {
      kind: 'day_grid',
      options: pageOptions,
      catalog,
    },
    machine_action: MACHINE_ACTIONS.ACTION_ASK_DATE,
  });
}

async function missingSlotsResult({
  business,
  recipientPhone,
  draft,
  service,
  employeeId,
  dateKey,
  requestId,
  reasonKey = 'MISSING_SLOT',
  occupiedLabel = null,
  conversationStep = CONVERSATION_STEPS.WAITING_FOR_TIME,
  extraContext = {},
  timeWindow = null,
  page = 0,
  notice = null,
}) {
  // "mâine seara" is a day-part, not a clock time: clip it to the Admin hours of that
  // date, and when nothing free is left inside it fall back to the whole day with a
  // notice instead of dropping the client back to the day picker.
  let windowFilter = normalizeTimeWindow(timeWindow);
  let windowNotice = null;
  if (windowFilter && dateKey) {
    const clipped = timeWindowForDate(business, dateKey, windowFilter);
    if (clipped && !clipped.overlaps) {
      windowNotice = timeWindowOutsideHoursNotice(business, dateKey, windowFilter);
      windowFilter = null;
    }
  }
  let listed = await listSlotsForService({
    business,
    service,
    draftId: draft?.id,
    employeeId,
    requestId,
    dateKey,
    timeWindow: windowFilter,
  });
  if (!listed.error && windowFilter && !listed.slots.length) {
    const wholeDay = await listSlotsForService({
      business,
      service,
      draftId: draft?.id,
      employeeId,
      requestId,
      dateKey,
      timeWindow: null,
    });
    if (!wholeDay.error && wholeDay.slots.length) {
      windowNotice = timeWindowFullNotice(business, dateKey, windowFilter);
      windowFilter = null;
      listed = wholeDay;
    }
  }
  const bodyNotice = notice || windowNotice;
  if (listed.error) {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_GENERIC',
      data: { client_message: listed.error },
    });
  }
  const times = listTimeWindows(listed.slots, business.timezone);
  const listPage = buildListPickerPage(times, page);
  const datePretty = dateKey ? formatRomanianDate(dateKey, business.timezone) : null;
  const body = withNotice(
    bodyNotice,
    formatTimeGridMessage(times, dateKey, business.timezone, service?.name),
  );
  const useQuickReply = times.length > 0 && times.length <= QUICK_REPLY_MAX && listPage.pageCount <= 1;
  const pageOptions = useQuickReply
    ? times.map((t) => ({ id: t.id, title: t.title }))
    : listPage.items.map((i) => ({ id: i.id, title: i.title, description: i.description }));
  const catalog = times.map((t) => ({ id: t.id, title: t.title, description: t.description }));
  const menuOptions = mergeMenuOptions(pageOptions, catalog);

  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: conversationStep,
    context: {
      ...extraContext,
      draft_id: draft?.id,
      intent: extraContext.intent || 'book',
      service,
      booking_wait: dateKey || windowFilter ? BOOKING_WAIT.TIME : BOOKING_WAIT.DATE,
      pending_time_window: windowFilter || null,
      // Must win over extraContext — otherwise Alte opțiuni resets to page 0 / day grid.
      grid_kind: 'time',
      grid_page: listPage.page,
      last_menu: {
        kind: 'time_grid',
        options: menuOptions,
      },
      pending_date_text: dateKey || extraContext.pending_date_text || null,
    },
    requestId,
  });
  if (!listed.slots.length) {
    return askDateGridResult({
      business,
      recipientPhone,
      draft,
      service,
      requestId,
      conversationStep: extraContext.intent === 'reschedule'
        ? CONVERSATION_STEPS.RESCHEDULING
        : CONVERSATION_STEPS.WAITING_FOR_DATE,
      extraContext: extraContext.intent === 'reschedule' ? extraContext : {},
      notice: bodyNotice,
      clientMessage:
        `Nu am găsit ore libere pentru *${service?.name || 'serviciu'}*` +
        (datePretty ? ` pe *${datePretty}*` : '') +
        '.\n\n' +
        formatDayGridMessage(listOpenDayWindows(business), business.timezone, service?.name),
    });
  }
  return handlerResult({
    status: 'MISSING_INFO',
    next_required_step: 'CHOOSE_SLOT',
    user_message_template_key: reasonKey,
    data: {
      service_name: service?.name,
      occupied_label: occupiedLabel,
      date_label: datePretty,
      time_window: windowFilter,
      notice: bodyNotice || null,
      client_message: body,
      alternatives: listed.slots.map((s) => ({
        id: s.id,
        label: formatSlotLabel(s.start, business.timezone),
        time: formatTime(s.start, business.timezone),
      })),
      grid_page: listPage.page,
      ui: useQuickReply ? 'quick_reply' : 'list_picker',
      list_button: 'Ore libere',
    },
    menu: {
      kind: 'time_grid',
      options: pageOptions,
      catalog,
    },
    machine_action: reasonKey === 'SLOT_UNAVAILABLE'
      ? MACHINE_ACTIONS.ACTION_SLOT_UNAVAILABLE
      : MACHINE_ACTIONS.ACTION_ASK_TIME,
  });
}

async function afterHold({ business, recipientPhone, draft, service, slotStart, slotEnd, requestId }) {
  // Never show Confirmă/Anulează unless the slot is soft-locked in DB.
  if (!draft?.id || draft.state !== 'pending_confirmation' || !draft.selected_slot_start) {
    console.error('[booking] afterHold refused: draft is not pending_confirmation', {
      draftId: draft?.id ?? null,
      state: draft?.state ?? null,
      hasSlot: Boolean(draft?.selected_slot_start),
      requestId,
    });
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_GENERIC',
      data: {
        client_message:
          'Nu am putut bloca intervalul în sistem. Te rog alege din nou ora.',
      },
    });
  }

  const client = await getClientByPhone({
    businessId: business.id,
    rawPhone: recipientPhone,
    requestId,
  });
  const empId = draftEmployeeId(draft);
  const employee = empId ? await getEmployeeById(empId, business.id) : null;
  const slotLabel = formatSlotLabel(slotStart, business.timezone);

  if (!client?.display_name) {
    await setConversationStep({
      businessId: business.id,
      rawPhone: recipientPhone,
      step: CONVERSATION_STEPS.ASKING_NAME,
    context: {
        draft_id: draft.id,
        service,
        slot_start: slotStart.toISOString(),
        slot_end: slotEnd.toISOString(),
        intent: 'book',
        awaiting_name: true,
        booking_wait: BOOKING_WAIT.CONFIRMATION,
        draft_booking: {
          service_id: service.id || null,
          service_name: service.name,
          date: formatDateKey(slotStart, business.timezone),
          time: formatTime(slotStart, business.timezone),
          duration: catalogDuration(business, service),
        },
        pending_date_text: formatDateKey(slotStart, business.timezone),
        pending_time_text: formatTime(slotStart, business.timezone),
      },
      requestId,
    });
    return handlerResult({
      status: 'SUCCESS',
      action_performed: 'SLOT_HELD',
      next_required_step: 'ASK_NAME',
      user_message_template_key: 'ASK_NAME',
      data: {
        service_name: service.name,
        slot_label: slotLabel,
        employee_name: employee?.name ?? null,
      },
    });
  }

  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: CONVERSATION_STEPS.WAITING_FOR_CONFIRMATION,
    context: {
        draft_id: draft.id,
        service,
        slot_start: slotStart.toISOString(),
        slot_end: slotEnd.toISOString(),
        intent: 'book',
        booking_wait: BOOKING_WAIT.CONFIRMATION,
        last_menu: confirmMenu(),
        draft_booking: {
          service_id: service.id || service.service_id || null,
          service_name: service.name,
          date: formatDateKey(slotStart, business.timezone),
          time: formatTime(slotStart, business.timezone),
          duration: catalogDuration(business, service),
        },
        pending_date_text: formatDateKey(slotStart, business.timezone),
        pending_time_text: formatTime(slotStart, business.timezone),
      },
    requestId,
  });
  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'SLOT_HELD',
    next_required_step: 'CONFIRM',
    user_message_template_key: 'ASK_CONFIRM',
    data: {
      service_name: service.name,
      slot_label: slotLabel,
      employee_name: employee?.name ?? null,
      client_name: client.display_name,
      date_key: formatDateKey(slotStart, business.timezone),
      time_hhmm: formatTime(slotStart, business.timezone),
    },
    menu: confirmMenu(),
    machine_action: MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION,
  });
}

async function holdRequestedSlot({
  business,
  recipientPhone,
  draft,
  service,
  slotStart,
  employeeId,
  requestId,
}) {
  const duration = catalogDuration(business, service);
  if (!duration) {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_DURATION',
      data: { client_message: durationMissingClientMessage(service?.name) },
    });
  }
  const slotEnd = new Date(slotStart.getTime() + duration * 60_000);
  const hoursCheck = assertWithinWorkingHours(business, slotStart, slotEnd);
  if (!hoursCheck.ok) {
    return hoursRecoveryResult({
      business,
      recipientPhone,
      draft,
      service,
      slotStart,
      hoursCheck,
      employeeId: employeeId || draftEmployeeId(draft),
      intent: 'book',
      requestId,
    });
  }

  const slotId = encodeSlotId(slotStart, business.timezone);
  const { employee } = await resolveStaff(business, { ...draft, employee_id: employeeId || draftEmployeeId(draft) });
  await lazySyncCalendar({
    business,
    requestId,
    calendarId: resolveEmployeeCalendarId(business, employee),
    employeeId: employeeId || draftEmployeeId(draft),
  });
  const available = await isSlotAvailable({
    business,
    slotId,
    durationMinutes: duration,
    excludeDraftId: draft.id,
    employeeId: employeeId || draftEmployeeId(draft),
  });
  if (!available) {
    return missingSlotsResult({
      business,
      recipientPhone,
      draft,
      service,
      employeeId: employeeId || draftEmployeeId(draft),
      dateKey: formatDateKey(slotStart, business.timezone),
      requestId,
      reasonKey: 'SLOT_UNAVAILABLE',
      occupiedLabel: formatSlotLabel(slotStart, business.timezone),
    });
  }

  const claimed = await claimSlotForDraft({
    draftId: draft.id,
    businessId: business.id,
    slotStart,
    slotEnd,
    ttlMinutes: getPendingTtlMinutes(business),
    employeeId: employeeId || draftEmployeeId(draft),
    context: { ...draft.conversation_context, step: 'confirm', slot_id: slotId },
    requestId,
  });
  if (!claimed.ok || !claimed.draft) {
    if (claimed.reason === 'slot_taken') {
      return missingSlotsResult({
        business,
        recipientPhone,
        draft,
        service,
        employeeId: employeeId || draftEmployeeId(draft),
        dateKey: formatDateKey(slotStart, business.timezone),
        requestId,
        reasonKey: 'SLOT_UNAVAILABLE',
        occupiedLabel: formatSlotLabel(slotStart, business.timezone),
      });
    }
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_GENERIC',
      data: { client_message: 'Nu am putut reține intervalul. Încearcă din nou.' },
    });
  }

  if (claimed.draft.state !== 'pending_confirmation' || !claimed.draft.selected_slot_start) {
    console.error('[booking] claimSlotForDraft returned non-pending draft', {
      draftId: claimed.draft.id,
      state: claimed.draft.state,
      requestId,
    });
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_GENERIC',
      data: { client_message: 'Nu am putut bloca intervalul. Te rog alege din nou ora.' },
    });
  }

  console.log('[booking] Slot held pending_confirmation', {
    draftId: claimed.draft.id,
    slotStart: slotStart.toISOString(),
    lockedUntil: claimed.draft.locked_until ?? claimed.draft.pending_expires_at ?? null,
    requestId,
  });

  return afterHold({
    business,
    recipientPhone,
    draft: claimed.draft,
    service,
    slotStart,
    slotEnd,
    requestId,
  });
}

async function executeBook({ business, recipientPhone, extract, clientId, requestId, activeDraft, convState }) {
  // Never spawn a parallel booking while a reschedule is in flight.
  const modifyInFlight = convState?.context_data?.intent === 'reschedule'
    || convState?.current_step === CONVERSATION_STEPS.RESCHEDULING
    || convState?.current_step === CONVERSATION_STEPS.MODIFYING;
  if (modifyInFlight) {
    return executeReschedule({
      business,
      recipientPhone,
      extract: { ...extract, action: 'reschedule' },
      activeDraft,
      convState,
      requestId,
    });
  }

  if (business.business_type === 'consulting') {
    return executeCallback({ business, recipientPhone, extract, clientId, requestId, textBody: 'consulting_booking_interest' });
  }

  let service = resolveServiceForBooking(business, {
    extract,
    activeDraft,
    draft: null,
    convState,
  });
  const draft = await ensureDraft({
    business,
    recipientPhone,
    clientId,
    requestId,
    activeDraft,
    convState,
  });
  if (!draft) {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_GENERIC',
      data: { client_message: 'Nu am putut porni programarea. Încearcă din nou.' },
    });
  }

  if (!service) {
    service = resolveServiceForBooking(business, {
      extract,
      activeDraft,
      draft,
      convState,
    });
  }

  if (!service) {
    return missingService(business, recipientPhone, draft, requestId);
  }

  if (extract.employee_name && !extract.employee_id) {
    const staff = await listEmployees(business.id, { activeOnly: true });
    await setConversationStep({
      businessId: business.id,
      rawPhone: recipientPhone,
      step: CONVERSATION_STEPS.CHOOSING_EMPLOYEE,
      context: { draft_id: draft.id, intent: 'book', service },
      requestId,
    });
    return handlerResult({
      status: 'MISSING_INFO',
      next_required_step: 'CHOOSE_EMPLOYEE',
      user_message_template_key: 'MISSING_EMPLOYEE',
      data: {
        client_message: `Nu am găsit *${extract.employee_name}* în echipă. Poți scrie un nume din echipă: ${staff.map((e) => e.name).join(', ')}.`,
        services: staff.map((e) => ({ id: e.id, name: e.name })),
      },
    });
  }

  let working = draft;
  const currentServiceId =
    working.selected_service && typeof working.selected_service === 'object'
      ? /** @type {{ id?: string }} */ (working.selected_service).id
      : null;
  if (!working.selected_service || currentServiceId !== service.id) {
    working = await setSelectedService({
      draftId: draft.id,
      businessId: business.id,
      service,
      context: { ...draft.conversation_context, step: 'select_slot', service_id: service.id },
      requestId,
    }) || draft;
  }

  if (extract.employee_id && extract.employee_id !== 'any') {
    working = await setDraftEmployee({
      draftId: working.id,
      businessId: business.id,
      employeeId: extract.employee_id,
      context: {
        ...working.conversation_context,
        employee_id: extract.employee_id,
        employee_name: extract.employee_name,
      },
      requestId,
    }) || working;
  }

  // Slot list id encodes the absolute instant. Never recombine a stale pending_date
  // (9 Feb) with a new clock time after the client picked another day (2 Sep).
  let slotStart = null;
  if (extract.slot_id) {
    slotStart = decodeSlotId(extract.slot_id, business.timezone);
  } else if (extract.datetime instanceof Date && !Number.isNaN(extract.datetime.getTime())) {
    slotStart = extract.datetime;
  } else if (extract.date_text && extract.time_text) {
    slotStart = localToUtc(extract.date_text, extract.time_text, business.timezone);
  }

  if (slotStart) {
    return holdRequestedSlot({
      business,
      recipientPhone,
      draft: working,
      service,
      slotStart,
      employeeId: extract.employee_id === 'any' ? null : (extract.employee_id || draftEmployeeId(working)),
      requestId,
    });
  }

  if (!extract.date_text) {
    // Soft window without a day: still require a day window first (click grid).
    if (extract.time_window) {
      return askDateGridResult({
        business,
        recipientPhone,
        draft: working,
        service,
        requestId,
        clientMessage:
          formatDayGridMessage(listOpenDayWindows(business), business.timezone, service.name)
          + `\n\nInterval preferat: *${timeWindowLabel(extract.time_window) || extract.time_window}*.`
          + ' Alege ziua, apoi ora.',
      });
    }
    return askDateGridResult({
      business,
      recipientPhone,
      draft: working,
      service,
      requestId,
    });
  }

  // Free-text / Flow may name a closed Admin day — never offer hours for it.
  {
    const noon = localToUtc(extract.date_text, '12:00', business.timezone);
    const dayInfo = getHoursForDate(business, noon);
    if (!dayInfo.open) {
      const pretty = formatRomanianDate(extract.date_text, business.timezone);
      return askDateGridResult({
        business,
        recipientPhone,
        draft: working,
        service,
        requestId,
        notice: `*${pretty}* suntem *INCHIS*. Alege o zi deschisă din listă:`,
      });
    }
  }

  return missingSlotsResult({
    business,
    recipientPhone,
    draft: working,
    service,
    employeeId: draftEmployeeId(working),
    dateKey: extract.date_text,
    timeWindow: extract.time_window || null,
    requestId,
    reasonKey: 'ASK_TIME',
    conversationStep: CONVERSATION_STEPS.WAITING_FOR_TIME,
  });
}

async function executeConfirm({ business, recipientPhone, activeDraft, requestId }) {
  let draft = activeDraft || await getActiveDraftBooking(business.id, recipientPhone);
  const expiry = await expirePendingIfNeeded({ business, draft, recipientPhone, requestId });
  if (expiry.expired) {
    return handlerResult({
      status: 'MISSING_INFO',
      action_performed: null,
      next_required_step: 'RESUME_OR_BOOK',
      user_message_template_key: 'HOLD_EXPIRED',
      data: {
        client_message: 'Timpul de rezervare a expirat și slotul a fost eliberat.',
        last_intent: expiry.lastIntent || null,
      },
    });
  }
  if (!draft || draft.state !== 'pending_confirmation') {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_GENERIC',
      data: { client_message: 'Nu există o programare în așteptarea confirmării.' },
    });
  }

  const service = /** @type {{ name: string; duration_minutes: number }} */ (draft.selected_service);
  const slotStart = draft.selected_slot_start;
  if (!service || !slotStart) {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_GENERIC',
      data: { client_message: 'Datele programării sunt incomplete.' },
    });
  }

  const duration = catalogDuration(business, service);
  if (!duration) {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_DURATION',
      data: { client_message: durationMissingClientMessage(service.name) },
    });
  }

  const startDate = new Date(slotStart);
  const endDate = new Date(startDate.getTime() + duration * 60_000);
  const hoursCheck = assertWithinWorkingHours(business, startDate, endDate);
  if (!hoursCheck.ok) {
    // Admin hours changed while the hold was pending — keep the service and
    // let the client pick a valid hour instead of dead-ending the flow.
    return hoursRecoveryResult({
      business,
      recipientPhone,
      draft,
      service,
      slotStart: startDate,
      hoursCheck,
      employeeId: draftEmployeeId(draft),
      intent: 'book',
      requestId,
    });
  }

  const phoneE164 = draft.phone_number;
  const client = await getClientByPhone({ businessId: business.id, rawPhone: recipientPhone, requestId });
  const clientName = client?.display_name?.trim() || '';
  const { employeeId, employee, calendarId } = await resolveStaff(business, draft);

  const result = await createCalendarEvent({
    business,
    calendarId,
    employeeId,
    event: {
      summary: `${service.name} — ${clientName || phoneE164}${employee ? ` (${employee.name})` : ''}`,
      description:
        `Programare WhatsApp Vidia\n` +
        (clientName ? `Client: ${clientName}\n` : '') +
        `Telefon: ${phoneE164}\n` +
        (employee ? `Angajat: ${employee.name}\n` : '') +
        `Draft: ${draft.id}`,
      startIso: startDate.toISOString(),
      endIso: endDate.toISOString(),
    },
    requestId,
  });

  const isMockEvent =
    result.mocked === true
    || business.google_calendar_mock_mode === true
    || (typeof result.eventId === 'string' && result.eventId.startsWith('mock_evt_'));

  if (!result.ok || !result.eventId || isMockEvent) {
    if (['closed', 'outside_hours', 'hours_unset', 'invalid_range'].includes(String(result.reason))) {
      return hoursRecoveryResult({
        business,
        recipientPhone,
        draft,
        service,
        slotStart: startDate,
        hoursCheck: {
          ok: false,
          reason: String(result.reason),
          message: result.error || hoursUnsetClientMessage(),
        },
        employeeId,
        intent: 'book',
        requestId,
      });
    }
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_CALENDAR',
      data: {
        client_message:
          'Din păcate nu am putut confirma programarea. Te rog încearcă din nou.',
      },
    });
  }

  const confirmed = await confirmDraftBooking({
    draftId: draft.id,
    businessId: business.id,
    googleEventId: result.eventId,
    googleEventLink: result.htmlLink,
    context: { ...draft.conversation_context, step: 'confirmed' },
    requestId,
  });
  if (!confirmed) {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_GENERIC',
      data: {
        client_message:
          'Din păcate nu am putut salva programarea în sistem. Te rog încearcă din nou.',
      },
    });
  }
  await optInClientAfterBooking({
    businessId: business.id,
    rawPhone: recipientPhone,
  });
  await resetConversationState({
    businessId: business.id,
    rawPhone: recipientPhone,
    hardReset: true,
    requestId,
  });

  const slotLabel = formatSlotLabel(startDate, business.timezone);
  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'BOOKED',
    next_required_step: null,
    user_message_template_key: 'CONFIRMATION_BOOKED',
    data: {
      service_name: service.name,
      slot_label: slotLabel,
      client_name: clientName,
      employee_name: employee?.name ?? null,
      date_key: formatDateKey(startDate, business.timezone),
      time_hhmm: formatTime(startDate, business.timezone),
    },
    calendar_cta: calendarCta(business, service.name, startDate, endDate),
  });
}

async function executeCancelPending({ business, recipientPhone, requestId }) {
  await cancelActiveDraftsForPhone({
    businessId: business.id,
    rawPhone: recipientPhone,
    context: { step: 'cancelled_by_user' },
    requestId,
  });
  await resetConversationState({
    businessId: business.id,
    rawPhone: recipientPhone,
    requestId,
  });
  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'CANCELLED_PENDING',
    next_required_step: null,
    user_message_template_key: 'CANCEL_PENDING',
    data: {},
  });
}

/**
 * Mid-flow revision: client said "modific" / "am greșit" while building a booking.
 * Keep the chosen service; clear the hold and re-ask day (or only time).
 * NEVER falls through to saved-appointment reschedule — that was the confirm-card bug.
 */
async function executeReviseDraft({
  business,
  recipientPhone,
  extract,
  activeDraft,
  convState,
  requestId,
  textBody = '',
  clientId = null,
}) {
  const ctx = convState?.context_data || {};
  let draft = activeDraft && ['browsing', 'pending_confirmation'].includes(activeDraft.state)
    ? activeDraft
    : null;

  if (!draft) {
    const live = await getActiveDraftBooking(business.id, recipientPhone);
    if (live && ['browsing', 'pending_confirmation'].includes(live.state)) {
      draft = live;
    }
  }
  if (!draft && typeof ctx.draft_id === 'string' && ctx.draft_id) {
    const byId = await getDraftBookingById(ctx.draft_id, business.id);
    if (byId && ['browsing', 'pending_confirmation'].includes(byId.state)) {
      draft = byId;
    }
  }

  const serviceFromDraftOrCtx = serviceFromInFlightContext(ctx, draft);
  const keepDate = extract.time_text === '__keep_date__'
    || looksLikeTimeOnlyRevision(textBody);

  if (draft) {
    const service = draft.selected_service
      ? /** @type {{ id?: string, name?: string, duration_minutes?: number }} */ (draft.selected_service)
      : serviceFromDraftOrCtx;
    const priorStart = draft.selected_slot_start ? new Date(draft.selected_slot_start) : null;
    const dateKey = keepDate && priorStart && !Number.isNaN(priorStart.getTime())
      ? formatDateKey(priorStart, business.timezone)
      : null;

    const reset = await cancelOrResetDraft({
      draftId: draft.id,
      businessId: business.id,
      state: 'browsing',
      context: {
        ...draft.conversation_context,
        step: 'revised_in_flight',
        revised_at: new Date().toISOString(),
        keep_service: true,
      },
      requestId,
    });
    const working = reset || draft;

    if (!service?.id && !service?.name) {
      return missingService(business, recipientPhone, working, requestId);
    }

    if (dateKey) {
      return missingSlotsResult({
        business,
        recipientPhone,
        draft: working,
        service,
        employeeId: draftEmployeeId(working),
        dateKey,
        requestId,
        reasonKey: 'ASK_TIME',
        conversationStep: CONVERSATION_STEPS.WAITING_FOR_TIME,
        extraContext: {
          intent: 'book',
          service,
          draft_id: working.id,
        },
        notice: `Ok, schimbăm ora pentru *${service.name || 'serviciu'}*. Alege un alt interval:`,
      });
    }

    return askDateGridResult({
      business,
      recipientPhone,
      draft: working,
      service,
      requestId,
      conversationStep: CONVERSATION_STEPS.WAITING_FOR_DATE,
      extraContext: {
        intent: 'book',
        service,
        draft_id: working.id,
      },
      clientMessage:
        `Ok, modificăm. Păstrăm *${service.name || 'serviciul'}* — alege din nou *ziua* (apoi ora).`,
    });
  }

  // Draft already TTL-expired or missing — reopen with remembered service. Never list saved appts.
  const service = serviceFromDraftOrCtx;
  const browsing = await startBrowsingFlow({
    businessId: business.id,
    rawPhone: recipientPhone,
    clientId: clientId || null,
    context: { step: 'revised_after_expired_hold', intent: 'book' },
    requestId,
  });
  if (!browsing) {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_GENERIC',
      data: {
        client_message:
          'Nu am putut redeschide programarea în curs. Scrie din nou serviciul dorit ca să o luăm de la capăt.',
      },
    });
  }

  if (!service?.id && !service?.name) {
    return missingService(business, recipientPhone, browsing, requestId);
  }

  const withService = await setSelectedService({
    draftId: browsing.id,
    businessId: business.id,
    service,
    context: {
      ...(browsing.conversation_context || {}),
      intent: 'book',
      revised_in_flight: true,
    },
    requestId,
  }) || browsing;

  return askDateGridResult({
    business,
    recipientPhone,
    draft: withService,
    service,
    requestId,
    conversationStep: CONVERSATION_STEPS.WAITING_FOR_DATE,
    extraContext: {
      intent: 'book',
      service,
      draft_id: withService.id,
    },
    clientMessage:
      `Ok, modificăm. Păstrăm *${service.name || 'serviciul'}* — alege din nou *ziua* (apoi ora).`,
  });
}

function executeThanks(business, lang = 'ro') {
  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'THANKS',
    next_required_step: null,
    user_message_template_key: 'THANKS',
    data: {
      business_name: business.name,
      client_language: lang,
      client_message: lang === 'en'
        ? `You're welcome! If you need anything else — a booking, hours, or contact — just write here.`
        : `Cu plăcere! Dacă mai ai nevoie — o programare, orarul sau contact — scrie-mi oricând.`,
    },
  });
}

async function executeCancelAppointment({
  business,
  recipientPhone,
  appointment,
  requestId,
  resetState = true,
}) {
  const { calendarId } = await resolveStaff(business, appointment);
  const eventId = await resolveCalendarEventId({
    business,
    eventId: appointment.google_event_id,
    phoneNumber: appointment.phone_number || recipientPhone,
    startIso: appointment.selected_slot_start,
    endIso: appointment.selected_slot_end,
    calendarId,
    requestId,
  });

  // DB-first atomic cancel — release the slot before touching calendar.
  const cancelled = await cancelConfirmedBookingAtomic({
    draftId: appointment.id,
    businessId: business.id,
    context: {
      ...appointment.conversation_context,
      step: 'cancelled_by_user',
      google_event_id: eventId || appointment.google_event_id,
    },
    requestId,
  });
  if (!cancelled.ok || !cancelled.draft) {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_GENERIC',
      data: {
        client_message:
          'Din păcate nu am putut anula programarea în sistem. Te rog încearcă din nou.',
      },
    });
  }

  if (!isBusinessMockMode(business) && eventId) {
    await deleteCalendarEvent({ business, eventId, calendarId, requestId });
  } else if (appointment.google_event_id) {
    await deleteCalendarEvent({
      business,
      eventId: appointment.google_event_id,
      calendarId,
      requestId,
    });
  }

  if (resetState) {
    await resetConversationState({
      businessId: business.id,
      rawPhone: recipientPhone,
      requestId,
    });
  }
  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'CANCELLED',
    next_required_step: null,
    user_message_template_key: 'CONFIRMATION_CANCELLED',
    data: {
      service_name: appointment.selected_service?.name || 'Programare',
    },
  });
}

async function executeCancelAllAppointments({ business, recipientPhone, appointments, requestId }) {
  const list = Array.isArray(appointments) ? appointments : [];
  let cancelled = 0;
  let failed = 0;
  for (const appointment of list) {
    const result = await executeCancelAppointment({
      business,
      recipientPhone,
      appointment,
      requestId,
      resetState: false,
    });
    if (result.status === 'SUCCESS') cancelled += 1;
    else failed += 1;
  }
  await resetConversationState({
    businessId: business.id,
    rawPhone: recipientPhone,
    requestId,
  });
  if (!cancelled) {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_CALENDAR',
      data: {
        client_message: 'Din păcate nu am putut anula programările. Te rog încearcă din nou.',
      },
    });
  }
  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'CANCELLED',
    next_required_step: null,
    user_message_template_key: 'CONFIRMATION_CANCELLED',
    data: {
      service_name: cancelled === 1 ? 'Programare' : `${cancelled} programări`,
      client_message: failed
        ? `Am anulat ${cancelled} programări. ${failed} nu au putut fi anulate.`
        : `Am anulat toate cele ${cancelled} programări.`,
    },
  });
}

async function askConfirmCancelAll({ business, recipientPhone, appointments, requestId }) {
  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: CONVERSATION_STEPS.CONFIRMING_CANCEL,
    context: {
      intent: 'cancel',
      cancel_all: true,
      appointment_ids: appointments.map((a) => a.id),
      last_menu: {
        kind: 'confirm',
        options: [
          { id: MOD_PREFIX.CONFIRM_CANCEL, title: 'Anulează' },
          { id: MOD_PREFIX.ABORT, title: 'Renunță' },
        ],
      },
    },
    mergeContext: false,
    requestId,
  });
  return handlerResult({
    status: 'MISSING_INFO',
    next_required_step: 'CONFIRM_CANCEL',
    user_message_template_key: 'CONFIRM_CANCEL',
    data: {
      client_message: `Anulezi toate cele ${appointments.length} programări?`,
      service_name: `${appointments.length} programări`,
      slot_label: 'toate intervalele',
    },
    menu: {
      kind: 'confirm',
      options: [
        { id: MOD_PREFIX.CONFIRM_CANCEL, title: 'Anulează' },
        { id: MOD_PREFIX.ABORT, title: 'Renunță' },
      ],
    },
  });
}

async function applyReschedule({
  business,
  recipientPhone,
  appointment,
  slotStart,
  convState,
  requestId,
}) {
  const service = /** @type {{ name?: string }} */ (appointment.selected_service ?? {});
  const duration = catalogDuration(business, service);
  if (!duration) {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_DURATION',
      data: { client_message: durationMissingClientMessage(service.name) },
    });
  }
  const slotEnd = new Date(slotStart.getTime() + duration * 60_000);
  const hoursCheck = assertWithinWorkingHours(business, slotStart, slotEnd);
  if (!hoursCheck.ok) {
    return hoursRecoveryResult({
      business,
      recipientPhone,
      draft: appointment,
      service,
      slotStart,
      hoursCheck,
      employeeId: draftEmployeeId(appointment),
      intent: 'reschedule',
      extraContext: {
        appointment_id: appointment.id,
        google_event_id: appointment.google_event_id ?? null,
        employee_id: draftEmployeeId(appointment),
        slot_start: appointment.selected_slot_start ?? null,
        slot_end: appointment.selected_slot_end ?? null,
      },
      requestId,
    });
  }

  const { employeeId, calendarId } = await resolveStaff(business, appointment);
  await lazySyncCalendar({ business, requestId, force: true, calendarId, employeeId });

  const storedEventId = convState.context_data?.google_event_id || appointment.google_event_id;
  const priorEventId = await resolveCalendarEventId({
    business,
    eventId: storedEventId,
    phoneNumber: appointment.phone_number || recipientPhone,
    startIso: appointment.selected_slot_start,
    endIso: appointment.selected_slot_end,
    calendarId,
    requestId,
  });
  const excludeEventIds = [priorEventId, appointment.google_event_id, storedEventId]
    .filter((id) => typeof id === 'string' && id && !isMockEventId(id));

  // Check free BEFORE any calendar write. Exclude this booking's own event so a
  // move to a new slot is never rejected as "self busy".
  const slotId = encodeSlotId(slotStart, business.timezone);
  const available = await isSlotAvailable({
    business,
    slotId,
    durationMinutes: duration,
    excludeDraftId: appointment.id,
    excludeGoogleEventIds: excludeEventIds,
    employeeId,
  });
  if (!available) {
    const listed = await listSlotsForService({
      business,
      service,
      draftId: appointment.id,
      employeeId,
      requestId,
      dateKey: formatDateKey(slotStart, business.timezone),
      excludeGoogleEventIds: excludeEventIds,
    });
    await setConversationStep({
      businessId: business.id,
      rawPhone: recipientPhone,
      step: CONVERSATION_STEPS.RESCHEDULING,
      context: {
        intent: 'reschedule',
        appointment_id: appointment.id,
        service,
        google_event_id: appointment.google_event_id,
        slot_start: appointment.selected_slot_start,
        slot_end: appointment.selected_slot_end,
        employee_id: employeeId,
      },
      mergeContext: false,
      requestId,
    });
    return handlerResult({
      status: 'MISSING_INFO',
      next_required_step: 'CHOOSE_SLOT',
      user_message_template_key: 'SLOT_UNAVAILABLE',
      data: {
        occupied_label: formatSlotLabel(slotStart, business.timezone),
        client_message:
          `Înțeleg, *${formatSlotLabel(slotStart, business.timezone)}* nu mai e liber. ` +
          'Te rog alege altă oră din listă — păstrăm același serviciu.',
        alternatives: (listed.slots || []).map((s) => ({
          id: s.id,
          label: formatSlotLabel(s.start, business.timezone),
        })),
      },
      menu: listed.slots?.length ? slotMenu(listed.slots, business.timezone) : null,
      machine_action: MACHINE_ACTIONS.ACTION_SLOT_UNAVAILABLE,
    });
  }

  // DB first — never write Google before the confirmed row is updated.
  // (Old order wrote calendar first → cache saw self as busy → false "tocmai s-a ocupat"
  // while the event was already moved, then retries spawned duplicate calendar events.)
  const mutated = await rescheduleConfirmedBookingAtomic({
    draftId: appointment.id,
    businessId: business.id,
    slotStart,
    slotEnd,
    employeeId,
    googleEventId: priorEventId || appointment.google_event_id || null,
    context: {
      step: 'rescheduled',
      previous_slot_start: convState.context_data?.slot_start || appointment.selected_slot_start,
      rescheduled_at: new Date().toISOString(),
      google_event_id: priorEventId || appointment.google_event_id || null,
      employee_id: employeeId,
    },
    requestId,
  });

  if (!mutated.ok || !mutated.draft) {
    if (mutated.reason === 'slot_taken') {
      const listed = await listSlotsForService({
        business,
        service,
        draftId: appointment.id,
        employeeId,
        requestId,
        dateKey: formatDateKey(slotStart, business.timezone),
        excludeGoogleEventIds: excludeEventIds,
      });
      await setConversationStep({
        businessId: business.id,
        rawPhone: recipientPhone,
        step: CONVERSATION_STEPS.RESCHEDULING,
        context: {
          intent: 'reschedule',
          appointment_id: appointment.id,
          service,
          google_event_id: appointment.google_event_id,
          slot_start: appointment.selected_slot_start,
          slot_end: appointment.selected_slot_end,
          employee_id: employeeId,
        },
        mergeContext: false,
        requestId,
      });
      return handlerResult({
        status: 'MISSING_INFO',
        next_required_step: 'CHOOSE_SLOT',
        user_message_template_key: 'SLOT_UNAVAILABLE',
        data: {
          occupied_label: formatSlotLabel(slotStart, business.timezone),
          client_message:
            `Înțeleg, *${formatSlotLabel(slotStart, business.timezone)}* nu mai e liber. ` +
            'Te rog alege altă oră din listă — păstrăm același serviciu.',
          alternatives: (listed.slots || []).map((s) => ({
            id: s.id,
            label: formatSlotLabel(s.start, business.timezone),
          })),
        },
        menu: listed.slots?.length ? slotMenu(listed.slots, business.timezone) : null,
        machine_action: MACHINE_ACTIONS.ACTION_SLOT_UNAVAILABLE,
      });
    }
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_GENERIC',
      data: {
        client_message:
          'Îmi pare rău, nu am putut salva reprogramarea acum. Te rog încearcă din nou peste un moment.',
      },
    });
  }

  // Calendar second: update the SAME event in place. On failure, booking is still saved —
  // never tell the client the slot was taken after a successful DB update.
  let activeEventId = priorEventId || appointment.google_event_id || null;
  if (!isBusinessMockMode(business)) {
    const summary = `${service.name || 'Programare'} — ${appointment.phone_number || recipientPhone}`;
    if (activeEventId && !isMockEventId(activeEventId)) {
      const calResult = await updateCalendarEvent({
        business,
        eventId: activeEventId,
        calendarId,
        updates: {
          summary,
          start: { dateTime: slotStart.toISOString(), timeZone: business.timezone },
          end: { dateTime: slotEnd.toISOString(), timeZone: business.timezone },
        },
        requestId,
      });
      if (!calResult?.ok) {
        const created = await createCalendarEvent({
          business,
          calendarId,
          employeeId,
          event: {
            summary,
            startIso: slotStart.toISOString(),
            endIso: slotEnd.toISOString(),
          },
          requestId,
        });
        const newId = created?.ok ? (created.eventId || null) : null;
        if (newId) {
          if (activeEventId && activeEventId !== newId) {
            await deleteCalendarEvent({
              business,
              eventId: activeEventId,
              calendarId,
              requestId,
            });
          }
          activeEventId = newId;
        }
      }
    } else {
      const created = await createCalendarEvent({
        business,
        calendarId,
        employeeId,
        event: {
          summary,
          startIso: slotStart.toISOString(),
          endIso: slotEnd.toISOString(),
        },
        requestId,
      });
      activeEventId = created?.ok ? (created.eventId || null) : null;
      const orphanId = appointment.google_event_id || storedEventId;
      if (
        activeEventId
        && orphanId
        && orphanId !== activeEventId
        && !isMockEventId(orphanId)
      ) {
        await deleteCalendarEvent({
          business,
          eventId: orphanId,
          calendarId,
          requestId,
        });
      }
    }

    if (activeEventId && activeEventId !== mutated.draft.google_event_id) {
      await rescheduleConfirmedBookingAtomic({
        draftId: appointment.id,
        businessId: business.id,
        slotStart,
        slotEnd,
        employeeId,
        googleEventId: activeEventId,
        context: {
          step: 'rescheduled',
          google_event_id: activeEventId,
          employee_id: employeeId,
          calendar_linked_at: new Date().toISOString(),
        },
        requestId,
      });
    }
  } else if (activeEventId) {
    await updateCalendarEvent({
      business,
      eventId: activeEventId,
      calendarId,
      updates: {
        summary: `${service.name || 'Programare'} — ${appointment.id.slice(0, 8)}`,
        start: { dateTime: slotStart.toISOString(), timeZone: business.timezone },
        end: { dateTime: slotEnd.toISOString(), timeZone: business.timezone },
      },
      requestId,
    });
  }

  try {
    await cancelActiveDraftsForPhone({
      businessId: business.id,
      rawPhone: recipientPhone,
      context: { step: 'cancelled_after_reschedule', kept_appointment_id: appointment.id },
      requestId,
    });
  } catch (error) {
    console.warn('[reschedule] cancel leftover drafts failed', error);
  }

  await resetConversationState({
    businessId: business.id,
    rawPhone: recipientPhone,
    hardReset: true,
    requestId,
  });

  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'RESCHEDULED',
    next_required_step: null,
    user_message_template_key: 'CONFIRMATION_RESCHEDULE',
    data: {
      service_name: service.name || 'Programare',
      slot_label: formatSlotLabel(slotStart, business.timezone),
      client_message:
        `Gata — am mutat programarea ta la *${service.name || 'serviciu'}* pe *${formatSlotLabel(slotStart, business.timezone)}*. ` +
        'Te așteptăm cu drag! Dacă mai schimbi ceva, scrie *reprogramare*.',
    },
    calendar_cta: calendarCta(business, service.name, slotStart, slotEnd),
  });
}

async function executeReschedule({
  business,
  recipientPhone,
  extract,
  activeDraft,
  convState,
  requestId,
}) {
  if (activeDraft && ['browsing', 'pending_confirmation'].includes(activeDraft.state)) {
    await cancelOrResetDraft({
      draftId: activeDraft.id,
      businessId: business.id,
      state: 'cancelled',
      context: { ...activeDraft.conversation_context, step: 'cancelled_for_modification_intent' },
      requestId,
    });
  }

  const appointments = await listActionableAppointments(business, recipientPhone, requestId);
  if (!appointments.length) {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_NO_APPOINTMENT',
      data: { client_message: 'Nu am găsit o programare activă de modificat. Scrie *programare* pentru una nouă.' },
    });
  }

  const resolved = resolveAppointmentForModify(appointments, extract, convState, business, 'reschedule');
  let appointment = resolved.appointment;
  if (resolved.reason === 'id' && appointment && !appointments.find((a) => a.id === appointment.id)) {
    appointment = await getDraftBookingById(appointment.id, business.id);
  }

  if (!appointment) {
    const pool = resolved.candidates?.length ? resolved.candidates : appointments;
    const clientMessage = resolved.reason === 'ambiguous'
      ? 'Am găsit mai multe programări pe intervalul menționat. Care o mutăm?'
      : null;
    return askWhichAppointment({
      business,
      recipientPhone,
      appointments: pool,
      intent: 'reschedule',
      requestId,
      clientMessage,
      extraContext: {
        // Keep new-slot hints so the next turn can apply them after choice.
        pending_date_text: extract.date_text || null,
        pending_time_text: extract.time_text || null,
      },
    });
  }

  const { employeeId } = await resolveStaff(business, appointment);
  const extraContext = {
    intent: 'reschedule',
    appointment_id: appointment.id,
    google_event_id: appointment.google_event_id,
    employee_id: employeeId,
    slot_start: appointment.selected_slot_start,
    slot_end: appointment.selected_slot_end,
  };

  if (resolved.reason !== 'slot_hint') {
    const tapped = extract.datetime
      || (extract.slot_id ? decodeSlotId(extract.slot_id, business.timezone) : null);
    if (tapped) {
      return applyReschedule({
        business,
        recipientPhone,
        appointment,
        slotStart: tapped,
        convState,
        requestId,
      });
    }
  }

  // slot_hint = date/time named the existing booking; otherwise date/time is the NEW slot.
  const slotStep = nextRescheduleSlotStep({
    resolvedReason: resolved.reason,
    extractDate: extract.date_text,
    extractTime: extract.time_text,
    pendingDate: typeof convState.context_data?.pending_date_text === 'string'
      ? convState.context_data.pending_date_text
      : null,
    pendingTime: typeof convState.context_data?.pending_time_text === 'string'
      ? convState.context_data.pending_time_text
      : null,
  });

  if (slotStep.kind === 'apply') {
    return applyReschedule({
      business,
      recipientPhone,
      appointment,
      slotStart: localToUtc(slotStep.date, slotStep.time, business.timezone),
      convState,
      requestId,
    });
  }

  if (slotStep.kind === 'ask_time') {
    return missingSlotsResult({
      business,
      recipientPhone,
      draft: appointment,
      service: appointment.selected_service,
      employeeId,
      dateKey: slotStep.date,
      requestId,
      reasonKey: 'MISSING_SLOT',
      conversationStep: CONVERSATION_STEPS.RESCHEDULING,
      extraContext,
    });
  }

  const oldWhen = appointment.selected_slot_start
    ? formatSlotLabel(new Date(appointment.selected_slot_start), business.timezone)
    : null;
  const serviceName = /** @type {{ name?: string }} */ (appointment.selected_service ?? {}).name || 'programarea';
  return askDateGridResult({
    business,
    recipientPhone,
    draft: appointment,
    service: appointment.selected_service,
    requestId,
    conversationStep: CONVERSATION_STEPS.RESCHEDULING,
    extraContext,
    clientMessage:
      `Reprogramăm *${serviceName}*` +
      (oldWhen ? ` de *${oldWhen}*` : '') +
      '. Alege mai întâi *ziua nouă* — orele apar după ce ai ales data.',
  });
}

async function executeCancel({
  business,
  recipientPhone,
  extract,
  activeDraft,
  convState,
  requestId,
  textBody = '',
}) {
  const inModifyFlow = convState.current_step === CONVERSATION_STEPS.CONFIRMING_CANCEL
    || convState.current_step === CONVERSATION_STEPS.MODIFYING
    || convState.current_step === CONVERSATION_STEPS.RESCHEDULING;
  const wantsAll = Boolean(extract.cancel_all || extract.action === 'cancel_all');
  const meansSavedBookings = wantsAll
    || Boolean(extract.vague_choice)
    || Boolean(extract.appointment_id)
    || Boolean(extract.date_text)
    || refersToSavedAppointments(textBody)
    || looksLikeCancelAll(textBody);

  // A pending NEW booking: "anulează" drops the hold — unless the client
  // is talking about saved appointments (plural, a day, "programare").
  if (
    activeDraft?.state === 'pending_confirmation'
    && !inModifyFlow
    && !meansSavedBookings
  ) {
    return executeCancelPending({ business, recipientPhone, requestId });
  }

  if (activeDraft && ['browsing', 'pending_confirmation'].includes(activeDraft.state)) {
    await cancelOrResetDraft({
      draftId: activeDraft.id,
      businessId: business.id,
      state: 'cancelled',
      context: { ...activeDraft.conversation_context, step: 'cancelled_for_modification_intent' },
      requestId,
    });
  }

  const appointments = await listActionableAppointments(business, recipientPhone, requestId);
  if (!appointments.length) {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_NO_APPOINTMENT',
      data: { client_message: 'Nu am găsit o programare activă de anulat. Scrie *programare* pentru una nouă.' },
    });
  }

  if (wantsAll && extract.source === 'menu' && appointments.length > 1) {
    return askConfirmCancelAll({ business, recipientPhone, appointments, requestId });
  }

  const resolved = resolveAppointmentForModify(appointments, extract, convState, business, 'cancel');
  let appointment = resolved.appointment;
  if (resolved.reason === 'id' && appointment && !appointments.find((a) => a.id === appointment.id)) {
    appointment = await getDraftBookingById(appointment.id, business.id);
  }

  if (!appointment) {
    const includeCancelAll = wantsAll && appointments.length > 1;
    if (resolved.reason === 'not_found' && (extract.date_text || extract.time_text)) {
      const hint = [extract.date_text, extract.time_text].filter(Boolean).join(' ');
      return askWhichAppointment({
        business,
        recipientPhone,
        appointments,
        intent: 'cancel',
        requestId,
        includeCancelAll,
        clientMessage: `Nu am găsit o programare la *${hint}*. Care vrei să anulezi?`,
      });
    }

    const pool = resolved.candidates?.length ? resolved.candidates : appointments;
    const clientMessage = resolved.reason === 'ambiguous'
      ? 'Am găsit mai multe programări pe intervalul menționat. Care o anulezi?'
      : (includeCancelAll
        ? `Ai ${pool.length} programări. Alege una sau anulează-le pe toate.`
        : null);
    return askWhichAppointment({
      business,
      recipientPhone,
      appointments: pool,
      intent: 'cancel',
      requestId,
      includeCancelAll,
      clientMessage,
    });
  }

  const when = appointment.selected_slot_start
    ? formatSlotLabel(new Date(appointment.selected_slot_start), business.timezone)
    : '—';
  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: CONVERSATION_STEPS.CONFIRMING_CANCEL,
    context: {
      intent: 'cancel',
      appointment_id: appointment.id,
      google_event_id: appointment.google_event_id,
      service: appointment.selected_service,
      slot_start: appointment.selected_slot_start,
      slot_end: appointment.selected_slot_end,
      last_menu: {
        kind: 'confirm',
        options: [
          { id: MOD_PREFIX.CONFIRM_CANCEL, title: 'Anulează' },
          { id: MOD_PREFIX.ABORT, title: 'Renunță' },
        ],
      },
    },
    mergeContext: false,
    requestId,
  });
  return handlerResult({
    status: 'MISSING_INFO',
    next_required_step: 'CONFIRM_CANCEL',
    user_message_template_key: 'CONFIRM_CANCEL',
    data: {
      service_name: appointment.selected_service?.name || 'Programare',
      slot_label: when,
    },
    menu: {
      kind: 'confirm',
      options: [
        { id: MOD_PREFIX.CONFIRM_CANCEL, title: 'Anulează' },
        { id: MOD_PREFIX.ABORT, title: 'Renunță' },
      ],
    },
  });
}

async function executeHours(business, lang = 'ro') {
  const hours = getConfiguredBusinessHours(business);
  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'HOURS_LOOKUP',
    next_required_step: null,
    user_message_template_key: 'HOURS_LIST',
    data: {
      hours_text: hours ? formatBusinessHoursText(hours) : null,
      hours_configured: Boolean(hours),
      client_language: lang,
    },
  });
}

async function executeServices(business, lang = 'ro') {
  const services = getBookingConfig(business).services;
  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'SERVICES_LOOKUP',
    next_required_step: null,
    user_message_template_key: 'SERVICES_LIST',
    data: {
      services: services.map((s) => ({
        id: s.id,
        name: s.name,
        duration_minutes: s.duration_minutes,
        price_ron: s.price_ron ?? null,
      })),
      client_language: lang,
    },
  });
}

async function executeHoursAndServices(business, lang = 'ro') {
  const hours = await executeHours(business, lang);
  const services = await executeServices(business, lang);
  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'HOURS_AND_SERVICES_LOOKUP',
    next_required_step: null,
    user_message_template_key: 'HOURS_AND_SERVICES',
    data: {
      ...hours.data,
      ...services.data,
      client_language: lang,
    },
  });
}

async function executeContact(business) {
  const linkButtons = buildContactLinkButtons(business);
  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'CONTACT_LOOKUP',
    next_required_step: null,
    user_message_template_key: 'CONTACT',
    data: {
      contact: getBusinessContactInfo(business),
      business_name: business.name,
      link_ctas: linkButtons,
    },
  });
}

async function executeMenu(business, recipientPhone, requestId) {
  if (business?.id && recipientPhone) {
    await cancelActiveDraftsForPhone({
      businessId: business.id,
      rawPhone: recipientPhone,
      context: { step: 'cancelled_by_menu' },
      requestId,
    });
    await resetConversationState({
      businessId: business.id,
      rawPhone: recipientPhone,
      requestId,
    });
  }
  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'MENU',
    next_required_step: null,
    user_message_template_key: 'MENU',
    data: { business_name: business.name, welcome: business.welcome_message || null },
    menu: entryMenu(business),
  });
}

async function executeCallback({ business, recipientPhone, extract, clientId, requestId, textBody }) {
  await createCallbackRequest({
    businessId: business.id,
    rawPhone: recipientPhone,
    message: textBody || extract.action,
    reason: 'pipeline_callback',
    clientId,
    requestId,
  });
  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'CALLBACK_REQUESTED',
    next_required_step: null,
    user_message_template_key: 'CALLBACK_SENT',
    data: { business_name: business.name },
  });
}

async function executeSetName({ business, recipientPhone, extract, activeDraft, requestId }) {
  const name = parseClientNameReply(extract.name || '');
  if (!name) {
    return handlerResult({
      status: 'MISSING_INFO',
      next_required_step: 'ASK_NAME',
      user_message_template_key: 'ASK_NAME',
      data: { client_message: 'Te rog scrie prenumele și numele, ex: *Ana Popescu*.' },
    });
  }
  const client = await getClientByPhone({
    businessId: business.id,
    rawPhone: recipientPhone,
    requestId,
  });
  const resolvedClientId = client?.id || activeDraft?.client_id;
  if (resolvedClientId) {
    await updateClientDisplayName({
      clientId: resolvedClientId,
      displayName: name,
      businessId: business.id,
      requestId,
    });
  }
  const draft = activeDraft || await getActiveDraftBooking(business.id, recipientPhone);
  if (draft?.state === 'pending_confirmation' && draft.selected_service && draft.selected_slot_start) {
    const duration = catalogDuration(business, draft.selected_service);
    const slotStart = new Date(draft.selected_slot_start);
    const slotEnd = draft.selected_slot_end
      ? new Date(draft.selected_slot_end)
      : (duration ? new Date(slotStart.getTime() + duration * 60_000) : slotStart);
    return afterHold({
      business,
      recipientPhone,
      draft,
      service: draft.selected_service,
      slotStart,
      slotEnd,
      requestId,
    });
  }
  // Never show Confirmă without a DB soft-lock — name alone is not enough.
  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'NAME_SAVED',
    next_required_step: null,
    user_message_template_key: 'THANKS',
    data: {
      client_name: name,
      client_message: 'Am salvat numele. Scrie *programare* ca să alegi din nou serviciul și ora.',
    },
    menu: entryMenu(business),
  });
}

async function executeListAppointments({ business, recipientPhone, activeDraft }) {
  const upcoming = await listUpcomingConfirmedBookings(business.id, recipientPhone);
  const pending = activeDraft?.state === 'pending_confirmation' ? activeDraft : null;
  const rows = upcoming.map((a) => {
    const service = /** @type {{ name?: string }} */ (a.selected_service ?? {});
    const when = a.selected_slot_start
      ? formatSlotLabel(new Date(a.selected_slot_start), business.timezone)
      : '—';
    return { service_name: service.name || 'Programare', slot_label: when };
  });
  if (pending?.selected_slot_start) {
    const service = /** @type {{ name?: string }} */ (pending.selected_service ?? {});
    rows.unshift({
      service_name: `${service.name || 'Programare'} (în așteptarea confirmării)`,
      slot_label: formatSlotLabel(new Date(pending.selected_slot_start), business.timezone),
    });
  }
  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'LISTED_APPOINTMENTS',
    user_message_template_key: 'MY_APPOINTMENTS',
    data: { appointments: rows },
  });
}

async function executeChat(business, textBody = '', lang = 'ro') {
  const looked = lookupBusinessInfo(business, textBody);
  if (looked.found) {
    return handlerResult({
      status: 'SUCCESS',
      action_performed: 'FACT_LOOKUP',
      user_message_template_key: 'ADMIN_FACT',
      data: {
        fact: formatBusinessInfoReply(looked, lang),
        business_name: business.name,
        fact_topic: looked.topic,
        client_language: lang,
      },
    });
  }
  return handlerResult({
    status: 'CHAT',
    action_performed: null,
    next_required_step: null,
    user_message_template_key: 'CHAT_FALLBACK',
    data: { business_name: business.name, client_language: lang },
  });
}

function executeStaleChoice({ business, convState }) {
  const last = readLastMenu(convState);
  const clientMessage =
    'Opțiunea aia nu mai e pe lista curentă. Te rog alege din mesajul cel mai recent (sau scrie *programare*).';
  if (last?.options?.length) {
    const kind = last.kind || 'generic';
    const listButton = kind === 'day_grid'
      ? 'Zile disponibile'
      : kind === 'time_grid'
        ? 'Ore libere'
        : kind === 'modify'
          ? 'Programările tale'
          : kind === 'service'
            ? 'Servicii'
            : 'Alege';
    return handlerResult({
      status: 'MISSING_INFO',
      action_performed: null,
      next_required_step: kind === 'modify' ? 'CHOOSE_APPOINTMENT' : null,
      user_message_template_key: 'STALE_CHOICE',
      data: {
        client_message: clientMessage,
        list_button: listButton,
      },
      menu: { kind, options: last.options, catalog: last.options },
    });
  }
  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'STALE_CHOICE',
    user_message_template_key: 'STALE_CHOICE',
    data: { client_message: clientMessage },
    menu: entryMenu(business),
  });
}

/**
 * Answer only from Admin ai_facts lines. Never invent a yes/no.
 * @param {Business} business
 * @param {string} text
 * @returns {string | null}
 */
export function lookupAdminFact(business, text) {
  const looked = lookupBusinessInfo(business, text);
  return looked.found ? formatBusinessInfoReply(looked, 'ro') : null;
}

function executeOffTopic(business, lang = 'ro') {
  return handlerResult({
    status: 'CHAT',
    action_performed: null,
    next_required_step: null,
    user_message_template_key: 'OFF_TOPIC',
    data: { business_name: business.name, client_language: lang },
  });
}

function executeMissingInfo(business, textBody = '', lang = 'ro') {
  const looked = lookupBusinessInfo(business, textBody);
  if (looked.found) {
    return handlerResult({
      status: 'SUCCESS',
      action_performed: 'FACT_LOOKUP',
      user_message_template_key: 'ADMIN_FACT',
      data: {
        fact: formatBusinessInfoReply(looked, lang),
        business_name: business.name,
        fact_topic: looked.topic,
        client_language: lang,
      },
    });
  }
  const topicLabel = lang === 'en' ? looked.topicLabelEn : looked.topicLabelRo;
  return handlerResult({
    status: 'CHAT',
    action_performed: null,
    user_message_template_key: 'MISSING_INFO',
    data: {
      business_name: business.name,
      fact_topic: looked.topic,
      topic_label: topicLabel,
      client_message: missingBusinessInfoMessage(topicLabel, lang),
      client_language: lang,
    },
  });
}

async function executeClarifyNeeded({ business, recipientPhone, extract, convState, requestId }) {
  const amb = extract.ambiguity || {};
  const value = Number(amb.value);
  if (!Number.isInteger(value) || value < 1 || value > 31) {
    // Never show "Data de 0" / null labels — guide the user instead.
    return handlerResult({
      status: 'CHAT',
      action_performed: null,
      next_required_step: null,
      user_message_template_key: 'CHAT_FALLBACK',
      data: {
        business_name: business.name,
        client_message:
          'Nu am înțeles exact. Te rog alege o opțiune din meniu sau reformulează (ex: *vreau vineri la 11*).',
      },
    });
  }
  const resumeWait = amb.resume_wait || getBookingWait(convState);
  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: CONVERSATION_STEPS.WAITING_FOR_CLARIFICATION,
    context: {
      booking_wait: BOOKING_WAIT.CLARIFICATION,
      clarification: {
        value,
        rejected: amb.rejected ?? null,
        date_candidate: amb.date_key || dateKeyFromDayNumber(value, business.timezone, convState?.context_data?.pending_date_text),
        time_candidate: amb.time_hhmm || timeFromHourNumber(value, business.timezone),
        resume_wait: resumeWait,
        raw_value: amb.date_label || String(value),
      },
      last_menu: {
        kind: 'clarify',
        options: [
          { id: CLARIFY_IDS.DATE, title: `Data de ${value}` },
          { id: CLARIFY_IDS.TIME, title: `Ora ${value}` },
        ],
      },
    },
    mergeContext: true,
    requestId,
  });
  return handlerResult({
    status: 'MISSING_INFO',
    action_performed: null,
    next_required_step: 'CLARIFY_DATE_OR_TIME',
    user_message_template_key: 'ASK_CLARIFY_DATE_OR_TIME',
    data: {
      value,
      date_label: String(amb.date_label || value),
      time_label: String(amb.time_label || value),
      client_message: clarificationPrompt(value),
    },
    menu: {
      kind: 'clarify',
      options: [
        { id: CLARIFY_IDS.DATE, title: `Data de ${value}` },
        { id: CLARIFY_IDS.TIME, title: `Ora ${value}` },
      ],
    },
    machine_action: MACHINE_ACTIONS.ACTION_ASK_CLARIFICATION,
  });
}

async function executeResolveClarification(params) {
  const { business, recipientPhone, extract, convState, requestId, clientId, activeDraft } = params;
  const clar = convState?.context_data?.clarification || {};
  const field = extract.ambiguity?.field === 'time' ? 'time' : 'date';
  const value = Number(extract.ambiguity?.value ?? clar.value);
  const timezone = business.timezone;
  const pendingDate = typeof convState?.context_data?.pending_date_text === 'string'
    ? convState.context_data.pending_date_text
    : null;

  /** @type {import('./turnExtract.js').TurnExtract} */
  const nextExtract = {
    ...extract,
    action: 'book',
    date_text: field === 'date'
      ? (clar.date_candidate || dateKeyFromDayNumber(value, timezone, pendingDate))
      : null,
    time_text: field === 'time'
      ? (clar.time_candidate || timeFromHourNumber(value, timezone))
      : null,
    ambiguity: null,
  };

  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: field === 'date' ? CONVERSATION_STEPS.WAITING_FOR_TIME : CONVERSATION_STEPS.WAITING_FOR_DATE,
    context: {
      clarification: null,
      booking_wait: field === 'date' ? BOOKING_WAIT.TIME : BOOKING_WAIT.DATE,
      last_menu: null,
    },
    mergeContext: true,
    requestId,
  });

  const convForHydrate = {
    ...convState,
    context_data: {
      ...(convState?.context_data || {}),
      clarification: null,
    },
  };
  const hydrated = hydrateExtract(nextExtract, convForHydrate, timezone);
  await persistPendingExtract({ business, recipientPhone, extract: hydrated, requestId });
  return executeBook({
    business,
    recipientPhone,
    extract: hydrated,
    clientId,
    requestId,
    activeDraft,
    convState: convForHydrate,
  });
}

/**
 * @param {Object} params
 * @returns {Promise<HandlerResult>}
 */
async function dispatchExecute({
  business,
  recipientPhone,
  extract,
  clientId = null,
  requestId = null,
  convState,
  activeDraft,
  textBody = '',
}) {
  const action = extract.action;
  const intent = convState.context_data?.intent;
  const lang = detectClientLanguage(textBody, convState?.context_data?.client_language);

  // Courtesy must never confirm a hold (stray confirm_booking payload + "Mulțumesc").
  if (action === 'thanks') {
    return executeThanks(business, lang);
  }

  let draft = activeDraft;
  // Keep the live pending draft for mid-flow "Modific" — TTL expiry here used to
  // null the draft and the old revise path fell through to saved-appointment lists.
  const keepDraftForRevise = action === 'revise_draft'
    || looksLikeInFlightRevision(textBody);
  if (draft?.state === 'pending_confirmation' && !keepDraftForRevise) {
    const expiry = await expirePendingIfNeeded({ business, draft, recipientPhone, requestId });
    if (expiry.expired) draft = null;
  }

  const stolenMod = rerouteModification(textBody, extract, {
    step: convState.current_step,
    wait: getBookingWait(convState),
    activeDraft: draft,
    context: convState.context_data,
  });
  if (stolenMod === 'cancel') {
    return executeCancel({
      business,
      recipientPhone,
      extract: { ...extract, action: 'cancel' },
      activeDraft: draft,
      convState,
      requestId,
      textBody,
    });
  }
  if (stolenMod === 'revise_draft') {
    return executeReviseDraft({
      business,
      recipientPhone,
      extract: {
        ...extract,
        action: 'revise_draft',
        time_text: looksLikeTimeOnlyRevision(textBody) ? '__keep_date__' : extract.time_text,
      },
      activeDraft: draft,
      convState,
      requestId,
      textBody,
      clientId,
    });
  }
  if (stolenMod === 'reschedule') {
    return executeReschedule({
      business,
      recipientPhone,
      extract: { ...extract, action: 'reschedule' },
      activeDraft: draft,
      convState,
      requestId,
    });
  }

  if (action === 'stale_choice') {
    return executeStaleChoice({ business, convState });
  }

  if (action === 'clarify_needed') {
    return executeClarifyNeeded({ business, recipientPhone, extract, convState, requestId });
  }
  if (action === 'resolve_clarification') {
    return executeResolveClarification({
      business,
      recipientPhone,
      extract,
      convState,
      requestId,
      clientId,
      activeDraft: draft,
    });
  }

  if (action === 'confirm') return executeConfirm({ business, recipientPhone, activeDraft: draft, requestId });
  if (action === 'cancel_pending') return executeCancelPending({ business, recipientPhone, requestId });
  if (action === 'confirm_cancel') {
    if (convState.context_data?.cancel_all) {
      const ids = Array.isArray(convState.context_data.appointment_ids)
        ? convState.context_data.appointment_ids
        : [];
      const appointments = [];
      for (const id of ids) {
        const found = await getDraftBookingById(id, business.id);
        if (found && found.state === 'confirmed') appointments.push(found);
      }
      if (!appointments.length) {
        return handlerResult({
          status: 'ERROR',
          user_message_template_key: 'ERROR_NO_APPOINTMENT',
          data: { client_message: 'Programările nu au fost găsite.' },
        });
      }
      return executeCancelAllAppointments({ business, recipientPhone, appointments, requestId });
    }
    const id = extract.appointment_id || convState.context_data?.appointment_id;
    const appointment = id ? await getDraftBookingById(id, business.id) : null;
    if (!appointment) {
      return handlerResult({
        status: 'ERROR',
        user_message_template_key: 'ERROR_NO_APPOINTMENT',
        data: { client_message: 'Programarea nu a fost găsită.' },
      });
    }
    return executeCancelAppointment({ business, recipientPhone, appointment, requestId });
  }
  if (action === 'abort') {
    await resetConversationState({ businessId: business.id, rawPhone: recipientPhone, requestId });
    return handlerResult({
      status: 'SUCCESS',
      action_performed: 'ABORTED',
      user_message_template_key: 'FLOW_ABORTED',
      data: {},
      menu: entryMenu(business),
    });
  }

  if (action === 'reprompt_grid' || action === 'grid_nav') {
    const ctx = convState.context_data || {};
    const service = ctx.service
      || (draft?.selected_service
        ? /** @type {{ id?: string, name: string, duration_minutes: number }} */ (draft.selected_service)
        : null);
    const pageNow = Number(ctx.grid_page) || 0;
    const delta = extract.choice_id === GRID_PREFIX.PREV ? -1 : extract.choice_id === GRID_PREFIX.NEXT ? 1 : 0;
    const page = action === 'grid_nav' ? Math.max(0, pageNow + delta) : pageNow;
    const kind = ctx.grid_kind || (ctx.pending_date_text ? 'time' : 'day');

    if (!service) {
      if (ctx.intent === 'reschedule' || convState.current_step === CONVERSATION_STEPS.RESCHEDULING) {
        return executeReschedule({
          business,
          recipientPhone,
          extract: { ...extract, action: 'reschedule' },
          activeDraft: draft,
          convState,
          requestId,
        });
      }
      return executeBook({
        business,
        recipientPhone,
        extract: { ...extract, action: 'book', service_id: null },
        clientId,
        requestId,
        activeDraft: draft,
        convState,
      });
    }

    if (kind === 'time' && (ctx.pending_date_text || extract.date_text)) {
      return missingSlotsResult({
        business,
        recipientPhone,
        draft: ctx.intent === 'reschedule' && ctx.appointment_id
          ? { id: ctx.appointment_id, selected_service: service, employee_id: ctx.employee_id }
          : draft,
        service,
        employeeId: ctx.employee_id || draftEmployeeId(draft),
        dateKey: ctx.pending_date_text || extract.date_text,
        timeWindow: ctx.pending_time_window || null,
        requestId,
        reasonKey: 'ASK_TIME',
        conversationStep: ctx.intent === 'reschedule'
          ? CONVERSATION_STEPS.RESCHEDULING
          : CONVERSATION_STEPS.WAITING_FOR_TIME,
        extraContext: ctx.intent === 'reschedule'
          ? {
            intent: 'reschedule',
            appointment_id: ctx.appointment_id,
            google_event_id: ctx.google_event_id,
            employee_id: ctx.employee_id,
            slot_start: ctx.slot_start,
            slot_end: ctx.slot_end,
          }
          : {},
        page,
      });
    }

    return askDateGridResult({
      business,
      recipientPhone,
      draft: ctx.intent === 'reschedule' && ctx.appointment_id
        ? { id: ctx.appointment_id, selected_service: service, employee_id: ctx.employee_id }
        : draft,
      service,
      requestId,
      page,
      conversationStep: ctx.intent === 'reschedule'
        ? CONVERSATION_STEPS.RESCHEDULING
        : CONVERSATION_STEPS.WAITING_FOR_DATE,
      extraContext: ctx.intent === 'reschedule'
        ? {
          intent: 'reschedule',
          appointment_id: ctx.appointment_id,
          google_event_id: ctx.google_event_id,
          employee_id: ctx.employee_id,
          slot_start: ctx.slot_start,
          slot_end: ctx.slot_end,
        }
        : {},
      clientMessage: action === 'reprompt_grid'
        ? `${formatDayGridMessage(listOpenDayWindows(business, { limit: 14 }), business.timezone, service.name)}\n\n_Poți alege din listă sau scrie, ex: *mâine la 10*._`
        : null,
    });
  }

  if (action === 'select_service' || action === 'select_employee' || action === 'select_slot') {
    const modifyIntent = convState.context_data?.intent === 'reschedule'
      || convState.current_step === CONVERSATION_STEPS.RESCHEDULING;
    if (modifyIntent) {
      return executeReschedule({
        business,
        recipientPhone,
        extract: {
          ...extract,
          action: 'reschedule',
          datetime: extract.datetime || (extract.slot_id ? decodeSlotId(extract.slot_id, business.timezone) : null),
        },
        activeDraft: draft,
        convState,
        requestId,
      });
    }
    return executeBook({
      business,
      recipientPhone,
      extract: {
        ...extract,
        action: 'book',
        datetime: extract.datetime || (extract.slot_id ? decodeSlotId(extract.slot_id, business.timezone) : null),
      },
      clientId,
      requestId,
      activeDraft: draft,
      convState,
    });
  }

  if (action === 'select_appointment') {
    // Intent comes from conversation context set when listing appointments
    // (cancel vs reschedule). Must never ReferenceError — that surfaces as
    // the generic technical WhatsApp fallback after a list pick.
    const modifyIntent = intent
      || (convState.current_step === CONVERSATION_STEPS.CONFIRMING_CANCEL
        || convState.current_step === CONVERSATION_STEPS.MODIFYING
          ? 'cancel'
          : null)
      || (convState.current_step === CONVERSATION_STEPS.RESCHEDULING ? 'reschedule' : null);
    if (modifyIntent === 'cancel') {
      return executeCancel({
        business,
        recipientPhone,
        extract,
        activeDraft: draft,
        convState,
        requestId,
        textBody,
      });
    }
    return executeReschedule({
      business,
      recipientPhone,
      extract,
      activeDraft: draft,
      convState,
      requestId,
    });
  }

  if (action === 'accept_offer') {
    if (extract.employee_id && draft) {
      await setDraftEmployee({
        draftId: draft.id,
        businessId: business.id,
        employeeId: extract.employee_id,
        context: {
          ...draft.conversation_context,
          employee_id: extract.employee_id,
          employee_name: extract.employee_name,
        },
        requestId,
      });
    }
    await clearPendingOffer({
      businessId: business.id,
      rawPhone: recipientPhone,
      requestId,
    });
    return executeBook({
      business,
      recipientPhone,
      extract: { ...extract, action: 'book' },
      clientId,
      requestId,
      activeDraft: draft,
      convState,
    });
  }

  if (action === 'resume_yes') {
    const lastIntent = convState.context_data?.last_booking_intent;
    const start = lastIntent?.slot_start ? new Date(lastIntent.slot_start) : null;
    if (!start || Number.isNaN(start.getTime()) || !lastIntent?.service) {
      return executeBook({
        business,
        recipientPhone,
        extract: { ...extract, action: 'book', datetime: null },
        clientId,
        requestId,
        activeDraft: draft,
        convState,
      });
    }
    return executeBook({
      business,
      recipientPhone,
      extract: {
        ...extract,
        action: 'book',
        datetime: start,
        service_id: lastIntent.service?.id || extract.service_id,
        service_name: lastIntent.service?.name || extract.service_name,
        employee_id: lastIntent.employee_id || extract.employee_id,
      },
      clientId,
      requestId,
      activeDraft: draft,
      convState,
    });
  }
  if (action === 'resume_no') {
    return executeBook({
      business,
      recipientPhone,
      extract: { ...extract, action: 'book', datetime: null },
      clientId,
      requestId,
      activeDraft: draft,
      convState,
    });
  }

  if (action === 'list_appointments') {
    return executeListAppointments({ business, recipientPhone, activeDraft: draft });
  }
  if (action === 'revise_draft') {
    return executeReviseDraft({
      business,
      recipientPhone,
      extract,
      activeDraft: draft,
      convState,
      requestId,
      textBody,
      clientId,
    });
  }
  if (action === 'thanks') {
    return executeThanks(business, lang);
  }
  if (action === 'book') {
    return executeBook({ business, recipientPhone, extract, clientId, requestId, activeDraft: draft, convState });
  }
  if (action === 'reschedule') {
    return executeReschedule({ business, recipientPhone, extract, activeDraft: draft, convState, requestId });
  }
  if (action === 'cancel' || action === 'cancel_all') {
    return executeCancel({
      business,
      recipientPhone,
      extract,
      activeDraft: draft,
      convState,
      requestId,
      textBody,
    });
  }
  if (action === 'hours') return executeHours(business, lang);
  if (action === 'services') return executeServices(business, lang);
  if (action === 'hours_and_services') return executeHoursAndServices(business, lang);
  if (action === 'contact') return executeContact(business);
  if (action === 'menu') return executeMenu(business, recipientPhone, requestId);
  if (action === 'callback') {
    return executeCallback({ business, recipientPhone, extract, clientId, requestId, textBody });
  }
  if (action === 'set_name') {
    return executeSetName({ business, recipientPhone, extract, activeDraft: draft, requestId });
  }
  if (action === 'off_topic') return executeOffTopic(business, lang);
  if (action === 'missing_info') return executeMissingInfo(business, textBody, lang);
  if (action === 'show_services') {
    return missingService(business, recipientPhone, draft, requestId);
  }
  if (action === 'unknown_service') {
    const asked = String(extract.unknown_service_name || '').trim();
    const label = asked || 'acest serviciu';
    const menu = unknownServiceOfferMenu(business);
    await setConversationStep({
      businessId: business.id,
      rawPhone: recipientPhone,
      step: CONVERSATION_STEPS.WAITING_FOR_SERVICE,
      context: {
        booking_wait: BOOKING_WAIT.SERVICE,
        last_menu: menu,
        intent: 'book',
      },
      mergeContext: true,
      requestId,
    });
    return handlerResult({
      status: 'MISSING_INFO',
      action_performed: null,
      next_required_step: 'CHOOSE_SERVICE',
      user_message_template_key: 'UNKNOWN_SERVICE',
      data: {
        business_name: business.name,
        service_name: asked || null,
        client_message:
          `Din păcate nu oferim *${label}*. ` +
          'Poți alege din catalogul nostru sau te pot pune în legătură cu cineva de la locație.',
        services: getBookingConfig(business).services.slice(0, 10).map((s) => ({
          id: s.id,
          name: s.name,
          duration_minutes: s.duration_minutes,
          price_ron: s.price_ron ?? null,
        })),
      },
      menu,
      // No ACTION_ASK_SERVICE — keep UNKNOWN_SERVICE copy (anti-hallucination).
    });
  }

  return executeChat(business, textBody, lang);
}

/**
 * Last-resort: never show "Nu am înțeles" when the client clearly wants cancel/reschedule.
 * Mid-flow "modific" must revise the draft — not jump to saved appointments.
 *
 * @returns {'cancel' | 'reschedule' | 'revise_draft' | null}
 */
function rerouteModification(textBody, extract, ctx = {}) {
  const action = extract?.action;
  if (
    action === 'cancel'
    || action === 'cancel_all'
    || action === 'reschedule'
    || action === 'revise_draft'
    || action === 'select_appointment'
    || action === 'thanks'
    || action === 'confirm'
    || action === 'cancel_pending'
  ) {
    return null;
  }
  const steal = new Set(['chat', 'off_topic', 'missing_info', 'clarify_needed', 'unknown_service', 'show_services', 'book']);
  if (!steal.has(String(action || ''))) return null;

  const mod = detectModificationIntent(textBody);
  if (mod === 'cancel') return 'cancel';

  if (looksLikeExplicitSavedReschedule(textBody)) return 'reschedule';

  const inFlight = isInFlightBookingContext({
    step: ctx.step,
    wait: ctx.wait,
    activeDraft: ctx.activeDraft,
    context: ctx.context,
  });

  if (inFlight && looksLikeInFlightRevision(textBody)) return 'revise_draft';
  if (mod === 'reschedule') return 'reschedule';
  return null;
}

function bookingMachineHandles(action) {
  return action === 'book'
    || action === 'clarify_needed'
    || action === 'select_service';
}

/**
 * Layer 2 entry: merge draft, persist atomically, decide the next action.
 * CHECK_SLOT falls through to executeBook (DB claim).
 *
 * @returns {Promise<HandlerResult | null>}
 */
async function runBookingMachine(params) {
  const { business, recipientPhone, extract, convState, activeDraft, requestId, textBody } = params;
  // Defense in depth: never collect a new service / draft while modify is active.
  const modifyGuard = convState?.context_data?.intent === 'reschedule'
    || convState?.context_data?.intent === 'cancel'
    || convState?.current_step === CONVERSATION_STEPS.RESCHEDULING
    || convState?.current_step === CONVERSATION_STEPS.MODIFYING
    || convState?.current_step === CONVERSATION_STEPS.CONFIRMING_CANCEL;
  if (modifyGuard) return null;

  let draft = hydrateCatalogService(readDraftBooking(convState, activeDraft), business);
  const namedThisTurn = Boolean(extract.service_id || extract.service_name);
  const keepLeftoverService = namedThisTurn
    || sessionKeepsChosenService(mapSessionState(convState?.current_step));
  if (isCleanSlateBooking(extract)) {
    draft = {
      ...draft,
      date: null,
      time: null,
      service_id: null,
      service_name: null,
      duration: null,
    };
  } else if (!keepLeftoverService) {
    draft = {
      ...draft,
      service_id: null,
      service_name: null,
      duration: null,
    };
  }
  if (extract.service_id) {
    draft.service_id = extract.service_id;
    draft.service_name = extract.service_name || draft.service_name;
  }

  let reduced = reduceBookingTurn({
    state: mapSessionState(convState?.current_step),
    draft,
    extraction: extract.extraction || null,
    text: textBody || '',
    timezone: business.timezone || 'Europe/Bucharest',
    extractDate: extract.date_text,
    extractTime: extract.time_text,
    extractServiceId: extract.service_id,
    extractServiceName: extract.service_name,
  });
  reduced = { ...reduced, draft: hydrateCatalogService(reduced.draft, business) };
  if (reduced.draft.service_id && reduced.action === MACHINE_ACTIONS.ACTION_ASK_SERVICE) {
    reduced = { ...nextActionFromDraft(reduced.draft), draft: reduced.draft };
  }

  extract.date_text = reduced.draft.date;
  extract.time_text = reduced.draft.time;
  if (reduced.draft.service_id) {
    extract.service_id = reduced.draft.service_id;
    extract.service_name = reduced.draft.service_name || extract.service_name;
  }
  if (extract.date_text && extract.time_text && business.timezone) {
    extract.datetime = localToUtc(extract.date_text, extract.time_text, business.timezone);
  } else if (!extract.date_text || !extract.time_text) {
    extract.datetime = null;
  }

  await persistSessionDraft({
    businessId: business.id,
    rawPhone: recipientPhone,
    state: reduced.state,
    draft: reduced.draft,
    extraContext: {
      ...(reduced.action === MACHINE_ACTIONS.ACTION_ASK_CLARIFICATION
        ? {
          clarification: {
            value: reduced.clarify_value,
            rejected: reduced.rejected ?? null,
            date_candidate: reduced.draft.date,
            time_candidate: reduced.draft.time,
            resume_wait: getBookingWait(convState),
            raw_value: reduced.clarify_value != null ? String(reduced.clarify_value) : '',
          },
        }
        : {}),
      ...(reduced.action === MACHINE_ACTIONS.ACTION_ASK_SERVICE
        ? { last_menu: serviceMenu(business) }
        : {}),
      ...(reduced.action === MACHINE_ACTIONS.ACTION_ASK_DATE_TIME
        || reduced.action === MACHINE_ACTIONS.ACTION_ASK_DATE
        || reduced.action === MACHINE_ACTIONS.ACTION_ASK_TIME
        ? { last_menu: null }
        : {}),
    },
    requestId,
  });

  if (reduced.action === MACHINE_ACTIONS.ACTION_ASK_CLARIFICATION) {
    return executeClarifyNeeded({
      business,
      recipientPhone,
      extract: {
        ...extract,
        action: 'clarify_needed',
        ambiguity: {
          value: reduced.clarify_value,
          rejected: reduced.rejected,
          date_label: reduced.clarify_value != null ? String(reduced.clarify_value) : '',
          time_label: reduced.clarify_value != null ? String(reduced.clarify_value) : '',
          reason: reduced.clarify_reason,
        },
      },
      convState,
      requestId,
    });
  }

  if (reduced.action === MACHINE_ACTIONS.ACTION_ASK_SERVICE) {
    const services = getBookingConfig(business).services;
    const menu = serviceMenu(business);
    return handlerResult({
      status: 'MISSING_INFO',
      next_required_step: 'CHOOSE_SERVICE',
      user_message_template_key: 'MISSING_SERVICE',
      data: {
        services: services.slice(0, 10).map((s) => ({
          id: s.id,
          name: s.name,
          duration_minutes: s.duration_minutes,
          price_ron: s.price_ron ?? null,
        })),
        service_name: reduced.draft.service_name,
        list_button: 'Servicii',
        ui: 'list_picker',
      },
      menu,
      machine_action: MACHINE_ACTIONS.ACTION_ASK_SERVICE,
    });
  }

  if (reduced.action === MACHINE_ACTIONS.ACTION_ASK_DATE_TIME
    || reduced.action === MACHINE_ACTIONS.ACTION_ASK_DATE) {
    const service = reduced.draft.service_id
      ? {
        id: reduced.draft.service_id,
        name: reduced.draft.service_name || 'Serviciu',
        duration_minutes: reduced.draft.duration || 30,
      }
      : null;
    return askDateGridResult({
      business,
      recipientPhone,
      draft: activeDraft,
      service,
      requestId,
    });
  }

  if (reduced.action === MACHINE_ACTIONS.ACTION_ASK_TIME && reduced.draft.date) {
    const service = reduced.draft.service_id
      ? {
        id: reduced.draft.service_id,
        name: reduced.draft.service_name || 'Serviciu',
        duration_minutes: reduced.draft.duration || 30,
      }
      : null;
    return missingSlotsResult({
      business,
      recipientPhone,
      draft: activeDraft,
      service,
      employeeId: draftEmployeeId(activeDraft),
      dateKey: reduced.draft.date,
      requestId,
      reasonKey: 'ASK_TIME',
    });
  }

  return null;
}

/**
 * @param {Object} params
 * @returns {Promise<HandlerResult>}
 */
export async function executeTurn(params) {
  if (params.extract?.action === 'resolve_clarification') {
    return executeResolveClarification(params);
  }
  const extract = hydrateExtract(params.extract, params.convState, params.business?.timezone);

  // Never run the new-booking state machine during modify/reschedule — it maps
  // RESCHEDULING→INIT, clears service_id, and asks for the service again while the
  // confirmed appointment stays put (duplicate bookings).
  const modifyFlow = params.convState?.context_data?.intent === 'reschedule'
    || params.convState?.context_data?.intent === 'cancel'
    || params.convState?.current_step === CONVERSATION_STEPS.RESCHEDULING
    || params.convState?.current_step === CONVERSATION_STEPS.MODIFYING
    || params.convState?.current_step === CONVERSATION_STEPS.CONFIRMING_CANCEL
    || extract.action === 'reschedule'
    || extract.action === 'cancel'
    || extract.action === 'cancel_all'
    || extract.action === 'select_appointment'
    || extract.action === 'confirm_cancel';

  // Absolute WhatsApp day_/slot_ taps must not go through the NLP draft reducer —
  // leftover draft_booking.date (e.g. 9 Feb) used to overwrite a fresh day row (2 Sep).
  const structuredCalendarPick = isStructuredDayPick(extract) || isStructuredSlotPick(extract);

  if (!modifyFlow && !structuredCalendarPick && bookingMachineHandles(extract.action)) {
    const handled = await runBookingMachine({ ...params, extract });
    if (handled) return handled;
    extract.action = 'book';
  }

  // Menu day pick → always book toward that date's free hours.
  if (structuredCalendarPick && extract.action !== 'select_slot' && !extract.slot_id) {
    extract.action = 'book';
  }

  await persistPendingExtract({
    business: params.business,
    recipientPhone: params.recipientPhone,
    extract,
    requestId: params.requestId,
  });
  return dispatchExecute({ ...params, extract });
}
