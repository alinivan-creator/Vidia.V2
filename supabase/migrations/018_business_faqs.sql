-- Tenant FAQ / business policies. Admin CRUD only — never a global catalog.

CREATE TABLE IF NOT EXISTS public.business_faqs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES public.businesses (id) ON DELETE CASCADE,
  question     TEXT NOT NULL,
  answer       TEXT NOT NULL,
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT business_faqs_question_not_empty CHECK (char_length(trim(question)) > 0),
  CONSTRAINT business_faqs_answer_not_empty CHECK (char_length(trim(answer)) > 0)
);

COMMENT ON TABLE public.business_faqs IS
  'Per-tenant Q&A (card, parking, pets, cancellation). Injected into the AI context; never shared across businesses.';

CREATE INDEX IF NOT EXISTS idx_business_faqs_business
  ON public.business_faqs (business_id, sort_order, created_at);

DROP TRIGGER IF EXISTS trg_business_faqs_updated_at ON public.business_faqs;
CREATE TRIGGER trg_business_faqs_updated_at
  BEFORE UPDATE ON public.business_faqs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.business_faqs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_faqs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.business_faqs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.business_faqs TO service_role;

NOTIFY pgrst, 'reload schema';
