-- =============================================================================
-- VIDIA V2 — Multi-employee calendars + SMS marketing opt-in
-- =============================================================================

-- ---------------------------------------------------------------------------
-- employees — one Google Calendar per staff member (Calendar Share)
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

-- ---------------------------------------------------------------------------
-- draft_bookings.employee_id
-- ---------------------------------------------------------------------------
ALTER TABLE public.draft_bookings
  ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES public.employees (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_draft_bookings_employee
  ON public.draft_bookings (business_id, employee_id)
  WHERE employee_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- calendar_cache.employee_id — scope busy slots per staff calendar
-- (external widgets on the same shared calendar stay conflict-free via Google sync)
-- ---------------------------------------------------------------------------
ALTER TABLE public.calendar_cache
  ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES public.employees (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_calendar_cache_employee_range
  ON public.calendar_cache (business_id, employee_id, slot_start, slot_end);

-- ---------------------------------------------------------------------------
-- clients SMS marketing opt-in (explicit consent required)
-- ---------------------------------------------------------------------------
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS sms_opt_in BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS sms_opt_in_at TIMESTAMPTZ;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS sms_opt_out_at TIMESTAMPTZ;

COMMENT ON COLUMN public.clients.sms_opt_in IS
  'True only after explicit marketing SMS consent. Required for campaigns.';

-- ---------------------------------------------------------------------------
-- sms_campaigns — audit log for Twilio SMS blasts
-- ---------------------------------------------------------------------------
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

NOTIFY pgrst, 'reload schema';
