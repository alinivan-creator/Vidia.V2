-- =============================================================================
-- VIDIA V2 — Calendars belong to employees only (not the business)
-- =============================================================================
-- Moves businesses.google_calendar_id onto a staff row, then clears the business
-- column. Prefer employee named "Mihai"; else sole employee; else create Mihai.
-- =============================================================================

DO $$
DECLARE
  biz RECORD;
  emp_id UUID;
  emp_cal TEXT;
  emp_count INT;
  target_name TEXT;
BEGIN
  FOR biz IN
    SELECT id, google_calendar_id
    FROM public.businesses
    WHERE google_calendar_id IS NOT NULL
      AND TRIM(google_calendar_id) <> ''
  LOOP
    SELECT COUNT(*)::INT INTO emp_count
    FROM public.employees
    WHERE business_id = biz.id;

    IF emp_count = 0 THEN
      INSERT INTO public.employees (
        business_id, name, google_calendar_id, active, sort_order, metadata
      ) VALUES (
        biz.id, 'Mihai', TRIM(biz.google_calendar_id), true, 0, '{}'::jsonb
      );
    ELSE
      -- Prefer Mihai (case-insensitive), else first by sort_order/name
      SELECT e.id, e.google_calendar_id, e.name
      INTO emp_id, emp_cal, target_name
      FROM public.employees e
      WHERE e.business_id = biz.id
      ORDER BY
        CASE WHEN LOWER(TRIM(e.name)) = 'mihai' THEN 0 ELSE 1 END,
        e.sort_order ASC NULLS LAST,
        e.name ASC
      LIMIT 1;

      IF emp_cal IS NULL OR TRIM(emp_cal) = '' THEN
        UPDATE public.employees
        SET google_calendar_id = TRIM(biz.google_calendar_id)
        WHERE id = emp_id;
      END IF;
      -- If employee already has a different calendar, keep theirs; still clear business.
    END IF;

    UPDATE public.businesses
    SET google_calendar_id = NULL
    WHERE id = biz.id;
  END LOOP;
END $$;

COMMENT ON COLUMN public.businesses.google_calendar_id IS
  'Deprecated — calendars live on employees.google_calendar_id only. Kept nullable for backward compatibility.';
