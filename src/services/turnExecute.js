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
  updateConfirmedBookingSlot,
  cancelOrResetDraft,
} from '../db/draftBookingService.js';
import {
  CONVERSATION_STEPS,
  setConversationStep,
  resetConversationState,
  getOrCreateConversationState,
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
  buildQuickReplyPage,
  formatDayGridMessage,
  formatTimeGridMessage,
  GRID_PREFIX,
} from '../utils/bookingGrid.js';
import { flowsEnabled, getConfiguredFlowId } from './whatsappFlowService.js';
import {
  assertWithinWorkingHours,
  durationMissingClientMessage,
  hasConfiguredOpenDay,
  hoursUnsetClientMessage,
  resolveServiceDurationMinutes,
  unknownInfoClientMessage,
} from '../utils/workingHours.js';
import {
  lookupBusinessInfo,
  formatBusinessInfoReply,
  missingBusinessInfoMessage,
} from '../utils/businessInfoLookup.js';
import { detectClientLanguage } from '../utils/clientLanguage.js';
import { getPendingTtlMinutes } from '../config/conversationConfig.js';
import { buildBookingCalendarInvite } from '../utils/calendarLink.js';
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
import { resolveTargetAppointment } from '../utils/appointmentMatch.js';
import {
  MACHINE_ACTIONS,
  hydrateCatalogService,
  mapSessionState,
  nextActionFromDraft,
  persistSessionDraft,
  readDraftBooking,
  reduceBookingTurn,
  sessionKeepsChosenService,
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

export function hydrateExtract(extract, convState, timezone) {
  const ctx = convState?.context_data || {};
  const next = { ...extract };
  const freshMenuStart = isFreshMenuStart(extract);
  if (freshMenuStart) {
    next.date_text = null;
    next.time_text = null;
    next.time_window = null;
    next.datetime = null;
    next.slot_id = null;
    next.service_id = null;
    next.service_name = null;
    return next;
  }
  const turnHasDate = Boolean(extract.date_text);
  const turnHasTime = Boolean(extract.time_text);
  const turnHasWindow = Boolean(extract.time_window);
  const keepService = sessionKeepsChosenService(mapSessionState(convState?.current_step));

  if (!turnHasDate && typeof ctx.pending_date_text === 'string' && ctx.pending_date_text) {
    next.date_text = ctx.pending_date_text;
  }
  if (!turnHasTime && typeof ctx.pending_time_text === 'string' && ctx.pending_time_text) {
    next.time_text = ctx.pending_time_text;
  }
  if (!turnHasWindow && !next.time_text && typeof ctx.pending_time_window === 'string') {
    next.time_window = ctx.pending_time_window;
  }
  if (next.time_text) next.time_window = null;
  if (!next.service_id && keepService && typeof ctx.pending_service_id === 'string') {
    next.service_id = ctx.pending_service_id;
  }
  if (!next.employee_id && typeof ctx.pending_employee_id === 'string') next.employee_id = ctx.pending_employee_id;
  if (!next.slot_id && typeof ctx.pending_slot_id === 'string') next.slot_id = ctx.pending_slot_id;
  if (!next.appointment_id && typeof ctx.appointment_id === 'string') next.appointment_id = ctx.appointment_id;

  if (next.date_text && next.time_text && timezone) {
    next.datetime = localToUtc(next.date_text, next.time_text, timezone);
  } else if (!turnHasDate && !turnHasTime && typeof ctx.pending_datetime === 'string') {
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
  const freshMenuStart = isFreshMenuStart(extract);
  if (freshMenuStart) {
    context.pending_date_text = null;
    context.pending_time_text = null;
    context.pending_time_window = null;
    context.pending_datetime = null;
    context.pending_slot_id = null;
    context.pending_service_id = null;
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
    context.pending_datetime = null;
  }
  if (freshMenuStart || extract.service_id || extract.service_name || extract.date_text || extract.time_text) {
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
      ...((freshMenuStart || !keepService)
        ? { service_id: null, service_name: null, duration: null }
        : {}),
      ...(freshMenuStart ? { date: null, time: null } : {}),
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
    options: getBookingConfig(business).services.slice(0, 10).map((s) => ({
      id: `${PREFIX.SERVICE}${s.id}`,
      title: s.name,
    })),
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

function hoursError(hoursCheck) {
  return handlerResult({
    status: 'ERROR',
    action_performed: null,
    next_required_step: null,
    user_message_template_key: hoursCheck.reason === 'closed' ? 'CLOSED_HOURS' : 'CLOSED_HOURS',
    data: {
      reason: hoursCheck.reason,
      client_message: hoursCheck.message,
    },
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
  );
}

function appointmentChoiceMenu(appointments, business) {
  return appointments.map((a) => {
    const service = /** @type {{ name?: string }} */ (a.selected_service ?? {});
    const when = a.selected_slot_start
      ? formatSlotLabel(new Date(a.selected_slot_start), business.timezone)
      : '—';
    return { id: `${MOD_PREFIX.APPT}${a.id}`, title: `${service.name || 'Programare'} — ${when}` };
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

async function ensureDraft({ business, recipientPhone, clientId, requestId, activeDraft }) {
  if (activeDraft && ['browsing', 'pending_confirmation'].includes(activeDraft.state)) {
    return activeDraft;
  }
  return startBrowsingFlow({
    businessId: business.id,
    clientId,
    rawPhone: recipientPhone,
    requestId,
  });
}

async function listSlotsForService({
  business,
  service,
  draftId,
  employeeId,
  requestId,
  dateKey = null,
  timeWindow = null,
  limit = 8,
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
  const slots = await getAvailableSlots({
    business,
    durationMinutes: duration,
    limit: dateKey ? limit : Math.max(limit, 12),
    excludeDraftId: draftId,
    employeeId,
    dateKey: dateKey || null,
    timeWindow: timeWindow || null,
  });
  return { error: null, slots: slots.slice(0, limit), duration };
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
  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: CONVERSATION_STEPS.WAITING_FOR_SERVICE,
    context: {
      draft_id: draft?.id,
      intent: 'book',
      booking_wait: BOOKING_WAIT.SERVICE,
      // Free-text is primary; numbered options remain as silent fallback if the client still types 1/2/3.
      last_menu: serviceMenu(business),
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
    },
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
}) {
  // Richer Meta Flow UI when the tenant has published a WhatsApp Flow.
  if (flowsEnabled(business) && page === 0 && !clientMessage) {
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
        flow_token: `vidia_${business.id}_${Date.now().toString(36)}`,
      },
      menu: null,
      machine_action: MACHINE_ACTIONS.ACTION_ASK_DATE,
    });
  }

  const days = listOpenDayWindows(business);
  if (!days.length) {
    return handlerResult({
      status: 'MISSING_INFO',
      next_required_step: 'CHOOSE_DATE',
      user_message_template_key: 'ASK_DATE',
      data: {
        service_name: service?.name,
        client_message: 'Nu am zile deschise în orizontul de programare. Contactează salonul.',
      },
      machine_action: MACHINE_ACTIONS.ACTION_ASK_DATE,
    });
  }
  const qr = buildQuickReplyPage(days, page);
  const body = clientMessage || formatDayGridMessage(days, business.timezone, service?.name);
  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: CONVERSATION_STEPS.WAITING_FOR_DATE,
    context: {
      draft_id: draft?.id,
      intent: 'book',
      service,
      booking_wait: BOOKING_WAIT.DATE,
      grid_kind: 'day',
      grid_page: qr.page,
      last_menu: {
        kind: 'day_grid',
        options: days.map((d) => ({ id: d.id, title: d.title })),
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
      grid_page: qr.page,
      ui: 'rich_card',
    },
    menu: {
      kind: 'day_grid',
      options: qr.actions,
      catalog: days.map((d) => ({ id: d.id, title: d.title })),
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
}) {
  const listed = await listSlotsForService({
    business,
    service,
    draftId: draft?.id,
    employeeId,
    requestId,
    dateKey,
    timeWindow,
  });
  if (listed.error) {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_GENERIC',
      data: { client_message: listed.error },
    });
  }
  const times = listTimeWindows(listed.slots, business.timezone);
  const qr = buildQuickReplyPage(times, page);
  const datePretty = dateKey ? formatRomanianDate(dateKey, business.timezone) : null;
  const body = formatTimeGridMessage(times, dateKey, business.timezone, service?.name);

  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: conversationStep,
    context: {
      draft_id: draft?.id,
      intent: extraContext.intent || 'book',
      service,
      booking_wait: dateKey || timeWindow ? BOOKING_WAIT.TIME : BOOKING_WAIT.DATE,
      pending_time_window: timeWindow || null,
      grid_kind: 'time',
      grid_page: qr.page,
      last_menu: {
        kind: 'time_grid',
        options: times.map((t) => ({ id: t.id, title: t.title })),
      },
      ...extraContext,
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
      time_window: timeWindow,
      client_message: body,
      alternatives: listed.slots.map((s) => ({
        id: s.id,
        label: formatSlotLabel(s.start, business.timezone),
        time: formatTime(s.start, business.timezone),
      })),
      grid_page: qr.page,
    },
    menu: {
      kind: 'time_grid',
      options: qr.actions,
      catalog: times.map((t) => ({ id: t.id, title: t.title })),
    },
    machine_action: reasonKey === 'SLOT_UNAVAILABLE'
      ? MACHINE_ACTIONS.ACTION_SLOT_UNAVAILABLE
      : MACHINE_ACTIONS.ACTION_ASK_TIME,
  });
}

async function afterHold({ business, recipientPhone, draft, service, slotStart, slotEnd, requestId }) {
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
  if (!hoursCheck.ok) return hoursError(hoursCheck);

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
  if (business.business_type === 'consulting') {
    return executeCallback({ business, recipientPhone, extract, clientId, requestId, textBody: 'consulting_booking_interest' });
  }

  let service = null;
  if (extract.service_id) {
    service = getBookingConfig(business).services.find((s) => s.id === extract.service_id) || null;
  }
  if (!service && activeDraft?.selected_service) {
    service = /** @type {Record<string, unknown>} */ (activeDraft.selected_service);
  }
  const draft = await ensureDraft({ business, recipientPhone, clientId, requestId, activeDraft });
  if (!draft) {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_GENERIC',
      data: { client_message: 'Nu am putut porni programarea. Încearcă din nou.' },
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

  const slotStart = (extract.date_text && extract.time_text)
    ? localToUtc(extract.date_text, extract.time_text, business.timezone)
    : extract.datetime
      || (extract.slot_id ? decodeSlotId(extract.slot_id, business.timezone) : null);

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
          + `\n\nInterval preferat: *${extract.time_window}*. Alege ziua, apoi ora.`,
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
  if (!hoursCheck.ok) return hoursError(hoursCheck);

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
      return handlerResult({
        status: 'ERROR',
        user_message_template_key: 'CLOSED_HOURS',
        data: { client_message: result.error || hoursUnsetClientMessage(), reason: result.reason },
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

  await confirmDraftBooking({
    draftId: draft.id,
    businessId: business.id,
    googleEventId: result.eventId,
    googleEventLink: result.htmlLink,
    context: { ...draft.conversation_context, step: 'confirmed' },
    requestId,
  });
  await optInClientAfterBooking({
    businessId: business.id,
    rawPhone: recipientPhone,
  });
  await resetConversationState({
    businessId: business.id,
    rawPhone: recipientPhone,
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

async function executeCancelAppointment({ business, recipientPhone, appointment, requestId }) {
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

  if (!isBusinessMockMode(business)) {
    if (!eventId) {
      return handlerResult({
        status: 'ERROR',
        user_message_template_key: 'ERROR_CALENDAR',
        data: {
          client_message:
            'Din păcate nu am putut anula programarea. Te rog încearcă din nou.',
        },
      });
    }
    const del = await deleteCalendarEvent({ business, eventId, calendarId, requestId });
    if (!del?.ok) {
      return handlerResult({
        status: 'ERROR',
        user_message_template_key: 'ERROR_CALENDAR',
        data: {
          client_message:
            'Din păcate nu am putut anula programarea. Te rog încearcă din nou.',
        },
      });
    }
  } else if (appointment.google_event_id) {
    await deleteCalendarEvent({
      business,
      eventId: appointment.google_event_id,
      calendarId,
      requestId,
    });
  }

  await cancelOrResetDraft({
    draftId: appointment.id,
    businessId: business.id,
    state: 'cancelled',
    context: {
      ...appointment.conversation_context,
      step: 'cancelled_by_user',
      google_event_id: eventId || appointment.google_event_id,
    },
    requestId,
  });
  await resetConversationState({
    businessId: business.id,
    rawPhone: recipientPhone,
    requestId,
  });
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
  if (!hoursCheck.ok) return hoursError(hoursCheck);

  const { employeeId, calendarId } = await resolveStaff(business, appointment);
  await lazySyncCalendar({ business, requestId, force: true, calendarId, employeeId });

  const claimed = await claimSlotForDraft({
    draftId: appointment.id,
    businessId: business.id,
    slotStart,
    slotEnd,
    employeeId,
    mode: 'reschedule',
    context: {
      step: 'rescheduled',
      previous_slot_start: convState.context_data?.slot_start,
      rescheduled_at: new Date().toISOString(),
      employee_id: employeeId,
    },
    requestId,
  });
  if (!claimed.ok) {
    const listed = await listSlotsForService({
      business,
      service,
      draftId: appointment.id,
      employeeId,
      requestId,
      dateKey: formatDateKey(slotStart, business.timezone),
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
        alternatives: (listed.slots || []).map((s) => ({
          id: s.id,
          label: formatSlotLabel(s.start, business.timezone),
        })),
      },
      menu: listed.slots?.length ? slotMenu(listed.slots, business.timezone) : null,
    });
  }

  const storedEventId = convState.context_data?.google_event_id || appointment.google_event_id;
  const eventId = await resolveCalendarEventId({
    business,
    eventId: storedEventId,
    phoneNumber: appointment.phone_number || recipientPhone,
    startIso: appointment.selected_slot_start,
    endIso: appointment.selected_slot_end,
    calendarId,
    requestId,
  });

  if (!isBusinessMockMode(business)) {
    if (!eventId) {
      return handlerResult({
        status: 'ERROR',
        user_message_template_key: 'ERROR_CALENDAR',
        data: {
          client_message:
            'Din păcate nu am putut reprograma. Te rog încearcă din nou.',
        },
      });
    }
    const calResult = await updateCalendarEvent({
      business,
      eventId,
      calendarId,
      updates: {
        summary: `${service.name || 'Programare'} — ${appointment.phone_number || recipientPhone}`,
        start: { dateTime: slotStart.toISOString(), timeZone: business.timezone },
        end: { dateTime: slotEnd.toISOString(), timeZone: business.timezone },
      },
      requestId,
    });
    if (!calResult?.ok) {
      return handlerResult({
        status: 'ERROR',
        user_message_template_key: 'ERROR_CALENDAR',
        data: {
          client_message:
            'Din păcate nu am putut reprograma. Te rog încearcă din nou.',
        },
      });
    }
  } else if (eventId) {
    await updateCalendarEvent({
      business,
      eventId,
      calendarId,
      updates: {
        summary: `${service.name || 'Programare'} — ${appointment.id.slice(0, 8)}`,
        start: { dateTime: slotStart.toISOString(), timeZone: business.timezone },
        end: { dateTime: slotEnd.toISOString(), timeZone: business.timezone },
      },
      requestId,
    });
  }

  await updateConfirmedBookingSlot({
    draftId: appointment.id,
    businessId: business.id,
    slotStart,
    slotEnd,
    googleEventId: eventId || undefined,
    context: {
      step: 'rescheduled',
      previous_slot_start: convState.context_data?.slot_start,
      rescheduled_at: new Date().toISOString(),
      google_event_id: eventId,
      employee_id: employeeId,
    },
    requestId,
  });
  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: CONVERSATION_STEPS.MODIFIED,
    context: {
      last_action: 'rescheduled',
      appointment_id: appointment.id,
      slot_start: slotStart.toISOString(),
      google_event_id: eventId,
    },
    mergeContext: false,
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
    const options = appointmentChoiceMenu(pool, business);
    await setConversationStep({
      businessId: business.id,
      rawPhone: recipientPhone,
      step: CONVERSATION_STEPS.MODIFYING,
      context: {
        intent: 'reschedule',
        appointment_ids: pool.map((a) => a.id),
        // Keep new-slot hints so the next turn can apply them after choice.
        pending_date_text: extract.date_text || null,
        pending_time_text: extract.time_text || null,
      },
      mergeContext: false,
      requestId,
    });
    return handlerResult({
      status: 'MISSING_INFO',
      next_required_step: 'CHOOSE_APPOINTMENT',
      user_message_template_key: 'MISSING_APPOINTMENT',
      data: {
        intent: 'reschedule',
        appointments: options,
        client_message: resolved.reason === 'ambiguous'
          ? 'Am găsit mai multe programări pe intervalul menționat. Care o mutăm?'
          : null,
      },
      menu: { kind: 'modify', options },
    });
  }

  // slot_hint = date/time named the existing booking; otherwise date/time is the NEW slot.
  let applyStart = null;
  if (resolved.reason !== 'slot_hint') {
    applyStart = (extract.date_text && extract.time_text)
      ? localToUtc(extract.date_text, extract.time_text, business.timezone)
      : extract.datetime
        || (extract.slot_id ? decodeSlotId(extract.slot_id, business.timezone) : null);
    if (!applyStart) {
      const pendingDate = typeof convState.context_data?.pending_date_text === 'string'
        ? convState.context_data.pending_date_text
        : null;
      const pendingTime = typeof convState.context_data?.pending_time_text === 'string'
        ? convState.context_data.pending_time_text
        : null;
      if (pendingDate && pendingTime) {
        applyStart = localToUtc(pendingDate, pendingTime, business.timezone);
      }
    }
  }

  if (applyStart) {
    return applyReschedule({
      business,
      recipientPhone,
      appointment,
      slotStart: applyStart,
      convState,
      requestId,
    });
  }

  const { employeeId } = await resolveStaff(business, appointment);
  return missingSlotsResult({
    business,
    recipientPhone,
    draft: appointment,
    service: appointment.selected_service,
    employeeId,
    dateKey: resolved.reason === 'slot_hint' ? null : extract.date_text,
    requestId,
    reasonKey: 'MISSING_SLOT',
    conversationStep: CONVERSATION_STEPS.RESCHEDULING,
    extraContext: {
      intent: 'reschedule',
      appointment_id: appointment.id,
      google_event_id: appointment.google_event_id,
      employee_id: employeeId,
      slot_start: appointment.selected_slot_start,
      slot_end: appointment.selected_slot_end,
    },
  });
}

async function executeCancel({ business, recipientPhone, extract, activeDraft, convState, requestId }) {
  if (activeDraft && ['browsing', 'pending_confirmation'].includes(activeDraft.state)
      && convState.current_step !== CONVERSATION_STEPS.CONFIRMING_CANCEL) {
    return executeCancelPending({ business, recipientPhone, requestId });
  }

  const appointments = await listActionableAppointments(business, recipientPhone, requestId);
  if (!appointments.length) {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_NO_APPOINTMENT',
      data: { client_message: 'Nu am găsit o programare activă de anulat. Scrie *programare* pentru una nouă.' },
    });
  }

  const resolved = resolveAppointmentForModify(appointments, extract, convState, business, 'cancel');
  let appointment = resolved.appointment;
  if (resolved.reason === 'id' && appointment && !appointments.find((a) => a.id === appointment.id)) {
    appointment = await getDraftBookingById(appointment.id, business.id);
  }

  if (!appointment) {
    if (resolved.reason === 'not_found' && (extract.date_text || extract.time_text)) {
      const hint = [
        extract.date_text,
        extract.time_text,
      ].filter(Boolean).join(' ');
      const options = appointmentChoiceMenu(appointments, business);
      await setConversationStep({
        businessId: business.id,
        rawPhone: recipientPhone,
        step: CONVERSATION_STEPS.MODIFYING,
        context: {
          intent: 'cancel',
          appointment_ids: appointments.map((a) => a.id),
        },
        mergeContext: false,
        requestId,
      });
      return handlerResult({
        status: 'MISSING_INFO',
        next_required_step: 'CHOOSE_APPOINTMENT',
        user_message_template_key: 'MISSING_APPOINTMENT',
        data: {
          intent: 'cancel',
          appointments: options,
          client_message:
            `Nu am găsit o programare la *${hint}*. Care vrei să anulezi?`,
        },
        menu: { kind: 'modify', options },
      });
    }

    const pool = resolved.candidates?.length ? resolved.candidates : appointments;
    const options = appointmentChoiceMenu(pool, business);
    await setConversationStep({
      businessId: business.id,
      rawPhone: recipientPhone,
      step: CONVERSATION_STEPS.MODIFYING,
      context: {
        intent: 'cancel',
        appointment_ids: pool.map((a) => a.id),
      },
      mergeContext: false,
      requestId,
    });
    return handlerResult({
      status: 'MISSING_INFO',
      next_required_step: 'CHOOSE_APPOINTMENT',
      user_message_template_key: 'MISSING_APPOINTMENT',
      data: {
        intent: 'cancel',
        appointments: options,
        client_message: resolved.reason === 'ambiguous'
          ? 'Am găsit mai multe programări pe intervalul menționat. Care o anulezi?'
          : null,
      },
      menu: { kind: 'modify', options },
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
  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'CONTACT_LOOKUP',
    next_required_step: null,
    user_message_template_key: 'CONTACT',
    data: { contact: getBusinessContactInfo(business), business_name: business.name },
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
  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'NAME_SAVED',
    next_required_step: null,
    user_message_template_key: 'ASK_CONFIRM',
    data: { client_name: name },
    menu: confirmMenu(),
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

async function executeChat(business) {
  return handlerResult({
    status: 'CHAT',
    action_performed: null,
    next_required_step: null,
    user_message_template_key: 'CHAT_FALLBACK',
    data: { business_name: business.name },
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
  let draft = activeDraft;
  if (draft?.state === 'pending_confirmation') {
    const expiry = await expirePendingIfNeeded({ business, draft, recipientPhone, requestId });
    if (expiry.expired) draft = null;
  }

  const action = extract.action;
  const intent = convState.context_data?.intent;
  const lang = detectClientLanguage(textBody, convState?.context_data?.client_language);

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
        draft,
        service,
        employeeId: draftEmployeeId(draft),
        dateKey: ctx.pending_date_text || extract.date_text,
        timeWindow: ctx.pending_time_window || null,
        requestId,
        reasonKey: 'ASK_TIME',
        page,
      });
    }

    return askDateGridResult({
      business,
      recipientPhone,
      draft,
      service,
      requestId,
      page,
      clientMessage: action === 'reprompt_grid'
        ? `${formatDayGridMessage(listOpenDayWindows(business), business.timezone, service.name)}\n\n_Alege o fereastră — nu scrie text._`
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
    if (intent === 'cancel') {
      return executeCancel({
        business,
        recipientPhone,
        extract,
        activeDraft: draft,
        convState,
        requestId,
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
  if (action === 'book') {
    return executeBook({ business, recipientPhone, extract, clientId, requestId, activeDraft: draft, convState });
  }
  if (action === 'reschedule') {
    return executeReschedule({ business, recipientPhone, extract, activeDraft: draft, convState, requestId });
  }
  if (action === 'cancel') {
    return executeCancel({ business, recipientPhone, extract, activeDraft: draft, convState, requestId });
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

  return executeChat(business);
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
  let draft = hydrateCatalogService(readDraftBooking(convState, activeDraft), business);
  const namedThisTurn = Boolean(extract.service_id || extract.service_name);
  const keepLeftoverService = namedThisTurn
    || sessionKeepsChosenService(mapSessionState(convState?.current_step));
  if (isFreshMenuStart(extract)) {
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
      },
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

  if (bookingMachineHandles(extract.action)) {
    const handled = await runBookingMachine({ ...params, extract });
    if (handled) return handled;
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
