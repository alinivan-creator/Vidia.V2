-- =============================================================================
-- VIDIA V2 — Employee ↔ service association for multi-staff FreeBusy booking
-- =============================================================================
-- Empty / null service_ids = employee can perform every catalog service
-- (backward compatible with tenants that have not configured associations yet).

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS service_ids JSONB NOT NULL DEFAULT '[]'::JSONB;

ALTER TABLE public.employees
  DROP CONSTRAINT IF EXISTS employees_service_ids_is_array;

ALTER TABLE public.employees
  ADD CONSTRAINT employees_service_ids_is_array
  CHECK (jsonb_typeof(service_ids) = 'array');

COMMENT ON COLUMN public.employees.service_ids IS
  'Catalog service ids this employee can perform. Empty array = all services.';
