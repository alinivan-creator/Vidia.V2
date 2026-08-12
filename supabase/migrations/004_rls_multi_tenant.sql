-- =============================================================================
-- VIDIA V2 — Multi-tenant RLS hardening
--
-- Tables covered:
--   businesses, services, clients (= leads), draft_bookings (= appointments),
--   calendar_cache, error_logs
--
-- Access model:
--   • service_role (Node backend) — bypasses RLS (Supabase default)
--   • anon — no access (no policies / revoked grants)
--   • authenticated — only rows for businesses they own
--     (businesses.owner_user_id = auth.uid())
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Ownership column (nullable until Supabase Auth is wired to owners)
-- ---------------------------------------------------------------------------
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS owner_user_id UUID;

COMMENT ON COLUMN public.businesses.owner_user_id IS
  'Supabase Auth user who owns this tenant. NULL = backend/service_role only.';

CREATE INDEX IF NOT EXISTS idx_businesses_owner_user
  ON public.businesses (owner_user_id)
  WHERE owner_user_id IS NOT NULL;

-- Optional FK to auth.users (skip if auth schema unavailable in local clones)
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
-- Helpers (SECURITY DEFINER — safe, search_path pinned)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_business_owner(p_business_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.businesses b
    WHERE b.id = p_business_id
      AND b.owner_user_id IS NOT NULL
      AND b.owner_user_id = auth.uid()
  );
$$;

COMMENT ON FUNCTION public.is_business_owner(UUID) IS
  'True when auth.uid() owns the given business tenant.';

CREATE OR REPLACE FUNCTION public.current_owned_business_ids()
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT b.id
  FROM public.businesses b
  WHERE b.owner_user_id IS NOT NULL
    AND b.owner_user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- Enable RLS on every tenant table
-- ---------------------------------------------------------------------------
ALTER TABLE public.businesses      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_bookings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_cache  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.error_logs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services        ENABLE ROW LEVEL SECURITY;

-- Force RLS even for table owners (extra safety in Supabase)
ALTER TABLE public.businesses      FORCE ROW LEVEL SECURITY;
ALTER TABLE public.clients         FORCE ROW LEVEL SECURITY;
ALTER TABLE public.draft_bookings  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_cache  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.error_logs      FORCE ROW LEVEL SECURITY;
ALTER TABLE public.services        FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Drop overly-permissive / legacy policies
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS services_service_role_all ON public.services;

DROP POLICY IF EXISTS businesses_owner_select ON public.businesses;
DROP POLICY IF EXISTS businesses_owner_insert ON public.businesses;
DROP POLICY IF EXISTS businesses_owner_update ON public.businesses;
DROP POLICY IF EXISTS businesses_owner_delete ON public.businesses;

DROP POLICY IF EXISTS services_owner_select ON public.services;
DROP POLICY IF EXISTS services_owner_insert ON public.services;
DROP POLICY IF EXISTS services_owner_update ON public.services;
DROP POLICY IF EXISTS services_owner_delete ON public.services;

DROP POLICY IF EXISTS clients_owner_select ON public.clients;
DROP POLICY IF EXISTS clients_owner_insert ON public.clients;
DROP POLICY IF EXISTS clients_owner_update ON public.clients;
DROP POLICY IF EXISTS clients_owner_delete ON public.clients;

DROP POLICY IF EXISTS draft_bookings_owner_select ON public.draft_bookings;
DROP POLICY IF EXISTS draft_bookings_owner_insert ON public.draft_bookings;
DROP POLICY IF EXISTS draft_bookings_owner_update ON public.draft_bookings;
DROP POLICY IF EXISTS draft_bookings_owner_delete ON public.draft_bookings;

DROP POLICY IF EXISTS calendar_cache_owner_select ON public.calendar_cache;
DROP POLICY IF EXISTS calendar_cache_owner_insert ON public.calendar_cache;
DROP POLICY IF EXISTS calendar_cache_owner_update ON public.calendar_cache;
DROP POLICY IF EXISTS calendar_cache_owner_delete ON public.calendar_cache;

DROP POLICY IF EXISTS error_logs_owner_select ON public.error_logs;
DROP POLICY IF EXISTS error_logs_owner_update ON public.error_logs;

-- ---------------------------------------------------------------------------
-- businesses — owner can manage own row only
-- ---------------------------------------------------------------------------
CREATE POLICY businesses_owner_select
  ON public.businesses
  FOR SELECT
  TO authenticated
  USING (owner_user_id IS NOT NULL AND owner_user_id = auth.uid());

CREATE POLICY businesses_owner_insert
  ON public.businesses
  FOR INSERT
  TO authenticated
  WITH CHECK (owner_user_id IS NOT NULL AND owner_user_id = auth.uid());

CREATE POLICY businesses_owner_update
  ON public.businesses
  FOR UPDATE
  TO authenticated
  USING (owner_user_id IS NOT NULL AND owner_user_id = auth.uid())
  WITH CHECK (owner_user_id IS NOT NULL AND owner_user_id = auth.uid());

CREATE POLICY businesses_owner_delete
  ON public.businesses
  FOR DELETE
  TO authenticated
  USING (owner_user_id IS NOT NULL AND owner_user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- services — isolated by business_id
-- ---------------------------------------------------------------------------
CREATE POLICY services_owner_select
  ON public.services
  FOR SELECT
  TO authenticated
  USING (public.is_business_owner(business_id));

CREATE POLICY services_owner_insert
  ON public.services
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_business_owner(business_id));

CREATE POLICY services_owner_update
  ON public.services
  FOR UPDATE
  TO authenticated
  USING (public.is_business_owner(business_id))
  WITH CHECK (public.is_business_owner(business_id));

CREATE POLICY services_owner_delete
  ON public.services
  FOR DELETE
  TO authenticated
  USING (public.is_business_owner(business_id));

-- ---------------------------------------------------------------------------
-- clients (= leads) — isolated by business_id
-- ---------------------------------------------------------------------------
CREATE POLICY clients_owner_select
  ON public.clients
  FOR SELECT
  TO authenticated
  USING (public.is_business_owner(business_id));

CREATE POLICY clients_owner_insert
  ON public.clients
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_business_owner(business_id));

CREATE POLICY clients_owner_update
  ON public.clients
  FOR UPDATE
  TO authenticated
  USING (public.is_business_owner(business_id))
  WITH CHECK (public.is_business_owner(business_id));

CREATE POLICY clients_owner_delete
  ON public.clients
  FOR DELETE
  TO authenticated
  USING (public.is_business_owner(business_id));

-- ---------------------------------------------------------------------------
-- draft_bookings (= appointments) — isolated by business_id
-- ---------------------------------------------------------------------------
CREATE POLICY draft_bookings_owner_select
  ON public.draft_bookings
  FOR SELECT
  TO authenticated
  USING (public.is_business_owner(business_id));

CREATE POLICY draft_bookings_owner_insert
  ON public.draft_bookings
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_business_owner(business_id));

CREATE POLICY draft_bookings_owner_update
  ON public.draft_bookings
  FOR UPDATE
  TO authenticated
  USING (public.is_business_owner(business_id))
  WITH CHECK (public.is_business_owner(business_id));

CREATE POLICY draft_bookings_owner_delete
  ON public.draft_bookings
  FOR DELETE
  TO authenticated
  USING (public.is_business_owner(business_id));

-- ---------------------------------------------------------------------------
-- calendar_cache — isolated by business_id
-- ---------------------------------------------------------------------------
CREATE POLICY calendar_cache_owner_select
  ON public.calendar_cache
  FOR SELECT
  TO authenticated
  USING (public.is_business_owner(business_id));

CREATE POLICY calendar_cache_owner_insert
  ON public.calendar_cache
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_business_owner(business_id));

CREATE POLICY calendar_cache_owner_update
  ON public.calendar_cache
  FOR UPDATE
  TO authenticated
  USING (public.is_business_owner(business_id))
  WITH CHECK (public.is_business_owner(business_id));

CREATE POLICY calendar_cache_owner_delete
  ON public.calendar_cache
  FOR DELETE
  TO authenticated
  USING (public.is_business_owner(business_id));

-- ---------------------------------------------------------------------------
-- error_logs — owners may read/resolve their own business logs
-- ---------------------------------------------------------------------------
CREATE POLICY error_logs_owner_select
  ON public.error_logs
  FOR SELECT
  TO authenticated
  USING (
    business_id IS NOT NULL
    AND public.is_business_owner(business_id)
  );

CREATE POLICY error_logs_owner_update
  ON public.error_logs
  FOR UPDATE
  TO authenticated
  USING (
    business_id IS NOT NULL
    AND public.is_business_owner(business_id)
  )
  WITH CHECK (
    business_id IS NOT NULL
    AND public.is_business_owner(business_id)
  );

-- No INSERT/DELETE for authenticated on error_logs — backend only.

-- ---------------------------------------------------------------------------
-- Grants: public/anon locked down; authenticated gets DML under RLS
-- ---------------------------------------------------------------------------
REVOKE ALL ON TABLE public.businesses FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.services FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.clients FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.draft_bookings FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.calendar_cache FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.error_logs FROM PUBLIC, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.businesses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.services TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.clients TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.draft_bookings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.calendar_cache TO authenticated;
GRANT SELECT, UPDATE ON TABLE public.error_logs TO authenticated;

-- Convenience views (aliases requested as appointments / leads)
CREATE OR REPLACE VIEW public.appointments
  WITH (security_invoker = true)
AS
SELECT * FROM public.draft_bookings;

CREATE OR REPLACE VIEW public.leads
  WITH (security_invoker = true)
AS
SELECT * FROM public.clients;

COMMENT ON VIEW public.appointments IS
  'Alias for draft_bookings (booking/appointment state machine). RLS via underlying table.';
COMMENT ON VIEW public.leads IS
  'Alias for clients (CRM / WhatsApp leads). RLS via underlying table.';

GRANT SELECT ON public.appointments TO authenticated;
GRANT SELECT ON public.leads TO authenticated;

REVOKE ALL ON public.appointments FROM PUBLIC, anon;
REVOKE ALL ON public.leads FROM PUBLIC, anon;
