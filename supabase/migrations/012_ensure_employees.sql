-- =============================================================================
-- VIDIA V2 — Ensure public.employees + reload PostgREST schema cache
--
-- Rulează acest fișier în Supabase SQL Editor → Run (idempotent).
-- Repară: Could not find the table 'public.employees' in the schema cache (PGRST205)
--
-- Coloanele potrivesc aplicația (employeeService / Admin):
--   id, business_id, name, google_calendar_id, active
-- (nu calendar_id / is_active — acele alias-uri ar rupe Admin-ul existent)
-- =============================================================================

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

-- Force PostgREST to pick up the new table immediately (no dashboard restart).
NOTIFY pgrst, 'reload schema';

SELECT
  'employees' AS table_name,
  CASE WHEN to_regclass('public.employees') IS NOT NULL THEN 'OK' ELSE 'MISSING' END AS status,
  (
    SELECT string_agg(column_name, ', ' ORDER BY ordinal_position)
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'employees'
  ) AS columns;
