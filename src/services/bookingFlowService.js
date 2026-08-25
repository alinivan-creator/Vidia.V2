import { getAvailableSlots, isSlotAvailable, decodeSlotId, pendingHoldCacheEventId } from '../db/cacheService.js';
import {
  getActiveDraftBooking,
  setSelectedService,
  setSelectedSlot,
  setDraftEmployee,
  confirmDraftBooking,
  startBrowsingFlow,
} from '../db/draftBookingService.js';
import {
  CONVERSATION_STEPS,
  setConversationStep,
  resetConversationState,
  getOrCreateConversationState,
  readLastMenu,
} from '../db/conversationStateService.js';
import { logError } from '../db/loggerService.js';
import {
  getClientByPhone,
  updateClientDisplayName,
  parseClientNameReply,
} from '../db/clientService.js';
import {
  listEmployees,
  getEmployeeById,
  matchEmployeeMention,
  resolveEmployeeCalendarId,
} from '../db/employeeService.js';
import { getBookingConfig, formatSlotLabel, encodeSlotId } from '../utils/datetime.js';
import { WA_DIVIDER, waField, waJoin, waServiceMeta, waTitle } from '../utils/waCopy.js';
import {
  assertWithinWorkingHours,
  durationMissingClientMessage,
  hasConfiguredOpenDay,
  hoursUnsetClientMessage,
  resolveServiceDurationMinutes,
  unknownInfoClientMessage,
} from '../utils/workingHours.js';
import { persistPendingOffer } from './pendingOfferService.js';
import { expirePendingIfNeeded, resolveLastBookingIntent, cancelActiveDraftsForPhoneWithCalendar, cancelOrResetDraftWithCalendar } from './pendingExpiryService.js';
import { getPendingTtlMinutes } from '../config/conversationConfig.js';
import { triageUserIntent, looksLikeDatetimeOrSlot, isAffirmativeReply } from './intentTriageService.js';
import { buildBookingCalendarInvite } from '../utils/calendarLink.js';
import {
  buildBookingConfirmationMessage,
} from '../utils/businessMessages.js';
import { optInClientAfterBooking } from './smsMarketingService.js';
import {
  lazySyncCalendar,
  createCalendarEvent,
  deleteCalendarEvent,
  resolveCalendarEventId,
  isBusinessMockMode,
} from './googleCalendarService.js';
import {
  sendTextMessage,
  sendMessageWithUrlButton,
  sendInteractiveButtons,
  sendInteractiveList,
  simulateHumanDelay,
  rememberMenuOptions,
  clearRememberedMenuOptions,
  resolveNumberedChoice,
} from './whatsappService.js';
import { matchServiceMention } from '../utils/serviceMatch.js';

/** @typedef {import('../db/businessService.js').Business} Business */


/**
 * Numbered service options reconstructed from Admin catalog (does not need Vercel memory).
 * @param {Business} business
 */
export function buildServiceMenuOptions(business) {
  const { services } = getBookingConfig(business);
  return services.slice(0, 10).map((s) => ({
    id: `${PREFIX.SERVICE}${s.id}`,
    title: s.name,
  }));
}

/**
 * If the user is in a booking picker step, map "1"/service name to the real option id.
 * Reconstructs the catalog from DB/config so a Vercel cold start cannot re-send the same list.
 *
 * @returns {Promise<boolean>}
 */
export async function tryApplyBookingStepReply({
  business,
  recipientPhone,
  textBody,
  convState,
  draft = null,
  clientId = null,
  requestId = null,
}) {
  const step = convState?.current_step;
  const lastMenu = readLastMenu(convState);
  const browsingNoService = draft?.state === 'browsing' && !draft.selected_service;

  const choosingService = step === CONVERSATION_STEPS.CHOOSING_SERVICE;

  if (choosingService || (browsingNoService && lastMenu?.kind === 'service')) {
    const options = lastMenu?.kind === 'service' && lastMenu.options.length
      ? lastMenu.options
      : buildServiceMenuOptions(business);
    let replyId = resolveNumberedChoice(textBody, options);
    if (!replyId) {
      const named = matchServiceMention(textBody, getBookingConfig(business).services);
      if (named) replyId = `${PREFIX.SERVICE}${named.id}`;
    }
    if (!replyId) return false;
    return handleBookingInteractiveReply({
      business,
      recipientPhone,
      replyId,
      clientId,
      requestId,
    });
  }

  if (step === CONVERSATION_STEPS.CHOOSING_EMPLOYEE) {
    const employees = await listEmployees(business.id, { activeOnly: true });
    const options = lastMenu?.kind === 'employee' && lastMenu.options.length
      ? lastMenu.options
      : [
          ...employees.map((e) => ({ id: `${PREFIX.EMPLOYEE}${e.id}`, title: e.name })),
          { id: PREFIX.ANY_EMPLOYEE, title: 'Primul disponibil' },
        ];
    let replyId = resolveNumberedChoice(textBody, options);
    if (!replyId) {
      const mentioned = matchEmployeeMention(textBody, employees);
      if (mentioned) replyId = `${PREFIX.EMPLOYEE}${mentioned.id}`;
    }
    if (!replyId && isAffirmativeReply(textBody)) {
      const suggestedId = convState?.context_data?.suggested_employee_id;
      const suggested = employees.find((e) => e.id === suggestedId) || employees[0] || null;
      if (suggested) replyId = `${PREFIX.EMPLOYEE}${suggested.id}`;
    }
    if (!replyId) return false;
    return handleBookingInteractiveReply({
      business,
      recipientPhone,
      replyId,
      clientId,
      requestId,
    });
  }

  const choosingSlot = step === CONVERSATION_STEPS.SELECTING_SLOT;

  if (choosingSlot && draft) {
    let replyId = lastMenu?.kind === 'slot'
      ? resolveNumberedChoice(textBody, lastMenu.options)
      : null;
    if (!replyId && draft.selected_service) {
      const service = /** @type {{ duration_minutes: number }} */ (draft.selected_service);
      const duration = catalogDuration(business, service);
      const slots = duration
        ? await getAvailableSlots({
            business,
            durationMinutes: duration,
            limit: 10,
            excludeDraftId: draft.id,
            employeeId: draftEmployeeId(draft),
          })
        : [];
      const options = slots.map((s) => ({
        id: s.id,
        title: formatSlotLabel(s.start, business.timezone),
      }));
      replyId = resolveNumberedChoice(textBody, options);
    }
    if (!replyId) return false;
    return handleBookingInteractiveReply({
      business,
      recipientPhone,
      replyId,
      clientId,
      requestId,
    });
  }

  return false;
}

const PREFIX = {
  SERVICE: 'svc_',
  EMPLOYEE: 'emp_',
  CONFIRM: 'confirm_booking',
  CANCEL: 'cancel_booking',
  RESUME_YES: 'resume_confirm',
  RESUME_NO: 'resume_other_slots',
  RESCHEDULE: 'reschedule_booking',
  ANY_EMPLOYEE: 'emp_any',
};

/**
 * @param {import('../db/draftBookingService.js').DraftBooking | null | undefined} draft
 * @returns {string | null}
 */
function draftEmployeeId(draft) {
  if (!draft) return null;
  if (draft.employee_id) return draft.employee_id;
  const ctxEmp = draft.conversation_context?.employee_id;
  return typeof ctxEmp === 'string' ? ctxEmp : null;
}

/**
 * Catalog duration for this tenant — never a hardcoded guess.
 * @param {Business} business
 * @param {{ id?: string, name?: string, duration_minutes?: number } | null | undefined} service
 */
function catalogDuration(business, service) {
  return resolveServiceDurationMinutes(business, service);
}

/**
 * Shows service picker (buttons ≤3, list otherwise).
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {import('../db/draftBookingService.js').DraftBooking} params.draft
 * @param {string | null} [params.requestId]
 */
export async function sendServicePicker({ business, recipientPhone, draft, requestId = null }) {
  const { services } = getBookingConfig(business);

  if (services.length === 0) {
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: unknownInfoClientMessage(),
    });
    return;
  }

  await simulateHumanDelay({ business, recipientPhone, requestId });

  const listed = services.slice(0, 10);
  const options = listed.map((s) => {
    const meta = waServiceMeta(s);
    return {
      id: `${PREFIX.SERVICE}${s.id}`,
      title: String(s.name || 'Serviciu').slice(0, 24),
      description: (meta || 'Disponibil').slice(0, 72),
    };
  });
  await rememberMenuOptions(business.id, recipientPhone, options, 'service');

  await sendInteractiveList({
    business,
    recipientPhone,
    requestId,
    bodyText: waJoin(
      waTitle('Ce serviciu dorești?'),
      '',
      'Apasă *Servicii* și alege din listă (durată și preț apar la fiecare opțiune), sau scrie direct numele.',
    ),
    buttonText: 'Servicii',
    sections: [{
      title: 'Servicii',
      rows: options,
    }],
    footerText: business.name,
    menuKind: 'service',
    rememberOptions: options,
  });
}

/**
 * Lazy sync + show available slot list from the selected employee (or business) calendar.
 */
export async function sendSlotPicker({ business, recipientPhone, draft, requestId = null }) {
  const service = /** @type {{ id: string; name: string; duration_minutes: number }} */ (
    draft.selected_service
  );

  if (!service) {
    await sendServicePicker({ business, recipientPhone, draft, requestId });
    return;
  }

  await simulateHumanDelay({ business, recipientPhone, requestId });

  if (!hasConfiguredOpenDay(business)) {
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: hoursUnsetClientMessage(),
    });
    return;
  }

  const duration = catalogDuration(business, service);
  if (!duration) {
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: durationMissingClientMessage(service.name),
    });
    return;
  }

  const empId = draftEmployeeId(draft);
  const employee = empId ? await getEmployeeById(empId, business.id) : null;
  const calendarId = resolveEmployeeCalendarId(business, employee);

  await lazySyncCalendar({
    business,
    requestId,
    calendarId,
    employeeId: empId,
  });

  const slots = await getAvailableSlots({
    business,
    durationMinutes: duration,
    limit: 10,
    excludeDraftId: draft.id,
    employeeId: empId,
  });

  if (slots.length === 0) {
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text:
        `Ne pare rău, nu am găsit sloturi libere pentru *${service.name}*` +
        (employee ? ` cu *${employee.name}*` : '') +
        ` în următoarele ${getBookingConfig(business).bookingHorizonDays} zile. Încearcă din nou mai târziu.`,
    });
    return;
  }

  const options = slots.map((s) => ({
    id: s.id,
    title: formatSlotLabel(s.start, business.timezone),
  }));

  await rememberMenuOptions(business.id, recipientPhone, options, 'slot');

  const lines = [
    waTitle(`Alege ora — ${service.name}`),
    employee ? waField('Specialist', employee.name) : null,
    '',
    'Primele opțiuni disponibile',
    '',
  ];
  options.forEach((opt, i) => {
    lines.push(`*${i + 1}.*  ${opt.title}`);
  });
  lines.push('', WA_DIVIDER, '', 'Scrie *ora* dorită — ex: *18:00* (sau numărul opțiunii).');

  await sendTextMessage({
    business,
    recipientPhone,
    requestId,
    text: waJoin(...lines),
  });
}

/**
 * First active employee who has at least one free slot (live calendar sync).
 * @returns {Promise<import('../db/employeeService.js').Employee | null>}
 */
async function findFirstAvailableEmployee({ business, durationMinutes, draftId, requestId, serviceId = null }) {
  const duration = Number(durationMinutes);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  if (!hasConfiguredOpenDay(business)) return null;

  const { listEmployeesForService } = await import('../db/employeeService.js');
  const employees = await listEmployeesForService(business.id, serviceId, { activeOnly: true });
  for (const emp of employees) {
    const calendarId = resolveEmployeeCalendarId(business, emp);
    if (!calendarId && !isBusinessMockMode(business)) continue;

    await lazySyncCalendar({
      business,
      requestId,
      force: true,
      calendarId,
      employeeId: emp.id,
    });

    const slots = await getAvailableSlots({
      business,
      durationMinutes,
      limit: 1,
      excludeDraftId: draftId,
      employeeId: emp.id,
    });
    if (slots.length > 0) return emp;
  }
  return null;
}

/**
 * After service selection: resolve employee (mention / single / first available / ask).
 */
async function continueAfterServiceSelected({
  business,
  recipientPhone,
  draft,
  service,
  hintText = '',
  requestId = null,
}) {
  const { listEmployeesForService } = await import('../db/employeeService.js');
  const employees = await listEmployeesForService(business.id, service?.id, { activeOnly: true });

  // No staff configured → classic business calendar
  if (!employees.length) {
    await setConversationStep({
      businessId: business.id,
      rawPhone: recipientPhone,
      step: CONVERSATION_STEPS.SELECTING_SLOT,
      context: { draft_id: draft.id, service, intent: 'book' },
      requestId,
    });
    if (hintText && looksLikeDatetimeOrSlot(hintText)) {
      const handled = await handleFreeTextSlotRequest({
        business,
        recipientPhone,
        draft,
        textBody: hintText,
        requestId,
      });
      if (handled) return;
    }
    await sendSlotPicker({ business, recipientPhone, draft, requestId });
    return;
  }

  const mentioned = matchEmployeeMention(hintText, employees);
  /** @type {import('../db/employeeService.js').Employee | null} */
  let chosen = mentioned;

  if (!chosen) {
    const existingEmpId = draftEmployeeId(draft);
    if (existingEmpId) {
      chosen = employees.find((e) => e.id === existingEmpId)
        || await getEmployeeById(existingEmpId, business.id);
    }
  }

  if (!chosen && employees.length === 1) {
    chosen = employees[0];
  }

  if (!chosen) {
    // Prefer first available; if none, still show picker
    chosen = await findFirstAvailableEmployee({
      business,
      durationMinutes: catalogDuration(business, service),
      draftId: draft.id,
      requestId,
      serviceId: service?.id ?? null,
    });
  }

  if (chosen && (mentioned || draftEmployeeId(draft) || employees.length === 1)) {
    await assignEmployeeAndShowSlots({
      business,
      recipientPhone,
      draft,
      service,
      employee: chosen,
      hintText,
      requestId,
    });
    return;
  }

  // Multiple staff — ask the client (pre-select first available as option 1 hint)
  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: CONVERSATION_STEPS.CHOOSING_EMPLOYEE,
    context: {
      draft_id: draft.id,
      service,
      intent: 'book',
      suggested_employee_id: chosen?.id ?? null,
    },
    requestId,
  });
  await sendEmployeePicker({
    business,
    recipientPhone,
    employees,
    suggested: chosen,
    requestId,
  });
}

/**
 * @param {Object} params
 */
async function assignEmployeeAndShowSlots({
  business,
  recipientPhone,
  draft,
  service,
  employee,
  hintText = '',
  requestId = null,
}) {
  const updated = await setDraftEmployee({
    draftId: draft.id,
    businessId: business.id,
    employeeId: employee.id,
    context: {
      ...draft.conversation_context,
      step: 'select_slot',
      employee_id: employee.id,
      employee_name: employee.name,
    },
    requestId,
  });

  const nextDraft = updated ?? { ...draft, employee_id: employee.id };

  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: CONVERSATION_STEPS.SELECTING_SLOT,
    context: {
      draft_id: draft.id,
      service,
      employee_id: employee.id,
      employee_name: employee.name,
      intent: 'book',
    },
    requestId,
  });

  await simulateHumanDelay({ business, recipientPhone, requestId, delayMs: 600 });
  await sendTextMessage({
    business,
    recipientPhone,
    requestId,
    text: `Te programez cu *${employee.name}*.`,
  });
  if (hintText && looksLikeDatetimeOrSlot(hintText)) {
    const handled = await handleFreeTextSlotRequest({
      business,
      recipientPhone,
      draft: nextDraft,
      textBody: hintText,
      requestId,
    });
    if (handled) return;
  }
  await sendSlotPicker({ business, recipientPhone, draft: nextDraft, requestId });
}

/**
 * Numbered employee menu for WhatsApp.
 */
export async function sendEmployeePicker({
  business,
  recipientPhone,
  employees,
  suggested = null,
  requestId = null,
}) {
  await simulateHumanDelay({ business, recipientPhone, requestId });

  const options = employees.map((e) => ({
    id: `${PREFIX.EMPLOYEE}${e.id}`,
    title: e.name.slice(0, 24),
  }));
  options.push({ id: PREFIX.ANY_EMPLOYEE, title: 'Primul disponibil' });

  await rememberMenuOptions(business.id, recipientPhone, options, 'employee');

  if (suggested?.id) {
    await persistPendingOffer({
      businessId: business.id,
      rawPhone: recipientPhone,
      offer: {
        kind: 'employee',
        id: suggested.id,
        name: suggested.name,
      },
      requestId,
    });
  }

  const lines = [waTitle('Cu cine preferi?'), ''];
  options.forEach((opt, i) => {
    const hint =
      suggested && opt.id === `${PREFIX.EMPLOYEE}${suggested.id}`
        ? '  · disponibil acum'
        : '';
    lines.push(`*${i + 1}.*  ${opt.title}${hint}`);
  });
  lines.push('', WA_DIVIDER, '', 'Scrie *numele* specialistului (sau numărul opțiunii).');

  await sendTextMessage({
    business,
    recipientPhone,
    requestId,
    text: waJoin(...lines),
  });
}

/**
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {import('../db/draftBookingService.js').DraftBooking} params.draft
 * @param {string | null} [params.requestId]
 */
export async function sendConfirmationPrompt({ business, recipientPhone, draft, requestId = null }) {
  const service = /** @type {{ name: string }} */ (draft.selected_service);
  const slotStart = draft.selected_slot_start ? new Date(draft.selected_slot_start) : null;

  if (!slotStart || !service) return;

  const client = await getClientByPhone({
    businessId: business.id,
    rawPhone: recipientPhone,
    requestId,
  });
  const empId = draftEmployeeId(draft);
  const employee = empId ? await getEmployeeById(empId, business.id) : null;

  await simulateHumanDelay({ business, recipientPhone, requestId });

  await sendInteractiveButtons({
    business,
    recipientPhone,
    requestId,
    bodyText: waJoin(
      waTitle('Confirmi programarea?'),
      '',
      waField('Client', client?.display_name),
      waField('Specialist', employee?.name),
      waField('Serviciu', service.name),
      waField('Când', formatSlotLabel(slotStart, business.timezone)),
    ),
    buttons: [
      { id: PREFIX.CONFIRM, title: 'Confirmă' },
      { id: PREFIX.CANCEL, title: 'Anulează' },
    ],
    menuKind: 'confirm',
  });
}

/**
 * After a slot is chosen: ask for client name if missing, else show confirm prompt.
 * @returns {Promise<void>}
 */
async function continueAfterSlotSelected({
  business,
  recipientPhone,
  draft,
  service,
  slotStart,
  slotEnd,
  requestId = null,
}) {
  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: CONVERSATION_STEPS.CONFIRMING,
    context: {
      draft_id: draft.id,
      service,
      slot_start: slotStart instanceof Date ? slotStart.toISOString() : slotStart,
      slot_end: slotEnd instanceof Date ? slotEnd.toISOString() : slotEnd,
      intent: 'book',
    },
    requestId,
  });

  const client = await getClientByPhone({
    businessId: business.id,
    rawPhone: recipientPhone,
    requestId,
  });

  if (!client?.display_name) {
    await setConversationStep({
      businessId: business.id,
      rawPhone: recipientPhone,
      step: CONVERSATION_STEPS.ASKING_NAME,
      context: {
        draft_id: draft.id,
        service,
        slot_start: slotStart instanceof Date ? slotStart.toISOString() : slotStart,
        slot_end: slotEnd instanceof Date ? slotEnd.toISOString() : slotEnd,
        intent: 'book',
        awaiting_name: true,
      },
      requestId,
    });

    await simulateHumanDelay({ business, recipientPhone, requestId });
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text:
        'Pentru rezervare am nevoie de *numele tău* (cum să te trecem în calendar).\n' +
        'Scrie prenumele și numele, ex: *Ana Popescu*.',
    });
    return;
  }

  await sendConfirmationPrompt({ business, recipientPhone, draft, requestId });
}

/**
 * Handles free-text while waiting for the client name before confirm.
 * @returns {Promise<boolean>}
 */
export async function handleClientNameReply({
  business,
  recipientPhone,
  textBody,
  clientId = null,
  requestId = null,
}) {
  const draft = await getActiveDraftBooking(business.id, recipientPhone);
  if (!draft || draft.state !== 'pending_confirmation') {
    return false;
  }

  const name = parseClientNameReply(textBody);
  if (!name) {
    const triage = triageUserIntent(textBody, {
      businessType: business.business_type,
      services: getBookingConfig(business).services,
    });
    if (triage.intent !== 'unknown' || looksLikeDatetimeOrSlot(textBody)) {
      return false;
    }
    await simulateHumanDelay({ business, recipientPhone, requestId });
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: 'Te rog scrie un nume valid (minim 2 litere), ex: *Ana Popescu*.',
    });
    return true;
  }

  const resolvedClientId = clientId || draft.client_id;
  if (resolvedClientId) {
    await updateClientDisplayName({
      clientId: resolvedClientId,
      displayName: name,
      businessId: business.id,
      requestId,
    });
  }

  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: CONVERSATION_STEPS.CONFIRMING,
    context: {
      draft_id: draft.id,
      service: draft.selected_service,
      slot_start: draft.selected_slot_start,
      slot_end: draft.selected_slot_end,
      intent: 'book',
      client_name: name,
    },
    requestId,
  });

  await sendConfirmationPrompt({ business, recipientPhone, draft, requestId });
  return true;
}

/**
 * Starts booking flow: draft browsing + service picker.
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {string | null} [params.clientId]
 * @param {string} [params.hintText] — original user text (employee name mentions)
 * @param {string | null} [params.requestId]
 */
export async function startBookingFlow({
  business,
  recipientPhone,
  clientId,
  hintText = '',
  requestId = null,
}) {
  const draft = await startBrowsingFlow({
    businessId: business.id,
    clientId,
    rawPhone: recipientPhone,
    context: { step: 'select_service', booking_hint: hintText || '' },
    requestId,
  });

  if (!draft) {
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: 'A apărut o eroare la inițierea programării. Încearcă din nou.',
    });
    return;
  }

  if (!hintText.trim()) {
    await simulateHumanDelay({ business, recipientPhone, requestId });
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: waJoin(
        waTitle(`Programare — ${business.name}`),
        'Hai să găsim un moment potrivit.',
      ),
    });
  }

  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: CONVERSATION_STEPS.CHOOSING_SERVICE,
    context: { draft_id: draft.id, intent: 'book', booking_hint: hintText || '' },
    mergeContext: false,
    requestId,
  });

  await sendServicePicker({ business, recipientPhone, draft, requestId });
}

/**
 * Routes booking-related interactive replies (services, slots, confirm/cancel).
 * @returns {Promise<boolean>} true if handled
 */
export async function handleBookingInteractiveReply({
  business,
  recipientPhone,
  replyId,
  clientId,
  requestId = null,
}) {
  if (replyId === PREFIX.CANCEL) {
    await clearPendingBookingSession({
      business,
      recipientPhone,
      requestId,
    });
    await simulateHumanDelay({ business, recipientPhone, requestId });
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: 'Programarea a fost anulată. Dacă dorești, poți începe o programare nouă oricând.',
    });
    return true;
  }

  let draft = await getActiveDraftBooking(business.id, recipientPhone);
  const expiry = await expirePendingIfNeeded({
    business,
    draft,
    recipientPhone,
    requestId,
  });
  if (expiry.expired) draft = null;

  if (replyId === PREFIX.RESUME_YES || replyId === PREFIX.RESUME_NO) {
    const conv = await getOrCreateConversationState(business.id, recipientPhone);
    const lastIntent =
      conv.context_data?.last_booking_intent
      ?? expiry.lastIntent
      ?? (await resolveLastBookingIntent(business, recipientPhone));
    if (!lastIntent) return false;
    return handleResumeOfferReply({
      business,
      recipientPhone,
      replyId,
      lastIntent,
      clientId,
      requestId,
    });
  }

  if (replyId === PREFIX.CONFIRM) {
    if (!draft) {
      const lastIntent =
        expiry.lastIntent ?? (await resolveLastBookingIntent(business, recipientPhone));
      if (lastIntent) {
        await sendTextMessage({
          business,
          recipientPhone,
          requestId,
          text:
            'Timpul de rezervare a expirat și slotul a fost eliberat.\n' +
            'Verific dacă mai este liber…',
        });
        return offerResumeOrAlternatives({
          business,
          recipientPhone,
          lastIntent,
          clientId,
          requestId,
        });
      }
      return false;
    }
    await handleConfirmBooking({ business, recipientPhone, draft, requestId });
    return true;
  }

  if (replyId.startsWith(PREFIX.SERVICE)) {
    const serviceId = replyId.slice(PREFIX.SERVICE.length);
    const { services } = getBookingConfig(business);
    const service = services.find((s) => s.id === serviceId);

    if (!service) {
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text: 'Serviciul selectat nu mai este disponibil.',
      });
      return true;
    }

    let activeDraft = draft;
    if (!activeDraft) {
      activeDraft = await startBrowsingFlow({
        businessId: business.id,
        clientId,
        rawPhone: recipientPhone,
        requestId,
      });
    }

    if (!activeDraft) return true;

    const updated = await setSelectedService({
      draftId: activeDraft.id,
      businessId: business.id,
      service,
      context: { ...activeDraft.conversation_context, step: 'select_slot', service_id: service.id },
      requestId,
    });

    if (updated) {
      const hintText =
        typeof updated.conversation_context?.booking_hint === 'string'
          ? updated.conversation_context.booking_hint
          : '';
      await continueAfterServiceSelected({
        business,
        recipientPhone,
        draft: updated,
        service,
        hintText,
        requestId,
      });
    }
    return true;
  }

  if (replyId === PREFIX.ANY_EMPLOYEE || replyId.startsWith(PREFIX.EMPLOYEE)) {
    if (!draft) return false;
    const service = /** @type {{ duration_minutes: number; name: string }} */ (
      draft.selected_service
    );
    if (!service) return false;

    let employee = null;
    if (replyId === PREFIX.ANY_EMPLOYEE) {
      employee = await findFirstAvailableEmployee({
        business,
        durationMinutes: catalogDuration(business, service),
        draftId: draft.id,
        requestId,
        serviceId: service?.id ?? null,
      });
      if (!employee) {
        const all = await listEmployees(business.id, { activeOnly: true });
        employee = all[0] ?? null;
      }
    } else {
      const empId = replyId.slice(PREFIX.EMPLOYEE.length);
      employee = await getEmployeeById(empId, business.id);
    }

    if (!employee) {
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text: 'Angajatul selectat nu este disponibil. Alege din listă.',
      });
      return true;
    }

    await assignEmployeeAndShowSlots({
      business,
      recipientPhone,
      draft,
      service,
      employee,
      hintText:
        typeof draft.conversation_context?.booking_hint === 'string'
          ? draft.conversation_context.booking_hint
          : '',
      requestId,
    });
    return true;
  }

  if (replyId.startsWith('slot_')) {
    if (!draft) return false;

    const service = /** @type {{ duration_minutes: number; name: string }} */ (
      draft.selected_service
    );
    if (!service) return false;

    const slotStart = decodeSlotId(replyId, business.timezone);
    if (!slotStart) {
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text: 'Slot invalid. Te rugăm să alegi din listă.',
      });
      return true;
    }

    const duration = catalogDuration(business, service);
    if (!duration) {
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text: durationMissingClientMessage(service.name),
      });
      return true;
    }

    const slotEnd = new Date(slotStart.getTime() + duration * 60_000);
    const hoursCheck = assertWithinWorkingHours(business, slotStart, slotEnd);
    if (!hoursCheck.ok) {
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text: hoursCheck.message,
      });
      return true;
    }

    const empId = draftEmployeeId(draft);
    const available = await isSlotAvailable({
      business,
      slotId: replyId,
      durationMinutes: duration,
      excludeDraftId: draft.id,
      employeeId: empId,
    });

    if (!available) {
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text: 'Ne pare rău, acest slot tocmai a fost ocupat. Alege altă oră:',
      });
      await sendSlotPicker({ business, recipientPhone, draft, requestId });
      return true;
    }

    const updated = await setSelectedSlot({
      draftId: draft.id,
      businessId: business.id,
      slotStart,
      slotEnd,
      ttlMinutes: getPendingTtlMinutes(business),
      context: { ...draft.conversation_context, step: 'confirm', slot_id: replyId },
      requestId,
    });

    if (!updated || updated.state !== 'pending_confirmation') {
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text: 'Ne pare rău, acest interval tocmai a fost rezervat. Te rog alege altă oră:',
      });
      await sendSlotPicker({ business, recipientPhone, draft, requestId });
      return true;
    }

    await continueAfterSlotSelected({
      business,
      recipientPhone,
      draft: updated,
      service,
      slotStart,
      slotEnd,
      requestId,
    });
    return true;
  }

  return false;
}

async function handleConfirmBooking({ business, recipientPhone, draft, requestId }) {
  const expiry = await expirePendingIfNeeded({
    business,
    draft,
    recipientPhone,
    requestId,
  });
  if (expiry.expired) {
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text:
        'Timpul de rezervare a expirat și slotul a fost eliberat.\n' +
        'Verific dacă mai este liber…',
    });
    if (expiry.lastIntent) {
      await offerResumeOrAlternatives({
        business,
        recipientPhone,
        lastIntent: expiry.lastIntent,
        clientId: draft.client_id,
        requestId,
      });
    }
    return;
  }

  if (draft.state !== 'pending_confirmation') {
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: 'Nu există o programare în așteptarea confirmării.',
    });
    return;
  }

  const service = /** @type {{ name: string; duration_minutes: number }} */ (draft.selected_service);
  const slotStart = draft.selected_slot_start;

  if (!service || !slotStart) return;

  await simulateHumanDelay({ business, recipientPhone, requestId });

  const duration = catalogDuration(business, service);
  if (!duration) {
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: durationMissingClientMessage(service.name),
    });
    return;
  }

  const startDate = new Date(slotStart);
  const endDate = new Date(startDate.getTime() + duration * 60_000);
  const hoursCheck = assertWithinWorkingHours(business, startDate, endDate);
  if (!hoursCheck.ok) {
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: hoursCheck.message,
    });
    return;
  }

  const confirmSlotId = encodeSlotId(startDate, business.timezone);
  const empId = draftEmployeeId(draft);
  const employee = empId ? await getEmployeeById(empId, business.id) : null;
  const calendarId = resolveEmployeeCalendarId(business, employee);

  await lazySyncCalendar({
    business,
    requestId,
    force: true,
    calendarId,
    employeeId: empId,
  });

  const ownEventId = typeof draft.google_event_id === 'string' ? draft.google_event_id.trim() : null;
  const excludeGoogleEventIds = [
    pendingHoldCacheEventId(draft.id),
    ...(ownEventId ? [ownEventId] : []),
  ];

  const stillAvailable = await isSlotAvailable({
    business,
    slotId: confirmSlotId,
    durationMinutes: duration,
    excludeDraftId: draft.id,
    employeeId: empId,
    excludeGoogleEventIds,
  });
  if (!stillAvailable) {
    await cancelOrResetDraftWithCalendar({
      business,
      draftId: draft.id,
      state: 'browsing',
      context: { ...draft.conversation_context, step: 'slot_lost_on_confirm' },
      requestId,
    });
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: 'Ne pare rău, acest interval tocmai a fost ocupat. Te rog alege altă oră:',
    });
    await sendSlotPicker({ business, recipientPhone, draft, requestId });
    return;
  }

  const phoneE164 = draft.phone_number;
  const client = await getClientByPhone({
    businessId: business.id,
    rawPhone: recipientPhone,
    requestId,
  });
  const clientName = client?.display_name?.trim() || '';
  const clientLabel = clientName || phoneE164;

  const result = await createCalendarEvent({
    business,
    calendarId,
    employeeId: empId,
    event: {
      summary: `${service.name} — ${clientLabel}${employee ? ` (${employee.name})` : ''}`,
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

  // Nu confirmăm niciodată o programare care nu a fost scrisă în Google Calendar real.
  if (!result.ok || !result.eventId || isMockEvent) {
    if (result.reason === 'closed' || result.reason === 'outside_hours' || result.reason === 'hours_unset' || result.reason === 'invalid_range') {
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text: result.error || hoursUnsetClientMessage(),
      });
      return;
    }

    console.error('Eroare detalii:', {
      reason: 'createCalendarEvent failed or mock — refusing confirmation',
      mockMode: business.google_calendar_mock_mode === true,
      mockedResult: result.mocked === true,
      hasCalendarId: Boolean(calendarId),
      employeeId: empId,
      eventId: result.eventId ?? null,
      result,
    });

    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text:
        'Din păcate nu am putut confirma programarea. Te rog încearcă din nou sau scrie *contact*.',
    });
    return;
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

  const calendarInvite = buildBookingCalendarInvite({
    business,
    serviceName: service.name,
    startIso: startDate.toISOString(),
    endIso: endDate.toISOString(),
  });

  // Confirmation + calendar CTA (privacy disclosure is only at session start)
  const confirmBody = buildBookingConfirmationMessage({
    business,
    serviceName: service.name,
    slotLabel: formatSlotLabel(new Date(slotStart), business.timezone),
    clientName,
    calendarLine: '',
    includeGdpr: false,
  });

  if (calendarInvite.url) {
    await sendMessageWithUrlButton({
      business,
      recipientPhone,
      requestId,
      text: confirmBody,
      buttonTitle: calendarInvite.buttonTitle,
      buttonUrl: calendarInvite.url,
    });
  } else {
    const bodyWithCalendar = calendarInvite.markdownLine
      ? `${confirmBody}\n\n${calendarInvite.markdownLine}`
      : confirmBody;
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: bodyWithCalendar,
    });
  }
}

/**
 * Immediately drops pending/browsing holds for this phone: DB state, slot lock,
 * conversation memory, and numbered confirm menus. Does not touch confirmed bookings.
 *
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {string | null} [params.requestId]
 */
export async function clearPendingBookingSession({
  business,
  recipientPhone,
  requestId = null,
}) {
  const active = await getActiveDraftBooking(business.id, recipientPhone);

  await cancelActiveDraftsForPhoneWithCalendar({
    business,
    rawPhone: recipientPhone,
    context: {
      ...(active?.conversation_context ?? {}),
      step: 'cancelled_by_user',
      last_booking_intent: null,
    },
    requestId,
  });

  clearRememberedMenuOptions(business.id, recipientPhone);

  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: CONVERSATION_STEPS.IDLE,
    context: { pending_dismissed: true },
    mergeContext: false,
    requestId,
  });
}

/**
 * Drops a stuck pending confirmation without nagging the client,
 * so a new intent (another day, menu, FAQ) can be handled immediately.
 *
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.recipientPhone
 * @param {import('../db/draftBookingService.js').DraftBooking | null} [params.draft]
 * @param {string | null} [params.requestId]
 */
export async function abandonPendingConfirmation({
  business,
  recipientPhone,
  draft = null,
  requestId = null,
}) {
  void draft;
  await clearPendingBookingSession({
    business,
    recipientPhone,
    requestId,
  });
}

/**
 * Client asked for another employee while a pending hold is still live.
 * Keeps the same slot when that staff member is free; otherwise shows their hours.
 *
 * @returns {Promise<boolean>}
 */
export async function applyPendingEmployeeChange({
  business,
  recipientPhone,
  draft,
  textBody = '',
  requestId = null,
}) {
  if (!draft) return false;

  const employees = await listEmployees(business.id, { activeOnly: true });
  if (!employees.length) {
    await simulateHumanDelay({ business, recipientPhone, requestId });
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: 'Nu am angajați configurați încă. Programarea rămâne cum e — confirmi?',
    });
    return true;
  }

  const mentioned = matchEmployeeMention(textBody, employees);
  const service = /** @type {{ name: string; duration_minutes: number } | null} */ (
    draft.selected_service
  );

  if (!mentioned) {
    await setConversationStep({
      businessId: business.id,
      rawPhone: recipientPhone,
      step: CONVERSATION_STEPS.CHOOSING_EMPLOYEE,
      context: {
        draft_id: draft.id,
        service,
        intent: 'book',
        pending_hold: true,
      },
      requestId,
    });
    await sendEmployeePicker({
      business,
      recipientPhone,
      employees,
      requestId,
    });
    return true;
  }

  if (!service) {
    await setDraftEmployee({
      draftId: draft.id,
      businessId: business.id,
      employeeId: mentioned.id,
      context: {
        ...draft.conversation_context,
        employee_id: mentioned.id,
        employee_name: mentioned.name,
      },
      requestId,
    });
    await simulateHumanDelay({ business, recipientPhone, requestId });
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: `Te programez cu *${mentioned.name}*. Alege serviciul:`,
    });
    await sendServicePicker({ business, recipientPhone, draft, requestId });
    return true;
  }

  const slotStart = draft.selected_slot_start ? new Date(draft.selected_slot_start) : null;
  const keepSlot =
    draft.state === 'pending_confirmation'
    && slotStart
    && !Number.isNaN(slotStart.getTime());

  if (keepSlot) {
    const duration = catalogDuration(business, service);
    if (!duration) {
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text: durationMissingClientMessage(service.name),
      });
      return true;
    }

    const slotId = encodeSlotId(slotStart, business.timezone);
    const slotEnd = new Date(slotStart.getTime() + duration * 60_000);
    const hoursCheck = assertWithinWorkingHours(business, slotStart, slotEnd);
    if (!hoursCheck.ok) {
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text: hoursCheck.message,
      });
      return true;
    }

    const available = await isSlotAvailable({
      business,
      slotId,
      durationMinutes: duration,
      excludeDraftId: draft.id,
      employeeId: mentioned.id,
    });

    if (available) {
      const withEmp = await setDraftEmployee({
        draftId: draft.id,
        businessId: business.id,
        employeeId: mentioned.id,
        context: {
          ...draft.conversation_context,
          employee_id: mentioned.id,
          employee_name: mentioned.name,
        },
        requestId,
      });
      const updated = await setSelectedSlot({
        draftId: draft.id,
        businessId: business.id,
        slotStart,
        slotEnd,
        ttlMinutes: getPendingTtlMinutes(business),
        context: {
          ...(withEmp?.conversation_context ?? draft.conversation_context),
          step: 'confirm',
          slot_id: slotId,
          employee_id: mentioned.id,
          employee_name: mentioned.name,
        },
        requestId,
      });
      if (!updated || updated.state !== 'pending_confirmation') {
        await sendTextMessage({
          business,
          recipientPhone,
          requestId,
          text: 'Ne pare rău, acest interval tocmai a fost rezervat. Te rog alege altă oră:',
        });
        await sendSlotPicker({ business, recipientPhone, draft, requestId });
        return true;
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
          employee_id: mentioned.id,
          employee_name: mentioned.name,
          intent: 'book',
        },
        requestId,
      });
      await simulateHumanDelay({ business, recipientPhone, requestId });
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text: `Te programez cu *${mentioned.name}*.`,
      });
      await continueAfterSlotSelected({
        business,
        recipientPhone,
        draft: updated,
        service,
        slotStart,
        slotEnd,
        requestId,
      });
      return true;
    }

    await simulateHumanDelay({ business, recipientPhone, requestId });
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text:
        `*${mentioned.name}* nu e liber la ora aleasă. Iată orele disponibile:`,
    });
  }

  await assignEmployeeAndShowSlots({
    business,
    recipientPhone,
    draft,
    service,
    employee: mentioned,
    hintText: textBody,
    requestId,
  });
  return true;
}

/**
 * After TTL expiry: if the remembered slot is free, ask to resume confirmation;
 * otherwise show the next available slots.
 *
 * @returns {Promise<boolean>}
 */
export async function offerResumeOrAlternatives({
  business,
  recipientPhone,
  lastIntent,
  clientId = null,
  requestId = null,
}) {
  const service = lastIntent?.service;
  const slotStart = lastIntent?.slot_start;
  if (!service || !slotStart) return false;

  const empId = typeof lastIntent.employee_id === 'string' ? lastIntent.employee_id : null;
  const startDate = new Date(slotStart);
  const slotId = encodeSlotId(startDate, business.timezone);
  const duration = catalogDuration(business, service);
  const free = duration
    ? await isSlotAvailable({
        business,
        slotId,
        durationMinutes: duration,
        employeeId: empId,
      })
    : false;
  const label = lastIntent.slot_label || formatSlotLabel(startDate, business.timezone);

  if (free) {
    await setConversationStep({
      businessId: business.id,
      rawPhone: recipientPhone,
      step: CONVERSATION_STEPS.OFFERING_RESUME,
      context: { last_booking_intent: lastIntent },
      mergeContext: false,
      requestId,
    });
    await simulateHumanDelay({ business, recipientPhone, requestId });
    await sendInteractiveButtons({
      business,
      recipientPhone,
      requestId,
      bodyText: waJoin(
        waTitle('Slot încă disponibil'),
        '',
        waField('Serviciu', service.name),
        waField('Când', label),
        '',
        'Reiei confirmarea?',
      ),
      buttons: [
        { id: PREFIX.RESUME_YES, title: 'Da, reia' },
        { id: PREFIX.RESUME_NO, title: 'Alte ore' },
      ],
      menuKind: 'resume',
    });
    return true;
  }

  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: CONVERSATION_STEPS.IDLE,
    context: { last_booking_intent: lastIntent },
    mergeContext: false,
    requestId,
  });
  await simulateHumanDelay({ business, recipientPhone, requestId });
  await sendTextMessage({
    business,
    recipientPhone,
    requestId,
    text:
      `Intervalul *${label}* nu mai este disponibil — a fost rezervat între timp.\n` +
      `Îți arăt următoarele ore libere:`,
  });
  await resumeWithAlternativeSlots({
    business,
    recipientPhone,
    lastIntent,
    clientId,
    requestId,
  });
  return true;
}

/**
 * @returns {Promise<void>}
 */
async function resumeWithAlternativeSlots({
  business,
  recipientPhone,
  lastIntent,
  clientId = null,
  requestId = null,
}) {
  const service = lastIntent?.service;
  const draft = await startBrowsingFlow({
    businessId: business.id,
    clientId,
    rawPhone: recipientPhone,
    context: { step: 'select_slot', resumed_after_ttl: true },
    requestId,
  });
  if (!draft || !service) return;

  const updated = await setSelectedService({
    draftId: draft.id,
    businessId: business.id,
    service,
    context: { ...draft.conversation_context, step: 'select_slot', service_id: service.id },
    requestId,
  });
  if (updated) {
    await sendSlotPicker({
      business,
      recipientPhone,
      draft: updated,
      requestId,
    });
  }
}

/**
 * Re-locks the remembered slot for 5 minutes and shows the confirmation prompt.
 * @returns {Promise<boolean>}
 */
export async function relockRememberedSlot({
  business,
  recipientPhone,
  lastIntent,
  clientId = null,
  requestId = null,
}) {
  const service = lastIntent?.service;
  const slotStart = lastIntent?.slot_start;
  if (!service || !slotStart) return false;

  const empId = typeof lastIntent.employee_id === 'string' ? lastIntent.employee_id : null;
  const startDate = new Date(slotStart);
  const duration = catalogDuration(business, service);
  if (!duration) return false;

  const endDate = new Date(startDate.getTime() + duration * 60_000);
  const slotId = encodeSlotId(startDate, business.timezone);
  const hoursCheck = assertWithinWorkingHours(business, startDate, endDate);
  if (!hoursCheck.ok) {
    await offerResumeOrAlternatives({
      business,
      recipientPhone,
      lastIntent,
      clientId,
      requestId,
    });
    return true;
  }

  const free = await isSlotAvailable({
    business,
    slotId,
    durationMinutes: duration,
    employeeId: empId,
  });

  if (!free) {
    await offerResumeOrAlternatives({
      business,
      recipientPhone,
      lastIntent,
      clientId,
      requestId,
    });
    return true;
  }

  let draft = await startBrowsingFlow({
    businessId: business.id,
    clientId,
    rawPhone: recipientPhone,
    context: { step: 'confirm', resumed_after_ttl: true },
    requestId,
  });
  if (!draft) return false;

  draft = await setSelectedService({
    draftId: draft.id,
    businessId: business.id,
    service,
    context: { ...draft.conversation_context, service_id: service.id },
    requestId,
  });
  if (!draft) return false;

  if (empId) {
    await setDraftEmployee({
      draftId: draft.id,
      businessId: business.id,
      employeeId: empId,
      requestId,
    });
  }

  const locked = await setSelectedSlot({
    draftId: draft.id,
    businessId: business.id,
    slotStart: startDate,
    slotEnd: endDate,
    ttlMinutes: getPendingTtlMinutes(business),
    context: { ...draft.conversation_context, step: 'confirm', resumed_after_ttl: true },
    requestId,
  });
  if (!locked) return false;

  await continueAfterSlotSelected({
    business,
    recipientPhone,
    draft: locked,
    service,
    slotStart: startDate,
    slotEnd: endDate,
    requestId,
  });
  return true;
}

/**
 * Handles 1/2 (or buttons) on the post-TTL resume prompt.
 * @returns {Promise<boolean>}
 */
export async function handleResumeOfferReply({
  business,
  recipientPhone,
  replyId,
  lastIntent,
  clientId = null,
  requestId = null,
}) {
  if (replyId === PREFIX.RESUME_YES || replyId === PREFIX.CONFIRM) {
    return relockRememberedSlot({
      business,
      recipientPhone,
      lastIntent,
      clientId,
      requestId,
    });
  }
  if (replyId === PREFIX.RESUME_NO || replyId === PREFIX.CANCEL) {
    await resumeWithAlternativeSlots({
      business,
      recipientPhone,
      lastIntent,
      clientId,
      requestId,
    });
    return true;
  }
  return false;
}

export { PREFIX as BOOKING_PREFIXES };

/**
 * Tries to interpret free-text like "maine la 10:30" into a slot selection.
 * @returns {Promise<boolean>} true if handled
 */
export async function handleFreeTextSlotRequest({
  business,
  recipientPhone,
  draft,
  textBody,
  requestId = null,
}) {
  const service = /** @type {{ duration_minutes: number; name: string } | null} */ (
    draft.selected_service
  );
  if (!service) return false;

  const duration = catalogDuration(business, service);
  if (!duration) {
    await simulateHumanDelay({ business, recipientPhone, requestId });
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: durationMissingClientMessage(service.name),
    });
    return true;
  }

  const parsed = parseRomanianDateTime(textBody, business.timezone);
  if (!parsed) {
    return false;
  }

  const slotEnd = new Date(parsed.getTime() + duration * 60_000);
  const hoursCheck = assertWithinWorkingHours(business, parsed, slotEnd);
  if (!hoursCheck.ok) {
    await simulateHumanDelay({ business, recipientPhone, requestId });
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: hoursCheck.message,
    });
    return true;
  }

  const slotId = encodeSlotId(parsed, business.timezone);
  const available = await isSlotAvailable({
    business,
    slotId,
    durationMinutes: duration,
    excludeDraftId: draft.id,
    employeeId: draftEmployeeId(draft),
  });

  if (!available) {
    await simulateHumanDelay({ business, recipientPhone, requestId });
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: `Intervalul *${formatSlotLabel(parsed, business.timezone)}* nu e disponibil. Alege din listă:`,
    });
    return false;
  }

  const updated = await setSelectedSlot({
    draftId: draft.id,
    businessId: business.id,
    slotStart: parsed,
    slotEnd,
    ttlMinutes: getPendingTtlMinutes(business),
    context: { ...draft.conversation_context, step: 'confirm', slot_id: slotId, free_text: textBody },
    requestId,
  });

  if (!updated || updated.state !== 'pending_confirmation') {
    await simulateHumanDelay({ business, recipientPhone, requestId });
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: `Intervalul *${formatSlotLabel(parsed, business.timezone)}* tocmai a fost rezervat. Alege din listă:`,
    });
    return false;
  }

  await continueAfterSlotSelected({
    business,
    recipientPhone,
    draft: updated,
    service,
    slotStart: parsed,
    slotEnd,
    requestId,
  });
  return true;
}

export { parseRomanianDateTime } from '../utils/roDateTime.js';

/**
 * Free-text slot while rescheduling a confirmed appointment.
 * @returns {Promise<boolean>}
 */
export async function handleFreeTextReschedule({
  business,
  recipientPhone,
  textBody,
  convState,
  requestId = null,
}) {
  const parsed = parseRomanianDateTime(textBody, business.timezone);
  if (!parsed) {
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: 'Nu am înțeles ora. Alege din listă sau scrie ex: *mâine la 10:30*.',
    });
    return true;
  }

  const slotId = encodeSlotId(parsed, business.timezone);
  const { applyRescheduleSlot } = await import('./modificationFlowService.js');
  return applyRescheduleSlot({
    business,
    recipientPhone,
    convState,
    slotId,
    requestId,
  });
}
