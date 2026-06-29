# PulseEDU — Full Developer Migration Roadmap

**Bringing the LIVE app (`pulseedu.pulsekinetics.us`) up to match current dev.**

| | |
|---|---|
| **Last point dev & live were in sync** | commit `5aaa9a80` — _"Add 1-page Quick Roadmap PDF for school tours"_ (2026-06-22 10:25) |
| **Current dev HEAD (target)** | commit `ae6bca94` (2026-06-27 14:14) |
| **Commits to bring forward** | 50 (2026-06-25 → 2026-06-27) |
| **New dependencies / lockfile changes** | **None** (no `package.json` / `pnpm-lock` changes) |
| **New `.sql` migration files** | None — schema is applied via idempotent boot `ensure*` migrations (see §2) |

> **Note on the "3 days" window.** The work spans June 25–27, but there were **no
> commits on June 23–24**, so the true divergence point — the last commit both
> environments shared — is `5aaa9a80` from **June 22**. This roadmap covers
> everything from there to HEAD.

> **Reality check (important).** The live host is a **separate deployment with
> its own database** that this workspace cannot reach. Nothing here can be pushed
> automatically — this is a manual roadmap your developer runs against the live
> environment. Apply every change against whichever Postgres the **deployed**
> api-server actually connects to.

This document supersedes and consolidates two earlier partial docs, which remain
in the repo for deeper feature detail:
- `docs/dev-changes-2026-06-19_to_2026-06-25.md` (Eligibility, Tours, Student Profile, Pick-Up)
- `docs/migration-report-2026-06-26.md` (Classroom-intervention quick-log)

---

## ⚠️ 0. Read this first — the one thing that will break live

There is **one schema change with NO automatic boot migration**:

- **`staff.is_confidential_secretary`** (the new "Confidential Secretary" role)
  exists in the Drizzle schema and is **read** by `auth.ts`, `adminStaff.ts`,
  `hallPasses.ts`, `onTimeLottery.ts`, and `coreTeam.ts` — but **no
  `ALTER TABLE … ADD COLUMN` for it exists anywhere in `seed.ts`.**

Every *other* new column this window is created automatically when the
api-server boots. This one is **not**. If you deploy the new code to live and
rely only on the normal boot path, the api-server will query a column that does
not exist and **staff/login queries will throw `column "is_confidential_secretary" does not exist`**.

**You MUST run this against the live DB (idempotent, safe to re-run):**

```sql
ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS is_confidential_secretary BOOLEAN NOT NULL DEFAULT FALSE;
```

(Running `pnpm --filter @workspace/db run push` against live also covers it,
since it syncs the full Drizzle schema — see §2 Option B.)

---

## 1. Database changes (the authoritative migration list)

All additive. **No tables dropped, no columns dropped, no type changes, no
destructive operations, no data backfill required.** Existing rows keep working.

### 1a. New tables

**Communication Log + Call Initiative + Contact-Info Fixes** (commit `2cd762e9`):

| Table | Purpose |
|---|---|
| `communication_types` | Per-school editable list of contact methods (Phone, Email, …); rename-preserving, Active/Archived. |
| `communication_logs` | One logged family communication per row (type, who, outcome, tone, note, contactedAt). |
| `call_initiatives` | "Call all families" campaigns (one active per school; completion rule + window). |
| `bad_number_flags` | Bad-phone flags routed to the front office; corrected number is an audited override. |

**Eligibility Hub** (commits `e8a58dd7`…`f8ee3605`; fully detailed in
`docs/dev-changes-2026-06-19_to_2026-06-25.md` §1):

| Table |
|---|
| `eligibility_activities` |
| `eligibility_activity_members` |
| `eligibility_activity_coaches` |
| `eligibility_absences` |
| `eligibility_parent_notes` |
| `eligibility_uploads` |
| `eligibility_notifications` |

### 1b. New columns

| Table | Column | Type | Default | Boot migration? | Feature |
|---|---|---|---|---|---|
| `staff` | `is_confidential_secretary` | BOOLEAN NOT NULL | FALSE | **❌ NO — see §0** | Confidential Secretary role |
| `staff` | `cap_manage_contact_info` | BOOLEAN NOT NULL | FALSE | ✅ yes | Contact-Info Fixes queue |
| `staff` | `is_athletic_director` | BOOLEAN NOT NULL | FALSE | ✅ yes | Eligibility Hub owner |
| `school_settings` | `intervention_effectiveness_days` | INTEGER NOT NULL | 14 | ✅ yes | School-configurable effectiveness window |
| `school_settings` | `eligibility_ineligibility_threshold` | INTEGER NOT NULL | 10 | ✅ yes | Eligibility |
| `school_settings` | `eligibility_warning_window_days` | INTEGER NOT NULL | 4 | ✅ yes | Eligibility |
| `school_settings` | `eligibility_tardy_to_absence_ratio` | INTEGER NOT NULL | 0 | ✅ yes | Eligibility |
| `school_settings` | `eligibility_parent_note_cap` | INTEGER NOT NULL | 5 | ✅ yes | Eligibility |
| `school_settings` | `eligibility_district_ad_notify` | BOOLEAN NOT NULL | FALSE | ✅ yes | Eligibility |
| `school_settings` | `eligibility_semester_label` | TEXT NOT NULL | `''` | ✅ yes | Eligibility |
| `school_settings` | `eligibility_semester_start` | TEXT (null) | — | ✅ yes | Eligibility |
| `school_settings` | `eligibility_semester_end` | TEXT (null) | — | ✅ yes | Eligibility |
| `school_settings` | `feature_eligibility` | BOOLEAN NOT NULL | TRUE | ✅ yes | Eligibility feature flag |
| `school_settings` | `super_feature_eligibility` | BOOLEAN NOT NULL | TRUE | ✅ yes | Eligibility feature flag |
| `intervention_entries` | `behavior_reason` | TEXT (null) | — | ✅ yes | Quick-log effectiveness |

### 1c. Explicit SQL appendix (idempotent — for manual / non-boot environments)

Run this whole block if you are applying by hand. Every statement is
`IF NOT EXISTS`, so it is safe to re-run and safe on a DB that already has some
of these.

```sql
-- ===== New columns =====
ALTER TABLE staff           ADD COLUMN IF NOT EXISTS is_confidential_secretary BOOLEAN NOT NULL DEFAULT FALSE; -- §0: no boot migration!
ALTER TABLE staff           ADD COLUMN IF NOT EXISTS cap_manage_contact_info   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE staff           ADD COLUMN IF NOT EXISTS is_athletic_director      BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE intervention_entries ADD COLUMN IF NOT EXISTS behavior_reason TEXT;

ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS intervention_effectiveness_days     INTEGER NOT NULL DEFAULT 14;
ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS eligibility_ineligibility_threshold INTEGER NOT NULL DEFAULT 10;
ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS eligibility_warning_window_days     INTEGER NOT NULL DEFAULT 4;
ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS eligibility_tardy_to_absence_ratio  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS eligibility_parent_note_cap         INTEGER NOT NULL DEFAULT 5;
ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS eligibility_district_ad_notify      BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS eligibility_semester_label          TEXT NOT NULL DEFAULT '';
ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS eligibility_semester_start          TEXT;
ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS eligibility_semester_end            TEXT;
ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS feature_eligibility                 BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS super_feature_eligibility           BOOLEAN NOT NULL DEFAULT TRUE;

-- ===== New tables: Communication Log + Call Initiative + Contact-Info Fixes =====
CREATE TABLE IF NOT EXISTS communication_types (
  id         SERIAL PRIMARY KEY,
  school_id  INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS communication_types_school_id_name_unique
  ON communication_types (school_id, name);

CREATE TABLE IF NOT EXISTS communication_logs (
  id            SERIAL PRIMARY KEY,
  school_id     INTEGER NOT NULL,
  student_id    TEXT    NOT NULL,
  type          TEXT    NOT NULL,
  who_contacted TEXT,
  outcome       TEXT    NOT NULL,
  tone          TEXT    NOT NULL DEFAULT 'neutral',
  note          TEXT,
  staff_id      INTEGER NOT NULL,
  staff_name    TEXT    NOT NULL,
  contacted_at  TIMESTAMPTZ NOT NULL,
  logged_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS communication_logs_school_student_idx   ON communication_logs (school_id, student_id);
CREATE INDEX IF NOT EXISTS communication_logs_school_contacted_idx ON communication_logs (school_id, contacted_at);

CREATE TABLE IF NOT EXISTS bad_number_flags (
  id                 SERIAL PRIMARY KEY,
  school_id          INTEGER NOT NULL,
  student_id         TEXT    NOT NULL,
  contact_slot       INTEGER NOT NULL,
  contact_label      TEXT,
  bad_phone          TEXT,
  reason             TEXT    NOT NULL,
  status             TEXT    NOT NULL DEFAULT 'open',
  flagged_by_staff_id INTEGER NOT NULL,
  flagged_by_name    TEXT    NOT NULL,
  flagged_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  corrected_phone    TEXT,
  resolved_by_staff_id INTEGER,
  resolved_by_name   TEXT,
  resolved_at        TIMESTAMPTZ,
  note               TEXT
);
CREATE INDEX IF NOT EXISTS bad_number_flags_school_status_idx  ON bad_number_flags (school_id, status);
CREATE INDEX IF NOT EXISTS bad_number_flags_school_student_idx ON bad_number_flags (school_id, student_id);

CREATE TABLE IF NOT EXISTS call_initiatives (
  id                 SERIAL PRIMARY KEY,
  school_id          INTEGER NOT NULL,
  name               TEXT    NOT NULL,
  start_date         TEXT    NOT NULL,
  window_days        INTEGER NOT NULL DEFAULT 14,
  responsible_period INTEGER NOT NULL DEFAULT 1,
  completion_rule    TEXT    NOT NULL DEFAULT 'balanced',
  attempts_required  INTEGER NOT NULL DEFAULT 2,
  active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_staff_id INTEGER,
  created_by_name    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS call_initiatives_school_active_idx ON call_initiatives (school_id, active);
```

> **Eligibility tables** (`eligibility_*`) are created by `ensureEligibilitySchema()`
> at boot. If you must hand-create them, run `pnpm db push` (§2 Option B) instead
> of transcribing — the exact column set is in `lib/db/src/schema/eligibility.ts`.

---

## 2. How to apply the migration

This repo does **not** use drizzle-kit migration files. Schema is brought
forward by **idempotent `ensure*` boot migrations** in
`artifacts/api-server/src/seed.ts`, which run automatically on api-server
startup. (`ensureCommunicationSchema()` and `ensureEligibilitySchema()` are
wired into boot in `artifacts/api-server/src/index.ts`.)

**Option A — Standard deploy (recommended):**
1. Deploy the new code to live.
2. **Confirm the api-server actually restarts** — the boot path is where the
   migrations run.
3. **Run the §0 SQL manually** for `is_confidential_secretary` (the only column
   with no boot migration).
4. Verify with §7.

**Option B — Sync the full schema directly:**
- Point `DATABASE_URL` at the **live** DB and run
  `pnpm --filter @workspace/db run push`. This syncs the entire Drizzle schema
  (source of truth in `lib/db/src/schema/*.ts`), including
  `is_confidential_secretary`, so §0 is covered automatically. Use this if your
  live host does not run the app's boot seeder.

**Option C — Fully manual:** run the entire §1c SQL block (plus the eligibility
tables via Option B) by hand before/with the deploy.

---

## 3. Environment variables / secrets

**No new env vars or secrets were introduced this window.** A grep of the new
route/lib files found no new `process.env.*` reads.

Pre-existing vars the new email features **reuse** (confirm they are set on live
if you want the Eligibility digest/alerts to send):
- `EMAIL_REMINDERS_ENABLED=true`
- `RESEND_FROM_ADDRESS` set + the Resend integration connected
- Public URLs/QRs resolve via `PUBLIC_APP_URL` → `$REPLIT_DOMAINS` (prod) — never `$REPLIT_DEV_DOMAIN`

---

## 4. Code areas touched

### Server — `artifacts/api-server/src/`

| File | Change |
|---|---|
| `routes/communications.ts` | **NEW** — Communication Log + Call Initiative (P1–P5) + bad-number flags. |
| `routes/eligibility.ts` | **NEW** — ~21 Eligibility Hub routes. |
| `lib/eligibility.ts`, `lib/eligibilityNotify.ts` | **NEW** — eligibility logic + Resend notifications. |
| `routes/interventions.ts` | quick-log, effectiveness, per-student report; `behaviorReason`. |
| `routes/schoolSettings.ts` | new settings fields (effectiveness window, eligibility config). |
| `routes/adminStaff.ts` | Confidential Secretary + `cap_manage_contact_info` + AD role assignment. |
| `routes/auth.ts` | `publicStaff()` exposes `isConfidentialSecretary`, `isAthleticDirector`. |
| `routes/insights.ts` | counselors get school-wide student visibility (behavior change, no DB). |
| `routes/studentLookup.ts`, `routes/hallPasses.ts` | role plumbing. |
| `lib/coreTeam.ts` | `isConfidentialSecretary` ORed into `isCoreTeam()`; `canManageEligibility()`. |
| `lib/featureLicensing.ts`, `lib/onboardingSteps.ts`, `lib/onTimeLottery.ts` | feature flag + onboarding + role plumbing. |
| `seed.ts`, `index.ts` | new `ensure*` migrations + boot wiring. |

### Client — `artifacts/client/src/`

| File | Change |
|---|---|
| `components/CallInitiativePanel.tsx` | **NEW** — Call Initiative UI. |
| `components/ContactFixesPage.tsx`, `ContactRatePage.tsx` | **NEW** — Contact-Info Fixes queue + contact-rate report. |
| `components/EligibilityHub.tsx` | **NEW** — 4-tab Eligibility Hub. |
| `components/InterventionTypesAdmin.tsx`, `PulloutReasonsAdmin.tsx` | **NEW** — list management. |
| `components/StudentPicker.tsx` | **NEW** — standardized student/staff search. |
| `App.tsx` | sidebar nav consolidation (Phases 0–5), Quick Access favorites, "Student Support" rename, new sections wiring, Classroom Intervention Report. |
| `components/PbisPointsHub.tsx` | color-first Positive/Negative fork, Manage Lists relocation. |
| `components/TeacherRosterPage.tsx` | per-row quick-log modal, sticky headers, bulk-upload redesign + sample file. |
| `components/MtssPlansAdmin.tsx`, `MtssReportsPage.tsx`, `MyInterventionsPage.tsx`, `InsightsHub.tsx` | report tabs, intervention-tried column, chips. |
| `components/SettingsHub.tsx`, `StaffRolesMatrix.tsx` | new settings + role assignment. |
| `components/StudentLookupPage.tsx`, `StudentProfile.tsx`, `AddDisciplineLogModal.tsx`, `watchlist/LogInteractionModal.tsx` | standardized search + profile tweaks. |
| `studio/RecordingStudio.tsx`, `index.css` | CapCut-style teleprompter redesign + camera orientation. |

All client work is **build-and-deploy-the-bundle** — no migration.

---

## 5. Build / codegen steps

- `pnpm install` (no new deps, but run for parity).
- **No OpenAPI/orval codegen needed** — new routes are consumed with `authFetch`
  directly, not generated hooks. (`pnpm-lock.yaml` and `api-spec` are unchanged.)
- `pnpm run typecheck` — clean as of HEAD.
- `pnpm run build` for production.
- **Restart the api-server after deploy** so the boot `ensure*` migrations run
  and the new routes mount.

---

## 6. Deploy ordering & rollback

**Ordering:** every schema change is additive + nullable/defaulted and the
server reads new fields as optional → **no breaking change**. Apply DB changes
(or let boot run them) + the §0 manual SQL, then deploy server, then client. An
older client keeps working against the new server.

**Rollback:**
- **Code:** redeploy the previous build (the `5aaa9a80`-era artifact), or roll
  back to a Replit checkpoint. Code rollback is safe and self-contained.
- **DB:** the additive columns/tables are **harmless to leave in place** after a
  code rollback (old code simply ignores them) — this is the recommended,
  zero-risk rollback. Only if you must fully revert schema, the new tables can be
  dropped and the new columns dropped; there is no data the old code depends on.
  Dropping is destructive (loses any communication logs / eligibility data
  captured post-deploy) — prefer leaving them.

---

## 7. Post-deploy verification

1. **The §0 column exists** (this is the most likely failure):
   ```sql
   SELECT column_name FROM information_schema.columns
   WHERE table_name='staff' AND column_name='is_confidential_secretary';
   ```
2. **New tables exist:**
   ```sql
   SELECT table_name FROM information_schema.tables
   WHERE table_name IN ('communication_logs','communication_types','call_initiatives',
     'bad_number_flags','eligibility_activities','eligibility_absences');
   ```
3. **New routes mounted + gated** (expect HTTP 401 unauthenticated):
   `/api/communications/*`, `/api/eligibility/*`, `/api/interventions/quick-log`.
4. **Login works** (proves `staff` selects don't hit a missing column).
5. Smoke each new surface: Communication Log + Call Initiative, Contact-Info
   Fixes (front office), Eligibility Hub (Athletic Director / Core Team), PBIS
   Points color-first entry, Teacher Roster quick-log, Classroom Intervention
   Report, the consolidated sidebar nav.
6. Assign the new roles where needed: **Confidential Secretary**, **Athletic
   Director**, **`cap_manage_contact_info`** (Contact-Info Fixes).

---

## 8. Divergences flagged

1. **🔴 `staff.is_confidential_secretary` has no boot migration** (§0). This also
   affects any *fresh* dev deploy that relies on the boot path. Recommend either
   running the §0 SQL on live now, or adding the missing
   `ALTER TABLE staff ADD COLUMN IF NOT EXISTS is_confidential_secretary …` to
   `ensureCommunicationSchema()` in `seed.ts` so it self-heals everywhere. _(I
   did not change code — say the word and I'll add the boot migration.)_
2. **Counselor visibility widened** (`insights.ts` `getVisibleStudentIds`):
   school counselors now get school-wide student visibility through
   lookup/profile/schedule/watchlist. Behavior change, no DB change, intentional.
3. **Eligibility texting is stubbed** — email sends via Resend; SMS is a stub (no
   provider wired). Not a blocker.
