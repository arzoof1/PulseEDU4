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

## Multi-tenancy / Cross-school Isolation (April 2026)

PulseEDU is multi-tenant by `school_id` (Hernando County: Parrott=1,
Springstead=2, NCT=3, Weeki=4, Powell=5, Test Middle=36). The session sets
`req.schoolId`; routes call `requireSchool(req,res)` from
`artifacts/api-server/src/lib/scope.ts` and AND-filter every read/write by
that id. SuperUser is intentionally district-wide and is the only role that
escapes school scoping.

`student_id` and `displayName` are NOT globally unique across schools, so
membership filters in JS are not sufficient — every query that touches
`students`, `class_sections`, `section_roster`, `student_accommodations`,
`accommodation_logs`, `pbis_entries`, `staff_defaults`,
`teacher_destination_allowlist`, or `location_allowed_destinations` must
include `eq(table.schoolId, schoolId)` in SQL.

Per-school uniqueness on master lists — composite `(school_id, name)`
unique indexes on `school_accommodations`, `pullout_reasons`,
`intervention_types`, `trusted_adult_interventions`, and `pbis_reasons`
so each school can carry its own copy of "Extended Time" / "Verbal
Redirect" / etc. without colliding with another school. Routes that
consume these lists by id (e.g. `/interventions` POST validating
`interventionTypeId`) must AND the FK lookup by `schoolId` to prevent a
caller from attaching another school's master-list id to their own row.

`adminStaff.ts` carve-out: SuperUser sees/edits district-wide; all other
admins (incl. `cap_staff_roles` holders) are hard-scoped to
`actor.schoolId` for LIST, PATCH, POST, and password-reset.

`schedule.ts` identity is session-only — the prior `?staffId=` query
fallback was an intra-school impersonation surface and has been removed.
Clients always rely on the session cookie; `?all=1` is the only
documented variant, still tenant-scoped to the caller's school, and
gated server-side to `isAdmin || isEseCoordinator` so the UI gate is
mirrored at the API boundary.
`accommodationsAdmin.ts` no longer accepts `?staffId` / body `staffId` as an
actor identity — only the signed-in `req.staffId` is used.

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

**Tenant audit follow-up — kiosk hall passes (Apr 23 2026).**
After D5, a broader audit found four cross-school holes in
`routes/kiosk.ts` (the unattended hallway kiosk flow):

- The hall-pass INSERT in `/kiosk/hall-passes` was not stamping
  `school_id`, so every pass issued by a kiosk bound to school 2-36
  was silently being written with the column default of 1
  (mis-tenant write, identical pattern to the parent-email support-
  notes bug fixed earlier). Now stamps `schoolId: act.schoolId` from
  the kiosk activation row.
- The "student already has an active pass" duplicate-check query was
  district-wide. Two schools could legitimately have the same
  student id, so a kiosk at school B would 409 on a student whose
  only open pass lived at school A. Now AND-filtered on
  `act.schoolId`.
- The "I'm back" return-tap query (`/kiosk/hall-passes/return`)
  filtered by `studentId + status='active' + originRoom`. Room labels
  like "Room 102" repeat across schools, so a kiosk at school B
  Room 102 could end school A's open pass. Now AND-filtered on
  `act.schoolId`.
- Both student-name lookups (issuance + return) were keyed on
  `studentId` only, leaking first names across schools — same
  enumeration-oracle pattern. Now AND-filtered on `act.schoolId`.

False positives that were verified safe and left alone:
`accommodationLogs.ts:307` and `locations.ts:217` already stamp
`schoolId` via the spread inside `toInsert.push({...})`;
`kiosk.ts:255` is authenticated by `tokenHash` (not by url id);
`pbisGoals.ts:134` UPDATE-by-id is preceded by a school-scoped
existence check on the same row; `lib/pulloutEmail.ts` "load
pullout by id" calls are internal helpers invoked from already-
scoped routes.

**Tenant audit follow-up — polarity pairs (Apr 23 2026).**
Architect review of the kiosk fixes flagged that
`findPolarityConflict(studentId)` in `routes/polarityPairs.ts` was
still globally scoped — it ran the keep-apart check across every
school's `polarity_pairs` and `hall_passes` rows. With the kiosk
issuance flow now correctly tenant-scoped, this helper became the
last cross-school oracle in the kiosk path: a kiosk at school B
could be told "cannot issue pass: STUDENT X is currently out on
a pass to BATHROOM" purely because some unrelated student id at
school A was paired and out.

Closed it the same way as the rest of D5:

- Exposed `school_id` on `polarityPairsTable` (Drizzle schema; the
  column was already in the DB from the D2 backfill, default 1).
- `findPolarityConflict(studentId, schoolId)` now requires the
  caller to pass `schoolId` and AND-filters every internal query
  (`polarity_pairs`, `hall_passes`, partner-name lookup on
  `students`).
- Updated both call sites: `routes/hallPasses.ts` POST passes
  `schoolId` from `requireSchool(req)`, and the kiosk
  `/kiosk/hall-passes` route passes `act.schoolId` from the
  activation row.
- Scoped the polarity-pairs CRUD too: `GET /polarity-pairs` filters
  pairs and the hydration `students` fetch by school; `POST` stamps
  `schoolId`, validates both student ids exist *at this school*
  (was a global oracle), and dedupes per-school; `DELETE /:id`
  matches by `(id, school_id)`.

**Verification.** SQL spot-check confirmed: a polarity pair inserted
with `school_id=2` is invisible to a `school_id=1` lookup
(0 rows) and visible to a `school_id=2` lookup (1 row). API
restarts clean and serves requests.

**Legacy data.** No remediation needed — all 7,732 historical
`hall_passes` rows and the 1 existing `polarity_pairs` row are
already `school_id=1` (the only active school today), and there
are zero `kiosk_activations` historically, so no kiosk has yet
written a mis-tenanted row.

**Tenant audit follow-up — record_edits, admin_notifications,
hall-pass report (Apr 23 2026).** Architect's third pass found three
more cross-school exposures outside the kiosk surface:

- `GET /api/record-edits` returned the entire global edit log with
  no auth boundary at all, and the matching writer paths in
  `routes/pbis.ts` (`logEdit`) and `routes/hallPasses.ts`
  (PATCH-end edit batch) were not stamping `school_id` on insert.
- `GET /api/admin/notifications` and the matching resolve POST
  showed every kiosk default-room-missing alert across the
  district to any school's admin, and the writer at
  `routes/kiosk.ts` `/kiosk/activations` was not stamping
  `school_id` on insert.
- `GET /api/reports/hall-passes` (Admin/ESE-only daily summary)
  ran a date-only query against `hall_passes` and a
  `studentId`-only `IN (...)` against `students` for name
  hydration, so the admin/ESE report at one school silently
  aggregated every school's passes and merged student names.

Closed all three with the same pattern as the rest of D5:

- Drizzle schemas now expose `school_id` on `recordEditsTable` and
  `adminNotificationsTable` (DB columns were already there from
  D2 backfill, default 1).
- Every INSERT into `record_edits` (`pbis.ts logEdit` — now takes
  `schoolId` parameter and passes it from the route's
  `requireSchool(req)` value at every call site, including void;
  `hallPasses.ts` PATCH edit-batch — stamps `schoolId`) and
  `admin_notifications` (`kiosk.ts` `/kiosk/activations` —
  stamps `staff.schoolId`) now sets `school_id` explicitly.
- `GET /api/record-edits` now requires a signed-in session AND
  AND-filters by `requireSchool(req)`. Both query paths
  (with-recordType-and-id and bare list) are scoped.
- `GET /api/admin/notifications` and POST `/admin/notifications/
  :id/resolve` now AND-filter by `requireSchool(req)`.
- `GET /api/reports/hall-passes` now requires `requireSchool(req)`
  and AND-filters `hall_passes.schoolId` on the day-of query.

**Verification.** SQL spot-check: rows inserted into
`record_edits` and `admin_notifications` with `school_id=2` are
invisible to a `school_id=1` lookup (0 rows) and visible to a
`school_id=2` lookup (1 row). API restarts clean.

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

## Multi-tenancy — DEFAULT 1 safety net dropped (Apr 23 2026)

The DB-level `school_id INTEGER NOT NULL DEFAULT 1` safety net introduced
during D2 backfill is now removed across all 33 tenant-scoped tables. From
this point on, any INSERT path that forgets to stamp `schoolId` fails fast
with a NOT NULL constraint violation instead of silently mis-tenanting
rows to D. S. Parrott (`school_id = 1`) — exactly the failure mode that
masked the kiosk hall_passes / kiosk_activations / parent-email
support_notes / iss_roster bugs we hunted down through D5.

**What changed.**
- Audited every `.insert()` in `artifacts/api-server/src` (52 call sites
  across 33 scoped tables). All route paths already stamp `schoolId`
  correctly (4 architect-validated false positives where `schoolId` is
  spread/array-mapped onto rows: `accommodationLogs.ts:307`,
  `locations.ts:217` mesh insert, `hallPasses.ts:273` `record_edits`,
  `accommodationsAdmin.ts:421`).
- Real gaps were 9 inserts in `artifacts/api-server/src/seed.ts` (the
  boot-time `seedIfEmpty` flow). Added `const SEED_SCHOOL_ID = 1` and
  stamped it on every insert: `staff`, `students`, `classSections`,
  `sectionRoster`, `schoolAccommodations`, `studentAccommodations`,
  `locations` (via `.map((l) => ({ schoolId: SEED_SCHOOL_ID, ...l }))`),
  `locationAllowedDestinations`, `staffDefaults`.
- Dropped `DEFAULT 1` from `school_id` on all 33 tables in a single
  transaction. Verified `information_schema.columns` shows 0 rows with
  a `school_id` default remaining.
- Removed `.notNull().default(1)` → `.notNull()` from all 32 Drizzle
  schema files in `lib/db/src/schema/*.ts` (33 occurrences;
  `pbisMilestones.ts` had two columns) so a future `db:push` cannot
  silently re-apply the defaults. Restored the unrelated
  `pbisReasons.defaultPoints.default(1)` that was bystander-stripped by
  the sed (legitimate non-tenancy default; DB column already has it).

**Smoke test.**
- `INSERT INTO students (student_id, first_name, last_name, grade) VALUES
  (...)` without `school_id` → `ERROR: null value in column "school_id"
  ... violates not-null constraint`. Correct.
- `INSERT INTO students (school_id, ...) VALUES (2, ...)` → success, row
  visible at `school_id = 2`. Correct.

**Tables NOT in scope** (no `school_id`, intentional): `districts`,
`schools`, `custom_roles`, `district_integrations`, `user_sessions`,
`check_in_with_options`, `bell_schedule_periods` (scoped via parent
`bell_schedules.school_id`).
