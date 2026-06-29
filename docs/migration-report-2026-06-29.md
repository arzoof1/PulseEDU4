# PulseEDU — Complete Developer Migration Report (2026-06-29)

**Purpose:** bring the LIVE site up to the current dev `HEAD`. Read top to
bottom. Section **0** and **1** are the only parts that *will break live if
skipped*; everything else either auto-applies on deploy or is informational.

| | |
|---|---|
| **Last point dev & live were in sync** | `5aaa9a80` — _"Add 1-page Quick Roadmap PDF for school tours"_ (2026-06-22) |
| **Current dev HEAD (target)** | `fbd6847b` — _"Add controls for parent notification emails"_ (2026-06-28) |
| **New dependencies / lockfile changes** | **None** (only a dev-only `brochure-pdf` npm script was added) |
| **New `.sql` migration files** | None — schema is applied via idempotent boot `ensure*` migrations, **except the items in §0** |

> **Reality check.** The live host (`pulseedu.pulsekinetics.us`) is a **separate
> deployment with its own database** that this workspace cannot reach. Nothing
> here is pushed automatically — this is a manual runbook you execute against
> whichever Postgres the **deployed** api-server connects to. Apply every change
> in §0 against the LIVE database, then deploy.

This report **supersedes and consolidates** the earlier partial docs (kept for
deeper per-feature detail):
`docs/migration-roadmap-2026-06-22_to_2026-06-27.md`,
`docs/migration-report-2026-06-26.md`,
`docs/dev-changes-2026-06-19_to_2026-06-25.md`.

---

## 0. ⚠️ READ FIRST — schema changes with NO automatic boot migration

Most additive schema this window is applied automatically at API-server boot
(see §2). **These are the exceptions.** They exist in the Drizzle schema and
are read/written by live code, but there is **no `ALTER TABLE … IF NOT EXISTS`
for them in `seed.ts`.** On dev they were created by `db push`; on live they
will be **missing** unless you apply them. A missing column makes the relevant
`SELECT`/`INSERT` throw at runtime.

### Recommended path (one command, authoritative)

Point your DB tooling at the **live** database and run:

```bash
pnpm --filter @workspace/db run push
```

`db push` derives exact DDL from `lib/db/src/schema/*.ts` (the source of truth)
and applies every diff below in one shot. **Caveat:** push can stall on an
interactive "rename vs. create?" prompt — if it does, answer *create column* /
*create table* (never *rename*), or use the explicit SQL fallback below.

### Explicit SQL fallback (idempotent — safe to re-run)

```sql
-- 0.1  Confidential Secretary role (read by auth.ts, adminStaff.ts,
--      hallPasses.ts, onTimeLottery.ts, coreTeam.ts). THE #1 thing that
--      breaks login/role checks on live if missing.
ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS is_confidential_secretary BOOLEAN NOT NULL DEFAULT FALSE;

-- 0.2  School Store redemption engine (Task #60) — NEW TABLE.
CREATE TABLE IF NOT EXISTS school_store_redemptions (
  id                    SERIAL PRIMARY KEY,
  school_id             INTEGER NOT NULL,
  item_id               INTEGER NOT NULL,
  student_id            TEXT    NOT NULL,          -- FLEID, internal join key only
  item_name             TEXT    NOT NULL,          -- snapshot
  points_spent          INTEGER NOT NULL,          -- snapshot
  status                TEXT    NOT NULL DEFAULT 'pending',
  requested_by_type     TEXT    NOT NULL,          -- staff | parent | student
  requested_by_id       INTEGER,
  approved_by_staff_id  INTEGER,
  approved_at           TEXT,
  fulfilled_by_staff_id INTEGER,
  fulfilled_at          TEXT,
  deliver_teacher_name  TEXT,
  deliver_period        TEXT,
  cancelled_by_staff_id INTEGER,
  cancelled_at          TEXT,
  cancel_reason         TEXT,
  stock_held            BOOLEAN NOT NULL DEFAULT FALSE,
  points_refunded       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TEXT    NOT NULL,
  updated_at            TEXT
);
CREATE INDEX IF NOT EXISTS school_store_redemptions_school_status_idx
  ON school_store_redemptions (school_id, status);
CREATE INDEX IF NOT EXISTS school_store_redemptions_school_student_idx
  ON school_store_redemptions (school_id, student_id);
CREATE INDEX IF NOT EXISTS school_store_redemptions_school_item_idx
  ON school_store_redemptions (school_id, item_id);

-- 0.3  School Store item inventory/approval columns (new this window).
ALTER TABLE school_store_items
  ADD COLUMN IF NOT EXISTS in_stock          BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE school_store_items
  ADD COLUMN IF NOT EXISTS quantity_on_hand  INTEGER;
ALTER TABLE school_store_items
  ADD COLUMN IF NOT EXISTS per_student_limit INTEGER;
ALTER TABLE school_store_items
  ADD COLUMN IF NOT EXISTS requires_approval BOOLEAN NOT NULL DEFAULT FALSE;

-- 0.4  School Store inventory mode (per-school: 'simple' | 'quantity').
ALTER TABLE school_settings
  ADD COLUMN IF NOT EXISTS school_store_inventory_mode TEXT NOT NULL DEFAULT 'simple';

-- 0.5  Parent Notifications panel (HEAD commit). Default TRUE preserves
--      today's send behavior — no notifications change until an admin flips one.
ALTER TABLE school_settings
  ADD COLUMN IF NOT EXISTS notify_parent_eligibility    BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE school_settings
  ADD COLUMN IF NOT EXISTS notify_parent_pbis_milestone BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE school_settings
  ADD COLUMN IF NOT EXISTS notify_parent_tardy          BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE school_settings
  ADD COLUMN IF NOT EXISTS notify_parent_event_tickets  BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE school_settings
  ADD COLUMN IF NOT EXISTS notify_parent_esign          BOOLEAN NOT NULL DEFAULT TRUE;
```

> If you prefer "apply only what's missing", every statement above is
> `IF NOT EXISTS`, so running the whole block twice is harmless.

---

## 1. Deploy order (do this exactly)

1. **Back up the live database** (single most important step before any DDL).
2. Apply **§0** against the live DB (either `db push` *or* the SQL block).
3. **Deploy / publish** the new build. On boot the api-server runs all the
   `ensure*` migrations in §2 automatically (additive, idempotent) and runs the
   one-shot data jobs in §3.
4. Confirm boot succeeded (no errors in the deploy logs) and walk the
   **verification checklist** in §6.

There is **no required ordering between §2 items** — they're all
`IF NOT EXISTS`. The only hard rule is: **§0 before the app serves traffic.**

---

## 2. Auto-applied at boot (no action needed — informational)

These run every boot from `seed.ts` / `index.ts` and are safe/idempotent. Listed
so you can verify them post-deploy if a feature misbehaves.

**New tables**
| Table | Created by (boot fn) | Feature |
|---|---|---|
| `communication_types`, `communication_logs`, `bad_number_flags`, `call_initiatives` | `ensureCommunicationSchema` | Communication Log + Call Initiative |
| `eligibility_activities`, `eligibility_activity_members`, `eligibility_activity_coaches`, `eligibility_absences` | `ensureEligibilitySchema` | Eligibility Hub |
| `teacher_allowlist_import_batches`, `teacher_allowlist_zone_rules` | `ensureHallPassAllowlistSchema` | Hall-pass bulk destination mgmt |
| `pbis_point_migrations` | `ensurePbisPointMigrationsSchema` | PBIS point-balance import |
| `app_one_shot_markers` | inline (see §3) | one-shot job ledger |

**New columns (auto)**
| Table | Column(s) | Boot fn |
|---|---|---|
| `staff` | `cap_manage_contact_info`, `house_id`, `department`, `title`, `is_athletic_director` | `ensureHousesSchema` / inline |
| `students` | `sso_external_id`, `last_portal_login_at` | `ensureHousesSchema` |
| `intervention_entries` | `behavior_reason` | `ensureInterventionEntriesSchema` |
| `pbis_entries`, `pbis_milestone_emails` | `import_job_id` | `ensurePbisPointMigrationsSchema` |
| `locations` | `restroom_area`, `gender`, `school_wide_default` | `ensureHallPassAllowlistSchema` |
| `teacher_destination_allowlist` | `staff_id` (+ staffId-keyed unique index) | `ensureHallPassAllowlistSchema` |
| `school_settings` | `intervention_effectiveness_days`, `iready_ap1_cuts`, `feature_eligibility`, `super_feature_eligibility`, plan/feature-licensing flags | various `ensure*` |

> ⚠️ Note the asymmetry: `staff.is_athletic_director` **has** a boot ALTER, but
> `staff.is_confidential_secretary` does **not** — that's why the latter is in
> §0 and the former is here.

---

## 3. One-shot data jobs (auto, run once on first boot)

Each guards itself with a row in `app_one_shot_markers`, so it runs exactly once
per environment and is a no-op on every later boot. No action required — listed
for awareness:

- **Enterprise/licensing fold** — re-applies feature-licensing plans to existing
  schools (`reapplyLicensingToSchool`).
- **Parrott room-location seed**, **demo-email normalization**, **SuperUser
  recovery** — environment-hygiene one-shots.

If you ever need to *re-run* one against live, delete its marker row by name from
`app_one_shot_markers` and reboot.

---

## 4. Environment variables / secrets

**No new *required* secrets.** Verify the existing email path is configured
(unchanged, but the new notifications depend on it):

- `RESEND_API_KEY` / `RESEND_FROM_ADDRESS` — required for any parent email
  (HeartBEAT, eligibility, tickets, e-sign, etc.).
- `EMAIL_REMINDERS_ENABLED` — gates the scheduled email crons.

**New, optional (have safe defaults):**
- `ELIGIBILITY_DIGEST_CRON` (default `0 7 * * 1`) — weekly eligibility digest schedule.
- `ELIGIBILITY_DIGEST_TZ` (default `America/New_York`).

**🔒 Security — must NOT be set on live:**
- `STUDENT_DEMO_LOGIN` — when `=1` it enables a **password-less student portal
  login bypass** (dev convenience only). Ensure it is **unset / not `1`** in
  production.

---

## 5. What shipped this window (feature summary)

Code-only unless a DB note is attached; all DB notes are covered by §0/§2.

- **Parent Notifications panel** (HEAD) — per-school admin toggles for each
  automated parent email; all default to current behavior. *DB: §0.5.*
- **School Store redemption engine + points wallet** — student/parent/staff
  redemptions, Core Team fulfillment dashboard, inventory modes (simple/qty),
  per-student limits, approval flow, point-balance import. *DB: §0.2–0.4, §2.*
- **Student ClassLink portal + HeartBEAT + self-redeem** — SSO student login,
  student dashboard/store. *DB: `students.sso_external_id`,
  `last_portal_login_at` (§2). Security: `STUDENT_DEMO_LOGIN` (§4).*
- **Communication Log + Call Initiative** — contact logging, bad-number flags,
  "call all families" campaigns. *DB: §2.*
- **Feature Licensing** — Starter / Starter Plus / Enterprise plans, dependency
  checks, school search. *DB: §2 + one-shot fold (§3).*
- **Hall-pass bulk destination management** — CSV round-trip + zone rules.
  *DB: §2.*
- **PBIS** — color-first positive/negative entry, point-balance migration,
  weekend activity in weekly totals, all-awarder staff reporting, school-wide
  usage benchmark.
- **Insights drill-downs** — FAST achievement-level pills, PM progression +
  score deltas, attendance/FAST metric columns, wider student popups.
- **Classroom Intervention Report** — evaluate-by-teacher, CSV/PDF, configurable
  effectiveness window. *DB: `intervention_entries.behavior_reason` (§2),
  `school_settings.intervention_effectiveness_days` (§2).*
- **Confidential Secretary role** — reusable full-Core-Team role. *DB: §0.1.*
- **Sidebar / nav** — role-aware groups, pending-count badges, customizable
  quick access, consolidated staff-time hub.
- **Recording Studio** — CapCut-style fullscreen teleprompter, orientation-aware
  capture (code-only).
- **Eligibility Hub** — attendance-driven participation eligibility. *DB: §2.*
- Roster sticky headers, roll-call filters, sample-file downloads (code-only).
- Demo/slide artifacts updated (no effect on the staff app).

---

## 6. Post-deploy verification checklist

- [ ] Live DB backed up before any DDL.
- [ ] §0 applied (push succeeded, or all SQL ran without error).
- [ ] `\d staff` shows `is_confidential_secretary`; `\d school_store_redemptions`
      exists; `\d school_settings` shows the five `notify_parent_*` columns +
      `school_store_inventory_mode`.
- [ ] App boots clean (deploy logs show no migration errors).
- [ ] Admin can open **Family → Parent Notifications** and toggle a switch (PUT
      returns 200).
- [ ] A student/family can open the **School Store**; a redemption creates a row
      and the wallet math is correct.
- [ ] Staff login works for a Confidential-Secretary-flagged user.
- [ ] `STUDENT_DEMO_LOGIN` is unset in the live environment.
- [ ] `RESEND_*` configured; send one test parent email.

---

## 7. Rollback

- The **code** rolls back by redeploying the previous build.
- The **schema** changes in §0/§2 are **purely additive** (new tables, new
  nullable/defaulted columns) — they are backward-compatible, so the previous
  build keeps working against the new schema. There is **no destructive change
  to undo**; you generally do **not** need to drop anything on rollback.
