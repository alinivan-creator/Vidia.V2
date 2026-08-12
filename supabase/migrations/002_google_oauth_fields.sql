-- =============================================================================
-- VIDIA V2 — Google Calendar OAuth fields per business
-- =============================================================================

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS google_client_id TEXT,
  ADD COLUMN IF NOT EXISTS google_client_secret TEXT,
  ADD COLUMN IF NOT EXISTS google_calendar_mock_mode BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.businesses.google_client_id IS
  'OAuth2 Client ID (apps.googleusercontent.com). Per-tenant override.';
COMMENT ON COLUMN public.businesses.google_client_secret IS
  'OAuth2 Client Secret. Store encrypted at application layer.';
COMMENT ON COLUMN public.businesses.google_calendar_mock_mode IS
  'When true, bookings write to calendar_cache only (no Google API).';
