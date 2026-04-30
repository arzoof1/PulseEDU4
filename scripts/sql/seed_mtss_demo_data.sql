-- =====================================================================
-- MTSS Demo Data Backfill — School ID 2
-- ---------------------------------------------------------------------
-- Seeds ~60 days of Tier 2 daily entries and ~8 weeks of Tier 3 weekly
-- records for every active T2 / T3 plan at school 2, using the *new*
-- effective-teacher resolution (live schedule ∪ additional
-- interventionists − excluded teachers).
--
-- Targets ~90% completion / ~90% average score so the upcoming Reports
-- page has rich content to demonstrate.
--
-- Idempotent: WHERE NOT EXISTS guards prevent duplicates if you re-run.
-- ---------------------------------------------------------------------

-- Effective-teacher CTE shared by both backfills.
-- (Materialized via WITH so we don't recompute it twice.)

-- ---------- TIER 2 (DAILY) ----------
WITH date_series AS (
  SELECT generate_series(
    (CURRENT_DATE - INTERVAL '60 days')::date,
    (CURRENT_DATE - INTERVAL '1 day')::date,
    '1 day'
  )::date AS d
),
weekdays AS (
  SELECT to_char(d, 'YYYY-MM-DD') AS entry_date, d
  FROM date_series
  WHERE EXTRACT(DOW FROM d) BETWEEN 1 AND 5
),
plan_teachers AS (
  SELECT
    p.id              AS plan_id,
    p.school_id,
    p.student_id,
    COALESCE(p.intervention_sub_type, 'cico') AS sub_type,
    eff.staff_id
  FROM student_mtss_plans p
  CROSS JOIN LATERAL (
    SELECT DISTINCT staff_id FROM (
      -- schedule teachers (auto plans)
      SELECT cs.teacher_staff_id AS staff_id
      FROM section_roster sr
      JOIN class_sections cs ON cs.id = sr.section_id
      WHERE p.auto_assign_schedule_teachers
        AND sr.school_id = p.school_id
        AND sr.student_id = p.student_id
        AND cs.is_planning = false
      UNION
      -- additional interventionists
      SELECT NULLIF(BTRIM(x), '')::int
      FROM unnest(string_to_array(p.additional_interventionist_ids, ',')) AS u(x)
      WHERE BTRIM(x) ~ '^[0-9]+$'
      UNION
      -- legacy assigned (manual mode only)
      SELECT NULLIF(BTRIM(x), '')::int
      FROM unnest(string_to_array(p.assigned_teacher_ids, ',')) AS u(x)
      WHERE NOT p.auto_assign_schedule_teachers
        AND BTRIM(x) ~ '^[0-9]+$'
    ) src
    WHERE staff_id IS NOT NULL
      AND staff_id NOT IN (
        SELECT NULLIF(BTRIM(x), '')::int
        FROM unnest(string_to_array(p.excluded_teacher_ids, ',')) AS u(x)
        WHERE BTRIM(x) ~ '^[0-9]+$'
      )
  ) eff
  WHERE p.school_id = 2
    AND p.closed_at IS NULL
    AND p.tier = 2
)
INSERT INTO tier2_intervention_entries
  (school_id, student_id, teacher_staff_id, entry_date, sub_type, notes, created_at)
SELECT
  pt.school_id,
  pt.student_id,
  pt.staff_id,
  w.entry_date,
  pt.sub_type,
  '',
  (w.entry_date || 'T15:30:00Z')::timestamptz
FROM plan_teachers pt
CROSS JOIN weekdays w
-- Deterministic ~90% completion: hash the (student, teacher, date)
-- triple and skip the unlucky 10%. Re-running the script is a true
-- no-op for previously sampled rows because the same triple always
-- hashes to the same bucket.
WHERE (abs(hashtext(pt.student_id || ':' || pt.staff_id::text || ':' || w.entry_date)) % 10) < 9
  AND NOT EXISTS (
    SELECT 1 FROM tier2_intervention_entries e
    WHERE e.school_id        = pt.school_id
      AND e.student_id       = pt.student_id
      AND e.teacher_staff_id = pt.staff_id
      AND e.entry_date       = w.entry_date
  );


-- ---------- TIER 3 (WEEKLY) ----------
WITH mondays AS (
  SELECT to_char(d, 'YYYY-MM-DD') AS week_start, d::date AS week_start_d
  FROM generate_series(
    (CURRENT_DATE - INTERVAL '60 days')::date,
    CURRENT_DATE::date,
    '1 day'
  ) AS g(d)
  WHERE EXTRACT(DOW FROM d) = 1
),
plan_teachers AS (
  SELECT
    p.id              AS plan_id,
    p.school_id,
    p.student_id,
    eff.staff_id
  FROM student_mtss_plans p
  CROSS JOIN LATERAL (
    SELECT DISTINCT staff_id FROM (
      SELECT cs.teacher_staff_id AS staff_id
      FROM section_roster sr
      JOIN class_sections cs ON cs.id = sr.section_id
      WHERE p.auto_assign_schedule_teachers
        AND sr.school_id = p.school_id
        AND sr.student_id = p.student_id
        AND cs.is_planning = false
      UNION
      SELECT NULLIF(BTRIM(x), '')::int
      FROM unnest(string_to_array(p.additional_interventionist_ids, ',')) AS u(x)
      WHERE BTRIM(x) ~ '^[0-9]+$'
      UNION
      SELECT NULLIF(BTRIM(x), '')::int
      FROM unnest(string_to_array(p.assigned_teacher_ids, ',')) AS u(x)
      WHERE NOT p.auto_assign_schedule_teachers
        AND BTRIM(x) ~ '^[0-9]+$'
    ) src
    WHERE staff_id IS NOT NULL
      AND staff_id NOT IN (
        SELECT NULLIF(BTRIM(x), '')::int
        FROM unnest(string_to_array(p.excluded_teacher_ids, ',')) AS u(x)
        WHERE BTRIM(x) ~ '^[0-9]+$'
      )
  ) eff
  WHERE p.school_id = 2
    AND p.closed_at IS NULL
    AND p.tier = 3
),
score_pool AS (
  -- Pool averages exactly 4.5 / 5 = 90%, with realistic per-day variance.
  SELECT ARRAY[5,5,4,5,4,5,3,5,4,5]::int[] AS pool
)
INSERT INTO tier3_weekly_records (
  school_id, student_id, teacher_staff_id, week_start_date,
  mon_score, tue_score, wed_score, thu_score, fri_score,
  weekly_comment, goal_version_ids, goal_scores, absent_days,
  submitted_at, created_at
)
SELECT
  pt.school_id,
  pt.student_id,
  pt.staff_id,
  m.week_start,
  sp.pool[1 + floor(random() * 10)::int],
  sp.pool[1 + floor(random() * 10)::int],
  sp.pool[1 + floor(random() * 10)::int],
  sp.pool[1 + floor(random() * 10)::int],
  sp.pool[1 + floor(random() * 10)::int],
  '',
  '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
  ((m.week_start_d + 4) || 'T15:30:00Z')::timestamptz,  -- Friday submit
  (m.week_start || 'T08:00:00Z')::timestamptz
FROM plan_teachers pt
CROSS JOIN mondays m
CROSS JOIN score_pool sp
WHERE NOT EXISTS (
  SELECT 1 FROM tier3_weekly_records r
  WHERE r.school_id        = pt.school_id
    AND r.student_id       = pt.student_id
    AND r.teacher_staff_id = pt.staff_id
    AND r.week_start_date  = m.week_start
);
