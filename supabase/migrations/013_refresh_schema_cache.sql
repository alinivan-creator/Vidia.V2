-- =============================================================================
-- VIDIA V2 — PostgREST schema cache refresh (callable from the app)
--
-- After CREATE TABLE, PostgREST may still return PGRST205 until notified.
-- This RPC lets Admin / `npm run schema:refresh` force a reload.
-- =============================================================================

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

COMMENT ON FUNCTION public.refresh_postgrest_schema() IS
  'Notifies PostgREST to reload the schema cache. Service-role only.';

REVOKE ALL ON FUNCTION public.refresh_postgrest_schema() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_postgrest_schema() TO service_role;

NOTIFY pgrst, 'reload schema';
