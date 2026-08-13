-- =============================================================================
-- VIDIA V2 — Pending confirmation TTL (5 minutes)
-- =============================================================================

ALTER TABLE public.draft_bookings
  ADD COLUMN IF NOT EXISTS pending_expires_at TIMESTAMPTZ;

COMMENT ON COLUMN public.draft_bookings.pending_expires_at IS
  'When pending_confirmation should auto-release the slot (typically NOW() + 5 minutes). Soft-lock (locked_until) matches this TTL.';

CREATE INDEX IF NOT EXISTS idx_draft_bookings_pending_expires
  ON public.draft_bookings (business_id, pending_expires_at)
  WHERE state = 'pending_confirmation' AND pending_expires_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.expire_stale_draft_bookings()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected INTEGER;
BEGIN
  UPDATE public.draft_bookings
  SET
    state = 'expired',
    locked_until = NULL,
    pending_expires_at = NULL,
    updated_at = NOW()
  WHERE
    (
      state IN ('browsing', 'pending_confirmation')
      AND expires_at < NOW()
    )
    OR (
      state = 'pending_confirmation'
      AND pending_expires_at IS NOT NULL
      AND pending_expires_at < NOW()
    );

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

COMMENT ON FUNCTION public.expire_stale_draft_bookings IS
  'Releases expired browsing drafts and pending_confirmation slots (5 min TTL). Calendar event cleanup runs in the app on the next message or availability check.';
