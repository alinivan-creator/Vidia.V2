-- =============================================================================
-- VIDIA V2 — Global system settings (Super-Admin)
-- Stores Master Google Calendar credentials so they are not required in .env.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.system_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL DEFAULT '{}'::JSONB,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT system_settings_value_object
    CHECK (jsonb_typeof(value) = 'object')
);

COMMENT ON TABLE public.system_settings IS
  'Global Super-Admin settings (e.g. google_master). Not tenant-scoped.';

DROP TRIGGER IF EXISTS trg_system_settings_updated_at ON public.system_settings;
CREATE TRIGGER trg_system_settings_updated_at
  BEFORE UPDATE ON public.system_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_settings FORCE ROW LEVEL SECURITY;

-- No policies for anon/authenticated — only service_role (backend) can access.
REVOKE ALL ON TABLE public.system_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.system_settings TO service_role;

-- Seed empty google_master row
INSERT INTO public.system_settings (key, value)
VALUES ('google_master', '{}'::JSONB)
ON CONFLICT (key) DO NOTHING;
