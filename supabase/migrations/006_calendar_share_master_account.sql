-- =============================================================================
-- VIDIA V2 — Calendar Share + Master Account
--
-- Per-business OAuth (client_id / client_secret / refresh_token) is removed.
-- Auth is a single master identity in the app .env (Service Account or master
-- refresh token). Each business only stores google_calendar_id = shared email.
-- =============================================================================

COMMENT ON COLUMN public.businesses.google_calendar_id IS
  'Shared Google Calendar id/email (e.g. salonulmeu@gmail.com) that granted edit access to the Vidia master account / service account.';

ALTER TABLE public.businesses DROP COLUMN IF EXISTS google_client_id;
ALTER TABLE public.businesses DROP COLUMN IF EXISTS google_client_secret;
ALTER TABLE public.businesses DROP COLUMN IF EXISTS google_refresh_token;
