-- =============================================================================
-- VIDIA V2 — Initial Database Schema
-- Supabase (PostgreSQL) migration
--
-- Run via: Supabase SQL Editor or `supabase db push`
-- Backend services should use the service_role key (bypasses RLS).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enumerated types
-- ---------------------------------------------------------------------------
CREATE TYPE business_type AS ENUM ('booking', 'consulting');

CREATE TYPE business_status AS ENUM ('active', 'paused');

CREATE TYPE draft_booking_state AS ENUM (
  'browsing',
  'pending_confirmation',
  'confirmed',
  'cancelled',
  'expired'
);

CREATE TYPE calendar_slot_status AS ENUM ('available', 'busy', 'blocked');

CREATE TYPE calendar_slot_source AS ENUM (
  'google_sync',
  'vidia_booking',
  'manual'
);

CREATE TYPE error_severity AS ENUM (
  'debug',
  'info',
  'warning',
  'error',
  'critical'
);

CREATE TYPE error_source AS ENUM (
  'meta_api',
  'google_calendar',
  'ai',
  'webhook',
  'system',
  'database'
);

-- ---------------------------------------------------------------------------
-- Shared trigger: auto-update updated_at
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- businesses
-- Central tenant table. All runtime config lives here — zero hardcoding.
-- ---------------------------------------------------------------------------
CREATE TABLE public.businesses (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity & branding (WhatsApp Business Profile)
  name                        TEXT NOT NULL,
  slug                        TEXT NOT NULL,
  logo_url                    TEXT,
  timezone                    TEXT NOT NULL DEFAULT 'Europe/Bucharest',

  -- Multi-tenancy mode
  business_type               business_type NOT NULL DEFAULT 'booking',
  status                      business_status NOT NULL DEFAULT 'active',

  -- Entry menu (Interaction Tree root)
  welcome_message             TEXT NOT NULL DEFAULT '',
  menu_buttons                JSONB NOT NULL DEFAULT '[]'::JSONB,

  -- Meta WhatsApp Cloud API (encrypt at application layer before storage)
  whatsapp_phone_number_id    TEXT,
  whatsapp_business_account_id TEXT,
  whatsapp_access_token       TEXT,
  whatsapp_webhook_verify_token TEXT,

  -- Google Calendar proxy sync
  google_calendar_id          TEXT,
  google_refresh_token        TEXT,
  google_webhook_channel_id   TEXT,
  google_webhook_resource_id  TEXT,
  google_webhook_expiration   TIMESTAMPTZ,

  -- AI configuration (consulting mode relies heavily on this)
  ai_system_prompt            TEXT NOT NULL DEFAULT '',
  ai_model                    TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  ai_temperature              NUMERIC(3, 2) NOT NULL DEFAULT 0.30
    CHECK (ai_temperature >= 0 AND ai_temperature <= 2),

  -- Booking-mode settings (ignored when business_type = 'consulting')
  booking_settings            JSONB NOT NULL DEFAULT '{}'::JSONB,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT businesses_slug_unique UNIQUE (slug),
  CONSTRAINT businesses_menu_buttons_is_array
    CHECK (jsonb_typeof(menu_buttons) = 'array'),
  CONSTRAINT businesses_booking_settings_is_object
    CHECK (jsonb_typeof(booking_settings) = 'object')
);

COMMENT ON TABLE public.businesses IS
  'Tenant root. Every WhatsApp number, token, prompt and menu button is stored here.';
COMMENT ON COLUMN public.businesses.menu_buttons IS
  'Array of button objects, e.g. [{"id":"book","label":"📅 Programare","action":"start_booking"}]. Max 3 for entry menu.';
COMMENT ON COLUMN public.businesses.booking_settings IS
  'Dynamic booking rules: slot duration, buffer, business hours, services list, etc.';
COMMENT ON COLUMN public.businesses.whatsapp_access_token IS
  'Store encrypted. Decrypt only in backend at runtime.';
COMMENT ON COLUMN public.businesses.google_refresh_token IS
  'Store encrypted. Used for Calendar read/write and webhook renewal.';

CREATE INDEX idx_businesses_status ON public.businesses (status);
CREATE INDEX idx_businesses_type ON public.businesses (business_type);
CREATE INDEX idx_businesses_whatsapp_phone ON public.businesses (whatsapp_phone_number_id)
  WHERE whatsapp_phone_number_id IS NOT NULL;

CREATE TRIGGER trg_businesses_updated_at
  BEFORE UPDATE ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- clients
-- Local CRM — one row per unique phone number per business.
-- ---------------------------------------------------------------------------
CREATE TABLE public.clients (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES public.businesses (id) ON DELETE CASCADE,

  phone_number      TEXT NOT NULL,
  display_name      TEXT,
  email             TEXT,
  notes             TEXT,

  -- Flexible payload for CSV/XLS imports and contact-form captures
  metadata          JSONB NOT NULL DEFAULT '{}'::JSONB,
  import_source     TEXT,

  first_contact_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_contact_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT clients_business_phone_unique UNIQUE (business_id, phone_number),
  CONSTRAINT clients_phone_e164_format
    CHECK (phone_number ~ '^\+[1-9]\d{6,14}$'),
  CONSTRAINT clients_metadata_is_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

COMMENT ON TABLE public.clients IS
  'Per-tenant CRM. Phone is the WhatsApp identity key.';
COMMENT ON COLUMN public.clients.metadata IS
  'Arbitrary fields from imports or AI-collected contact data (company, city, offer interest, etc.).';

CREATE INDEX idx_clients_business_id ON public.clients (business_id);
CREATE INDEX idx_clients_last_contact ON public.clients (business_id, last_contact_at DESC);
CREATE INDEX idx_clients_metadata ON public.clients USING GIN (metadata);

CREATE TRIGGER trg_clients_updated_at
  BEFORE UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- draft_bookings
-- State machine for in-progress and confirmed appointments.
-- AI guides the user; this table owns slot selection and locks.
-- ---------------------------------------------------------------------------
CREATE TABLE public.draft_bookings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           UUID NOT NULL REFERENCES public.businesses (id) ON DELETE CASCADE,
  client_id             UUID REFERENCES public.clients (id) ON DELETE SET NULL,

  phone_number          TEXT NOT NULL,

  state                 draft_booking_state NOT NULL DEFAULT 'browsing',

  -- Selected service / flow context (from WhatsApp Flows or button actions)
  selected_service      JSONB,
  selected_slot_start   TIMESTAMPTZ,
  selected_slot_end     TIMESTAMPTZ,

  -- Soft lock: prevents double-booking while user confirms
  locked_until          TIMESTAMPTZ,

  -- Set after successful Google Calendar write
  google_event_id       TEXT,
  google_event_link     TEXT,

  -- AI conversation state (intent, last question, flow step)
  conversation_context  JSONB NOT NULL DEFAULT '{}'::JSONB,

  expires_at            TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes'),
  confirmed_at            TIMESTAMPTZ,
  cancelled_at            TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT draft_bookings_phone_e164_format
    CHECK (phone_number ~ '^\+[1-9]\d{6,14}$'),
  CONSTRAINT draft_bookings_slot_pair_check
    CHECK (
      (selected_slot_start IS NULL AND selected_slot_end IS NULL)
      OR (selected_slot_start IS NOT NULL AND selected_slot_end IS NOT NULL
          AND selected_slot_end > selected_slot_start)
    ),
  CONSTRAINT draft_bookings_confirmed_requires_event
    CHECK (
      state <> 'confirmed'
      OR google_event_id IS NOT NULL
    ),
  CONSTRAINT draft_bookings_conversation_context_is_object
    CHECK (jsonb_typeof(conversation_context) = 'object')
);

COMMENT ON TABLE public.draft_bookings IS
  'Booking state machine. AI never decides availability — only this table + calendar_cache do.';
COMMENT ON COLUMN public.draft_bookings.locked_until IS
  'Soft lock TTL. While active, the selected slot is reserved for this draft.';
COMMENT ON COLUMN public.draft_bookings.google_event_id IS
  'Required once confirmed. Used for precise cancel/reschedule in Google Calendar.';

CREATE INDEX idx_draft_bookings_business_phone
  ON public.draft_bookings (business_id, phone_number);

CREATE INDEX idx_draft_bookings_active
  ON public.draft_bookings (business_id, phone_number, state)
  WHERE state IN ('browsing', 'pending_confirmation');

CREATE INDEX idx_draft_bookings_expires
  ON public.draft_bookings (expires_at)
  WHERE state IN ('browsing', 'pending_confirmation');

CREATE INDEX idx_draft_bookings_google_event
  ON public.draft_bookings (business_id, google_event_id)
  WHERE google_event_id IS NOT NULL;

CREATE INDEX idx_draft_bookings_slot_lookup
  ON public.draft_bookings (business_id, selected_slot_start, selected_slot_end)
  WHERE state IN ('pending_confirmation', 'confirmed');

-- Only one active draft per phone per business at a time
CREATE UNIQUE INDEX uq_draft_bookings_one_active_per_phone
  ON public.draft_bookings (business_id, phone_number)
  WHERE state IN ('browsing', 'pending_confirmation');

CREATE TRIGGER trg_draft_bookings_updated_at
  BEFORE UPDATE ON public.draft_bookings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- calendar_cache
-- Mirror of Google Calendar availability. Updated via lazy sync + webhooks.
-- ---------------------------------------------------------------------------
CREATE TABLE public.calendar_cache (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES public.businesses (id) ON DELETE CASCADE,

  slot_start        TIMESTAMPTZ NOT NULL,
  slot_end          TIMESTAMPTZ NOT NULL,

  status            calendar_slot_status NOT NULL,
  source            calendar_slot_source NOT NULL DEFAULT 'google_sync',

  google_event_id   TEXT,
  google_event_etag TEXT,

  title             TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}'::JSONB,

  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT calendar_cache_slot_range_check
    CHECK (slot_end > slot_start),
  CONSTRAINT calendar_cache_busy_requires_event
    CHECK (
      status <> 'busy'
      OR google_event_id IS NOT NULL
    ),
  CONSTRAINT calendar_cache_metadata_is_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

COMMENT ON TABLE public.calendar_cache IS
  'Proxy mirror of calendar state. Backend reads this instead of hitting Google on every message.';
COMMENT ON COLUMN public.calendar_cache.google_event_etag IS
  'Used for optimistic concurrency when applying webhook deltas.';

CREATE INDEX idx_calendar_cache_business_range
  ON public.calendar_cache (business_id, slot_start, slot_end);

CREATE INDEX idx_calendar_cache_business_status
  ON public.calendar_cache (business_id, status, slot_start);

CREATE INDEX idx_calendar_cache_google_event
  ON public.calendar_cache (business_id, google_event_id)
  WHERE google_event_id IS NOT NULL;

CREATE INDEX idx_calendar_cache_synced
  ON public.calendar_cache (business_id, synced_at DESC);

-- Prevent duplicate cache rows for the same Google event
CREATE UNIQUE INDEX uq_calendar_cache_google_event
  ON public.calendar_cache (business_id, google_event_id)
  WHERE google_event_id IS NOT NULL;

CREATE TRIGGER trg_calendar_cache_updated_at
  BEFORE UPDATE ON public.calendar_cache
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- error_logs
-- Zero-touch debugging: every failure is persisted for live admin triage.
-- ---------------------------------------------------------------------------
CREATE TABLE public.error_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  business_id     UUID REFERENCES public.businesses (id) ON DELETE SET NULL,

  severity        error_severity NOT NULL DEFAULT 'error',
  source          error_source NOT NULL,

  message         TEXT NOT NULL,
  details         JSONB NOT NULL DEFAULT '{}'::JSONB,

  -- Correlation helpers
  request_id      TEXT,
  phone_number    TEXT,
  draft_booking_id UUID REFERENCES public.draft_bookings (id) ON DELETE SET NULL,

  http_status     INTEGER,
  resolved        BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at     TIMESTAMPTZ,
  resolved_note   TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT error_logs_details_is_object
    CHECK (jsonb_typeof(details) = 'object')
);

COMMENT ON TABLE public.error_logs IS
  'Structured error stream for live debugging from the admin dashboard.';
COMMENT ON COLUMN public.error_logs.details IS
  'Full context: stack trace, Meta/Google API response body, payload snapshots, etc.';

CREATE INDEX idx_error_logs_business_created
  ON public.error_logs (business_id, created_at DESC);

CREATE INDEX idx_error_logs_unresolved
  ON public.error_logs (business_id, created_at DESC)
  WHERE resolved = FALSE;

CREATE INDEX idx_error_logs_severity
  ON public.error_logs (severity, created_at DESC);

CREATE INDEX idx_error_logs_source
  ON public.error_logs (source, created_at DESC);

CREATE INDEX idx_error_logs_request_id
  ON public.error_logs (request_id)
  WHERE request_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- Enabled on all tables. Backend (service_role) bypasses RLS automatically.
-- Add admin policies once Supabase Auth is wired to the dashboard.
-- ---------------------------------------------------------------------------
ALTER TABLE public.businesses      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_bookings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_cache  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.error_logs      ENABLE ROW LEVEL SECURITY;

-- Service-role-only default: no policies for anon/authenticated yet.
-- This blocks public access until explicit admin policies are added.

-- ---------------------------------------------------------------------------
-- Helper: expire stale draft bookings (call from a Supabase cron job)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expire_stale_draft_bookings()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected INTEGER;
BEGIN
  UPDATE public.draft_bookings
  SET
    state = 'expired',
    locked_until = NULL,
    updated_at = NOW()
  WHERE
    state IN ('browsing', 'pending_confirmation')
    AND expires_at < NOW();

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

COMMENT ON FUNCTION public.expire_stale_draft_bookings IS
  'Run periodically (e.g. every 5 min via pg_cron) to release expired soft locks.';
