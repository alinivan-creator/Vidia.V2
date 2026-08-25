/**
 * Calendar facade — booking flow entry point.
 *
 * Auth: Google Service Account (JWT) from Admin → Setări sistem.
 * Per employee: `google_calendar_id` (shared calendar email via Calendar Share).
 * Service Account is global (Admin → Setări sistem). Business calendar field is deprecated.
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
