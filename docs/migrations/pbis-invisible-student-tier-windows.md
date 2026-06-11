# Migration — Tier-Aware "Invisible Student" Windows

Additive, idempotent schema change that replaces the single per-school
"Invisible Student" alert window (`pbis_invisible_student_days`) with three
tier-aware windows. A student is flagged "invisible" when they have **0
non-voided PBIS recognitions** within the window for their **highest active
MTSS tier**:

- **Tier 1** (no active MTSS plan) — default **8** school days
- **Tier 2** (active Tier 2 plan) — default **5** school days
- **Tier 3** (active Tier 3 plan) — default **3** school days

Higher-need students surface faster. Schools can edit all three thresholds
in **Settings → PBIS thresholds**.

## Scope

`school_settings` gains three columns. All are `NOT NULL` with safe
defaults, so the change is **online-safe** and **backward compatible** —
existing rows get 8/5/3 automatically.

- `school_settings`
  - `pbis_invisible_days_tier1 INTEGER NOT NULL DEFAULT 8`
  - `pbis_invisible_days_tier2 INTEGER NOT NULL DEFAULT 5`
  - `pbis_invisible_days_tier3 INTEGER NOT NULL DEFAULT 3`

The legacy `pbis_invisible_student_days` column is **left in place** (no
longer read) to avoid a destructive migration. It can be dropped later in a
separate cleanup once no environment references it.

## How dev / Replit apply this

On the Replit deployment these statements run automatically at boot via
`ensurePbisInvisibleTierColumns()` in `artifacts/api-server/src/seed.ts`
(wired into `runSeed` in `index.ts`). No manual step is needed there.

## AWS production — run once

The AWS prod database is a **separate host** that this workspace cannot
reach, so a developer must apply the change manually. Run the block below
against the prod database (psql, RDS query editor, or your migration
runner). Every statement is `IF NOT EXISTS`, so the script is safe to
re-run and safe if some columns already exist.

```sql
BEGIN;

ALTER TABLE school_settings
  ADD COLUMN IF NOT EXISTS pbis_invisible_days_tier1 INTEGER NOT NULL DEFAULT 8;
ALTER TABLE school_settings
  ADD COLUMN IF NOT EXISTS pbis_invisible_days_tier2 INTEGER NOT NULL DEFAULT 5;
ALTER TABLE school_settings
  ADD COLUMN IF NOT EXISTS pbis_invisible_days_tier3 INTEGER NOT NULL DEFAULT 3;

-- Apply the agreed 8/5/3 baseline to every existing school. The ADD COLUMN
-- DEFAULT already backfills new columns, so this is belt-and-suspenders to
-- normalize any rows that may have been set otherwise.
UPDATE school_settings
SET pbis_invisible_days_tier1 = 8,
    pbis_invisible_days_tier2 = 5,
    pbis_invisible_days_tier3 = 3;

COMMIT;
```

## Verification

```sql
SELECT school_id,
       pbis_invisible_days_tier1,
       pbis_invisible_days_tier2,
       pbis_invisible_days_tier3
FROM school_settings
ORDER BY school_id;
```

Every row should read `8 / 5 / 3` immediately after the migration. Schools
may subsequently tune their own values in Settings → PBIS thresholds (each
field is validated to 1–180 school days).

## Rollback

The change is purely additive. To roll back, drop the three columns (the
legacy `pbis_invisible_student_days` column is untouched and still present):

```sql
ALTER TABLE school_settings DROP COLUMN IF EXISTS pbis_invisible_days_tier1;
ALTER TABLE school_settings DROP COLUMN IF EXISTS pbis_invisible_days_tier2;
ALTER TABLE school_settings DROP COLUMN IF EXISTS pbis_invisible_days_tier3;
```
