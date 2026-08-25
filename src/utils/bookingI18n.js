/**
 * Booking-flow client messages (errors, recovery, modify).
 * Used by turnExecute and related handlers — always pass session lang.
 * Tone: professional, polite, no colloquialisms.
 */

/** @typedef {'ro' | 'en'} UiLang */

/** @type {Record<string, { ro: string, en: string }>} */
export const BOOKING_MSG = {
  errHoldLockFailed: {
    ro: 'Intervalul selectat nu a putut fi rezervat în sistem. Vă rugăm să alegeți o altă oră.',
    en: 'The selected time slot could not be reserved. Please choose another time.',
  },
  errSlotRetainFailed: {
    ro: 'Intervalul selectat nu a putut fi păstrat. Vă rugăm să încercați din nou.',
    en: 'The selected time slot could not be held. Please try again.',
  },
  errSlotLockFailed: {
    ro: 'Intervalul selectat nu a putut fi blocat. Vă rugăm să alegeți o altă oră.',
    en: 'The selected time slot could not be locked. Please choose another time.',
  },
  errBookingStartFailed: {
    ro: 'Procesul de programare nu a putut fi inițiat. Vă rugăm să încercați din nou.',
    en: 'The booking process could not be started. Please try again.',
  },
  errEmployeeNotFound: {
    ro: 'Nu am găsit un angajat numit *{name}* la noi. {staffOffer}',
    en: 'We could not find a specialist named *{name}*. {staffOffer}',
  },
  errEmployeeOfferOne: {
    ro: 'Te putem programa la *{staff}* — continuăm?',
    en: 'We can book you with *{staff}* — continue?',
  },
  errEmployeeOfferMany: {
    ro: 'Poți alege: {staff}.',
    en: 'You can choose: {staff}.',
  },
  errEmployeeCalendarMissing: {
    ro: 'Momentan nu putem verifica agenda acestui specialist. Scrie *programare* sau alege alt coleg.',
    en: 'We cannot check this specialist’s calendar right now. Type *booking* or pick another colleague.',
  },
  errHoldExpired: {
    ro: 'Perioada de rezervare a expirat, iar intervalul a fost eliberat.',
    en: 'The reservation period has expired and the time slot has been released.',
  },
  errNoPendingConfirm: {
    ro: 'Nu există o programare în așteptarea confirmării.',
    en: 'There is no booking awaiting confirmation.',
  },
  errIncompleteBooking: {
    ro: 'Informațiile programării sunt incomplete.',
    en: 'The booking details are incomplete.',
  },
  errConfirmCalendar: {
    ro: 'Programarea nu a putut fi confirmată. Vă rugăm să încercați din nou.',
    en: 'The booking could not be confirmed. Please try again.',
  },
  errSaveBooking: {
    ro: 'Programarea nu a putut fi salvată în sistem. Vă rugăm să încercați din nou.',
    en: 'The booking could not be saved. Please try again.',
  },
  errReopenDraft: {
    ro: 'Programarea în curs nu a putut fi reluată. Vă rugăm să indicați din nou serviciul dorit.',
    en: 'The booking in progress could not be resumed. Please specify the desired service again.',
  },
  errCancelOne: {
    ro: 'Programarea nu a putut fi anulată în sistem. Vă rugăm să încercați din nou.',
    en: 'The appointment could not be cancelled. Please try again.',
  },
  errCancelAll: {
    ro: 'Programările nu au putut fi anulate. Vă rugăm să încercați din nou.',
    en: 'The appointments could not be cancelled. Please try again.',
  },
  cancelAllPartial: {
    ro: 'Au fost anulate {cancelled} programări. {failed} nu au putut fi anulate.',
    en: '{cancelled} appointments were cancelled. {failed} could not be cancelled.',
  },
  cancelAllSuccess: {
    ro: 'Toate cele {count} programări au fost anulate.',
    en: 'All {count} appointments have been cancelled.',
  },
  confirmCancelAll: {
    ro: 'Confirmați anularea tuturor celor {count} programări?',
    en: 'Do you confirm cancelling all {count} appointments?',
  },
  slotTakenReschedule: {
    ro: 'Intervalul *{slot}* nu mai este disponibil. Vă rugăm alegeți o altă oră din listă; serviciul selectat rămâne neschimbat.',
    en: 'The time slot *{slot}* is no longer available. Please choose another time from the list; your selected service will remain unchanged.',
  },
  pickAnotherTime: {
    ro: 'Vă rugăm alegeți o altă oră din listă; serviciul selectat rămâne neschimbat.',
    en: 'Please choose another time from the list; your selected service will remain unchanged.',
  },
  errRescheduleSave: {
    ro: 'Reprogramarea nu a putut fi salvată momentan. Vă rugăm să încercați din nou.',
    en: 'The reschedule could not be saved at this time. Please try again shortly.',
  },
  rescheduleDone: {
    ro: 'Programarea pentru *{service}* a fost reprogramată pentru *{when}*. Vă așteptăm. Pentru modificări ulterioare, scrieți *reprogramare*.',
    en: 'Your appointment for *{service}* has been rescheduled to *{when}*. We look forward to seeing you. To make further changes, type *reschedule*.',
  },
  noApptAtHint: {
    ro: 'Nu a fost găsită o programare la *{hint}*. Vă rugăm indicați programarea pe care doriți să o anulați.',
    en: 'No appointment was found at *{hint}*. Please indicate which appointment you would like to cancel.',
  },
  pickApptOrCancelAll: {
    ro: 'Aveți {count} programări active. Selectați una sau anulați-le pe toate.',
    en: 'You have {count} active appointments. Select one or cancel all.',
  },
  askFullName: {
    ro: 'Vă rugăm introduceți prenumele și numele, de exemplu: *Ana Popescu*.',
    en: 'Please enter your first and last name, for example: *Ana Popescu*.',
  },
  nameSavedRestart: {
    ro: 'Numele a fost salvat. Scrieți *programare* pentru a selecta serviciul și intervalul dorit.',
    en: 'Your name has been saved. Type *booking* to select the desired service and time.',
  },
  clarifyNotUnderstood: {
    ro: 'Mesajul nu a putut fi interpretat. Vă rugăm selectați o opțiune din meniu sau reformulați solicitarea (ex.: *vineri la 11*).',
    en: 'Your message could not be understood. Please select a menu option or rephrase your request (e.g. *Friday at 11*).',
  },
  errApptsNotFound: {
    ro: 'Programările nu au fost găsite.',
    en: 'The appointments could not be found.',
  },
  errApptNotFound: {
    ro: 'Programarea nu a fost găsită.',
    en: 'The appointment could not be found.',
  },
  reviseKeepService: {
    ro: 'Vă rugăm selectați din nou *ziua* (apoi ora), păstrând serviciul *{service}*.',
    en: 'Please select the *day* again (then the time), keeping *{service}* as your service.',
  },
  noOpenDays14: {
    ro: 'Nu există zile cu intervale disponibile în următoarele 14 zile. Contactați {business} sau încercați mai târziu.',
    en: 'There are no days with available time slots in the next 14 days. Please contact {business} or try again later.',
  },
  errDurationMissing: {
    ro: 'Această programare nu poate fi confirmată momentan.',
    en: 'This booking cannot be confirmed at this time.',
  },
  thanksReply: {
    ro: 'Vă mulțumim. Pentru programări, informații despre program sau contact, ne puteți scrie oricând.',
    en: 'Thank you. For bookings, business hours, or contact details, you may message us at any time.',
  },
  businessSuspended: {
    ro: 'Serviciul de programări este temporar indisponibil. Vă rugăm reveniți mai târziu sau contactați direct locația.',
    en: 'The booking service is temporarily unavailable. Please try again later or contact the business directly.',
  },
  serviceFallback: { ro: 'serviciul selectat', en: 'the selected service' },
  appointmentFallback: { ro: 'Programare', en: 'Appointment' },
  cancelAllSlotLabel: { ro: 'toate intervalele', en: 'all time slots' },
  cancelAllServiceLabel: { ro: '{count} programări', en: '{count} appointments' },
  noSlotsGeneric: {
    ro: 'Nu există intervale disponibile pentru *{service}*{date}.',
    en: 'There are no available time slots for *{service}*{date}.',
  },
  closedDayNotice: {
    ro: 'În data de *{date}* locația este *ÎNCHISĂ*. Vă rugăm alegeți o zi deschisă din listă:',
    en: 'On *{date}* we are *CLOSED*. Please choose an open day from the list:',
  },
  reviseTimeNotice: {
    ro: 'Vă rugăm selectați un alt interval pentru *{service}*:',
    en: 'Please select another time slot for *{service}*:',
  },
  reschedulePickDay: {
    ro: 'Reprogramarea pentru *{service}*{from}. Vă rugăm selectați mai întâi *noua zi* — intervalele orare apar după selectarea datei.',
    en: 'Rescheduling *{service}*{from}. Please select the *new day* first — time slots appear after you choose the date.',
  },
  unableToAttendChoice: {
    ro: 'Înțeleg că nu mai poți ajunge. Preferi să *anulezi* programarea sau să o *reprogramăm*? Scrie „anulez” sau „reprogramare”.',
    en: 'I understand you cannot make it. Would you like to *cancel* or *reschedule*? Reply with “cancel” or “reschedule”.',
  },
  runningLateAck: {
    ro: 'Am înregistrat că vei întârzia. Echipa a fost notificată. Mulțumim că ne-ai anunțat!',
    en: 'We noted that you will be running late. The team has been notified. Thank you for letting us know!',
  },
  specialRequestForwarded: {
    ro: 'Am transmis cererea colegilor — revin cu un răspuns după confirmare. Nu pot confirma automat slotul.',
    en: 'We forwarded your request to the team — we will reply once confirmed. We cannot auto-book this slot.',
  },
  chitchatReply: {
    ro: 'Cu plăcere! Dacă mai aveți nevoie de ceva, sunt aici.',
    en: 'You are welcome! If you need anything else, I am here.',
  },
  sensitiveQuestionSafe: {
    ro: 'Pentru întrebări medicale sau de siguranță, cel mai bine discutați direct cu echipa — am transmis mesajul colegilor.',
    en: 'For medical or safety questions, it is best to speak with the team directly — we forwarded your message.',
  },
};

/**
 * @param {string} key
 * @param {UiLang} [lang]
 * @param {Record<string, string | number>} [vars]
 */
export function bm(key, lang = 'ro', vars = {}) {
  const uiLang = lang === 'en' ? 'en' : 'ro';
  const row = BOOKING_MSG[key];
  if (!row) return key;
  let out = row[uiLang];
  for (const [k, v] of Object.entries(vars || {})) {
    out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v ?? ''));
  }
  return out;
}

/**
 * @param {UiLang} lang
 * @param {string | null | undefined} businessName
 */
export function businessLabel(lang, businessName) {
  if (businessName) return businessName;
  return lang === 'en' ? 'the business' : 'locația';
}
