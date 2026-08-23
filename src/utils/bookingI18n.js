/**
 * Booking-flow client messages (errors, recovery, modify).
 * Used by turnExecute and related handlers — always pass session lang.
 */

/** @typedef {'ro' | 'en'} UiLang */

/** @type {Record<string, { ro: string, en: string }>} */
export const BOOKING_MSG = {
  errHoldLockFailed: {
    ro: 'Nu am putut bloca intervalul în sistem. Te rog alege din nou ora.',
    en: 'I could not lock that time in the system. Please pick a time again.',
  },
  errSlotRetainFailed: {
    ro: 'Nu am putut reține intervalul. Încearcă din nou.',
    en: 'I could not hold that slot. Please try again.',
  },
  errSlotLockFailed: {
    ro: 'Nu am putut bloca intervalul. Te rog alege din nou ora.',
    en: 'I could not lock the slot. Please pick a time again.',
  },
  errBookingStartFailed: {
    ro: 'Nu am putut porni programarea. Încearcă din nou.',
    en: 'I could not start the booking. Please try again.',
  },
  errEmployeeNotFound: {
    ro: 'Nu am găsit *{name}* în echipă. Poți scrie un nume din echipă: {staff}.',
    en: 'I could not find *{name}* on the team. You can type a name from the team: {staff}.',
  },
  errHoldExpired: {
    ro: 'Timpul de rezervare a expirat și slotul a fost eliberat.',
    en: 'The hold expired and the slot was released.',
  },
  errNoPendingConfirm: {
    ro: 'Nu există o programare în așteptarea confirmării.',
    en: 'There is no booking waiting for confirmation.',
  },
  errIncompleteBooking: {
    ro: 'Datele programării sunt incomplete.',
    en: 'The booking details are incomplete.',
  },
  errConfirmCalendar: {
    ro: 'Din păcate nu am putut confirma programarea. Te rog încearcă din nou.',
    en: 'Unfortunately I could not confirm the booking. Please try again.',
  },
  errSaveBooking: {
    ro: 'Din păcate nu am putut salva programarea în sistem. Te rog încearcă din nou.',
    en: 'Unfortunately I could not save the booking. Please try again.',
  },
  errReopenDraft: {
    ro: 'Nu am putut redeschide programarea în curs. Scrie din nou serviciul dorit ca să o luăm de la capăt.',
    en: 'I could not reopen your booking in progress. Type the service again and we will start over.',
  },
  errCancelOne: {
    ro: 'Din păcate nu am putut anula programarea în sistem. Te rog încearcă din nou.',
    en: 'Unfortunately I could not cancel the appointment. Please try again.',
  },
  errCancelAll: {
    ro: 'Din păcate nu am putut anula programările. Te rog încearcă din nou.',
    en: 'Unfortunately I could not cancel the appointments. Please try again.',
  },
  cancelAllPartial: {
    ro: 'Am anulat {cancelled} programări. {failed} nu au putut fi anulate.',
    en: 'I cancelled {cancelled} appointments. {failed} could not be cancelled.',
  },
  cancelAllSuccess: {
    ro: 'Am anulat toate cele {count} programări.',
    en: 'I cancelled all {count} appointments.',
  },
  confirmCancelAll: {
    ro: 'Anulezi toate cele {count} programări?',
    en: 'Cancel all {count} appointments?',
  },
  slotTakenReschedule: {
    ro: 'Înțeleg, *{slot}* nu mai e liber. Te rog alege altă oră din listă — păstrăm același serviciu.',
    en: 'Got it — *{slot}* is no longer free. Please pick another time from the list — we keep the same service.',
  },
  pickAnotherTime: {
    ro: 'Te rog alege altă oră din listă — păstrăm același serviciu.',
    en: 'Please pick another time from the list — we keep the same service.',
  },
  errRescheduleSave: {
    ro: 'Îmi pare rău, nu am putut salva reprogramarea acum. Te rog încearcă din nou peste un moment.',
    en: 'Sorry, I could not save the reschedule right now. Please try again in a moment.',
  },
  rescheduleDone: {
    ro: 'Gata — am mutat programarea ta la *{service}* pe *{when}*. Te așteptăm cu drag! Dacă mai schimbi ceva, scrie *reprogramare*.',
    en: 'Done — I moved your appointment for *{service}* to *{when}*. See you soon! To change again, type *reschedule*.',
  },
  noApptAtHint: {
    ro: 'Nu am găsit o programare la *{hint}*. Care vrei să anulezi?',
    en: 'I could not find an appointment at *{hint}*. Which one do you want to cancel?',
  },
  pickApptOrCancelAll: {
    ro: 'Ai {count} programări. Alege una sau anulează-le pe toate.',
    en: 'You have {count} appointments. Pick one or cancel all.',
  },
  askFullName: {
    ro: 'Te rog scrie prenumele și numele, ex: *Ana Popescu*.',
    en: 'Please type your first and last name, e.g. *Ana Popescu*.',
  },
  nameSavedRestart: {
    ro: 'Am salvat numele. Scrie *programare* ca să alegi din nou serviciul și ora.',
    en: 'Name saved. Type *booking* to choose the service and time again.',
  },
  clarifyNotUnderstood: {
    ro: 'Nu am înțeles exact. Te rog alege o opțiune din meniu sau reformulează (ex: *vreau vineri la 11*).',
    en: "I didn't catch that. Please pick a menu option or rephrase (e.g. *Friday at 11*).",
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
    ro: 'Ok, modificăm. Păstrăm *{service}* — alege din nou *ziua* (apoi ora).',
    en: "Ok, let's revise. We keep *{service}* — pick the *day* again (then the time).",
  },
  noOpenDays14: {
    ro: 'Nu am zile cu ore libere în următoarele 14 zile. Contactează {business} sau încearcă mai târziu.',
    en: 'No open days with free times in the next 14 days. Contact {business} or try again later.',
  },
  errDurationMissing: {
    ro: 'Din păcate nu pot confirma această programare momentan.',
    en: 'Unfortunately I cannot confirm this booking right now.',
  },
  thanksReply: {
    ro: 'Cu plăcere! Dacă mai ai nevoie — o programare, orarul sau contact — scrie-mi oricând.',
    en: "You're welcome! If you need anything else — a booking, hours, or contact — just write here.",
  },
  businessSuspended: {
    ro: 'Serviciul de programări este temporar inactiv. Te rugăm să revii mai târziu sau să contactezi direct afacerea.',
    en: 'The booking service is temporarily inactive. Please try again later or contact the business directly.',
  },
  serviceFallback: { ro: 'serviciul', en: 'service' },
  appointmentFallback: { ro: 'Programare', en: 'Appointment' },
  cancelAllSlotLabel: { ro: 'toate intervalele', en: 'all slots' },
  cancelAllServiceLabel: { ro: '{count} programări', en: '{count} appointments' },
  noSlotsGeneric: {
    ro: 'Nu am găsit ore libere pentru *{service}*{date}.',
    en: 'No free times for *{service}*{date}.',
  },
  closedDayNotice: {
    ro: '*{date}* suntem *ÎNCHIS*. Alege o zi deschisă din listă:',
    en: '*{date}* we are *CLOSED*. Pick an open day from the list:',
  },
  reviseTimeNotice: {
    ro: 'Ok, schimbăm ora pentru *{service}*. Alege un alt interval:',
    en: 'Ok, changing the time for *{service}*. Pick another slot:',
  },
  reschedulePickDay: {
    ro: 'Reprogramăm *{service}*{from}. Alege mai întâi *ziua nouă* — orele apar după ce ai ales data.',
    en: "Let's reschedule *{service}*{from}. First pick the *new day* — times appear after you choose the date.",
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
