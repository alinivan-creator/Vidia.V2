/**
 * Step 2 — Backend execution / single source of truth.
 * Hours, catalog duration, calendar and DB writes happen here.
 * Returns a HandlerResult; never sends WhatsApp.
 */

import { getAvailableSlots, isSlotAvailable, pendingHoldCacheEventId } from '../db/cacheService.js';
import {
  getActiveDraftBooking,
  setSelectedService,
  setDraftEmployee,
  claimSlotForDraft,
  confirmDraftBooking,
  startBrowsingFlow,
  listUpcomingConfirmedBookings,
  getDraftBookingById,
  rescheduleConfirmedBookingAtomic,
  cancelConfirmedBookingAtomic,
  setDraftGoogleEvent,
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
import { formatRomanianDate, formatLocalizedDate } from '../lib/ai/responseFormatter.js';
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
import { resolveClientLanguage } from '../utils/clientLanguage.js';
import { t, tf } from '../utils/uiI18n.js';
import { bm, businessLabel } from '../utils/bookingI18n.js';
import {
  runWithServiceDisplay,
  svcDisplay,
  localizeServicesList,
} from './serviceDisplayI18n.js';
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
import { isEntryMenuChoiceId } from '../utils/entryMenu.js';
import { waServiceMeta } from '../utils/waCopy.js';
import { getBusinessContactInfo } from './contactService.js';
import { createCallbackRequest } from '../db/callbackRequestService.js';
import { optInClientAfterBooking } from './smsMarketingService.js';
import {
  expirePendingIfNeeded,
  releaseGoogleHoldForDraft,
  cancelActiveDraftsForPhoneWithCalendar,
  cancelOrResetDraftWithCalendar,
  purgeDuplicatePendingHoldsForPhone,
} from './pendingExpiryService.js';
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
  hasExternalGoogleOverlap,
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

/** Client-facing service label (catalog id unchanged). */
function displaySvc(serviceOrName, serviceId = null, lang = null) {
  if (serviceOrName && typeof serviceOrName === 'object') {
    return svcDisplay(serviceOrName.name, serviceOrName.id, lang);
  }
  return svcDisplay(serviceOrName, serviceId, lang);
}

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

function serviceMenu(business, lang = 'ro') {
  const uiLang = lang === 'en' ? 'en' : 'ro';
  return {
    kind: 'service',
    options: getBookingConfig(business).services.slice(0, 10).map((s) => {
      const meta = waServiceMeta(s);
      return {
        id: `${PREFIX.SERVICE}${s.id}`,
        title: String(displaySvc(s, null, uiLang) || t('labelService', uiLang)).slice(0, 24),
        description: (meta || t('available', uiLang)).slice(0, 72),
      };
    }),
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

function employeeMenu(employees, lang = 'ro') {
  const en = lang === 'en';
  return {
    kind: 'employee',
    options: [
      ...employees.slice(0, 9).map((e) => ({ id: `${PREFIX.EMPLOYEE}${e.id}`, title: e.name })),
      { id: PREFIX.ANY_EMPLOYEE, title: en ? t('firstAvailable', 'en') : t('firstAvailable', 'ro') },
    ],
  };
}

function confirmMenu(lang = 'ro') {
  const en = lang === 'en';
  return {
    kind: 'confirm',
    options: [
      { id: PREFIX.CONFIRM, title: en ? 'Confirm' : 'Confirmă' },
      { id: PREFIX.CANCEL, title: en ? 'Cancel' : 'Anulează' },
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
    await cancelOrResetDraftWithCalendar({
      business,
      draftId: appointment.id,
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

function appointmentChoiceMenu(appointments, business, { includeCancelAll = false, lang = 'ro' } = {}) {
  return buildAppointmentChoiceMenu(appointments, business.timezone, {
    includeCancelAll,
    apptPrefix: MOD_PREFIX.APPT,
    cancelAllId: MOD_PREFIX.CANCEL_ALL,
    lang,
  });
}

/**
 * Persist the interactive appointment picker and lock the conversation on CHOOSE_APPOINTMENT.
 * last_menu stores the full catalog so page nav (Alte programări ›) and numbered replies work.
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
  lang = 'ro',
  page = 0,
}) {
  const uiLang = lang === 'en' ? 'en' : 'ro';
  const catalog = appointmentChoiceMenu(appointments, business, { includeCancelAll, lang: uiLang });
  const listPage = buildListPickerPage(catalog, page, 10, {
    lang: uiLang,
    nextTitle: uiLang === 'en' ? 'More appointments ›' : 'Alte programări ›',
    prevTitle: uiLang === 'en' ? '‹ Back' : '‹ Înapoi',
    nextDesc: uiLang === 'en' ? 'Next page' : 'Pagina următoare',
    prevDesc: uiLang === 'en' ? 'Previous page' : 'Pagina anterioară',
  });
  const pageOptions = listPage.items.map((i) => ({
    id: i.id,
    title: i.title,
    description: i.description,
  }));
  const menuOptions = mergeMenuOptions(pageOptions, catalog);
  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: CONVERSATION_STEPS.MODIFYING,
    context: {
      intent,
      appointment_ids: appointments.map((a) => a.id),
      include_cancel_all: includeCancelAll,
      grid_kind: 'modify',
      grid_page: listPage.page,
      last_menu: { kind: 'modify', options: menuOptions },
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
      appointments: pageOptions,
      client_message: clientMessage,
      list_button: uiLang === 'en' ? 'Your appointments' : 'Programările tale',
    },
    menu: { kind: 'modify', options: pageOptions, catalog },
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
  lang = 'ro',
}) {
  const openDays = listOpenDayWindows(business, { limit: 14, lang });
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

async function missingService(business, recipientPhone, draft, requestId, lang = 'ro') {
  const uiLang = lang === 'en' ? 'en' : 'ro';
  const services = getBookingConfig(business).services;
  if (!services.length) {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_GENERIC',
      data: { client_message: unknownInfoClientMessage(lang) },
    });
  }
  const menu = serviceMenu(business, lang);
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
      services: localizeServicesList(services.slice(0, 10).map((s) => ({
        id: s.id,
        name: s.name,
        duration_minutes: s.duration_minutes,
        price_ron: s.price_ron ?? null,
      })), lang),
      list_button: t('listServices', uiLang),
      ui: 'list_picker',
      ui_language: uiLang,
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
  lang = 'ro',
}) {
  const uiLang = lang === 'en' ? 'en' : 'ro';
  const intent = extraContext.intent || 'book';
  // Richer Meta Flow UI when the tenant has published a WhatsApp Flow.
  // A notice must stay visible, so keep the text grid in that case.
  if (flowsEnabled(business) && page === 0 && !clientMessage && !notice && intent !== 'reschedule') {
    const flowId = getConfiguredFlowId(business);
    const body = service?.name
      ? tf('flowCalendarPromptService', uiLang, { service: displaySvc(service, null, uiLang) })
      : t('flowCalendarPrompt', uiLang);
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
        service_name: displaySvc(service),
        client_message: body,
        ui: 'whatsapp_flow',
        flow_id: flowId,
        flow_token: createFlowToken(business.id),
        ui_language: uiLang,
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
    lang: uiLang,
  });
  if (!days.length) {
    return handlerResult({
      status: 'MISSING_INFO',
      next_required_step: 'CHOOSE_DATE',
      user_message_template_key: 'ASK_DATE',
      data: {
        service_name: displaySvc(service),
        client_message: withNotice(
          notice,
          uiLang === 'en'
            ? bm('noOpenDays14', 'en', { business: businessLabel('en', business.name) })
            : bm('noOpenDays14', 'ro', { business: businessLabel('ro', business.name) }),
        ),
      },
      machine_action: MACHINE_ACTIONS.ACTION_ASK_DATE,
    });
  }
  const listPage = buildListPickerPage(days, page, 10, { lang: uiLang });
  const body = withNotice(
    notice,
    clientMessage || formatDayGridMessage(days, business.timezone, service ? displaySvc(service, null, uiLang) : null, uiLang),
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
      service_name: displaySvc(service),
      client_message: body,
      grid_page: listPage.page,
      ui: 'list_picker',
      list_button: t('listDays', uiLang),
      ui_language: uiLang,
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
  lang = 'ro',
}) {
  const uiLang = lang === 'en' ? 'en' : 'ro';
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
  const listPage = buildListPickerPage(times, page, 10, { lang: uiLang });
  const datePretty = dateKey ? formatLocalizedDate(dateKey, business.timezone, uiLang) : null;
  const body = withNotice(
    bodyNotice,
    formatTimeGridMessage(times, dateKey, business.timezone, service ? displaySvc(service, null, uiLang) : null, uiLang),
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
    const dateSuffix = datePretty ? (uiLang === 'en' ? ` on *${datePretty}*` : ` pe *${datePretty}*`) : '';
    return askDateGridResult({
      business,
      recipientPhone,
      draft,
      service,
      requestId,
      lang: uiLang,
      conversationStep: extraContext.intent === 'reschedule'
        ? CONVERSATION_STEPS.RESCHEDULING
        : CONVERSATION_STEPS.WAITING_FOR_DATE,
      extraContext: extraContext.intent === 'reschedule' ? extraContext : {},
      notice: bodyNotice,
      clientMessage:
        tf('noFreeTimesForService', uiLang, {
          service: displaySvc(service, null, uiLang) || (uiLang === 'en' ? 'service' : 'serviciu'),
          date: dateSuffix,
        })
        + formatDayGridMessage(
          listOpenDayWindows(business, { lang: uiLang }),
          business.timezone,
          displaySvc(service, null, uiLang),
          uiLang,
        ),
    });
  }
  return handlerResult({
    status: 'MISSING_INFO',
    next_required_step: 'CHOOSE_SLOT',
    user_message_template_key: reasonKey,
    data: {
      service_name: displaySvc(service),
      occupied_label: occupiedLabel,
      date_label: datePretty,
      time_window: windowFilter,
      notice: bodyNotice || null,
      client_message: body,
      alternatives: listed.slots.map((s) => ({
        id: s.id,
        label: formatSlotLabel(s.start, business.timezone, uiLang),
        time: formatTime(s.start, business.timezone),
      })),
      grid_page: listPage.page,
      ui: useQuickReply ? 'quick_reply' : 'list_picker',
      list_button: t('listTimes', uiLang),
      ui_language: uiLang,
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

async function afterHold({ business, recipientPhone, draft, service, slotStart, slotEnd, requestId, lang = null }) {
  const conv = lang
    ? null
    : await getOrCreateConversationState(business.id, recipientPhone);
  const uiLang = lang === 'en' || lang === 'ro'
    ? lang
    : resolveClientLanguage('', null, conv?.context_data);
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
        client_message: bm('errHoldLockFailed', uiLang),
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
  const slotLabel = formatSlotLabel(slotStart, business.timezone, uiLang);

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
          service_name: displaySvc(service),
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
        service_name: displaySvc(service),
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
        last_menu: confirmMenu(uiLang),
        draft_booking: {
          service_id: service.id || service.service_id || null,
          service_name: displaySvc(service),
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
      service_name: displaySvc(service),
      slot_label: slotLabel,
      employee_name: employee?.name ?? null,
      client_name: client.display_name,
      date_key: formatDateKey(slotStart, business.timezone),
      time_hhmm: formatTime(slotStart, business.timezone),
    },
    menu: confirmMenu(uiLang),
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
  lang = 'ro',
}) {
  const uiLang = lang === 'en' ? 'en' : 'ro';
  await purgeDuplicatePendingHoldsForPhone({
    business,
    rawPhone: recipientPhone,
    keepDraftId: draft?.id ?? null,
    requestId,
  });
  const duration = catalogDuration(business, service);
  if (!duration) {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_DURATION',
      data: { client_message: durationMissingClientMessage(service?.name, uiLang) },
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
      data: { client_message: bm('errSlotRetainFailed', uiLang) },
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
      data: { client_message: bm('errSlotLockFailed', uiLang) },
    });
  }

  console.log('[booking] Slot held pending_confirmation', {
    draftId: claimed.draft.id,
    slotStart: slotStart.toISOString(),
    lockedUntil: claimed.draft.locked_until ?? claimed.draft.pending_expires_at ?? null,
    requestId,
  });

  // Visible Google Calendar soft-lock — without this, Admin/manual calendar
  // looks free until Confirm and double-booking is easy.
  const staffForHold = await resolveStaff(business, claimed.draft);
  if (claimed.draft.google_event_id) {
    try {
      await deleteCalendarEvent({
        business,
        eventId: claimed.draft.google_event_id,
        calendarId: staffForHold.calendarId,
        requestId,
      });
    } catch (error) {
      console.warn('[booking] failed to clear previous Google hold', error);
    }
  }

  const holdEvent = await createCalendarEvent({
    business,
    calendarId: staffForHold.calendarId,
    employeeId: staffForHold.employeeId,
    event: {
      summary: `⏳ HOLD — ${service.name}`,
      description:
        `Pending WhatsApp booking (not confirmed yet)\n` +
        `Phone: ${claimed.draft.phone_number || recipientPhone}\n` +
        `Draft: ${claimed.draft.id}\n` +
        `Expires with pending TTL if not confirmed.`,
      startIso: slotStart.toISOString(),
      endIso: slotEnd.toISOString(),
    },
    requestId,
  });

  let draftAfterHold = claimed.draft;
  if (holdEvent.ok && holdEvent.eventId && !isMockEventId(holdEvent.eventId) && !holdEvent.mocked) {
    const withEvent = await setDraftGoogleEvent({
      draftId: claimed.draft.id,
      businessId: business.id,
      googleEventId: holdEvent.eventId,
      googleEventLink: holdEvent.htmlLink,
      requestId,
    });
    if (withEvent) draftAfterHold = withEvent;
    console.log('[booking] Google HOLD event created', {
      draftId: claimed.draft.id,
      eventId: holdEvent.eventId,
      requestId,
    });
  } else {
    console.warn('[booking] Google HOLD event missing — cache soft-lock only', {
      draftId: claimed.draft.id,
      reason: holdEvent.error || holdEvent.reason || 'unknown',
      requestId,
    });
  }

  return afterHold({
    business,
    recipientPhone,
    draft: draftAfterHold,
    service,
    slotStart,
    slotEnd,
    requestId,
  });
}

async function executeBook({ business, recipientPhone, extract, clientId, requestId, activeDraft, convState }) {
  const lang = resolveClientLanguage('', null, convState?.context_data);
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
      data: { client_message: bm('errBookingStartFailed', lang) },
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
    return missingService(business, recipientPhone, draft, requestId, lang);
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
        client_message: bm('errEmployeeNotFound', lang, {
          name: extract.employee_name,
          staff: staff.map((e) => e.name).join(', '),
        }),
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
      lang,
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
      const pretty = formatLocalizedDate(extract.date_text, business.timezone, lang);
      return askDateGridResult({
        business,
        recipientPhone,
        draft: working,
        service,
        requestId,
        lang,
        notice: bm('closedDayNotice', lang, { date: pretty }),
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

async function executeConfirm({ business, recipientPhone, activeDraft, requestId, convState }) {
  const lang = resolveClientLanguage('', null, convState?.context_data);
  const uiLang = lang === 'en' ? 'en' : 'ro';
  let draft = activeDraft || await getActiveDraftBooking(business.id, recipientPhone);
  const expiry = await expirePendingIfNeeded({ business, draft, recipientPhone, requestId });
  if (expiry.expired) {
    return handlerResult({
      status: 'MISSING_INFO',
      action_performed: null,
      next_required_step: 'RESUME_OR_BOOK',
      user_message_template_key: 'HOLD_EXPIRED',
      data: {
        client_message: bm('errHoldExpired', uiLang),
        last_intent: expiry.lastIntent || null,
        ui_language: uiLang,
      },
    });
  }
  if (!draft || draft.state !== 'pending_confirmation') {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_GENERIC',
      data: { client_message: bm('errNoPendingConfirm', uiLang), ui_language: uiLang },
    });
  }

  const service = /** @type {{ name: string; duration_minutes: number }} */ (draft.selected_service);
  const slotStart = draft.selected_slot_start;
  if (!service || !slotStart) {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_GENERIC',
      data: { client_message: bm('errIncompleteBooking', uiLang), ui_language: uiLang },
    });
  }

  const duration = catalogDuration(business, service);
  if (!duration) {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_DURATION',
      data: { client_message: durationMissingClientMessage(service.name, uiLang), ui_language: uiLang },
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

  // Final lock check before Google write — force-sync + live Google overlap
  // (manual events added after hold must block confirm).
  const { employeeId: confirmEmpId, employee: confirmEmp, calendarId: confirmCalId } = await resolveStaff(business, draft);
  await lazySyncCalendar({
    business,
    requestId,
    force: true,
    calendarId: confirmCalId,
    employeeId: confirmEmpId,
  });

  const ownEventId = typeof draft.google_event_id === 'string' ? draft.google_event_id : null;
  const excludeEventIds = [
    pendingHoldCacheEventId(draft.id),
    ...(ownEventId ? [ownEventId] : []),
  ];

  const confirmSlotId = encodeSlotId(startDate, business.timezone);
  const stillAvailable = await isSlotAvailable({
    business,
    slotId: confirmSlotId,
    durationMinutes: duration,
    excludeDraftId: draft.id,
    employeeId: confirmEmpId,
    excludeGoogleEventIds: excludeEventIds,
  });
  const googleConflict = await hasExternalGoogleOverlap({
    business,
    startIso: startDate.toISOString(),
    endIso: endDate.toISOString(),
    calendarId: confirmCalId,
    excludeEventIds: ownEventId ? [ownEventId] : [],
    requestId,
  });
  if (!stillAvailable || googleConflict) {
    await cancelOrResetDraftWithCalendar({
      business,
      draftId: draft.id,
      state: 'browsing',
      context: { ...draft.conversation_context, step: 'slot_lost_on_confirm' },
      requestId,
    });
    if (ownEventId) {
      try {
        await deleteCalendarEvent({
          business,
          eventId: ownEventId,
          calendarId: confirmCalId,
          requestId,
        });
      } catch (error) {
        console.warn('[booking] failed to release Google hold after conflict', error);
      }
    }
    return missingSlotsResult({
      business,
      recipientPhone,
      draft,
      service,
      employeeId: confirmEmpId,
      dateKey: formatDateKey(startDate, business.timezone),
      requestId,
      reasonKey: 'SLOT_UNAVAILABLE',
      occupiedLabel: formatSlotLabel(startDate, business.timezone),
    });
  }

  const phoneE164 = draft.phone_number;
  const client = await getClientByPhone({ businessId: business.id, rawPhone: recipientPhone, requestId });
  const clientName = client?.display_name?.trim() || '';
  const employeeId = confirmEmpId;
  const employee = confirmEmp;
  const calendarId = confirmCalId;

  const summary = `${service.name} — ${clientName || phoneE164}${employee ? ` (${employee.name})` : ''}`;
  const description =
    `Programare WhatsApp Vidia\n` +
    (clientName ? `Client: ${clientName}\n` : '') +
    `Telefon: ${phoneE164}\n` +
    (employee ? `Angajat: ${employee.name}\n` : '') +
    `Draft: ${draft.id}`;

  /** @type {{ ok: boolean, eventId: string | null, htmlLink: string | null, mocked?: boolean, reason?: string, error?: string }} */
  let result;
  if (ownEventId && !isMockEventId(ownEventId)) {
    const patched = await updateCalendarEvent({
      business,
      eventId: ownEventId,
      calendarId,
      requestId,
      updates: {
        summary,
        description,
        start: { dateTime: startDate.toISOString(), timeZone: business.timezone },
        end: { dateTime: endDate.toISOString(), timeZone: business.timezone },
      },
    });
    if (patched.ok) {
      result = { ok: true, eventId: ownEventId, htmlLink: draft.google_event_link || null, mocked: patched.mocked === true };
    } else {
      result = { ok: false, eventId: null, htmlLink: null, reason: patched.reason, error: patched.error };
    }
  } else {
    result = await createCalendarEvent({
      business,
      calendarId,
      employeeId,
      event: {
        summary,
        description,
        startIso: startDate.toISOString(),
        endIso: endDate.toISOString(),
      },
      requestId,
    });
  }

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
        client_message: bm('errConfirmCalendar', uiLang),
        ui_language: uiLang,
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
        client_message: bm('errSaveBooking', uiLang),
        ui_language: uiLang,
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

  const postConv = await getOrCreateConversationState(business.id, recipientPhone);
  const bookedLang = resolveClientLanguage('', null, postConv?.context_data);
  const slotLabel = formatSlotLabel(startDate, business.timezone, bookedLang);
  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'BOOKED',
    next_required_step: null,
    user_message_template_key: 'CONFIRMATION_BOOKED',
    data: {
      service_name: displaySvc(service),
      slot_label: slotLabel,
      client_name: clientName,
      employee_name: employee?.name ?? null,
      date_key: formatDateKey(startDate, business.timezone),
      time_hhmm: formatTime(startDate, business.timezone),
    },
    calendar_cta: calendarCta(business, displaySvc(service), startDate, endDate),
  });
}

async function releaseDraftGoogleHold(business, draft, requestId = null) {
  return releaseGoogleHoldForDraft({ business, draft, requestId });
}

async function executeCancelPending({ business, recipientPhone, requestId }) {
  await cancelActiveDraftsForPhoneWithCalendar({
    business,
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
  const lang = resolveClientLanguage(textBody, null, convState?.context_data);
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

    const reset = await cancelOrResetDraftWithCalendar({
      business,
      draftId: draft.id,
      state: 'browsing',
      context: {
        ...draft.conversation_context,
        step: 'revised_in_flight',
        revised_at: new Date().toISOString(),
        keep_service: true,
      },
      requestId,
    });
    // Hold already released by cancelOrResetDraftWithCalendar.
    const working = reset || draft;

    if (!service?.id && !service?.name) {
      return missingService(business, recipientPhone, working, requestId, lang);
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
        notice: bm('reviseTimeNotice', lang, {
          service: displaySvc(service) || bm('serviceFallback', lang),
        }),
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
        bm('reviseKeepService', lang, {
          service: displaySvc(service) || bm('serviceFallback', lang),
        }),
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
        client_message: bm('errReopenDraft', lang),
        ui_language: lang,
      },
    });
  }

  if (!service?.id && !service?.name) {
    return missingService(business, recipientPhone, browsing, requestId, lang);
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
      bm('reviseKeepService', lang, {
        service: service.name || bm('serviceFallback', lang),
      }),
  });
}

function executeThanks(business, lang = 'ro') {
  const uiLang = lang === 'en' ? 'en' : 'ro';
  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'THANKS',
    next_required_step: null,
    user_message_template_key: 'THANKS',
    data: {
      business_name: business.name,
      ui_language: uiLang,
      client_message: bm('thanksReply', uiLang),
    },
  });
}

async function executeCancelAppointment({
  business,
  recipientPhone,
  appointment,
  requestId,
  resetState = true,
  lang = 'ro',
}) {
  const uiLang = lang === 'en' ? 'en' : 'ro';
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
        client_message: bm('errCancelOne', uiLang),
        ui_language: uiLang,
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
      service_name: displaySvc(appointment.selected_service) || bm('appointmentFallback', uiLang),
      ui_language: uiLang,
    },
  });
}

async function executeCancelAllAppointments({ business, recipientPhone, appointments, requestId, lang = 'ro' }) {
  const uiLang = lang === 'en' ? 'en' : 'ro';
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
      lang: uiLang,
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
        client_message: bm('errCancelAll', uiLang),
        ui_language: uiLang,
      },
    });
  }
  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'CANCELLED',
    next_required_step: null,
    user_message_template_key: 'CONFIRMATION_CANCELLED',
    data: {
      service_name: cancelled === 1 ? bm('appointmentFallback', uiLang) : bm('cancelAllServiceLabel', uiLang, { count: cancelled }),
      client_message: failed
        ? bm('cancelAllPartial', uiLang, { cancelled, failed })
        : bm('cancelAllSuccess', uiLang, { count: cancelled }),
      ui_language: uiLang,
    },
  });
}

async function askConfirmCancelAll({ business, recipientPhone, appointments, requestId, lang = 'ro' }) {
  const uiLang = lang === 'en' ? 'en' : 'ro';
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
          { id: MOD_PREFIX.CONFIRM_CANCEL, title: t('cancelBtn', uiLang) },
          { id: MOD_PREFIX.ABORT, title: uiLang === 'en' ? 'Never mind' : 'Renunță' },
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
      client_message: bm('confirmCancelAll', uiLang, { count: appointments.length }),
      service_name: bm('cancelAllServiceLabel', uiLang, { count: appointments.length }),
      slot_label: bm('cancelAllSlotLabel', uiLang),
      ui_language: uiLang,
    },
    menu: {
      kind: 'confirm',
      options: [
        { id: MOD_PREFIX.CONFIRM_CANCEL, title: t('cancelBtn', uiLang) },
        { id: MOD_PREFIX.ABORT, title: uiLang === 'en' ? 'Never mind' : 'Renunță' },
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
  const lang = resolveClientLanguage('', null, convState?.context_data);
  const uiLang = lang === 'en' ? 'en' : 'ro';
  const service = /** @type {{ name?: string }} */ (appointment.selected_service ?? {});
  const duration = catalogDuration(business, service);
  if (!duration) {
    return handlerResult({
      status: 'ERROR',
      user_message_template_key: 'ERROR_DURATION',
      data: { client_message: durationMissingClientMessage(service.name, uiLang), ui_language: uiLang },
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
        occupied_label: formatSlotLabel(slotStart, business.timezone, uiLang),
        client_message: bm('slotTakenReschedule', uiLang, {
          slot: formatSlotLabel(slotStart, business.timezone, uiLang),
        }),
        ui_language: uiLang,
        alternatives: (listed.slots || []).map((s) => ({
          id: s.id,
          label: formatSlotLabel(s.start, business.timezone, uiLang),
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
          occupied_label: formatSlotLabel(slotStart, business.timezone, uiLang),
          client_message: bm('slotTakenReschedule', uiLang, {
            slot: formatSlotLabel(slotStart, business.timezone, uiLang),
          }),
          ui_language: uiLang,
          alternatives: (listed.slots || []).map((s) => ({
            id: s.id,
            label: formatSlotLabel(s.start, business.timezone, uiLang),
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
        client_message: bm('errRescheduleSave', uiLang),
        ui_language: uiLang,
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
    await cancelActiveDraftsForPhoneWithCalendar({
      business,
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

  const whenLabel = formatSlotLabel(slotStart, business.timezone, uiLang);
  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'RESCHEDULED',
    next_required_step: null,
    user_message_template_key: 'CONFIRMATION_RESCHEDULE',
    data: {
      service_name: displaySvc(service) || bm('appointmentFallback', uiLang),
      slot_label: whenLabel,
      client_message: bm('rescheduleDone', uiLang, {
        service: displaySvc(service) || bm('serviceFallback', uiLang),
        when: whenLabel,
      }),
      ui_language: uiLang,
    },
    calendar_cta: calendarCta(business, displaySvc(service), slotStart, slotEnd),
  });
}

async function executeReschedule({
  business,
  recipientPhone,
  extract,
  activeDraft,
  convState,
  requestId,
  textBody = '',
}) {
  const lang = resolveClientLanguage(textBody, null, convState?.context_data);
  if (activeDraft && ['browsing', 'pending_confirmation'].includes(activeDraft.state)) {
    await cancelOrResetDraftWithCalendar({
      business,
      draftId: activeDraft.id,
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
      data: { client_message: t('noApptReschedule', lang) },
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
      ? t('whichAmbiguousMove', lang)
      : null;
    return askWhichAppointment({
      business,
      recipientPhone,
      appointments: pool,
      intent: 'reschedule',
      requestId,
      clientMessage,
      lang,
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
      lang,
    });
  }

  const oldWhen = appointment.selected_slot_start
    ? formatSlotLabel(new Date(appointment.selected_slot_start), business.timezone, lang)
    : null;
  const serviceName = /** @type {{ name?: string }} */ (appointment.selected_service ?? {}).name
    || (lang === 'en' ? 'your appointment' : 'programarea');
  return askDateGridResult({
    business,
    recipientPhone,
    draft: appointment,
    service: appointment.selected_service,
    requestId,
    conversationStep: CONVERSATION_STEPS.RESCHEDULING,
    extraContext,
    lang,
    clientMessage: bm('reschedulePickDay', lang, {
      service: serviceName,
      from: oldWhen ? (lang === 'en' ? ` from *${oldWhen}*` : ` de *${oldWhen}*`) : '',
    }),
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
  const lang = resolveClientLanguage(textBody, null, convState?.context_data);
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
    await cancelOrResetDraftWithCalendar({
      business,
      draftId: activeDraft.id,
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
      data: { client_message: t('noApptCancel', lang) },
    });
  }

  if (wantsAll && extract.source === 'menu' && appointments.length > 1) {
    return askConfirmCancelAll({ business, recipientPhone, appointments, requestId, lang });
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
        lang,
        clientMessage: bm('noApptAtHint', lang, { hint }),
      });
    }

    const pool = resolved.candidates?.length ? resolved.candidates : appointments;
    const clientMessage = resolved.reason === 'ambiguous'
      ? t('whichAmbiguousCancel', lang)
      : (includeCancelAll
        ? bm('pickApptOrCancelAll', lang, { count: pool.length })
        : null);
    return askWhichAppointment({
      business,
      recipientPhone,
      appointments: pool,
      intent: 'cancel',
      requestId,
      includeCancelAll,
      lang,
      clientMessage,
    });
  }

  const when = appointment.selected_slot_start
    ? formatSlotLabel(new Date(appointment.selected_slot_start), business.timezone, lang)
    : '—';
  const cancelOpts = [
    { id: MOD_PREFIX.CONFIRM_CANCEL, title: lang === 'en' ? 'Cancel' : 'Anulează' },
    { id: MOD_PREFIX.ABORT, title: lang === 'en' ? 'Never mind' : 'Renunță' },
  ];
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
        options: cancelOpts,
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
      service_name: displaySvc(appointment.selected_service) || (lang === 'en' ? 'Appointment' : 'Programare'),
      slot_label: when,
    },
    menu: {
      kind: 'confirm',
      options: cancelOpts,
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
      services: localizeServicesList(services.map((s) => ({
        id: s.id,
        name: s.name,
        duration_minutes: s.duration_minutes,
        price_ron: s.price_ron ?? null,
      })), lang),
      client_language: lang,
      ui_language: lang === 'en' ? 'en' : 'ro',
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

async function executeContact(business, lang = 'ro') {
  // Deliver Contact as plain text only. Maps/website live in the body (markdown).
  // Twilio Content CTA (contents.create) has blocked Contact silently in production
  // while booking/hours (interactive list / text) kept working.
  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'CONTACT_LOOKUP',
    next_required_step: null,
    user_message_template_key: 'CONTACT',
    data: {
      contact: getBusinessContactInfo(business),
      business_name: business.name,
      ui_language: lang,
    },
  });
}

async function executeMenu(business, recipientPhone, requestId) {
  if (business?.id && recipientPhone) {
    await cancelActiveDraftsForPhoneWithCalendar({
      business,
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

async function executeSetName({ business, recipientPhone, extract, activeDraft, requestId, convState }) {
  const lang = resolveClientLanguage('', null, convState?.context_data);
  const uiLang = lang === 'en' ? 'en' : 'ro';
  const name = parseClientNameReply(extract.name || '');
  if (!name) {
    return handlerResult({
      status: 'MISSING_INFO',
      next_required_step: 'ASK_NAME',
      user_message_template_key: 'ASK_NAME',
      data: { client_message: bm('askFullName', uiLang), ui_language: uiLang },
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
      client_message: bm('nameSavedRestart', uiLang),
      ui_language: uiLang,
    },
    menu: entryMenu(business),
  });
}

async function executeListAppointments({ business, recipientPhone, activeDraft, lang = 'ro' }) {
  const uiLang = lang === 'en' ? 'en' : 'ro';
  const upcoming = await listUpcomingConfirmedBookings(business.id, recipientPhone);
  const pending = activeDraft?.state === 'pending_confirmation' ? activeDraft : null;
  const rows = upcoming.map((a) => {
    const service = /** @type {{ id?: string, name?: string }} */ (a.selected_service ?? {});
    const when = a.selected_slot_start
      ? formatSlotLabel(new Date(a.selected_slot_start), business.timezone, uiLang)
      : '—';
    return { service_name: displaySvc(service) || (uiLang === 'en' ? 'Appointment' : 'Programare'), slot_label: when };
  });
  if (pending?.selected_slot_start) {
    const service = /** @type {{ id?: string, name?: string }} */ (pending.selected_service ?? {});
    const label = displaySvc(service) || (uiLang === 'en' ? 'Appointment' : 'Programare');
    rows.unshift({
      service_name: uiLang === 'en'
        ? `${label} (awaiting confirmation)`
        : `${label} (în așteptarea confirmării)`,
      slot_label: formatSlotLabel(new Date(pending.selected_slot_start), business.timezone, uiLang),
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
    data: { business_name: business.name, ui_language: lang },
  });
}

function executeStaleChoice({ business, recipientPhone, convState, extract = null }) {
  const choiceId = typeof extract?.choice_id === 'string' ? extract.choice_id : null;
  if (choiceId && isEntryMenuChoiceId(business, choiceId)) {
    const lang = resolveClientLanguage('', null, convState?.context_data);
    const btn = (business.menu_buttons || []).find((b) => b.id === choiceId);
    if (btn?.action === 'show_contact') return executeContact(business, lang);
    if (btn?.action === 'show_info') return executeHoursAndServices(business, lang);
    if (btn?.action === 'start_booking') {
      return missingService(business, recipientPhone, null, null, lang);
    }
  }
  const lang = resolveClientLanguage('', null, convState?.context_data);
  const uiLang = lang === 'en' ? 'en' : 'ro';
  const last = readLastMenu(convState);
  const clientMessage = t('staleChoiceBody', uiLang);
  if (last?.options?.length) {
    const kind = last.kind || 'generic';
    const listButton = kind === 'day_grid'
      ? t('listDays', uiLang)
      : kind === 'time_grid'
        ? t('listTimes', uiLang)
        : kind === 'modify'
          ? t('listAppointments', uiLang)
          : kind === 'service'
            ? t('listServices', uiLang)
            : (uiLang === 'en' ? 'Choose' : 'Alege');
    return handlerResult({
      status: 'MISSING_INFO',
      action_performed: null,
      next_required_step: kind === 'modify' ? 'CHOOSE_APPOINTMENT' : null,
      user_message_template_key: 'STALE_CHOICE',
      data: {
        client_message: clientMessage,
        list_button: listButton,
        ui_language: uiLang,
      },
      menu: { kind, options: last.options, catalog: last.options },
    });
  }
  return handlerResult({
    status: 'SUCCESS',
    action_performed: 'STALE_CHOICE',
    user_message_template_key: 'STALE_CHOICE',
    data: { client_message: clientMessage, ui_language: uiLang },
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
    data: { business_name: business.name, ui_language: lang },
  });
}

function executeLanguageInfo(business, lang = 'ro') {
  const uiLang = lang === 'en' ? 'en' : 'ro';
  const key = uiLang === 'en' ? 'languageInfoEn' : 'languageInfoRo';
  return handlerResult({
    status: 'CHAT',
    action_performed: null,
    next_required_step: null,
    user_message_template_key: 'LANGUAGE_INFO',
    data: {
      ui_language: uiLang,
      client_message: t(key, uiLang),
    },
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
  const lang = resolveClientLanguage('', null, convState?.context_data);
  const uiLang = lang === 'en' ? 'en' : 'ro';
  const amb = extract.ambiguity || {};
  const value = Number(amb.value);
  if (!Number.isInteger(value) || value < 1 || value > 31) {
    return handlerResult({
      status: 'CHAT',
      action_performed: null,
      next_required_step: null,
      user_message_template_key: 'CHAT_FALLBACK',
      data: {
        business_name: business.name,
        client_message: bm('clarifyNotUnderstood', uiLang),
        ui_language: uiLang,
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
          { id: CLARIFY_IDS.DATE, title: uiLang === 'en' ? `Date ${value}` : `Data de ${value}` },
          { id: CLARIFY_IDS.TIME, title: uiLang === 'en' ? `Time ${value}` : `Ora ${value}` },
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
      client_message: clarificationPrompt(value, uiLang),
      ui_language: uiLang,
    },
    menu: {
      kind: 'clarify',
      options: [
        { id: CLARIFY_IDS.DATE, title: uiLang === 'en' ? `Date ${value}` : `Data de ${value}` },
        { id: CLARIFY_IDS.TIME, title: uiLang === 'en' ? `Time ${value}` : `Ora ${value}` },
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
  uiLang = null,
}) {
  const action = extract.action;
  const intent = convState.context_data?.intent;
  const lang = uiLang ?? resolveClientLanguage(textBody, null, convState?.context_data);

  // Courtesy must never confirm a hold (stray confirm_booking payload + "Mulțumesc").
  if (action === 'thanks') {
    return executeThanks(business, lang);
  }

  if (action === 'language_info') {
    return executeLanguageInfo(business, lang);
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
      textBody,
    });
  }

  if (action === 'stale_choice') {
    return executeStaleChoice({ business, recipientPhone, convState, extract });
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

  if (action === 'confirm') {
    return executeConfirm({ business, recipientPhone, activeDraft: draft, requestId, convState });
  }
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
          data: { client_message: bm('errApptsNotFound', lang), ui_language: lang },
        });
      }
      return executeCancelAllAppointments({ business, recipientPhone, appointments, requestId, lang });
    }
    const id = extract.appointment_id || convState.context_data?.appointment_id;
    const appointment = id ? await getDraftBookingById(id, business.id) : null;
    if (!appointment) {
      return handlerResult({
        status: 'ERROR',
        user_message_template_key: 'ERROR_NO_APPOINTMENT',
        data: { client_message: bm('errApptNotFound', lang), ui_language: lang },
      });
    }
    return executeCancelAppointment({ business, recipientPhone, appointment, requestId, lang });
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
    const pageNow = Number(ctx.grid_page) || 0;
    const delta = extract.choice_id === GRID_PREFIX.PREV ? -1 : extract.choice_id === GRID_PREFIX.NEXT ? 1 : 0;
    const page = action === 'grid_nav' ? Math.max(0, pageNow + delta) : pageNow;

    // Appointment cancel/reschedule list pagination (Alte programări ›).
    const modifyList = ctx.grid_kind === 'modify'
      || (
        convState.current_step === CONVERSATION_STEPS.MODIFYING
        && (ctx.intent === 'cancel' || ctx.intent === 'reschedule')
      );
    if (modifyList) {
      const appointments = await listActionableAppointments(business, recipientPhone, requestId);
      const ids = Array.isArray(ctx.appointment_ids) ? ctx.appointment_ids.map(String) : [];
      const byId = new Map(appointments.map((a) => [String(a.id), a]));
      const ordered = ids.length
        ? [
          ...ids.map((id) => byId.get(id)).filter(Boolean),
          ...appointments.filter((a) => !ids.includes(String(a.id))),
        ]
        : appointments;
      return askWhichAppointment({
        business,
        recipientPhone,
        appointments: ordered,
        intent: ctx.intent === 'cancel' ? 'cancel' : 'reschedule',
        requestId,
        includeCancelAll: Boolean(ctx.include_cancel_all),
        page,
        lang,
        extraContext: {
          pending_date_text: typeof ctx.pending_date_text === 'string' ? ctx.pending_date_text : null,
          pending_time_text: typeof ctx.pending_time_text === 'string' ? ctx.pending_time_text : null,
        },
      });
    }

    const service = ctx.service
      || (draft?.selected_service
        ? /** @type {{ id?: string, name: string, duration_minutes: number }} */ (draft.selected_service)
        : null);
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
          textBody,
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
        lang,
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
      lang,
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
        ? (lang === 'en'
          ? `${formatDayGridMessage(listOpenDayWindows(business, { limit: 14 }), business.timezone, displaySvc(service, null, 'en'), 'en')}\n\n_Please select from the list or type your request, e.g. *tomorrow at 10*._`
          : `${formatDayGridMessage(listOpenDayWindows(business, { limit: 14 }), business.timezone, displaySvc(service, null, 'ro'))}\n\n_Vă rugăm alegeți din listă sau scrieți solicitarea, ex.: *mâine la 10*._`)
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
    return executeListAppointments({ business, recipientPhone, activeDraft: draft, lang });
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
  if (action === 'contact') return executeContact(business, lang);
  if (action === 'menu') return executeMenu(business, recipientPhone, requestId);
  if (action === 'callback') {
    return executeCallback({ business, recipientPhone, extract, clientId, requestId, textBody });
  }
  if (action === 'set_name') {
    return executeSetName({ business, recipientPhone, extract, activeDraft: draft, requestId, convState });
  }
  if (action === 'off_topic') return executeOffTopic(business, lang);
  if (action === 'missing_info') return executeMissingInfo(business, textBody, lang);
  if (action === 'show_services') {
    return executeServices(business, lang);
  }
  if (action === 'unknown_service') {
    const uiLang = lang === 'en' ? 'en' : 'ro';
    const services = getBookingConfig(business).services;
    if (!services.length) {
      return handlerResult({
        status: 'ERROR',
        user_message_template_key: 'ERROR_GENERIC',
        data: { client_message: unknownInfoClientMessage(lang), ui_language: uiLang },
      });
    }
    const menu = serviceMenu(business, lang);
    const clientMessage = t('unknownServiceNotInList', uiLang);
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
        client_message: clientMessage,
        ui_language: uiLang,
        services: localizeServicesList(services.slice(0, 10).map((s) => ({
          id: s.id,
          name: s.name,
          duration_minutes: s.duration_minutes,
          price_ron: s.price_ron ?? null,
        })), lang),
        list_button: t('listServices', uiLang),
        ui: 'list_picker',
      },
      menu,
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
  const lang = resolveClientLanguage(textBody || '', null, convState?.context_data);
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
        ? { last_menu: serviceMenu(business, lang) }
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
    const menu = serviceMenu(business, lang);
    return handlerResult({
      status: 'MISSING_INFO',
      next_required_step: 'CHOOSE_SERVICE',
      user_message_template_key: 'MISSING_SERVICE',
      data: {
        services: localizeServicesList(services.slice(0, 10).map((s) => ({
          id: s.id,
          name: s.name,
          duration_minutes: s.duration_minutes,
          price_ron: s.price_ron ?? null,
        })), lang),
        service_name: reduced.draft.service_name,
        list_button: t('listServices', lang),
        ui: 'list_picker',
        ui_language: lang,
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
  const lang = params.uiLang
    ?? resolveClientLanguage(
      params.textBody ?? '',
      null,
      params.convState?.context_data,
    );
  return runWithServiceDisplay({
    business: params.business,
    lang,
    requestId: params.requestId ?? null,
    run: () => executeTurnBody({ ...params, uiLang: lang }),
  });
}

async function executeTurnBody(params) {
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
