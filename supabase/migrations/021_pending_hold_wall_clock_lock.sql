-- Critical: pending holds must block the same wall-clock slot for EVERY client,
-- regardless of employee_id (shared Google calendar double-book fix).
-- Also writes a synthetic calendar_cache busy row atomically with the claim.

CREATE OR REPLACE FUNCTION public.claim_booking_slot(
  p_draft_id uuid,
  p_business_id uuid,
  p_slot_start timestamptz,
  p_slot_end timestamptz,
  p_ttl_minutes integer DEFAULT 5,
  p_context jsonb DEFAULT '{}'::jsonb,
  p_employee_id uuid DEFAULT NULL,
  p_mode text DEFAULT 'hold'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_minutes integer;
  v_ttl timestamptz;
  v_emp uuid;
  v_conflict uuid;
  v_row public.draft_bookings%ROWTYPE;
  v_hold_event text;
BEGIN
  IF p_draft_id IS NULL OR p_business_id IS NULL
     OR p_slot_start IS NULL OR p_slot_end IS NULL
     OR p_slot_end <= p_slot_start THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_range');
  END IF;

  v_minutes := GREATEST(1, LEAST(60, COALESCE(p_ttl_minutes, 5)));
  v_ttl := NOW() + (v_minutes || ' minutes')::interval;
  v_hold_event := 'vidia_hold_' || p_draft_id::text;

  -- Serialize claims for this business + start instant (ignore employee).
  PERFORM pg_advisory_xact_lock(
    hashtext(p_business_id::text),
    hashtext(p_slot_start::text)
  );

  UPDATE public.draft_bookings
  SET
    state = 'expired',
    locked_until = NULL,
    pending_expires_at = NULL,
    updated_at = NOW()
  WHERE business_id = p_business_id
    AND state = 'pending_confirmation'
    AND (
      locked_until IS NULL
      OR locked_until <= NOW()
    );

  SELECT employee_id INTO v_emp
  FROM public.draft_bookings
  WHERE id = p_draft_id AND business_id = p_business_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  v_emp := COALESCE(p_employee_id, v_emp);

  IF v_emp IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.employees e
    WHERE e.id = v_emp
      AND e.business_id = p_business_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_employee');
  END IF;

  -- Any other pending/confirmed booking on this wall-clock interval blocks
  -- (employee_id must NOT be part of the match — shared calendar).
  SELECT d.id INTO v_conflict
  FROM public.draft_bookings d
  WHERE d.business_id = p_business_id
    AND d.id <> p_draft_id
    AND d.selected_slot_start IS NOT NULL
    AND d.selected_slot_end IS NOT NULL
    AND d.state IN ('pending_confirmation', 'confirmed')
    AND EXTRACT(EPOCH FROM (
      LEAST(d.selected_slot_end, p_slot_end) - GREATEST(d.selected_slot_start, p_slot_start)
    )) / 60.0 > 5
    AND (
      d.state = 'confirmed'
      OR (d.state = 'pending_confirmation' AND d.locked_until IS NOT NULL AND d.locked_until > NOW())
    )
  LIMIT 1;

  IF v_conflict IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'slot_taken');
  END IF;

  -- Any busy/blocked cache row on this interval (except this draft's hold).
  IF EXISTS (
    SELECT 1
    FROM public.calendar_cache c
    WHERE c.business_id = p_business_id
      AND c.status IN ('busy', 'blocked')
      AND COALESCE(c.google_event_id, '') <> v_hold_event
      AND EXTRACT(EPOCH FROM (
        LEAST(c.slot_end, p_slot_end) - GREATEST(c.slot_start, p_slot_start)
      )) / 60.0 > 5
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'slot_taken');
  END IF;

  IF p_mode = 'reschedule' THEN
    UPDATE public.draft_bookings
    SET
      selected_slot_start = p_slot_start,
      selected_slot_end = p_slot_end,
      conversation_context = COALESCE(p_context, conversation_context),
      updated_at = NOW()
    WHERE id = p_draft_id
      AND business_id = p_business_id
      AND state = 'confirmed'
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.draft_bookings
    SET
      state = 'pending_confirmation',
      selected_slot_start = p_slot_start,
      selected_slot_end = p_slot_end,
      locked_until = v_ttl,
      pending_expires_at = v_ttl,
      conversation_context = COALESCE(p_context, '{}'::jsonb),
      expires_at = NOW() + INTERVAL '30 minutes',
      employee_id = COALESCE(v_emp, employee_id),
      updated_at = NOW()
    WHERE id = p_draft_id
      AND business_id = p_business_id
      AND state IN ('browsing', 'pending_confirmation')
    RETURNING * INTO v_row;
  END IF;

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- Atomic soft-lock visibility for availability/cache readers.
  IF p_mode IS DISTINCT FROM 'reschedule' THEN
    DELETE FROM public.calendar_cache
    WHERE business_id = p_business_id
      AND google_event_id = v_hold_event;

    INSERT INTO public.calendar_cache (
      business_id,
      employee_id,
      slot_start,
      slot_end,
      status,
      source,
      google_event_id,
      title,
      metadata,
      synced_at
    ) VALUES (
      p_business_id,
      NULL,
      p_slot_start,
      p_slot_end,
      'busy',
      'vidia_booking',
      v_hold_event,
      'Pending WhatsApp booking',
      jsonb_build_object('pending_hold', true, 'draft_id', p_draft_id),
      NOW()
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'reason', NULL,
    'draft', to_jsonb(v_row)
  );
EXCEPTION
  WHEN exclusion_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'slot_taken');
  WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'slot_taken');
END;
$$;

REVOKE ALL ON FUNCTION public.claim_booking_slot(uuid, uuid, timestamptz, timestamptz, integer, jsonb, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_booking_slot(uuid, uuid, timestamptz, timestamptz, integer, jsonb, uuid, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
