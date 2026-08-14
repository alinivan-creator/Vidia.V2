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
  localToUtc,
} from '../utils/datetime.js';
import {
  assertWithinWorkingHours,
  durationMissingClientMessage,
  hasConfiguredOpenDay,
  hoursUnsetClientMessage,
  resolveServiceDurationMinutes,
} from '../utils/workingHours.js';
import { getPendingTtlMinutes } from '../config/conversationConfig.js';
import { buildBookingCalendarInvite } from '../utils/calendarLink.js';
import { getBusinessContactInfo } from './contactService.js';
import { createCallbackRequest } from '../db/callbackRequestService.js';
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

function hydrateExtract(extract, convState, timezone) {
  const ctx = convState?.context_data || {};
  const next = { ...extract };
  const turnHasDate = Boolean(extract.date_text);
  const turnHasTime = Boolean(extract.time_text);

  if (!turnHasDate && typeof ctx.pending_date_text === 'string' && ctx.pending_date_text) {
    next.date_text = ctx.pending_date_text;
  }
  if (!turnHasTime && typeof ctx.pending_time_text === 'string' && ctx.pending_time_text) {
    next.time_text = ctx.pending_time_text;
  }
  if (!next.service_id && typeof ctx.pending_service_id === 'string') next.service_id = ctx.pending_service_id;
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
  if (extract.date_text) context.pending_date_text = extract.date_text;
  if (extract.time_text) context.pending_time_text = extract.time_text;
  if (extract.service_id) context.pending_service_id = extract.service_id;
  if (extract.employee_id) context.pending_employee_id = extract.employee_id;
  if (extract.slot_id) context.pending_slot_id = extract.slot_id;
  if (extract.date_text && extract.time_text && extract.datetime instanceof Date) {
    context.pending_datetime = extract.datetime.toISOString();
  } else if (extract.date_text && !extract.time_text) {
    context.pending_datetime = null;
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
      { id: PREFIX.CONFIRM, title: '✅ Confirm' },
      { id: PREFIX.CANCEL, title: '❌ Anulează' },
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

async function listSlotsForService({ business, service, draftId, employeeId, requestId, dateKey = null }) {
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
  let slots = await getAvailableSlots({
    business,
    durationMinutes: duration,
    limit: 10,
    excludeDraftId: draftId,
    employeeId,
  });
  if (dateKey) {
    slots = slots.filter((s) => formatDateKey(s.start, business.timezone) === dateKey);
  }
  return { error: null, slots, duration };
}

async function missingService(business, recipientPhone, draft, requestId) {
  const services = getBookingConfig(business).services;
  if (!services.length) {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_GENERIC',
      data: { client_message: 'Nu există servicii configurate în Admin.' },
    });
  }
  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: CONVERSATION_STEPS.CHOOSING_SERVICE,
    context: { draft_id: draft?.id, intent: 'book' },
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
    menu: serviceMenu(business),
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
  conversationStep = CONVERSATION_STEPS.SELECTING_SLOT,
  extraContext = {},
}) {
  const listed = await listSlotsForService({
    business,
    service,
    draftId: draft?.id,
    employeeId,
    requestId,
    dateKey,
  });
  if (listed.error) {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_GENERIC',
      data: { client_message: listed.error },
    });
  }
  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: conversationStep,
    context: { draft_id: draft?.id, intent: extraContext.intent || 'book', service, ...extraContext },
    requestId,
  });
  if (!listed.slots.length) {
    return handlerResult({
      status: 'MISSING_INFO',
      next_required_step: 'CHOOSE_SLOT',
      user_message_template_key: 'SLOT_UNAVAILABLE',
      data: {
        service_name: service?.name,
        occupied_label: occupiedLabel,
        alternatives: [],
        client_message:
          `Nu am găsit ore libere pentru *${service?.name || 'serviciu'}*` +
          (dateKey ? ` pe ${dateKey}` : '') +
          '.',
      },
    });
  }
  return handlerResult({
    status: 'MISSING_INFO',
    next_required_step: 'CHOOSE_SLOT',
    user_message_template_key: reasonKey,
    data: {
      service_name: service?.name,
      occupied_label: occupiedLabel,
      alternatives: listed.slots.map((s) => ({
        id: s.id,
        label: formatSlotLabel(s.start, business.timezone),
      })),
    },
    menu: slotMenu(listed.slots, business.timezone),
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
    step: CONVERSATION_STEPS.CONFIRMING,
    context: {
      draft_id: draft.id,
      service,
      slot_start: slotStart.toISOString(),
      slot_end: slotEnd.toISOString(),
      intent: 'book',
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
    },
    menu: confirmMenu(),
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
  const catalog = getBookingConfig(business).services;
  if (!service && catalog.length === 1) service = catalog[0];

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
        client_message: `Nu am găsit *${extract.employee_name}* în echipă. Alege din listă:`,
        services: staff.map((e) => ({ id: e.id, name: e.name })),
      },
      menu: employeeMenu(staff),
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

  void convState;
  return missingSlotsResult({
    business,
    recipientPhone,
    draft: working,
    service,
    employeeId: draftEmployeeId(working),
    dateKey: extract.date_text,
    requestId,
    reasonKey: 'MISSING_SLOT',
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
          'Nu am putut salva programarea în Google Calendar, deci *nu am confirmat-o*.',
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
            'Nu am putut găsi evenimentul în Google Calendar, deci *nu am anulat* programarea.',
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
            'Nu am putut șterge evenimentul din Google Calendar, deci *nu am anulat* programarea.',
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
            'Nu am găsit evenimentul în Google Calendar, deci *nu am reprogramat*.',
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
            'Nu am putut actualiza Google Calendar, deci *nu am reprogramat*.',
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

  let appointment = null;
  const ctxId = extract.appointment_id || convState.context_data?.appointment_id;
  if (ctxId) appointment = appointments.find((a) => a.id === ctxId) || await getDraftBookingById(ctxId, business.id);
  if (!appointment && appointments.length === 1) appointment = appointments[0];

  if (!appointment) {
    const options = appointments.map((a) => {
      const service = /** @type {{ name?: string }} */ (a.selected_service ?? {});
      const when = a.selected_slot_start
        ? formatSlotLabel(new Date(a.selected_slot_start), business.timezone)
        : '—';
      return { id: `${MOD_PREFIX.APPT}${a.id}`, title: `${service.name || 'Programare'} — ${when}` };
    });
    await setConversationStep({
      businessId: business.id,
      rawPhone: recipientPhone,
      step: CONVERSATION_STEPS.MODIFYING,
      context: { intent: 'reschedule', appointment_ids: appointments.map((a) => a.id) },
      mergeContext: false,
      requestId,
    });
    return handlerResult({
      status: 'MISSING_INFO',
      next_required_step: 'CHOOSE_APPOINTMENT',
      user_message_template_key: 'MISSING_APPOINTMENT',
      data: { intent: 'reschedule', appointments: options },
      menu: { kind: 'modify', options },
    });
  }

  const slotStart = (extract.date_text && extract.time_text)
    ? localToUtc(extract.date_text, extract.time_text, business.timezone)
    : extract.datetime
      || (extract.slot_id ? decodeSlotId(extract.slot_id, business.timezone) : null);
  if (slotStart) {
    return applyReschedule({
      business,
      recipientPhone,
      appointment,
      slotStart,
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
    dateKey: extract.date_text,
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

  let appointment = null;
  const ctxId = extract.appointment_id || convState.context_data?.appointment_id;
  if (ctxId) appointment = appointments.find((a) => a.id === ctxId) || await getDraftBookingById(ctxId, business.id);
  if (!appointment && appointments.length === 1) appointment = appointments[0];

  if (!appointment) {
    const options = appointments.map((a) => {
      const service = /** @type {{ name?: string }} */ (a.selected_service ?? {});
      const when = a.selected_slot_start
        ? formatSlotLabel(new Date(a.selected_slot_start), business.timezone)
        : '—';
      return { id: `${MOD_PREFIX.APPT}${a.id}`, title: `${service.name || 'Programare'} — ${when}` };
    });
    await setConversationStep({
      businessId: business.id,
      rawPhone: recipientPhone,
      step: CONVERSATION_STEPS.MODIFYING,
      context: { intent: 'cancel', appointment_ids: appointments.map((a) => a.id) },
      mergeContext: false,
      requestId,
    });
    return handlerResult({
      status: 'MISSING_INFO',
      next_required_step: 'CHOOSE_APPOINTMENT',
      user_message_template_key: 'MISSING_APPOINTMENT',
      data: { intent: 'cancel', appointments: options },
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
        { id: MOD_PREFIX.CONFIRM_CANCEL, title: '✅ Anulează' },
        { id: MOD_PREFIX.ABORT, title: '❌ Renunță' },
      ],
    },
  });
}

async function executeHours(business) {
  const hours = getConfiguredBusinessHours(business);
  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'HOURS_LOOKUP',
    next_required_step: null,
    user_message_template_key: 'HOURS_LIST',
    data: {
      hours_text: hours ? formatBusinessHoursText(hours) : null,
      hours_configured: Boolean(hours),
    },
  });
}

async function executeServices(business) {
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

async function executeMenu(business) {
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

async function executeChat(business) {
  const hours = getConfiguredBusinessHours(business);
  const services = getBookingConfig(business).services;
  return handlerResult({
    status: 'CHAT',
    action_performed: null,
    next_required_step: null,
    user_message_template_key: 'CHAT_FALLBACK',
    data: {
      business_name: business.name,
      hours_text: hours ? formatBusinessHoursText(hours) : null,
      hours_configured: Boolean(hours),
      services: services.slice(0, 8).map((s) => ({
        name: s.name,
        duration_minutes: s.duration_minutes,
        price_ron: s.price_ron ?? null,
      })),
      contact: getBusinessContactInfo(business),
    },
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

  if (action === 'book') {
    return executeBook({ business, recipientPhone, extract, clientId, requestId, activeDraft: draft, convState });
  }
  if (action === 'reschedule') {
    return executeReschedule({ business, recipientPhone, extract, activeDraft: draft, convState, requestId });
  }
  if (action === 'cancel') {
    return executeCancel({ business, recipientPhone, extract, activeDraft: draft, convState, requestId });
  }
  if (action === 'hours') return executeHours(business);
  if (action === 'services') return executeServices(business);
  if (action === 'contact') return executeContact(business);
  if (action === 'menu') return executeMenu(business);
  if (action === 'callback') {
    return executeCallback({ business, recipientPhone, extract, clientId, requestId, textBody });
  }
  if (action === 'set_name') {
    return executeSetName({ business, recipientPhone, extract, activeDraft: draft, requestId });
  }

  return executeChat(business);
}

/**
 * @param {Object} params
 * @returns {Promise<HandlerResult>}
 */
export async function executeTurn(params) {
  const extract = hydrateExtract(params.extract, params.convState, params.business?.timezone);
  await persistPendingExtract({
    business: params.business,
    recipientPhone: params.recipientPhone,
    extract,
    requestId: params.requestId,
  });
  return dispatchExecute({ ...params, extract });
}
