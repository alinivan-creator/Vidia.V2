/**
 * Calendar facade — booking flow entry point.
 *
 * Auth: Google Service Account (JWT) from Admin → Setări sistem.
 * Per business: only `google_calendar_id` (shared calendar email via Calendar Share).
 */
export {
  createCalendarEvent as createEvent,
  createCalendarEvent,
  deleteCalendarEvent,
  updateCalendarEvent,
  lazySyncCalendar,
  syncEventsToCache,
  registerCalendarWatch,
  isBusinessMockMode,
  getGoogleAccessToken,
  invalidateGoogleAccessToken,
} from './googleCalendarService.js';
