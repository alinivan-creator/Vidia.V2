-- =============================================================================
-- VIDIA V2 — SAFE REAPPLY ALL (idempotent)
--
-- Rulează ÎNTREG acest fișier o singură dată în Supabase SQL Editor → Run.
-- Poți rula de câte ori vrei: ce există deja e sărit, ce lipsește se creează.
-- NU șterge datele existente (businesses, clienți, programări).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums (safe)
-- ---------------------------------------------------------------------------
DO $$ BEGIN CREATE TYPE business_type AS ENUM ('booking', 'consulting');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE business_status AS ENUM ('active', 'paused');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE draft_booking_state AS ENUM (
  'browsing', 'pending_confirmation', 'confirmed', 'cancelled', 'expired'
);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE calendar_slot_status AS ENUM ('available', 'busy', 'blocked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE calendar_slot_source AS ENUM ('google_sync', 'vidia_booking', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE error_severity AS ENUM ('debug', 'info', 'warning', 'error', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE error_source AS ENUM (
  'meta_api', 'google_calendar', 'ai', 'webhook', 'system', 'database'
);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Core tables (001)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.businesses (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        TEXT NOT NULL,
  slug                        TEXT NOT NULL,
  logo_url                    TEXT,
  timezone                    TEXT NOT NULL DEFAULT 'Europe/Bucharest',
  business_type               business_type NOT NULL DEFAULT 'booking',
  status                      business_status NOT NULL DEFAULT 'active',
  welcome_message             TEXT NOT NULL DEFAULT '',
  menu_buttons                JSONB NOT NULL DEFAULT '[]'::JSONB,
  whatsapp_phone_number_id    TEXT,
  whatsapp_business_account_id TEXT,
  whatsapp_access_token       TEXT,
  whatsapp_webhook_verify_token TEXT,
  google_calendar_id          TEXT,
  google_webhook_channel_id   TEXT,
  google_webhook_resource_id  TEXT,
  google_webhook_expiration   TIMESTAMPTZ,
  ai_system_prompt            TEXT NOT NULL DEFAULT '',
  ai_model                    TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  ai_temperature              NUMERIC(3, 2) NOT NULL DEFAULT 0.30
    CHECK (ai_temperature >= 0 AND ai_temperature <= 2),
  booking_settings            JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT businesses_slug_unique UNIQUE (slug),
  CONSTRAINT businesses_menu_buttons_is_array
    CHECK (jsonb_typeof(menu_buttons) = 'array'),
  CONSTRAINT businesses_booking_settings_is_object
    CHECK (jsonb_typeof(booking_settings) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_businesses_status ON public.businesses (status);
CREATE INDEX IF NOT EXISTS idx_businesses_type ON public.businesses (business_type);
CREATE INDEX IF NOT EXISTS idx_businesses_whatsapp_phone ON public.businesses (whatsapp_phone_number_id)
  WHERE whatsapp_phone_number_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_businesses_updated_at ON public.businesses;
CREATE TRIGGER trg_businesses_updated_at
  BEFORE UPDATE ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.clients (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES public.businesses (id) ON DELETE CASCADE,
  phone_number      TEXT NOT NULL,
  display_name      TEXT,
  email             TEXT,
  notes             TEXT,
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

CREATE INDEX IF NOT EXISTS idx_clients_business_id ON public.clients (business_id);
CREATE INDEX IF NOT EXISTS idx_clients_last_contact ON public.clients (business_id, last_contact_at DESC);
CREATE INDEX IF NOT EXISTS idx_clients_metadata ON public.clients USING GIN (metadata);

DROP TRIGGER IF EXISTS trg_clients_updated_at ON public.clients;
CREATE TRIGGER trg_clients_updated_at
  BEFORE UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.draft_bookings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           UUID NOT NULL REFERENCES public.businesses (id) ON DELETE CASCADE,
  client_id             UUID REFERENCES public.clients (id) ON DELETE SET NULL,
  phone_number          TEXT NOT NULL,
  state                 draft_booking_state NOT NULL DEFAULT 'browsing',
  selected_service      JSONB,
  selected_slot_start   TIMESTAMPTZ,
  selected_slot_end     TIMESTAMPTZ,
  locked_until          TIMESTAMPTZ,
  google_event_id       TEXT,
  google_event_link     TEXT,
  conversation_context  JSONB NOT NULL DEFAULT '{}'::JSONB,
  expires_at            TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes'),
  confirmed_at          TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
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
    CHECK (state <> 'confirmed' OR google_event_id IS NOT NULL),
  CONSTRAINT draft_bookings_conversation_context_is_object
    CHECK (jsonb_typeof(conversation_context) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_draft_bookings_business_phone
  ON public.draft_bookings (business_id, phone_number);
CREATE INDEX IF NOT EXISTS idx_draft_bookings_active
  ON public.draft_bookings (business_id, phone_number, state)
  WHERE state IN ('browsing', 'pending_confirmation');
CREATE INDEX IF NOT EXISTS idx_draft_bookings_expires
  ON public.draft_bookings (expires_at)
  WHERE state IN ('browsing', 'pending_confirmation');

ALTER TABLE public.draft_bookings
  ADD COLUMN IF NOT EXISTS pending_expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_draft_bookings_google_event
  ON public.draft_bookings (business_id, google_event_id)
  WHERE google_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_draft_bookings_slot_lookup
  ON public.draft_bookings (business_id, selected_slot_start, selected_slot_end)
  WHERE state IN ('pending_confirmation', 'confirmed');
CREATE UNIQUE INDEX IF NOT EXISTS uq_draft_bookings_one_active_per_phone
  ON public.draft_bookings (business_id, phone_number)
  WHERE state IN ('browsing', 'pending_confirmation');

DROP TRIGGER IF EXISTS trg_draft_bookings_updated_at ON public.draft_bookings;
CREATE TRIGGER trg_draft_bookings_updated_at
  BEFORE UPDATE ON public.draft_bookings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.calendar_cache (
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
  CONSTRAINT calendar_cache_slot_range_check CHECK (slot_end > slot_start),
  CONSTRAINT calendar_cache_busy_requires_event
    CHECK (status <> 'busy' OR google_event_id IS NOT NULL),
  CONSTRAINT calendar_cache_metadata_is_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_calendar_cache_business_range
  ON public.calendar_cache (business_id, slot_start, slot_end);
CREATE INDEX IF NOT EXISTS idx_calendar_cache_business_status
  ON public.calendar_cache (business_id, status, slot_start);
CREATE INDEX IF NOT EXISTS idx_calendar_cache_google_event
  ON public.calendar_cache (business_id, google_event_id)
  WHERE google_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calendar_cache_synced
  ON public.calendar_cache (business_id, synced_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_calendar_cache_google_event
  ON public.calendar_cache (business_id, google_event_id)
  WHERE google_event_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_calendar_cache_updated_at ON public.calendar_cache;
CREATE TRIGGER trg_calendar_cache_updated_at
  BEFORE UPDATE ON public.calendar_cache
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.error_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID REFERENCES public.businesses (id) ON DELETE SET NULL,
  severity        error_severity NOT NULL DEFAULT 'error',
  source          error_source NOT NULL,
  message         TEXT NOT NULL,
  details         JSONB NOT NULL DEFAULT '{}'::JSONB,
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

CREATE INDEX IF NOT EXISTS idx_error_logs_business_created
  ON public.error_logs (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_unresolved
  ON public.error_logs (business_id, created_at DESC)
  WHERE resolved = FALSE;
CREATE INDEX IF NOT EXISTS idx_error_logs_severity
  ON public.error_logs (severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_source
  ON public.error_logs (source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_request_id
  ON public.error_logs (request_id)
  WHERE request_id IS NOT NULL;

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
  SET state = 'expired', locked_until = NULL, pending_expires_at = NULL, updated_at = NOW()
  WHERE
    (state IN ('browsing', 'pending_confirmation') AND expires_at < NOW())
    OR (state = 'pending_confirmation' AND pending_expires_at IS NOT NULL AND pending_expires_at < NOW());
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

-- ---------------------------------------------------------------------------
-- Google Calendar Share + Twilio columns (003 + 006)
-- Master Google auth lives in app .env — businesses only store calendar id.
-- ---------------------------------------------------------------------------
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS google_calendar_mock_mode BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS twilio_account_sid TEXT,
  ADD COLUMN IF NOT EXISTS twilio_auth_token TEXT,
  ADD COLUMN IF NOT EXISTS owner_user_id UUID;

ALTER TABLE public.businesses DROP COLUMN IF EXISTS google_client_id;
ALTER TABLE public.businesses DROP COLUMN IF EXISTS google_client_secret;
ALTER TABLE public.businesses DROP COLUMN IF EXISTS google_refresh_token;

COMMENT ON COLUMN public.businesses.google_calendar_id IS
  'Shared Google Calendar id/email granted to the Vidia master account / service account.';

-- ---------------------------------------------------------------------------
-- services (003)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.services (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES public.businesses (id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  slug              TEXT,
  price_ron         NUMERIC(10, 2),
  duration_minutes  INTEGER NOT NULL DEFAULT 30
    CHECK (duration_minutes > 0 AND duration_minutes <= 24 * 60),
  sort_order        INTEGER NOT NULL DEFAULT 0,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_services_business
  ON public.services (business_id, sort_order, name);
CREATE INDEX IF NOT EXISTS idx_services_business_active
  ON public.services (business_id)
  WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS trg_services_updated_at ON public.services;
CREATE TRIGGER trg_services_updated_at
  BEFORE UPDATE ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Backfill services from JSON (only if business has none yet)
INSERT INTO public.services (business_id, name, slug, price_ron, duration_minutes, sort_order)
SELECT
  b.id,
  COALESCE(svc->>'name', 'Serviciu'),
  NULLIF(COALESCE(svc->>'id', svc->>'slug'), ''),
  NULLIF(svc->>'price_ron', '')::NUMERIC,
  COALESCE(NULLIF(svc->>'duration_minutes', '')::INTEGER, 30),
  ord.ordinality::INTEGER - 1
FROM public.businesses b
CROSS JOIN LATERAL jsonb_array_elements(
  CASE
    WHEN jsonb_typeof(b.booking_settings->'services') = 'array'
      THEN b.booking_settings->'services'
    ELSE '[]'::JSONB
  END
) WITH ORDINALITY AS ord(svc, ordinality)
WHERE NOT EXISTS (
  SELECT 1 FROM public.services s WHERE s.business_id = b.id
);

-- ---------------------------------------------------------------------------
-- conversation_states (005)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversation_states (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES public.businesses (id) ON DELETE CASCADE,
  client_phone    TEXT NOT NULL,
  current_step    TEXT NOT NULL DEFAULT 'IDLE',
  context_data    JSONB NOT NULL DEFAULT '{}'::JSONB,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT conversation_states_phone_e164
    CHECK (client_phone ~ '^\+[1-9]\d{6,14}$'),
  CONSTRAINT conversation_states_context_object
    CHECK (jsonb_typeof(context_data) = 'object'),
  CONSTRAINT conversation_states_step_not_empty
    CHECK (char_length(trim(current_step)) > 0),
  CONSTRAINT conversation_states_business_phone_unique
    UNIQUE (business_id, client_phone)
);

CREATE INDEX IF NOT EXISTS idx_conversation_states_business_phone
  ON public.conversation_states (business_id, client_phone);
CREATE INDEX IF NOT EXISTS idx_conversation_states_step
  ON public.conversation_states (business_id, current_step)
  WHERE current_step <> 'IDLE';

DROP TRIGGER IF EXISTS trg_conversation_states_updated_at ON public.conversation_states;
CREATE TRIGGER trg_conversation_states_updated_at
  BEFORE UPDATE ON public.conversation_states
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_businesses_owner_user
  ON public.businesses (owner_user_id)
  WHERE owner_user_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'auth' AND table_name = 'users'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'businesses_owner_user_id_fkey'
  ) THEN
    ALTER TABLE public.businesses
      ADD CONSTRAINT businesses_owner_user_id_fkey
      FOREIGN KEY (owner_user_id) REFERENCES auth.users (id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- RLS helpers + policies (004 + 005)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_business_owner(p_business_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.businesses b
    WHERE b.id = p_business_id
      AND b.owner_user_id IS NOT NULL
      AND b.owner_user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.current_owned_business_ids()
RETURNS SETOF UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT b.id FROM public.businesses b
  WHERE b.owner_user_id IS NOT NULL AND b.owner_user_id = auth.uid();
$$;

ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.error_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_states ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.businesses FORCE ROW LEVEL SECURITY;
ALTER TABLE public.clients FORCE ROW LEVEL SECURITY;
ALTER TABLE public.draft_bookings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_cache FORCE ROW LEVEL SECURITY;
ALTER TABLE public.error_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.services FORCE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_states FORCE ROW LEVEL SECURITY;

-- Drop legacy / recreate owner policies
DROP POLICY IF EXISTS services_service_role_all ON public.services;

DROP POLICY IF EXISTS businesses_owner_select ON public.businesses;
DROP POLICY IF EXISTS businesses_owner_insert ON public.businesses;
DROP POLICY IF EXISTS businesses_owner_update ON public.businesses;
DROP POLICY IF EXISTS businesses_owner_delete ON public.businesses;
CREATE POLICY businesses_owner_select ON public.businesses FOR SELECT TO authenticated
  USING (owner_user_id IS NOT NULL AND owner_user_id = auth.uid());
CREATE POLICY businesses_owner_insert ON public.businesses FOR INSERT TO authenticated
  WITH CHECK (owner_user_id IS NOT NULL AND owner_user_id = auth.uid());
CREATE POLICY businesses_owner_update ON public.businesses FOR UPDATE TO authenticated
  USING (owner_user_id IS NOT NULL AND owner_user_id = auth.uid())
  WITH CHECK (owner_user_id IS NOT NULL AND owner_user_id = auth.uid());
CREATE POLICY businesses_owner_delete ON public.businesses FOR DELETE TO authenticated
  USING (owner_user_id IS NOT NULL AND owner_user_id = auth.uid());

DROP POLICY IF EXISTS services_owner_select ON public.services;
DROP POLICY IF EXISTS services_owner_insert ON public.services;
DROP POLICY IF EXISTS services_owner_update ON public.services;
DROP POLICY IF EXISTS services_owner_delete ON public.services;
CREATE POLICY services_owner_select ON public.services FOR SELECT TO authenticated
  USING (public.is_business_owner(business_id));
CREATE POLICY services_owner_insert ON public.services FOR INSERT TO authenticated
  WITH CHECK (public.is_business_owner(business_id));
CREATE POLICY services_owner_update ON public.services FOR UPDATE TO authenticated
  USING (public.is_business_owner(business_id))
  WITH CHECK (public.is_business_owner(business_id));
CREATE POLICY services_owner_delete ON public.services FOR DELETE TO authenticated
  USING (public.is_business_owner(business_id));

DROP POLICY IF EXISTS clients_owner_select ON public.clients;
DROP POLICY IF EXISTS clients_owner_insert ON public.clients;
DROP POLICY IF EXISTS clients_owner_update ON public.clients;
DROP POLICY IF EXISTS clients_owner_delete ON public.clients;
CREATE POLICY clients_owner_select ON public.clients FOR SELECT TO authenticated
  USING (public.is_business_owner(business_id));
CREATE POLICY clients_owner_insert ON public.clients FOR INSERT TO authenticated
  WITH CHECK (public.is_business_owner(business_id));
CREATE POLICY clients_owner_update ON public.clients FOR UPDATE TO authenticated
  USING (public.is_business_owner(business_id))
  WITH CHECK (public.is_business_owner(business_id));
CREATE POLICY clients_owner_delete ON public.clients FOR DELETE TO authenticated
  USING (public.is_business_owner(business_id));

DROP POLICY IF EXISTS draft_bookings_owner_select ON public.draft_bookings;
DROP POLICY IF EXISTS draft_bookings_owner_insert ON public.draft_bookings;
DROP POLICY IF EXISTS draft_bookings_owner_update ON public.draft_bookings;
DROP POLICY IF EXISTS draft_bookings_owner_delete ON public.draft_bookings;
CREATE POLICY draft_bookings_owner_select ON public.draft_bookings FOR SELECT TO authenticated
  USING (public.is_business_owner(business_id));
CREATE POLICY draft_bookings_owner_insert ON public.draft_bookings FOR INSERT TO authenticated
  WITH CHECK (public.is_business_owner(business_id));
CREATE POLICY draft_bookings_owner_update ON public.draft_bookings FOR UPDATE TO authenticated
  USING (public.is_business_owner(business_id))
  WITH CHECK (public.is_business_owner(business_id));
CREATE POLICY draft_bookings_owner_delete ON public.draft_bookings FOR DELETE TO authenticated
  USING (public.is_business_owner(business_id));

DROP POLICY IF EXISTS calendar_cache_owner_select ON public.calendar_cache;
DROP POLICY IF EXISTS calendar_cache_owner_insert ON public.calendar_cache;
DROP POLICY IF EXISTS calendar_cache_owner_update ON public.calendar_cache;
DROP POLICY IF EXISTS calendar_cache_owner_delete ON public.calendar_cache;
CREATE POLICY calendar_cache_owner_select ON public.calendar_cache FOR SELECT TO authenticated
  USING (public.is_business_owner(business_id));
CREATE POLICY calendar_cache_owner_insert ON public.calendar_cache FOR INSERT TO authenticated
  WITH CHECK (public.is_business_owner(business_id));
CREATE POLICY calendar_cache_owner_update ON public.calendar_cache FOR UPDATE TO authenticated
  USING (public.is_business_owner(business_id))
  WITH CHECK (public.is_business_owner(business_id));
CREATE POLICY calendar_cache_owner_delete ON public.calendar_cache FOR DELETE TO authenticated
  USING (public.is_business_owner(business_id));

DROP POLICY IF EXISTS error_logs_owner_select ON public.error_logs;
DROP POLICY IF EXISTS error_logs_owner_update ON public.error_logs;
CREATE POLICY error_logs_owner_select ON public.error_logs FOR SELECT TO authenticated
  USING (business_id IS NOT NULL AND public.is_business_owner(business_id));
CREATE POLICY error_logs_owner_update ON public.error_logs FOR UPDATE TO authenticated
  USING (business_id IS NOT NULL AND public.is_business_owner(business_id))
  WITH CHECK (business_id IS NOT NULL AND public.is_business_owner(business_id));

DROP POLICY IF EXISTS conversation_states_owner_select ON public.conversation_states;
DROP POLICY IF EXISTS conversation_states_owner_insert ON public.conversation_states;
DROP POLICY IF EXISTS conversation_states_owner_update ON public.conversation_states;
DROP POLICY IF EXISTS conversation_states_owner_delete ON public.conversation_states;
CREATE POLICY conversation_states_owner_select ON public.conversation_states FOR SELECT TO authenticated
  USING (public.is_business_owner(business_id));
CREATE POLICY conversation_states_owner_insert ON public.conversation_states FOR INSERT TO authenticated
  WITH CHECK (public.is_business_owner(business_id));
CREATE POLICY conversation_states_owner_update ON public.conversation_states FOR UPDATE TO authenticated
  USING (public.is_business_owner(business_id))
  WITH CHECK (public.is_business_owner(business_id));
CREATE POLICY conversation_states_owner_delete ON public.conversation_states FOR DELETE TO authenticated
  USING (public.is_business_owner(business_id));

REVOKE ALL ON TABLE public.businesses FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.services FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.clients FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.draft_bookings FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.calendar_cache FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.error_logs FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.conversation_states FROM PUBLIC, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.businesses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.services TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.clients TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.draft_bookings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.calendar_cache TO authenticated;
GRANT SELECT, UPDATE ON TABLE public.error_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.conversation_states TO authenticated;

CREATE OR REPLACE VIEW public.appointments WITH (security_invoker = true) AS
SELECT * FROM public.draft_bookings;
CREATE OR REPLACE VIEW public.leads WITH (security_invoker = true) AS
SELECT * FROM public.clients;
GRANT SELECT ON public.appointments TO authenticated;
GRANT SELECT ON public.leads TO authenticated;
REVOKE ALL ON public.appointments FROM PUBLIC, anon;
REVOKE ALL ON public.leads FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- system_settings (007) — Super-Admin Master Google credentials
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.system_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL DEFAULT '{}'::JSONB,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT system_settings_value_object
    CHECK (jsonb_typeof(value) = 'object')
);

DROP TRIGGER IF EXISTS trg_system_settings_updated_at ON public.system_settings;
CREATE TRIGGER trg_system_settings_updated_at
  BEFORE UPDATE ON public.system_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_settings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.system_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.system_settings TO service_role;

INSERT INTO public.system_settings (key, value)
VALUES ('google_master', '{}'::JSONB)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 008 — callback_requests (AI out-of-scope → human team)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.callback_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES public.businesses (id) ON DELETE CASCADE,
  client_id       UUID REFERENCES public.clients (id) ON DELETE SET NULL,
  phone_number    TEXT NOT NULL,
  message         TEXT NOT NULL,
  reason          TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'contacted', 'closed')),
  request_id      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,
  CONSTRAINT callback_requests_phone_e164
    CHECK (phone_number ~ '^\+[1-9]\d{6,14}$')
);

CREATE INDEX IF NOT EXISTS idx_callback_requests_business_status
  ON public.callback_requests (business_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_callback_requests_phone
  ON public.callback_requests (business_id, phone_number);

DROP TRIGGER IF EXISTS trg_callback_requests_updated_at ON public.callback_requests;
CREATE TRIGGER trg_callback_requests_updated_at
  BEFORE UPDATE ON public.callback_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.callback_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.callback_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.callback_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.callback_requests TO service_role;

-- ---------------------------------------------------------------------------
-- 010 / 012 — employees (Admin staff + per-person Google calendars)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.employees (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL REFERENCES public.businesses (id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  google_calendar_id  TEXT,
  active              BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order          INT NOT NULL DEFAULT 0,
  metadata            JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT employees_name_not_empty CHECK (char_length(trim(name)) > 0),
  CONSTRAINT employees_metadata_is_object CHECK (jsonb_typeof(metadata) = 'object')
);

COMMENT ON TABLE public.employees IS
  'Staff members with optional dedicated Google calendars (shared with Vidia SA).';
COMMENT ON COLUMN public.employees.google_calendar_id IS
  'Google Calendar ID / email (product language: calendar_id).';
COMMENT ON COLUMN public.employees.active IS
  'Whether the employee is bookable (product language: is_active).';

CREATE INDEX IF NOT EXISTS idx_employees_business_active
  ON public.employees (business_id, active, sort_order);

DROP TRIGGER IF EXISTS trg_employees_updated_at ON public.employees;
CREATE TRIGGER trg_employees_updated_at
  BEFORE UPDATE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employees FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.employees FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.employees TO service_role;

ALTER TABLE public.draft_bookings
  ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES public.employees (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_draft_bookings_employee
  ON public.draft_bookings (business_id, employee_id)
  WHERE employee_id IS NOT NULL;

ALTER TABLE public.calendar_cache
  ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES public.employees (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_calendar_cache_employee_range
  ON public.calendar_cache (business_id, employee_id, slot_start, slot_end);

-- ---------------------------------------------------------------------------
-- 010 — SMS marketing (tables expected by the final check below)
-- ---------------------------------------------------------------------------
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS sms_opt_in BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS sms_opt_in_at TIMESTAMPTZ;
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS sms_opt_out_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.sms_campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES public.businesses (id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'sending', 'completed', 'failed')),
  target_count    INT NOT NULL DEFAULT 0,
  sent_count      INT NOT NULL DEFAULT 0,
  failed_count    INT NOT NULL DEFAULT 0,
  created_by      TEXT,
  details         JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.sms_campaign_sends (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     UUID NOT NULL REFERENCES public.sms_campaigns (id) ON DELETE CASCADE,
  client_id       UUID REFERENCES public.clients (id) ON DELETE SET NULL,
  phone_number    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  twilio_sid      TEXT,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_campaigns_business
  ON public.sms_campaigns (business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sms_campaign_sends_campaign
  ON public.sms_campaign_sends (campaign_id, status);

ALTER TABLE public.sms_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_campaigns FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sms_campaign_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_campaign_sends FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sms_campaigns FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.sms_campaign_sends FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.sms_campaigns TO service_role;
GRANT ALL ON TABLE public.sms_campaign_sends TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_postgrest_schema()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM pg_notify('pgrst', 'reload schema');
  RETURN 'reloaded';
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_postgrest_schema() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_postgrest_schema() TO service_role;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- 014 — atomic slot claim (race-safe double booking)
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE public.draft_bookings
  ADD COLUMN IF NOT EXISTS slot_lock_key UUID
  GENERATED ALWAYS AS (
    COALESCE(employee_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_draft_bookings_slot_lock_key
  ON public.draft_bookings (business_id, slot_lock_key, selected_slot_start)
  WHERE selected_slot_start IS NOT NULL
    AND state IN ('pending_confirmation', 'confirmed');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'draft_bookings_no_overlapping_slots'
  ) THEN
    ALTER TABLE public.draft_bookings
      ADD CONSTRAINT draft_bookings_no_overlapping_slots
      EXCLUDE USING gist (
        business_id WITH =,
        slot_lock_key WITH =,
        tstzrange(selected_slot_start, selected_slot_end, '[)') WITH &&
      )
      WHERE (
        selected_slot_start IS NOT NULL
        AND selected_slot_end IS NOT NULL
        AND state IN ('pending_confirmation', 'confirmed')
      );
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN others THEN
    RAISE NOTICE 'draft_bookings_no_overlapping_slots skipped: %', SQLERRM;
END $$;

CREATE OR REPLACE FUNCTION public.claim_booking_slot(
  p_draft_id uuid,
  p_business_id uuid,
  p_slot_start timestamptz,
  p_slot_end timestamptz,
  p_ttl_minutes integer DEFAULT 5,
  p_context jsonb DEFAULT '{}'::jsonb,
  p_employee_id uuid DEFAULT NULL,
  p_mode text DEFAULT 'hold'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp uuid;
  v_ttl timestamptz;
  v_minutes integer;
  v_row public.draft_bookings%ROWTYPE;
  v_conflict uuid;
BEGIN
  IF p_draft_id IS NULL OR p_business_id IS NULL
     OR p_slot_start IS NULL OR p_slot_end IS NULL
     OR p_slot_end <= p_slot_start THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_range');
  END IF;

  v_minutes := GREATEST(1, LEAST(60, COALESCE(p_ttl_minutes, 5)));
  v_ttl := NOW() + (v_minutes || ' minutes')::interval;

  PERFORM pg_advisory_xact_lock(
    hashtext(p_business_id::text),
    hashtext(p_slot_start::text)
  );

  UPDATE public.draft_bookings
  SET
    state = 'expired',
    locked_until = NULL,
    pending_expires_at = NULL,
    updated_at = NOW()
  WHERE business_id = p_business_id
    AND state = 'pending_confirmation'
    AND (locked_until IS NULL OR locked_until <= NOW());

  SELECT employee_id INTO v_emp
  FROM public.draft_bookings
  WHERE id = p_draft_id AND business_id = p_business_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  v_emp := COALESCE(p_employee_id, v_emp);

  SELECT d.id INTO v_conflict
  FROM public.draft_bookings d
  WHERE d.business_id = p_business_id
    AND d.id <> p_draft_id
    AND d.selected_slot_start IS NOT NULL
    AND d.selected_slot_end IS NOT NULL
    AND d.state IN ('pending_confirmation', 'confirmed')
    AND tstzrange(d.selected_slot_start, d.selected_slot_end, '[)')
        && tstzrange(p_slot_start, p_slot_end, '[)')
    AND COALESCE(d.employee_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = COALESCE(v_emp, '00000000-0000-0000-0000-000000000000'::uuid)
    AND (
      d.state = 'confirmed'
      OR (d.state = 'pending_confirmation' AND d.locked_until IS NOT NULL AND d.locked_until > NOW())
    )
  LIMIT 1;

  IF v_conflict IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'slot_taken');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.calendar_cache c
    WHERE c.business_id = p_business_id
      AND c.status IN ('busy', 'blocked')
      AND tstzrange(c.slot_start, c.slot_end, '[)')
          && tstzrange(p_slot_start, p_slot_end, '[)')
      AND (
        (v_emp IS NULL AND c.employee_id IS NULL)
        OR (v_emp IS NOT NULL AND c.employee_id = v_emp)
      )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'slot_taken');
  END IF;

  IF p_mode = 'reschedule' THEN
    UPDATE public.draft_bookings
    SET
      selected_slot_start = p_slot_start,
      selected_slot_end = p_slot_end,
      conversation_context = COALESCE(p_context, conversation_context),
      updated_at = NOW()
    WHERE id = p_draft_id
      AND business_id = p_business_id
      AND state = 'confirmed'
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.draft_bookings
    SET
      state = 'pending_confirmation',
      selected_slot_start = p_slot_start,
      selected_slot_end = p_slot_end,
      locked_until = v_ttl,
      pending_expires_at = v_ttl,
      conversation_context = COALESCE(p_context, '{}'::jsonb),
      expires_at = NOW() + INTERVAL '30 minutes',
      employee_id = COALESCE(v_emp, employee_id),
      updated_at = NOW()
    WHERE id = p_draft_id
      AND business_id = p_business_id
    RETURNING * INTO v_row;
  END IF;

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  RETURN jsonb_build_object('ok', true, 'reason', NULL, 'draft', to_jsonb(v_row));
EXCEPTION
  WHEN exclusion_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'slot_taken');
  WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'slot_taken');
END;
$$;

REVOKE ALL ON FUNCTION public.claim_booking_slot(uuid, uuid, timestamptz, timestamptz, integer, jsonb, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_booking_slot(uuid, uuid, timestamptz, timestamptz, integer, jsonb, uuid, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Verificare finală — ar trebui să vezi "OK" la toate
-- ---------------------------------------------------------------------------
SELECT
  t.tbl AS table_name,
  CASE WHEN to_regclass('public.' || t.tbl) IS NOT NULL THEN 'OK' ELSE 'MISSING' END AS status
FROM (VALUES
  ('businesses'),
  ('clients'),
  ('draft_bookings'),
  ('calendar_cache'),
  ('error_logs'),
  ('services'),
  ('conversation_states'),
  ('system_settings'),
  ('callback_requests'),
  ('employees'),
  ('sms_campaigns'),
  ('sms_campaign_sends')
) AS t(tbl)

UNION ALL

SELECT
  'col:' || c.col,
  CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'businesses' AND column_name = c.col
  ) THEN 'OK' ELSE 'MISSING' END
FROM (VALUES
  ('google_calendar_id'),
  ('google_calendar_mock_mode'),
  ('twilio_account_sid'),
  ('twilio_auth_token'),
  ('owner_user_id')
) AS c(col)

ORDER BY 1;
