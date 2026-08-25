import { env } from './env.js';

/**
 * Google Calendar — Service Account only (Calendar Share).
 * Credentials: system_settings.google_master in Supabase (Admin → Setări sistem).
 * Per business: google_calendar_id on each employee (Calendar Share with Service Account).
 * businesses.google_calendar_id is deprecated / unused.
 */
export const googleEnv = {
  /** Public base URL for push webhook, e.g. https://vidia.vercel.app */
  webhookBaseUrl: env.publicBaseUrl,
};

export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
