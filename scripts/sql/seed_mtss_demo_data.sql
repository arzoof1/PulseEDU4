-- =====================================================================
-- MTSS Demo Data Backfill — School ID 2
-- ---------------------------------------------------------------------
-- Seeds ~60 days of Tier 2 daily entries and ~8 weeks of Tier 3 weekly
-- records for every active T2 / T3 plan at school 2, using the new
-- effective-teacher resolution (live schedule ∪ additional
-- interventionists − excluded teachers).
--
-- Variance model (so the report math is visibly working):
--   * Each plan gets its own deterministic baseline performance band
--     in roughly 55–95% (T2) or 2.8–4.8/5 (T3) derived from
--     hashtext(plan_id). One student is the model student, another is
--     barely complying.
--   * Each (plan, week) gets an additional jitter of ±12 pts (T2) or
--     ±0.6 (T3) so weekly trend lines actually move and the entry-
--     weighted overall diverges from the week-weighted mean.
--   * Per-day score noise on top of the per-week center.
--
-- Idempotent: WHERE NOT EXISTS guards prevent duplicates if you re-run.
-- ---------------------------------------------------------------------

-- ---------- TIER 2 (DAILY) ----------
WITH date_series AS (
  SELECT generate_series(
    (CURRENT_DATE - INTERVAL '60 days')::date,
    (CURRENT_DATE - INTERVAL '1 day')::date,
    '1 day'
  )::date AS d
),
weekdays AS (
  SELECT
    to_char(d, 'YYYY-MM-DD')                    AS entry_date,
    d                                           AS d,
    to_char(date_trunc('week', d), 'YYYY-MM-DD') AS week_key
  FROM date_series
  WHERE EXTRACT(DOW FROM d) BETWEEN 1 AND 5
),
plan_teachers AS (
  SELECT
    p.id              AS plan_id,
    p.school_id,
    p.student_id,
    COALESCE(p.intervention_sub_type, 'cico') AS sub_type,
    eff.staff_id,
    -- per-plan baseline completion % in [55, 95]
    55 + (abs(hashtext('t2-base:' || p.id::text)) % 41) AS plan_base_pct
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
WHERE
  -- effective completion % for this (plan, week):
  -- plan baseline + per-week jitter in [-12, +12], clamped to [10, 100]
  (abs(hashtext('t2-cell:' || pt.plan_id::text || ':' || pt.staff_id::text || ':' || w.entry_date)) % 100)
    < LEAST(100, GREATEST(10,
        pt.plan_base_pct
        + ((abs(hashtext('t2-week:' || pt.plan_id::text || ':' || w.week_key)) % 25) - 12)
      ))
  AND NOT EXISTS (
    SELECT 1 FROM tier2_intervention_entries e
    WHERE e.school_id        = pt.school_id
      AND e.student_id       = pt.student_id
      AND e.teacher_staff_id = pt.staff_id
      AND e.entry_date       = w.entry_date
  );


-- ---------- TIER 3 (WEEKLY) ----------
WITH mondays AS (
  SELECT
    to_char(d, 'YYYY-MM-DD') AS week_start,
    d::date                  AS week_start_d
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
    eff.staff_id,
    -- per-plan target mean score in [2.8, 4.8] (×10 to keep it integer)
    28 + (abs(hashtext('t3-base:' || p.id::text)) % 21) AS plan_mean_x10
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
plan_week_centers AS (
  -- per-(plan, week) center score = plan mean ± 0.6 jitter
  SELECT
    pt.*,
    m.week_start,
    m.week_start_d,
    GREATEST(15, LEAST(50,
      pt.plan_mean_x10
      + ((abs(hashtext('t3-week:' || pt.plan_id::text || ':' || m.week_start)) % 13) - 6)
    )) AS week_center_x10
  FROM plan_teachers pt
  CROSS JOIN mondays m
)
INSERT INTO tier3_weekly_records (
  school_id, student_id, teacher_staff_id, week_start_date,
  mon_score, tue_score, wed_score, thu_score, fri_score,
  weekly_comment, goal_version_ids, goal_scores, absent_days,
  submitted_at, created_at
)
SELECT
  c.school_id,
  c.student_id,
  c.staff_id,
  c.week_start,
  -- per-day = round(center/10 + day noise in [-0.6,+0.6]) clamped to [1,5]
  GREATEST(1, LEAST(5, round(c.week_center_x10::numeric / 10
    + ((abs(hashtext('t3-day:mon:' || c.plan_id::text || ':' || c.staff_id::text || ':' || c.week_start)) % 13 - 6)::numeric / 10)
  )))::int,
  GREATEST(1, LEAST(5, round(c.week_center_x10::numeric / 10
    + ((abs(hashtext('t3-day:tue:' || c.plan_id::text || ':' || c.staff_id::text || ':' || c.week_start)) % 13 - 6)::numeric / 10)
  )))::int,
  GREATEST(1, LEAST(5, round(c.week_center_x10::numeric / 10
    + ((abs(hashtext('t3-day:wed:' || c.plan_id::text || ':' || c.staff_id::text || ':' || c.week_start)) % 13 - 6)::numeric / 10)
  )))::int,
  GREATEST(1, LEAST(5, round(c.week_center_x10::numeric / 10
    + ((abs(hashtext('t3-day:thu:' || c.plan_id::text || ':' || c.staff_id::text || ':' || c.week_start)) % 13 - 6)::numeric / 10)
  )))::int,
  GREATEST(1, LEAST(5, round(c.week_center_x10::numeric / 10
    + ((abs(hashtext('t3-day:fri:' || c.plan_id::text || ':' || c.staff_id::text || ':' || c.week_start)) % 13 - 6)::numeric / 10)
  )))::int,
  '',
  '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
  ((c.week_start_d + 4) || 'T15:30:00Z')::timestamptz,
  (c.week_start || 'T08:00:00Z')::timestamptz
FROM plan_week_centers c
-- ~8% of weeks the teacher just doesn't submit (creates "weeks with scores" variance)
WHERE (abs(hashtext('t3-skip:' || c.plan_id::text || ':' || c.staff_id::text || ':' || c.week_start)) % 100) >= 8
  AND NOT EXISTS (
    SELECT 1 FROM tier3_weekly_records r
    WHERE r.school_id        = c.school_id
      AND r.student_id       = c.student_id
      AND r.teacher_staff_id = c.staff_id
      AND r.week_start_date  = c.week_start
  );
