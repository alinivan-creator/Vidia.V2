-- =============================================================================
-- VIDIA V2 — conversation_states (WhatsApp memory / state machine)
-- =============================================================================

-- Ensure helper from 004 exists (no-op create if missing)
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

COMMENT ON TABLE public.conversation_states IS
  'Per-client WhatsApp conversation memory. Survives across messages for booking/reschedule flows.';
COMMENT ON COLUMN public.conversation_states.current_step IS
  'IDLE | CHOOSING_SERVICE | SELECTING_SLOT | CONFIRMING | MODIFYING | RESCHEDULING | CONFIRMING_CANCEL | MODIFIED';
COMMENT ON COLUMN public.conversation_states.context_data IS
  'Transient payload: selected service, slot, appointment_id, google_event_id, intent, etc.';

CREATE INDEX IF NOT EXISTS idx_conversation_states_business_phone
  ON public.conversation_states (business_id, client_phone);

CREATE INDEX IF NOT EXISTS idx_conversation_states_step
  ON public.conversation_states (business_id, current_step)
  WHERE current_step <> 'IDLE';

DROP TRIGGER IF EXISTS trg_conversation_states_updated_at ON public.conversation_states;
CREATE TRIGGER trg_conversation_states_updated_at
  BEFORE UPDATE ON public.conversation_states
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS (same multi-tenant model as 004)
ALTER TABLE public.conversation_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_states FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_states_owner_select ON public.conversation_states;
DROP POLICY IF EXISTS conversation_states_owner_insert ON public.conversation_states;
DROP POLICY IF EXISTS conversation_states_owner_update ON public.conversation_states;
DROP POLICY IF EXISTS conversation_states_owner_delete ON public.conversation_states;

CREATE POLICY conversation_states_owner_select
  ON public.conversation_states FOR SELECT TO authenticated
  USING (public.is_business_owner(business_id));

CREATE POLICY conversation_states_owner_insert
  ON public.conversation_states FOR INSERT TO authenticated
  WITH CHECK (public.is_business_owner(business_id));

CREATE POLICY conversation_states_owner_update
  ON public.conversation_states FOR UPDATE TO authenticated
  USING (public.is_business_owner(business_id))
  WITH CHECK (public.is_business_owner(business_id));

CREATE POLICY conversation_states_owner_delete
  ON public.conversation_states FOR DELETE TO authenticated
  USING (public.is_business_owner(business_id));

REVOKE ALL ON TABLE public.conversation_states FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.conversation_states TO authenticated;
