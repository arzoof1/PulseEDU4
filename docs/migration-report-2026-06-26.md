# Dev Migration Report — Classroom Interventions Quick-Log (2026-06-26)

Handoff notes for deploying today's new features to another environment
(staging / production / a non-Replit Postgres). Read top to bottom — the
**DB Changes** and **How the migration is applied** sections are the only
parts that touch the database; everything else is application code.

Commits in scope (most recent first):

- `833449d6` Roster quick-log: behavior + classroom interventions with effectiveness
- `e0d044ed` Roster quick-log: behavior + classroom interventions with effectiveness

(Earlier 2026-06-26 commits — Recording Studio redesign, Student Profile
fixes, teleprompter/orientation — are **code-only, no DB changes**. They are
not part of this migration beyond a normal build/deploy.)

---

## 1. DB Changes (the only schema change today)

**One additive, nullable column. No new tables, no new indexes, no
constraint or type changes, no data backfill.**

| Table | Column | Type | Nullable | Default | Purpose |
|---|---|---|---|---|---|
| `intervention_entries` | `behavior_reason` | `TEXT` | yes | `NULL` | Snapshot of the behavior (`pbis_reasons.name`) the intervention was logged to address. Drives the "what has worked before for this student" effectiveness insight. |

Equivalent raw SQL (idempotent):

```sql
ALTER TABLE intervention_entries
  ADD COLUMN IF NOT EXISTS behavior_reason TEXT;
```

- Existing rows keep `behavior_reason = NULL` (standalone interventions
  logged without a paired behavior are valid and stay null).
- Schema source of truth updated: `lib/db/src/schema/interventionEntries.ts`.

---

## 2. How the migration is applied

This project does **not** use drizzle-kit migration files for additive
changes. Schema is brought forward by **idempotent boot-time ALTERs** (see
`replit.md` → "API Versioning/Schema Evolution").

- The column is created automatically on api-server startup by
  `ensureInterventionEntriesSchema()` in `artifacts/api-server/src/seed.ts`,
  which is called from `seedFastScoresIfEmpty()` during boot.
- It runs `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so it is safe to run
  repeatedly and on a DB that already has the column.

**What this means for the developer:**

- **Standard Replit deploy:** nothing to do manually — just deploy and let
  the api-server boot. The ALTER runs on startup. Confirm the api-server
  actually restarts after the deploy/merge (the boot path is where the
  migration lives).
- **Non-Replit / managed Postgres where the app boot does not run the
  seeder:** run the SQL in section 1 by hand before (or with) the deploy.

> Note: per project history, the live production database is a **separate
> host** from this workspace's DB. Apply the change against whichever DB the
> deployed api-server actually connects to.

---

## 3. New environment variables / secrets

**None.** The feature reuses the existing PBIS and intervention systems and
the existing auth/session. No new env vars, secrets, or third-party
integrations were added.

---

## 4. API routes (no migration; for the dev's awareness)

In `artifacts/api-server/src/routes/interventions.ts`:

- `POST /api/interventions` — now also accepts an optional `behaviorReason`
  in the body (backward compatible).
- **NEW** `POST /api/interventions/quick-log` — atomic write. In one DB
  transaction it inserts one `pbis_entries` row (negative behavior, mirroring
  `POST /pbis` polarity/points + `pbisNegativeAffectsTotal` handling) plus one
  `intervention_entries` row per selected intervention type, then runs
  `processMilestonesForStudent` for parity. Body:
  `{ studentId, reasonId, interventionTypeIds: number[], note? }`.
- **NEW** `GET /api/interventions/effectiveness?studentId&behaviorReason` —
  derived effectiveness ("worked" = same behavior did not recur within a
  14-day window). Any signed-in staff.
- **NEW** `GET /api/interventions/student-report/:studentId` — Core-Team-gated
  per-student report (behaviors across teachers, interventions by teacher,
  effectiveness summary).

In `artifacts/api-server/src/routes/insights.ts`:

- `getVisibleStudentIds()` — **behavior change:** school counselors
  (`is_counselor` OR `is_guidance_counselor`) now receive school-wide student
  visibility, matching the documented student-lookup contract. This widens
  what counselors can see through the student-lookup/profile/schedule and
  watchlist surfaces. It intentionally does **not** widen the insights
  dashboard gate. No DB change.

Client: per-row "Log" modal on the Teacher Roster
(`artifacts/client/src/components/TeacherRosterPage.tsx`) and a Core-Team
admin report in `artifacts/client/src/App.tsx`. These call the routes above
with `authFetch` directly.

---

## 5. Build / codegen steps

- `pnpm install` (no new dependencies were added, but run it for parity).
- **No OpenAPI/orval codegen required** — the new routes are consumed with
  `authFetch` directly, not generated hooks, so no
  `@workspace/api-spec` regeneration is needed for this work.
- Typecheck / build as usual:
  - `pnpm run typecheck` (libs + all packages) — clean as of this commit.
  - `pnpm run build` for a production build.
- Restart the api-server after deploy so the boot ALTER runs and the new
  routes load.

---

## 6. Deploy ordering & safety

- The column is **additive + nullable** and the server reads it as optional,
  so there is **no breaking change**. Server can deploy before or after the
  client; an old client keeps working (it just won't send `behaviorReason`).
- No destructive operations. No data deletion or rewrites.

---

## 7. Post-deploy verification

1. Confirm the column exists:
   ```sql
   SELECT column_name
   FROM information_schema.columns
   WHERE table_name = 'intervention_entries'
     AND column_name = 'behavior_reason';
   ```
2. Confirm the new routes are mounted and gated (expect HTTP 401 when
   unauthenticated):
   ```
   POST /api/interventions/quick-log
   GET  /api/interventions/effectiveness?studentId=x&behaviorReason=y
   GET  /api/interventions/student-report/x
   ```
3. As a teacher: open the Teacher Roster → "Log" on a student → pick a
   behavior + intervention(s) → save. Verify one PBIS entry and one
   intervention row are written (and `intervention_entries.behavior_reason`
   is populated).
4. As Core Team: open the Classroom Interventions admin section → search a
   student → confirm the report renders.
5. As a counselor: confirm school-wide student lookup/profile access works.

---

## Summary for the developer

> The only database change is `ALTER TABLE intervention_entries ADD COLUMN
> IF NOT EXISTS behavior_reason TEXT;`. It is applied automatically on
> api-server boot (idempotent), or run it by hand if your environment does
> not run the app's boot seeder. No new env vars, no new tables, no backfill,
> no breaking changes. Everything else is application code — deploy, restart
> the api-server, and verify with section 7.
