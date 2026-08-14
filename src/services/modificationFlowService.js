import {
  listUpcomingConfirmedBookings,
  getDraftBookingById,
  updateConfirmedBookingSlot,
  cancelOrResetDraft,
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
import { formatSlotLabel, decodeSlotId, slotNumberEmoji } from '../utils/datetime.js';
import {
  assertWithinWorkingHours,
  durationMissingClientMessage,
  hasConfiguredOpenDay,
  hoursUnsetClientMessage,
  resolveServiceDurationMinutes,
} from '../utils/workingHours.js';
import { buildBookingCalendarInvite } from '../utils/calendarLink.js';
import { buildGdprNote, buildMapsInviteLine } from '../utils/businessMessages.js';
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
  rememberMenuOptions,
  simulateHumanDelay,
} from './whatsappService.js';
import { detectModificationIntent } from './intentTriageService.js';

/** @typedef {import('../db/businessService.js').Business} Business */
/** @typedef {import('../db/conversationStateService.js').ConversationState} ConversationState */

export { detectModificationIntent };

export const MOD_PREFIX = {
  APPT: 'mod_appt_',
  CONFIRM_CANCEL: 'mod_confirm_cancel',
  ABORT: 'mod_abort',
};

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

  if (!isBusinessMockMode(business)) {
    if (!eventId) {
      await simulateHumanDelay({ business, recipientPhone, requestId });
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text: 'Din păcate nu am putut anula programarea. Te rog încearcă din nou.',
      });
      return true;
    }

    const del = await deleteCalendarEvent({
      business,
      eventId,
      calendarId,
      requestId,
    });

    if (!del?.ok) {
      await simulateHumanDelay({ business, recipientPhone, requestId });
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text: 'Din păcate nu am putut anula programarea. Te rog încearcă din nou.',
      });
      return true;
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

  await simulateHumanDelay({ business, recipientPhone, requestId });
  await sendTextMessage({
    business,
    recipientPhone,
    requestId,
    text: 'Programarea ta a fost anulată cu succes. Te așteptăm cu drag altă dată!',
  });

  await resetConversationState({
    businessId: business.id,
    rawPhone: recipientPhone,
    requestId,
  });
  return true;
}

/**
 * Starts cancel/reschedule flow for confirmed appointments.
 * @returns {Promise<boolean>} true if handled
 */
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

  const options = appointments.map((a) => {
    const service = /** @type {{ name?: string }} */ (a.selected_service ?? {});
    const when = a.selected_slot_start
      ? formatSlotLabel(new Date(a.selected_slot_start), business.timezone)
      : '—';
    return {
      id: `${MOD_PREFIX.APPT}${a.id}`,
      title: `${service.name || 'Programare'} — ${when}`,
    };
  });

  await rememberMenuOptions(business.id, recipientPhone, options, 'modify');

  const lines = [
    intent === 'cancel'
      ? 'Care programare vrei să anulezi?'
      : 'Care programare vrei să reprogramezi?',
    '',
  ];
  options.forEach((opt, i) => {
    lines.push(`${slotNumberEmoji(i)} ${opt.title}`);
  });
  lines.push('', 'Răspunde cu numărul opțiunii.');

  await setConversationStep({
    businessId: business.id,
    rawPhone: recipientPhone,
    step: CONVERSATION_STEPS.MODIFYING,
    context: { intent, appointment_ids: appointments.map((a) => a.id) },
    mergeContext: false,
    requestId,
  });

  await sendTextMessage({
    business,
    recipientPhone,
    requestId,
    text: lines.join('\n'),
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
      bodyText:
        `Confirmi anularea?\n\n` +
        `📋 *${service.name || 'Programare'}*\n` +
        `🕐 ${when}`,
      buttons: [
        { id: MOD_PREFIX.CONFIRM_CANCEL, title: '✅ Anulează' },
        { id: MOD_PREFIX.ABORT, title: '❌ Renunță' },
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
    `📅 *Alege ora pentru ${serviceName}:*`,
    '_(Primele opțiuni disponibile)_',
    '',
  ];
  options.forEach((opt, i) => {
    lines.push(`🟦 ${i + 1}. ${opt.title}`);
    lines.push('');
  });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines.push('', '👉 _Răspunde cu numărul opțiunii dorite._');

  await sendTextMessage({
    business,
    recipientPhone,
    requestId,
    text: lines.join('\n'),
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

  const available = await isSlotAvailable({
    business,
    slotId,
    durationMinutes: duration,
    excludeDraftId: appointmentId,
    employeeId,
  });

  if (!available) {
    await sendTextMessage({
      business,
      recipientPhone,
      requestId,
      text: 'Slotul nu mai e liber. Alege altă oră:',
    });
    await sendRescheduleSlotPicker({ business, recipientPhone, appointment, requestId });
    return true;
  }

  const eventId = await resolveCalendarEventId({
    business,
    eventId: storedEventId || appointment.google_event_id,
    phoneNumber: appointment.phone_number || recipientPhone,
    startIso: appointment.selected_slot_start || /** @type {string | null} */ (convState.context_data?.slot_start) || null,
    endIso: appointment.selected_slot_end || /** @type {string | null} */ (convState.context_data?.slot_end) || null,
    calendarId,
    requestId,
  });

  if (!isBusinessMockMode(business)) {
    if (!eventId) {
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text: 'Din păcate nu am putut reprograma. Te rog încearcă din nou.',
      });
      return true;
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
      console.error('Eroare detalii:', calResult);
      await sendTextMessage({
        business,
        recipientPhone,
        requestId,
        text: 'Din păcate nu am putut reprograma. Te rog încearcă din nou.',
      });
      return true;
    }
  } else if (eventId) {
    await updateCalendarEvent({
      business,
      eventId,
      calendarId,
      updates: {
        summary: `${service.name || 'Programare'} — ${appointmentId.slice(0, 8)}`,
        start: { dateTime: slotStart.toISOString(), timeZone: business.timezone },
        end: { dateTime: slotEnd.toISOString(), timeZone: business.timezone },
      },
      requestId,
    });
  }

  await updateConfirmedBookingSlot({
    draftId: appointmentId,
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
      appointment_id: appointmentId,
      slot_start: slotStart.toISOString(),
      google_event_id: eventId,
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
  const mapsInvite = buildMapsInviteLine(business);
  const mapsLine = mapsInvite?.messageLine ? `\n${mapsInvite.messageLine}` : '';

  // Order: 1) GDPR note, 2) updated booking confirmation
  await sendTextMessage({
    business,
    recipientPhone,
    requestId,
    text: buildGdprNote(business),
  });

  const updateBody =
    `✅ *Programare actualizată!*\n\n` +
    `📋 ${service.name || 'Serviciu'}\n` +
    `🕐 ${formatSlotLabel(slotStart, business.timezone)}` +
    `${mapsLine}\n\n` +
    'Te așteptăm! Pentru anulare, scrie *anulează*.';

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
