# Migration — MTSS Tier 3 Academic Minutes Rework

Additive, idempotent schema change for the Tier 3 **academic** (FAST
subject) intervention rework: per-day 1–5 goal scoring is replaced by a
weekly **minutes-based small-group** model with a release valve. Behavior
Tier 3 plans and all existing records are untouched.

## Scope

Two tables gain new columns. All columns are nullable or have safe
defaults, so the change is **online-safe** and **backward compatible** —
old rows read correctly and the previous behavior code path is unaffected.

- `student_mtss_plans`
  - `academic_minutes_target INTEGER NOT NULL DEFAULT 30`
  - `academic_any_day BOOLEAN NOT NULL DEFAULT FALSE`
- `tier3_weekly_records`
  - `academic_minutes JSONB NOT NULL DEFAULT '{}'::jsonb`
  - `released_no_intervention BOOLEAN NOT NULL DEFAULT FALSE`
  - `release_reason TEXT`
  - `released_by_staff_id INTEGER`
  - `released_at TIMESTAMPTZ`

## How dev / Replit apply this

On the Replit deployment these statements run automatically at boot via
`ensureMtssPlansSchema()` in `artifacts/api-server/src/seed.ts` (the same
`ALTER TABLE … ADD COLUMN IF NOT EXISTS` block that carries every prior
additive MTSS column). No manual step is needed there.

## AWS production — run once

The AWS prod database is a **separate host** that this workspace cannot
reach, so a developer must apply the change manually. Run the block below
against the prod database (psql, RDS query editor, or your migration
runner). Every statement is `IF NOT EXISTS`, so the script is safe to
re-run and safe if some columns already exist.

```sql
BEGIN;

-- student_mtss_plans
ALTER TABLE student_mtss_plans
  ADD COLUMN IF NOT EXISTS academic_minutes_target INTEGER NOT NULL DEFAULT 30;
ALTER TABLE student_mtss_plans
  ADD COLUMN IF NOT EXISTS academic_any_day BOOLEAN NOT NULL DEFAULT FALSE;

-- tier3_weekly_records
ALTER TABLE tier3_weekly_records
  ADD COLUMN IF NOT EXISTS academic_minutes JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tier3_weekly_records
  ADD COLUMN IF NOT EXISTS released_no_intervention BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tier3_weekly_records
  ADD COLUMN IF NOT EXISTS release_reason TEXT;
ALTER TABLE tier3_weekly_records
  ADD COLUMN IF NOT EXISTS released_by_staff_id INTEGER;
ALTER TABLE tier3_weekly_records
  ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;

COMMIT;
```

## Verify

```sql
SELECT table_name, column_name
FROM information_schema.columns
WHERE (table_name = 'student_mtss_plans'
       AND column_name IN ('academic_minutes_target', 'academic_any_day'))
   OR (table_name = 'tier3_weekly_records'
       AND column_name IN ('academic_minutes', 'released_no_intervention',
                           'release_reason', 'released_by_staff_id',
                           'released_at'))
ORDER BY table_name, column_name;
```

Expect 7 rows. Once present, deploy the matching application build.

## Rollback

Not required — the change is additive and the new columns are ignored by
the prior application build. If you must remove them (e.g. a failed
deploy), drop in the reverse order. **Destructive — data loss for any
academic minutes already logged:**

```sql
ALTER TABLE tier3_weekly_records DROP COLUMN IF EXISTS released_at;
ALTER TABLE tier3_weekly_records DROP COLUMN IF EXISTS released_by_staff_id;
ALTER TABLE tier3_weekly_records DROP COLUMN IF EXISTS release_reason;
ALTER TABLE tier3_weekly_records DROP COLUMN IF EXISTS released_no_intervention;
ALTER TABLE tier3_weekly_records DROP COLUMN IF EXISTS academic_minutes;
ALTER TABLE student_mtss_plans   DROP COLUMN IF EXISTS academic_any_day;
ALTER TABLE student_mtss_plans   DROP COLUMN IF EXISTS academic_minutes_target;
```
