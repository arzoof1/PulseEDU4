# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Staff & Roles (April 2026)

PulseED has a per-page capability system on the `staff` table (`cap_*` columns)
that's gradually replacing the legacy role flags (`is_admin`, `is_dean`, etc.).
The Staff & Roles matrix at `/` (nav: "Staff & Roles") lets Admin/SuperUser
toggle each capability per user and apply role presets.

- New role flags: `is_super_user`, `is_counselor`, `is_social_worker`.
- New caps: `cap_staff_roles` (view matrix), `cap_manage_roles` (create custom roles).
- `custom_roles` table stores SuperUser-defined preset bundles (capabilities[] jsonb).
- Auth gating:
  - `cap_staff_roles` alone lets a user view the matrix and toggle ordinary caps.
  - Only Admin/SuperUser can change `is_admin`, `cap_staff_roles`, `cap_manage_roles`.
  - Only SuperUser can change `is_super_user`.
  - Custom-role capability strings are whitelisted server-side; `is_*` flags
    cannot be embedded in a custom role.
- Seeded SuperUsers: `chris.clifford@school.local`, `brandon.wright@school.local`
  (temp password `ChangeMe!2026`).

Files: `lib/db/src/schema/{staff,customRoles}.ts`,
`artifacts/api-server/src/routes/{adminStaff,customRoles}.ts`,
`artifacts/client/src/components/StaffRolesMatrix.tsx`.

## UI Style Conventions (April 2026)

- **Default for all new top-level section pages**: Hub Section Header treatment
  — a teal accent bar (`.section-header-bar-teal`) on top of a teal→purple
  gradient band (`.section-header-band-hub`) containing the section title in
  white, 1.5rem, bold. Defined in `artifacts/client/src/index.css`. Apply this
  by default unless the user explicitly asks for a different treatment.
- **Back / cancel buttons**: light-purple pill style — `#ede9fe` background,
  `#6d28d9` text, `#ddd6fe` border (referred to as "back-button-purple").
- **Primary save / submit buttons**: teal `#0d9488` background, white text.
- **Combobox pattern**: native `<input list=…>` + `<datalist>` for
  search-filter pickers; plain `<select>` for fixed dropdowns.

## Multi-tenancy — Day 1 + Day 2 (April 2026)

PulseEDU is migrating from single-tenant to silo-per-district.

**Day 1 — foundation tables.**
- New tables: `districts`, `schools` (`lib/db/src/schema/{districts,schools}.ts`).
- Seeded: `Hernando County School District` (slug `hernando`, state code `27`)
  with 5 schools — D. S. Parrott Middle (PRIMARY, code 0241), F. W. Springstead
  High (0181), Nature Coast Technical High (0351), Weeki Wachee High (0391),
  Powell Middle (0221).
- New SuperUser-only Settings tile: **Tenancy** (`TenancyPanel.tsx`).
- API: `GET /api/tenancy/status` (SuperUser-gated) — `routes/tenancy.ts`.
- Idempotent boot-time seed: `seedTenancy()` in `seed.ts`.
- Tables created via direct SQL because drizzle-kit push prompts on rename
  detection between unrelated existing tables (same workaround used for the
  PBIS thresholds columns).

**Day 2 — `school_id` on every tenant-scoped table + backfill.**
- 32 tables now have `school_id INTEGER NOT NULL DEFAULT 1` with a foreign key
  to `schools(id) ON DELETE RESTRICT` and a `school_id` index. Tables scoped:
  `students, staff, hall_passes, tardies, pbis_entries, pullouts,
  accommodation_logs, support_notes, intervention_entries, iss_roster,
  iss_attendance_day, record_edits, pbis_goals, pbis_milestones,
  pbis_milestone_emails, pbis_reasons, locations,
  location_allowed_destinations, bell_schedules, class_sections,
  section_roster, kiosk_activations, admin_notifications, staff_defaults,
  student_accommodations, school_accommodations, intervention_types,
  pullout_reasons, teacher_destination_allowlist, student_hall_pass_limits,
  trusted_adult_interventions, polarity_pairs`.
- All existing rows backfilled to D. S. Parrott (`school_id = 1`). 0 orphans
  across all 32 tables.
- DEFAULT 1 stays in place as a safety net so legacy INSERT paths that don't
  yet pass `school_id` still write to Parrott. Day 3 will remove the DEFAULT
  once routes explicitly carry `req.schoolId`.
- Drizzle schema files NOT yet updated to declare `school_id` — deliberately
  deferred to Day 3 when the route-by-route scoping work happens, so we don't
  pay the cost twice. The DB is the source of truth in the meantime.
- Tenancy panel now shows: per-school row counts (5 columns × 10 tables),
  total per row, and a green "✓ All records assigned to a school (0 orphans)"
  / red "✗ N orphan rows" data-integrity check.
- Tables NOT scoped (deliberately): `districts`, `schools`, `custom_roles`
  (cross-school presets), `district_integrations` (district-level),
  `school_settings` (singleton, becomes per-school in Day 4),
  `bell_schedule_periods` (child of `bell_schedules`, scoped via parent),
  `user_sessions`, `check_in_with_options` (legacy).

**Day 3 (in progress)** — silo-per-school request scoping.

Wave 1 (foundation):
- `req.schoolId`, `req.homeSchoolId`, `req.isSchoolSwitched` resolved on every
  request (`artifacts/api-server/src/app.ts`).
- `lib/scope.ts` exports `requireSchool(req, res)` — handler helper that
  returns the active school id or writes 401.
- 13 Drizzle schema files updated with `schoolId: integer().notNull().default(1)`
  so route code can reference the column without raw SQL.
- New routes (`artifacts/api-server/src/routes/tenancy.ts`):
  - `GET  /api/tenancy/schools` — pickable schools (SuperUser sees all,
    everyone else sees their own home school).
  - `POST /api/tenancy/switch-school { schoolId }` — SuperUser-only; persists
    `session.activeSchoolId`. `schoolId: null` clears the override.
  - `POST /api/tenancy/schools` — SuperUser-only create-school flow used by
    the Tenancy panel to prove silo isolation against an empty school.
- `/api/auth/me` and `/api/auth/login` now return
  `{ schoolId, homeSchoolId, isSchoolSwitched }`.

Wave 2 (route scoping). Each route below filters reads by `req.schoolId` and
stamps `school_id` on every INSERT:
- `students`, `hall-passes` (all CRUD), `tardies`, `support-notes`,
  `accommodation-logs` (GET + POST + bulk),
- `pbis` (list, leaderboard, POST, bulk, home-stats, needs-attention with
  student/staff denominators all scoped via `staff.school_id` join until the
  config tables migrate to per-school in Day 4),
- `pullouts` (list, by-student, report, POST, **all 6 PATCH actions** —
  `verify`, `reject`, `arrived`, `returned`, `closed`, `review` — now match
  `id AND school_id`),
- `locations` (GET, POST),
- `interventions` (GET + POST),
- `reports/teachers` (filters by `staff.school_id`).

Top bar (`artifacts/client/src/components/SchoolSwitcher.tsx`):
- Shows the active school as a 🏫 pill. SuperUsers click to open a switcher
  popover. When switched away from the home school, an amber "⚠ Acting as X"
  badge plus an "Exit switch" button appear so SuperUsers never get stuck.
- On a successful switch the page hard-reloads — every list refetches scoped
  data. Cheaper than threading a query-key through every `useState` list.

Tenancy panel (`TenancyPanel.tsx`) now includes a "Create new school" form
(SuperUser-only) that POSTs `/api/tenancy/schools`, refetches the status, and
instructs the SuperUser to switch into the new (empty) school to verify silo
isolation. Server validates name/code uniqueness within the district until the
composite unique index lands in Day 4.

Routes intentionally NOT scoped yet (config singletons → per-school in Day 4):
`bell-schedules`, `pbis-reasons` (lists), `school-settings`, `kiosk-activations`.

The DB-level `DEFAULT 1` on `school_id` stays until every INSERT path
(including kiosk + admin tools) is explicit; planned for end of Day 3 / start
of Day 4. `class_sections` and `section_roster` still lack `school_id` — also
Day 4.

Multi-day plan tracked in `.local/session_plan.md`.

## Multi-tenancy — Day 4 (April 2026)

D4 makes per-school configuration *truly* per-school instead of singleton.

**Schema (Wave A1).**
- `school_settings.school_id INTEGER NOT NULL DEFAULT 1` + unique index
  `school_settings_school_id_unique` — guarantees one row per school.
- `schools.timezone TEXT NOT NULL DEFAULT 'America/New_York'`.
- Drizzle schemas updated: `schoolSettings.ts`, `schools.ts`, plus
  `schoolId` columns added to `pbisGoals`, `pbisMilestones` (table-wide
  unique on `points` removed in favor of per-school dup-check),
  `kioskActivations`, `teacherDestinationAllowlist`,
  `locationAllowedDestinations` (DB columns existed since D2 — Drizzle
  was missing them).

**Routes (Wave A2).**
- `requireSchool(req, res)` helper at `src/lib/scope.ts` returns
  `req.schoolId` or writes 401.
- Lazy "ensure settings row" pattern in `routes/schoolSettings.ts` —
  GET reads-or-creates by `req.schoolId`, PUT updates by both `id` AND
  `school_id` (defensive). Concurrent inserts are absorbed by the
  unique index + retry-read.
- Scoped CRUD routes: `bellSchedules.ts`, `teacherAllowlist.ts`,
  `listsAdmin.ts` (pbis-reasons), `pbisGoals.ts`, `pbisMilestones.ts`,
  `kiosk.ts` (activations list / activate / deactivate),
  `locationAllowedDestinations.ts`.
- **Acceptance criterion fix at `routes/pbis.ts:583`** — the PBIS
  thresholds query now filters by `staff.schoolId`. Changing
  `pbisQuietTeacherDays` in Parrott no longer affects Powell.
- `routes/studentHallPassLimits.ts`: `getEffectiveDailyLimit` and
  `findDailyLimitConflict` now take `schoolId`. Callers in
  `hallPasses.ts` (uses `req.schoolId`) and `kiosk.ts` (uses
  `act.schoolId` from the kiosk activation) pass it through.
- `kiosk.ts /kiosk/activate` is unauthenticated, so it derives
  school from the verified staff record (not `req.schoolId`) and
  stamps `kiosk_activations.school_id` on insert. Origin-room lookup
  is also filtered to the staff's school.

**Post-review hardening (Wave A2.1).**
After the first architect pass, several non-obvious cross-school readers
were closed:
- `routes/issAttendance.ts /iss-attendance/today-periods` now scopes the
  bell-schedule lookup by `req.schoolId` (an ISS dean was previously
  seeing the first active default schedule globally).
- `routes/pbis.ts` cold-period logic scopes the `bellSchedules` query
  by `staff.schoolId`.
- `routes/kiosk.ts /kiosk/hall-passes` resolves origin/destination by
  `(name, act.schoolId)` and checks the allowlist by
  `(schoolId, origin, dest)` — names like "Library" can repeat across
  schools, so name-only lookup was a leak.
- `routes/locations.ts /wire-classrooms-mesh` now requires
  `req.schoolId`, reads classrooms + existing pairs filtered by school,
  and **stamps `school_id` on inserted mesh pairs** (previously inserts
  silently fell through to `DEFAULT 1`).
- `routes/locations.ts` PATCH/DELETE `/locations/:id` now match by
  `(id, schoolId)` so an admin can't mutate another school's row by id.
- DB constraint `pbis_milestones_school_points_unique UNIQUE
  (school_id, points)` replaces the old table-wide
  `pbis_milestones_points_key` — concurrency-safe per-school dup check.

**Tenancy panel (Wave A3).**
- `routes/tenancy.ts` `COUNT_TABLES` extended with `school_settings`,
  `bell_schedules`, `pbis_reasons`, `pbis_milestones`. SuperUsers see
  "1 settings row per school visited" once each school's UI loads.

## Multi-tenancy — Day 5 (April 2026)

D5 closes the cross-school *data* leaks that D4's settings-focused
work didn't cover. Acceptance: an admin or coordinator in school A
cannot read or mutate school B's ISS attendance, PBIS entries,
milestone-email log, or hall-pass limits even with a known row id.

**Drizzle schemas — exposed schoolId on four more tables.** All four
DB tables already had `school_id` from D2 backfill; the ORM was just
unaware:
- `studentHallPassLimits`, `issAttendanceDay`, `issRoster`,
  `pbisMilestoneEmails`.

**Routes.**
- `routes/issAttendance.ts`:
  - `GET /iss-attendance` filters by `req.schoolId` (was day-only).
  - `PUT /iss-attendance/:id` matches by `(id, schoolId)`.
  - `upsertIssAttendance` helper now requires `schoolId` and stamps
    it on insert. Both callers updated: `issRoster` manual add uses
    `req.schoolId`; `pullouts` arrival uses `existing.schoolId` from
    the parent pullout row.
- `routes/pbis.ts`:
  - `PATCH /pbis/:id` and `POST /pbis/:id/void` load + update by
    `(id, staff.schoolId)`.
  - `/pbis/needs-attention` top-heavy `monthEntries` query AND'd on
    `staff.schoolId` (analytics no longer mix schools).
- `routes/pbisMilestones.ts` `/pbis-milestone-emails` filters by
  `staff.schoolId`.
- `routes/studentHallPassLimits.ts`:
  - `countPassesToday(studentId, schoolId)` — caller passes school;
    counts only today's passes at that school.
  - `findDailyLimitConflict` threads schoolId through.
  - `GET /student-hall-pass-limits` filters by `req.schoolId`.
  - `POST /student-hall-pass-limits` stamps `schoolId`; the
    "deactivate prior active row" sweep is also scoped per-school
    so two schools can hold their own active row for the same
    student id.
  - `DELETE /student-hall-pass-limits/:id` matches by
    `(id, schoolId)`.

**Background helper — milestone email pipeline.**
`lib/pbisMilestones.ts` `processMilestonesForStudent(id, schoolId)`
and `processMilestonesForStudents(ids, schoolId)` now take school
explicitly. The helper:
- reads only THIS school's milestones (otherwise points awarded in
  Powell would be checked against Parrott's thresholds),
- reads only THIS school's prior PBIS entries when summing total
  points,
- reads/inserts the email-log row with `school_id` stamped.
Both call sites in `routes/pbis.ts` (single + bulk award) pass
`staff.schoolId`.

**DB unique indexes — relaxed to be school-scoped.** Three indexes
that previously enforced "one row per student id" globally are now
"one row per (student id, school id)":
- `iss_attendance_day_student_day_idx` →
  `(student_id, day, school_id)`. Conflict target on the
  `upsertIssAttendance` insert was updated to match; the manual→pullout
  enrichment update also includes `schoolId` in its WHERE.
- `pbis_milestone_emails_student_pts_unique` →
  `(student_id, milestone_points, school_id)`. Without this, school A
  claiming/sending a student's milestone email silently blocked
  school B from sending its own. All 4 status-update WHEREs in
  `lib/pbisMilestones.ts` (skip-no-roster, skip-no-email, sent, error)
  now include `schoolId`.
- `student_hall_pass_limits_student_active` partial index →
  `(student_id, school_id) WHERE active = true`.
  `getActiveStudentLimit(studentId, schoolId)` was previously
  unscoped (school A's effective limit could be school B's row);
  now school-scoped end-to-end.

**Pullouts → ISS roster.** `routes/pullouts.ts` `/pullouts/:id/arrived`
now stamps `existing.schoolId` on the auto-inserted `iss_roster` row
(was relying on DB DEFAULT 1, mis-tenanting non-Parrott arrivals).

**D5 follow-up (Apr 23 2026).** Closed the deferred display-only
`schoolSettings...limit(1)` readers and the unscoped intervention
oracle:

- `routes/pullouts.ts` `hasRecentIntervention(studentId, schoolId)`
  now AND-filters by school. Both callers (preflight GET uses
  `req.schoolId`; POST uses `staff.schoolId`) updated. Same
  enumeration-oracle pattern that D5 closed on hall-pass limits.
- `lib/pulloutEmail.ts` (3 functions: `sendPulloutArrivalEmail`,
  `sendPulloutReturnEmail`, `sendPulloutDispatchEmail`) — each loads
  the parent pullout first, then uses `p.schoolId` to scope both the
  student lookup and the schoolSettings fetch. Branding/from-name
  now matches the school the pullout belongs to, not whichever
  school sorts first.
- `lib/pbisMilestones.ts` settings read (line 109) — now scoped by
  `schoolId` (already a parameter on `processMilestonesForStudent`).
- `routes/email.ts` `getFromName(schoolId)` — now takes the
  caller's `req.schoolId`.
- `routes/parentEmail.ts` POST `/parent-email/send` — student lookup
  and settings fetch both AND-filter on `staff.schoolId`. The
  audit-log insert into `support_notes` now also stamps
  `schoolId: staff.schoolId` (was relying on DB DEFAULT 1, which
  mis-tenanted every non-Parrott parent-email log). Closes the
  same student-id enumeration oracle pattern on this surface.
- `lib/pulloutEmail.ts` `sendPulloutDispatchEmail` recipient query —
  was selecting all admins/deans/MTSS/ISS staff district-wide;
  now AND-filters `staffTable.schoolId = p.schoolId` so a school A
  pullout's student id, reason, and teacher name are only emailed
  to school A's dispatchers.

**D5 follow-up — daily digest per-school (Apr 23 2026).**
`lib/dailyDigest.ts` was district-wide: a single email mixed every
school's pullouts and went to every dispatcher across the district.
Now refactored to per-school:

- `buildDailyDigest(forDay, schoolId)` — schoolId required; pullouts
  query and unreviewed-closed backlog query both AND-filter by school.
- `sendDailyDigestEmailForSchool(forDay, schoolId)` — sends one
  digest for one school. Recipients are active admin/dean/MTSS
  staff in THAT school. Branding (school name, from-name) comes
  from THAT school's `school_settings` row. Returns
  `DailyDigestResult` with `schoolId` stamped.
- `sendDailyDigestEmail(forDay)` — cron entry point. Loops over
  every row in `schools` and calls the per-school sender. Returns
  `DailyDigestResult[]`. Per-school errors don't kill the loop.
- `index.ts` cron caller — iterates the result array and logs one
  line per school with its `schoolId`, status, recipient count, and
  any error.
- `routes/digest.ts` admin endpoints — `/digest/today` preview and
  `/digest/send-now` both now use the calling admin's
  `staff.schoolId`, so an admin can only preview or fire their own
  school's digest.

Today only school 1 has active dispatchers, so cron will fire once
for school 1 and skip schools 2/3/4/5/36 with "No digest recipients
configured" — exactly the right behavior, and adding a dispatcher
to any other school turns its digest on automatically.

**Verification.** SQL spot-checks confirmed:
- Two schools can each hold an active hall-pass limit, an ISS
  attendance day row, and a milestone-email row for the same
  student id (cross-school dups now permitted).
- Same-school dups still rejected with
  `duplicate key value violates unique constraint
  "student_hall_pass_limits_student_active"
  Key (student_id, school_id)=(D5VERIFY2, 1) already exists`.
- API restarts clean and serves requests.

## Bell Schedule (April 2026)

School Bell Schedule management lives at top-level nav "Bell Schedule" and is
gated to SuperUser, Admin, MTSS Coordinator, and Behavior Specialist. Hub
landing offers Regular / Activity / Early Release sub-tiles; each opens a list
of schedules of that kind with add/edit/delete and "set default" actions. The
editor lets users pick number of periods, period names, and start/end times.

- DB tables: `bell_schedules` and `bell_schedule_periods`
  (`lib/db/src/schema/bellSchedules.ts`).
- API routes: `GET/POST/PUT/DELETE /api/bell-schedules`
  (`artifacts/api-server/src/routes/bellSchedules.ts`).
- UI: `artifacts/client/src/components/BellScheduleSection.tsx`,
  rendered from `App.tsx` when `activeSection === "bellSchedule"`.
