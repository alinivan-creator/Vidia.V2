import {
  listUpcomingConfirmedBookings,
  getDraftBookingById,
  cancelOrResetDraft,
  cancelConfirmedBookingAtomic,
  rescheduleConfirmedBookingAtomic,
} from '../db/draftBookingService.js';
import {
  getEmployeeById,
  resolveEmployeeCalendarId,
} from '../db/employeeService.js';
import {
  CONVERSATION_STEPS,
  setConversationStep,
  resetConversationState,
} from '../db/conversationStateService.js';
import { getAvailableSlots, isSlotAvailable } from '../db/cacheService.js';
import { formatSlotLabel, decodeSlotId } from '../utils/datetime.js';
import { buildAppointmentChoiceMenu } from '../utils/appointmentMatch.js';
import {
  assertWithinWorkingHours,
  durationMissingClientMessage,
  hasConfiguredOpenDay,
  hoursUnsetClientMessage,
  resolveServiceDurationMinutes,
} from '../utils/workingHours.js';
import { buildBookingCalendarInvite } from '../utils/calendarLink.js';
import { WA_DIVIDER, waField, waJoin, waTitle } from '../utils/waCopy.js';
import {
  lazySyncCalendar,
  updateCalendarEvent,
  deleteCalendarEvent,
  resolveCalendarEventId,
  isMockEventId,
  isBusinessMockMode,
} from './googleCalendarService.js';
import {
  sendTextMessage,
  sendMessageWithUrlButton,
  sendInteractiveButtons,
  sendInteractiveList,
  rememberMenuOptions,
  simulateHumanDelay,
} from './whatsappService.js';
import { detectModificationIntent } from './intentTriageService.js';
import { MOD_PREFIX } from './flowIds.js';

/** @typedef {import('../db/businessService.js').Business} Business */
/** @typedef {import('../db/conversationStateService.js').ConversationState} ConversationState */

export { detectModificationIntent, MOD_PREFIX };

/**
 * Employee + calendar for a confirmed appointment (multi-staff safe).
 * @param {Business} business
 * @param {{ employee_id?: string | null; conversation_context?: Record<string, unknown> | null }} appointment
 */
async function resolveAppointmentStaff(business, appointment) {
  const ctxEmp = appointment.conversation_context?.employee_id;
  const empId =
    (typeof appointment.employee_id === 'string' && appointment.employee_id) ||
    (typeof ctxEmp === 'string' ? ctxEmp : null) ||
    null;
  const employee = empId ? await getEmployeeById(empId, business.id) : null;
  return {
    employeeId: empId,
    employee,
    calendarId: resolveEmployeeCalendarId(business, employee),
  };
}

/**
 * Global cancel/reschedule entry — clears any in-progress draft, then acts on
 * the latest confirmed appointment. Safe to call from any conversation step.
 * @returns {Promise<boolean>}
 */
export async function handleGlobalModificationIntent({
  business,
  recipientPhone,
  intent,
  activeDraft = null,
  requestId = null,
}) {
  let clearedDraft = false;
  if (activeDraft && ['browsing', 'pending_confirmation'].includes(activeDraft.state)) {
    await cancelOrResetDraft({
      draftId: activeDraft.id,
      businessId: business.id,
      state: 'cancelled',
      context: {
        ...activeDraft.conversation_context,
        step: 'cancelled_for_modification_intent',
      },
      requestId,
    });
    clearedDraft = true;
  }

  // Both cancel + reschedule go through the picker/confirm flow so we never
  // silently cancel an older mock booking while a real Google event remains.
  return beginModificationFlow({
    business,
    recipientPhone,
    intent,
    clearedDraft,
    requestId,
  });
}

/**
 * @returns {Promise<boolean>}
 */
async function cancelConfirmedAppointment({
  business,
  recipientPhone,
  appointment,
  requestId = null,
  notify = true,
  resetState = true,
}) {
  const { calendarId } = await resolveAppointmentStaff(business, appointment);

  const eventId = await resolveCalendarEventId({
    business,
    eventId: appointment.google_event_id,
    phoneNumber: appointment.phone_number || recipientPhone,
    startIso: appointment.selected_slot_start,
    endIso: appointment.selected_slot_end,
    calendarId,
    requestId,
  });

  // DB-first: never confirm cancel to the client unless Supabase mutated the row.
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
    if (notify) {
      await simulateHumanDelay({ business, recipientPhone, requestId });
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text: 'Din păcate nu am putut anula programarea în sistem. Te rog încearcă din nou.',
      });
    }
    return false;
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

  if (notify) {
    await simulateHumanDelay({ business, recipientPhone, requestId });
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: 'Programarea ta a fost anulată cu succes. Te așteptăm cu drag altă dată!',
    });
  }

  if (resetState) {
    await resetConversationState({
      businessId: business.id,
      rawPhone: recipientPhone,
      requestId,
    });
  }
  return true;
}

/**
 * Confirmed bookings that can be cancelled/rescheduled on a live calendar.
 * Auto-closes orphan mock confirmations left over from Mock Mode.
 * @param {import('../db/businessService.js').Business} business
 * @param {string} recipientPhone
 * @param {string | null} [requestId]
 */
async function listActionableConfirmedBookings(business, recipientPhone, requestId = null) {
  const appointments = await listUpcomingConfirmedBookings(business.id, recipientPhone);
  if (isBusinessMockMode(business)) return appointments;

  /** @type {typeof appointments} */
  const actionable = [];
  for (const appointment of appointments) {
    if (appointment.google_event_id && !isMockEventId(appointment.google_event_id)) {
      actionable.push(appointment);
      continue;
    }

    // Orphan mock confirmation on a live calendar — close locally.
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
    console.warn('[modification] auto-cancelled orphan mock booking', {
      draftId: appointment.id,
      googleEventId: appointment.google_event_id,
    });
  }
  return actionable;
}

export async function beginModificationFlow({
  business,
  recipientPhone,
  intent,
  clearedDraft = false,
  requestId = null,
}) {
  const appointments = await listActionableConfirmedBookings(
    business,
    recipientPhone,
    requestId,
  );

  await simulateHumanDelay({ business, recipientPhone, requestId });

  if (!appointments.length) {
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: clearedDraft
        ? 'Am anulat programarea în curs. Nu ai altă programare confirmată activă.'
        : intent === 'cancel'
          ? 'Nu am găsit o programare activă de anulat. Scrie *programare* pentru una nouă.'
          : 'Nu am găsit o programare activă de modificat. Scrie *programare* pentru una nouă.',
    });
    await resetConversationState({
      businessId: business.id,
      rawPhone: recipientPhone,
      requestId,
    });
    return true;
  }

  if (appointments.length === 1) {
    return offerActionForAppointment({
      business,
      recipientPhone,
      appointment: appointments[0],
      intent,
      requestId,
    });
  }

  const options = buildAppointmentChoiceMenu(appointments, business.timezone, {
    apptPrefix: MOD_PREFIX.APPT,
    cancelAllId: MOD_PREFIX.CANCEL_ALL,
    includeCancelAll: intent === 'cancel',
  });

  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: CONVERSATION_STEPS.MODIFYING,
    context: {
      intent,
      appointment_ids: appointments.map((a) => a.id),
      last_menu: { kind: 'modify', options },
    },
    mergeContext: false,
    requestId,
  });

  await sendInteractiveList({
    business,
    recipientPhone,
    requestId,
    bodyText: intent === 'cancel'
      ? 'Care programare vrei să anulezi?'
      : 'Care programare vrei să reprogramezi?',
    buttonText: 'Programările tale',
    sections: [{
      title: 'Programări',
      rows: options.map((opt) => ({
        id: opt.id,
        title: opt.title,
        description: opt.description || 'Programare activă',
      })),
    }],
    footerText: business.name,
    menuKind: 'modify',
    rememberOptions: options,
  });
  return true;
}

/**
 * @returns {Promise<boolean>}
 */
async function offerActionForAppointment({
  business,
  recipientPhone,
  appointment,
  intent,
  requestId,
}) {
  const service = /** @type {{ name?: string; duration_minutes?: number }} */ (
    appointment.selected_service ?? {}
  );
  const when = appointment.selected_slot_start
    ? formatSlotLabel(new Date(appointment.selected_slot_start), business.timezone)
    : '—';

  const { employeeId } = await resolveAppointmentStaff(business, appointment);
  const baseContext = {
    intent,
    appointment_id: appointment.id,
    google_event_id: appointment.google_event_id,
    employee_id: employeeId,
    service: appointment.selected_service,
    slot_start: appointment.selected_slot_start,
    slot_end: appointment.selected_slot_end,
  };

  if (intent === 'cancel') {
    await setConversationStep({
      businessId: business.id,
      rawPhone: recipientPhone,
      step: CONVERSATION_STEPS.CONFIRMING_CANCEL,
      context: baseContext,
      mergeContext: false,
      requestId,
    });

    await sendInteractiveButtons({
      business,
      recipientPhone,
      requestId,
      bodyText: waJoin(
        waTitle('Confirmi anularea?'),
        '',
        waField('Serviciu', service.name || 'Programare'),
        waField('Când', when),
      ),
      buttons: [
        { id: MOD_PREFIX.CONFIRM_CANCEL, title: 'Anulează' },
        { id: MOD_PREFIX.ABORT, title: 'Renunță' },
      ],
      menuKind: 'confirm',
    });
    return true;
  }

  // Reschedule → pick new slot
  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: CONVERSATION_STEPS.RESCHEDULING,
    context: baseContext,
    mergeContext: false,
    requestId,
  });

  await sendTextMessage({
    business,
    recipientPhone,
    requestId,
    text:
      `Reprogramăm *${service.name || 'serviciul'}* (acum: ${when}).\n` +
      'Alege o oră nouă sau scrie ex: *mâine la 10:30*.',
  });

  await sendRescheduleSlotPicker({ business, recipientPhone, appointment, requestId });
  return true;
}

/**
 * @returns {Promise<void>}
 */
async function sendRescheduleSlotPicker({ business, recipientPhone, appointment, requestId }) {
  const service = /** @type {{ duration_minutes?: number; name?: string }} */ (
    appointment.selected_service ?? {}
  );
  const duration = resolveServiceDurationMinutes(business, service);

  if (!hasConfiguredOpenDay(business)) {
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: hoursUnsetClientMessage(),
    });
    return;
  }

  if (!duration) {
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: durationMissingClientMessage(service.name),
    });
    return;
  }

  const { employeeId, calendarId } = await resolveAppointmentStaff(business, appointment);

  // Force live Google sync on the employee's calendar (not only business default)
  await lazySyncCalendar({
    business,
    requestId,
    force: true,
    calendarId,
    employeeId,
  });
  const slots = await getAvailableSlots({
    business,
    durationMinutes: duration,
    limit: 10,
    excludeDraftId: appointment.id,
    employeeId,
  });

  if (!slots.length) {
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: 'Nu am găsit sloturi libere în perioada următoare. Încearcă mai târziu.',
    });
    return;
  }

  const options = slots.map((s) => ({
    id: s.id,
    title: formatSlotLabel(s.start, business.timezone),
  }));
  await rememberMenuOptions(business.id, recipientPhone, options, 'slot');

  const serviceName =
    /** @type {{ name?: string }} */ (appointment.selected_service ?? {}).name || 'serviciu';
  const lines = [
    waTitle(`Alege ora — ${serviceName}`),
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
 * Interactive replies for modification flow.
 * @returns {Promise<boolean>}
 */
export async function handleModificationInteractive({
  business,
  recipientPhone,
  replyId,
  convState,
  requestId = null,
}) {
  if (replyId === MOD_PREFIX.ABORT) {
    await resetConversationState({
      businessId: business.id,
      rawPhone: recipientPhone,
      requestId,
    });
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: 'Ok, nu am modificat nimic. Scrie *programare* dacă ai nevoie.',
    });
    return true;
  }

  if (replyId === MOD_PREFIX.CONFIRM_CANCEL) {
    return finalizeCancel({ business, recipientPhone, convState, requestId });
  }

  if (replyId === MOD_PREFIX.CANCEL_ALL) {
    const ids = Array.isArray(convState.context_data?.appointment_ids)
      ? convState.context_data.appointment_ids.filter((id) => typeof id === 'string')
      : [];
    if (!ids.length) {
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text: 'Nu am găsit programări de anulat.',
      });
      return true;
    }
    await setConversationStep({
      businessId: business.id,
      rawPhone: recipientPhone,
      step: CONVERSATION_STEPS.CONFIRMING_CANCEL,
      context: {
        intent: 'cancel',
        cancel_all: true,
        appointment_ids: ids,
      },
      mergeContext: false,
      requestId,
    });
    await sendInteractiveButtons({
      business,
      recipientPhone,
      requestId,
      bodyText: `Anulezi toate cele ${ids.length} programări?`,
      buttons: [
        { id: MOD_PREFIX.CONFIRM_CANCEL, title: 'Anulează' },
        { id: MOD_PREFIX.ABORT, title: 'Renunță' },
      ],
      footerText: business.name,
      menuKind: 'confirm',
    });
    return true;
  }

  if (replyId.startsWith(MOD_PREFIX.APPT)) {
    const appointmentId = replyId.slice(MOD_PREFIX.APPT.length);
    const appointment = await getDraftBookingById(appointmentId, business.id);
    if (!appointment) {
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text: 'Programarea nu mai este disponibilă.',
      });
      return true;
    }
    const intent =
      /** @type {'cancel' | 'reschedule'} */ (convState.context_data?.intent) || 'reschedule';
    return offerActionForAppointment({
      business,
      recipientPhone,
      appointment,
      intent,
      requestId,
    });
  }

  if (
    convState.current_step === CONVERSATION_STEPS.RESCHEDULING &&
    replyId.startsWith('slot_')
  ) {
    return applyRescheduleSlot({
      business,
      recipientPhone,
      convState,
      slotId: replyId,
      requestId,
    });
  }

  return false;
}

/**
 * Free-text while in modification steps.
 * @returns {Promise<boolean>}
 */
export async function handleModificationText({
  business,
  recipientPhone,
  textBody,
  convState,
  requestId = null,
}) {
  if (convState.current_step === CONVERSATION_STEPS.CONFIRMING_CANCEL) {
    const n = textBody.toLowerCase();
    if (['da', 'yes', 'confirm', 'confirma', 'confirmă'].some((k) => n.includes(k))) {
      return finalizeCancel({ business, recipientPhone, convState, requestId });
    }
    if (['nu', 'no', 'renunt'].some((k) => n.includes(k))) {
      await resetConversationState({
        businessId: business.id,
        rawPhone: recipientPhone,
        requestId,
      });
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text: 'Anularea a fost abandonată.',
      });
      return true;
    }
  }

  if (convState.current_step === CONVERSATION_STEPS.RESCHEDULING) {
    const { handleFreeTextReschedule } = await import('./bookingFlowService.js');
    return handleFreeTextReschedule({
      business,
      recipientPhone,
      textBody,
      convState,
      requestId,
    });
  }

  if (convState.current_step === CONVERSATION_STEPS.MODIFYING) {
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: 'Alege numărul programării din listă.',
    });
    return true;
  }

  return false;
}

/**
 * @returns {Promise<boolean>}
 */
async function finalizeCancel({ business, recipientPhone, convState, requestId }) {
  if (convState.context_data?.cancel_all) {
    const ids = Array.isArray(convState.context_data.appointment_ids)
      ? convState.context_data.appointment_ids.filter((id) => typeof id === 'string')
      : [];
    let cancelled = 0;
    for (const id of ids) {
      const appointment = await getDraftBookingById(id, business.id);
      if (!appointment) continue;
      await cancelConfirmedAppointment({
        business,
        recipientPhone,
        appointment,
        requestId,
        notify: false,
        resetState: false,
      });
      cancelled += 1;
    }
    await resetConversationState({
      businessId: business.id,
      rawPhone: recipientPhone,
      requestId,
    });
    await simulateHumanDelay({ business, recipientPhone, requestId });
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: cancelled
        ? `Am anulat toate cele ${cancelled} programări. Te așteptăm cu drag altă dată!`
        : 'Nu am găsit programări de anulat.',
    });
    return true;
  }

  const appointmentId = /** @type {string | undefined} */ (convState.context_data?.appointment_id);
  if (!appointmentId) {
    await resetConversationState({
      businessId: business.id,
      rawPhone: recipientPhone,
      requestId,
    });
    return true;
  }

  const appointment = await getDraftBookingById(appointmentId, business.id);
  if (!appointment) {
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: 'Programarea nu a fost găsită.',
    });
    await resetConversationState({
      businessId: business.id,
      rawPhone: recipientPhone,
      requestId,
    });
    return true;
  }

  return cancelConfirmedAppointment({
    business,
    recipientPhone,
    appointment,
    requestId,
  });
}

/**
 * @returns {Promise<boolean>}
 */
export async function applyRescheduleSlot({
  business,
  recipientPhone,
  convState,
  slotId,
  requestId = null,
}) {
  const appointmentId = /** @type {string | undefined} */ (convState.context_data?.appointment_id);
  const service = /** @type {{ name?: string; duration_minutes?: number }} */ (
    convState.context_data?.service ?? {}
  );
  const duration = resolveServiceDurationMinutes(business, service);
  const storedEventId = /** @type {string | null} */ (convState.context_data?.google_event_id ?? null);

  if (!appointmentId) {
    await resetConversationState({
      businessId: business.id,
      rawPhone: recipientPhone,
      requestId,
    });
    return true;
  }

  const appointment = await getDraftBookingById(appointmentId, business.id);
  if (!appointment) {
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: 'Programarea nu a fost găsită.',
    });
    await resetConversationState({
      businessId: business.id,
      rawPhone: recipientPhone,
      requestId,
    });
    return true;
  }

  const { employeeId, calendarId } = await resolveAppointmentStaff(business, appointment);
  const slotStart = decodeSlotId(slotId, business.timezone);
  if (!slotStart) {
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: 'Slot invalid. Alege din listă.',
    });
    return true;
  }

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

  // Re-sync employee calendar right before accept
  await lazySyncCalendar({
    business,
    requestId,
    force: true,
    calendarId,
    employeeId,
  });

  const eventId = await resolveCalendarEventId({
    business,
    eventId: storedEventId || appointment.google_event_id,
    phoneNumber: appointment.phone_number || recipientPhone,
    startIso: appointment.selected_slot_start || /** @type {string | null} */ (convState.context_data?.slot_start) || null,
    endIso: appointment.selected_slot_end || /** @type {string | null} */ (convState.context_data?.slot_end) || null,
    calendarId,
    requestId,
  });
  const excludeEventIds = [eventId, appointment.google_event_id, storedEventId]
    .filter((id) => typeof id === 'string' && id && !isMockEventId(id));

  const available = await isSlotAvailable({
    business,
    slotId,
    durationMinutes: duration,
    excludeDraftId: appointmentId,
    excludeGoogleEventIds: excludeEventIds,
    employeeId,
  });

  if (!available) {
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: 'Înțeleg, ora asta nu mai e liberă. Te rog alege altă oră din listă:',
    });
    await sendRescheduleSlotPicker({ business, recipientPhone, appointment, requestId });
    return true;
  }

  // DB first — never move Google before the confirmed row is updated.
  let activeEventId = eventId || null;
  const mutated = await rescheduleConfirmedBookingAtomic({
    draftId: appointmentId,
    businessId: business.id,
    slotStart,
    slotEnd,
    employeeId,
    googleEventId: activeEventId,
    context: {
      step: 'rescheduled',
      previous_slot_start: convState.context_data?.slot_start,
      rescheduled_at: new Date().toISOString(),
      google_event_id: activeEventId,
      employee_id: employeeId,
    },
    requestId,
  });

  if (!mutated.ok || !mutated.draft) {
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: mutated.reason === 'slot_taken'
        ? 'Înțeleg, ora asta nu mai e liberă. Te rog alege altă oră din listă.'
        : 'Îmi pare rău, nu am putut salva reprogramarea acum. Te rog încearcă din nou peste un moment.',
    });
    if (mutated.reason === 'slot_taken') {
      await sendRescheduleSlotPicker({ business, recipientPhone, appointment, requestId });
    }
    return true;
  }

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
        console.error('Eroare detalii:', calResult);
        // Booking already saved — still confirm to the client.
      }
    }
  } else if (activeEventId) {
    await updateCalendarEvent({
      business,
      eventId: activeEventId,
      calendarId,
      updates: {
        summary: `${service.name || 'Programare'} — ${appointmentId.slice(0, 8)}`,
        start: { dateTime: slotStart.toISOString(), timeZone: business.timezone },
        end: { dateTime: slotEnd.toISOString(), timeZone: business.timezone },
      },
      requestId,
    });
  }

  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: CONVERSATION_STEPS.MODIFIED,
    context: {
      last_action: 'rescheduled',
      appointment_id: appointmentId,
      slot_start: slotStart.toISOString(),
      google_event_id: activeEventId,
    },
    mergeContext: false,
    requestId,
  });

  await simulateHumanDelay({ business, recipientPhone, requestId });

  const calendarInvite = buildBookingCalendarInvite({
    business,
    serviceName: service.name || 'Serviciu',
    startIso: slotStart,
    endIso: slotEnd,
  });

  // Updated booking confirmation (privacy disclosure is only at session start)
  const updateBody = waJoin(
    waTitle('Gata, am mutat programarea'),
    '',
    waField('Serviciu', service.name || 'Serviciu'),
    waField('Noua dată', formatSlotLabel(slotStart, business.timezone)),
    '',
    'Te așteptăm cu drag! Dacă mai schimbi ceva, scrie *reprogramare* sau *anulează*.',
  );

  if (calendarInvite.url) {
    await sendMessageWithUrlButton({
      business,
      recipientPhone,
      requestId,
      text: updateBody,
      buttonTitle: calendarInvite.buttonTitle,
      buttonUrl: calendarInvite.url,
    });
  } else {
    const body =
      calendarInvite.markdownLine
        ? `${updateBody}\n\n${calendarInvite.markdownLine}`
        : updateBody;
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: body,
    });
  }

  await resetConversationState({
    businessId: business.id,
    rawPhone: recipientPhone,
    requestId,
  });
  return true;
}
