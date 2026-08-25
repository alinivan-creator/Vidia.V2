/** Stable WhatsApp option ids — shared by extract/execute without loading booking handlers. */

export const BOOKING_PREFIXES = {
  SERVICE: 'svc_',
  EMPLOYEE: 'emp_',
  CONFIRM: 'confirm_booking',
  CANCEL: 'cancel_booking',
  RESUME_YES: 'resume_confirm',
  RESUME_NO: 'resume_other_slots',
  RESCHEDULE: 'reschedule_booking',
  ANY_EMPLOYEE: 'emp_any',
  /** Preferred/colleague alternate: staffslot_<uuid>_<YYYYMMDD>_<HHMM> */
  STAFF_SLOT: 'staffslot_',
  CLARIFY_DATE: 'clarify_date',
  CLARIFY_TIME: 'clarify_time',
};

export const MOD_PREFIX = {
  APPT: 'mod_appt_',
  CANCEL_ALL: 'mod_cancel_all',
  CONFIRM_CANCEL: 'mod_confirm_cancel',
  ABORT: 'mod_abort',
};
