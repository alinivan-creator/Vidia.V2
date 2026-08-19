-- Prevent false "slot_taken" when the busy calendar_cache row is THIS booking's
-- own Google event (classic bug: calendar updated first → RPC sees self as busy).

CREATE OR REPLACE FUNCTION public.reschedule_confirmed_booking(
  p_draft_id uuid,
  p_business_id uuid,
  p_slot_start timestamptz,
  p_slot_end timestamptz,
  p_context jsonb DEFAULT '{}'::jsonb,
  p_employee_id uuid DEFAULT NULL,
  p_google_event_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp uuid;
  v_own_event text;
  v_conflict uuid;
  v_row public.draft_bookings%ROWTYPE;
BEGIN
  IF p_draft_id IS NULL OR p_business_id IS NULL
     OR p_slot_start IS NULL OR p_slot_end IS NULL
     OR p_slot_end <= p_slot_start THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_range');
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(p_business_id::text),
    hashtext(COALESCE(p_employee_id::text, '') || p_slot_start::text)
  );

  SELECT employee_id, google_event_id
    INTO v_emp, v_own_event
  FROM public.draft_bookings
  WHERE id = p_draft_id
    AND business_id = p_business_id
    AND state = 'confirmed'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  v_emp := COALESCE(p_employee_id, v_emp);
  v_own_event := COALESCE(NULLIF(p_google_event_id, ''), v_own_event);

  IF v_emp IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.employees e
    WHERE e.id = v_emp AND e.business_id = p_business_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_employee');
  END IF;

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
    AND COALESCE(d.employee_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = COALESCE(v_emp, '00000000-0000-0000-0000-000000000000'::uuid)
    AND (
      d.state = 'confirmed'
      OR (d.state = 'pending_confirmation' AND d.locked_until IS NOT NULL AND d.locked_until > NOW())
    )
  LIMIT 1;

  IF v_conflict IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'slot_taken');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.calendar_cache c
    WHERE c.business_id = p_business_id
      AND c.status IN ('busy', 'blocked')
      AND EXTRACT(EPOCH FROM (
        LEAST(c.slot_end, p_slot_end) - GREATEST(c.slot_start, p_slot_start)
      )) / 60.0 > 5
      AND (
        v_emp IS NULL
        OR c.employee_id IS NULL
        OR c.employee_id = v_emp
      )
      -- Never treat this appointment's own Google event as a foreign conflict.
      AND (v_own_event IS NULL OR c.google_event_id IS DISTINCT FROM v_own_event)
      AND (
        p_google_event_id IS NULL
        OR NULLIF(p_google_event_id, '') IS NULL
        OR c.google_event_id IS DISTINCT FROM p_google_event_id
      )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'slot_taken');
  END IF;

  UPDATE public.draft_bookings
  SET
    selected_slot_start = p_slot_start,
    selected_slot_end = p_slot_end,
    employee_id = COALESCE(v_emp, employee_id),
    google_event_id = COALESCE(NULLIF(p_google_event_id, ''), google_event_id),
    conversation_context = COALESCE(p_context, conversation_context),
    updated_at = NOW()
  WHERE id = p_draft_id
    AND business_id = p_business_id
    AND state = 'confirmed'
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  RETURN jsonb_build_object('ok', true, 'reason', NULL, 'draft', to_jsonb(v_row));
EXCEPTION
  WHEN exclusion_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'slot_taken');
  WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'slot_taken');
END;
$$;

REVOKE ALL ON FUNCTION public.reschedule_confirmed_booking(uuid, uuid, timestamptz, timestamptz, jsonb, uuid, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reschedule_confirmed_booking(uuid, uuid, timestamptz, timestamptz, jsonb, uuid, text)
  TO service_role;
