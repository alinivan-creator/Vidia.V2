-- =============================================================================
-- VIDIA V2 — Services catalog table + Twilio & Google OAuth columns
-- =============================================================================

-- Google OAuth (also in 002 — safe IF NOT EXISTS)
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS google_client_id TEXT,
  ADD COLUMN IF NOT EXISTS google_client_secret TEXT,
  ADD COLUMN IF NOT EXISTS google_calendar_mock_mode BOOLEAN NOT NULL DEFAULT TRUE;

-- Twilio credentials per business (optional; fallback to .env)
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS twilio_account_sid TEXT,
  ADD COLUMN IF NOT EXISTS twilio_auth_token TEXT;

COMMENT ON COLUMN public.businesses.twilio_account_sid IS
  'Optional per-tenant Twilio Account SID. Falls back to TWILIO_ACCOUNT_SID.';
COMMENT ON COLUMN public.businesses.twilio_auth_token IS
  'Optional per-tenant Twilio Auth Token. Falls back to TWILIO_AUTH_TOKEN.';

-- ---------------------------------------------------------------------------
-- services — dedicated catalog per business
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

COMMENT ON TABLE public.services IS
  'Per-business service catalog (name, price LEI, duration). Used by WhatsApp menus & AI.';

CREATE INDEX IF NOT EXISTS idx_services_business
  ON public.services (business_id, sort_order, name);

CREATE INDEX IF NOT EXISTS idx_services_business_active
  ON public.services (business_id)
  WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS trg_services_updated_at ON public.services;
CREATE TRIGGER trg_services_updated_at
  BEFORE UPDATE ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS services_service_role_all ON public.services;
CREATE POLICY services_service_role_all
  ON public.services
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Backfill from booking_settings.services JSONB (one-time, idempotent-ish)
-- ---------------------------------------------------------------------------
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
