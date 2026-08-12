-- =============================================================================
-- VIDIA V2 — Human callback requests (AI out-of-scope / consulting leads)
-- =============================================================================

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

COMMENT ON TABLE public.callback_requests IS
  'Queue of client requests that exceed AI scope — for the human team.';

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
