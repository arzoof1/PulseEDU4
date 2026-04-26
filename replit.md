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

## Pulse signage screens (April 2026)

Three live signage/dashboard surfaces for the School Operations app, served
from the same Vite client under `/signage/*`:

- `/signage/heartbeat` — `signage/HeartbeatSignage.tsx`. Live mood meter +
  unified event feed (PBIS / tardies / pullouts / interventions). Polls
  `/api/pulse/heartbeat` and `/api/pulse/events` every 30s. Public-kiosk OK
  via `?schoolId=N` — server **redacts** free-text `detail` and replaces
  `staffName` with `"Staff"` for unauthenticated callers.
- `/signage/houses` — `signage/HousesSignage.tsx`. Four-house leaderboard
  (Falcon=blue, Phoenix=red, Stag=green, Wolf=violet) with per-house
  red-left / green-right mini mood meters under each bar. Polls
  `/api/houses` every 30s. Kiosk OK.
- `/signage/student?studentId=N` — `signage/StudentTimelineSignage.tsx`.
  Per-student deep-dive timeline used for parent conferences / MTSS.
  **REQUIRES staff session** — `/api/pulse/student-timeline` ignores
  `?schoolId=` and only reads `req.schoolId` from the session, since this
  screen surfaces full PII (real student names, free-text behavior notes,
  staff names).

Path dispatch lives in `signage/SignageApp.tsx`; `main.tsx` routes
`/signage*` paths to it. Polling helper: `signage/usePolling.ts`.

Schema additions (`lib/db/src/schema/houses.ts`):
- `housesTable` (id, schoolId, name, color hex, motto, createdAt) seeded
  idempotently in `seed.ts` via `ensureHousesSchema` + `seedHousesIfEmpty`.
- `studentsTable.houseId` nullable column; existing students round-robin
  assigned at seed time.

Parent dashboard (`parent/Dashboard.tsx`) gained a `<ParentMoodMeter>` card
above the Pulse cards. It reads `snapshot.pbis.weeklyCounts` (computed by a
dedicated SQL aggregate in `routes/parentSnapshot.ts` so it isn't truncated
by the 50-row recent-PBIS sample), with a fallback to filtering
`snapshot.pbis.recent` for older API servers.

API endpoints (all in `routes/pulse.ts` + `routes/houses.ts`):
- `GET /api/houses` — leaderboard + per-house counts (kiosk OK).
- `GET /api/pulse/heartbeat` — aggregate counts + trend vs yesterday.
  `positivePct = positive / (positive + negative)` (neutral concerns are
  surfaced separately, not folded into the bar).
- `GET /api/pulse/events` — unified event feed; redacted for public callers.
- `GET /api/pulse/student-timeline` — staff-only per-student timeline.

## Classroom Store + School Store + Object-storage thumbnails (April 2026)

PbisPointsHub now has two reward catalogs that share a single generic
`StoreView` component (in `PbisPointsHub.tsx`):

- **Classroom Store** (`tab === "rewards"`, `<ClassroomStoreView />`) —
  per-teacher catalog. Each staffer manages their own list. Anyone signed
  in can add to their own store; admins can edit anyone's row.
- **School Store** — school-wide catalog. Reachable from **three** places
  depending on role:
  - **Sidebar "School Store"** (`activeSection === "schoolStore"` in
    App.tsx, `baseNavSections`) — **always read-only** for everyone, even
    admins. This is the teacher-facing browse surface.
  - **PBIS Hub → "School Store" tab** (`tab === "rubric"`,
    `<SchoolStoreView canEdit={...} />`) — full edit controls if the
    viewer can edit.
  - **BS hub tile + MTSS hub tile** (`activeSection === "schoolStoreManage"`)
    — full edit controls.

  Edit access (`canEditSchoolStore` in App.tsx, `requireWriteAccess` in
  routes/schoolStore.ts) = `isSuperUser || isAdmin || isBehaviorSpecialist
  || isMtssCoordinator || isPbisCoordinator`. Plain teachers get 403 on
  writes and don't see edit/delete/+ controls anywhere. The two gates are
  intentionally mirrored — keep them in sync if either changes.

Both use the same `StoreItemCard`, `StoreItemModal`, image-upload flow, and
local blob preview (instant in-modal preview before Save). They differ only
in apiPath, header copy/gradient/icon, and `canEdit`. Cleanest place to
add a third reward catalog later is another `StoreConfig` + thin wrapper.

Backend pieces:
- Tables `classroom_store_items` and `school_store_items`
  (`lib/db/src/schema/{classroomStoreItems,schoolStoreItems}.ts`): same
  shape (name/description/points_cost/image_url/sort_order/archived) — the
  classroom variant has `owner_staff_id`, the school variant doesn't. Hard
  delete (no redemption history yet).
- `/api/classroom-store` GET/POST/PATCH/DELETE
  (`artifacts/api-server/src/routes/classroomStore.ts`): scoped by
  schoolId+ownerStaffId on read; per-row write gated to admin OR owner.
- `/api/school-store` GET/POST/PATCH/DELETE
  (`artifacts/api-server/src/routes/schoolStore.ts`): scoped by schoolId on
  every read/write; **all writes require `staff.isAdmin`** (`requireAdmin`
  helper returns 403 otherwise). GET is open to any signed-in staffer.
- `/api/storage/uploads/request-url`, `/api/storage/objects/*tail`,
  `/api/storage/public-objects/*tail`
  (`artifacts/api-server/src/routes/storage.ts`) on top of
  `lib/objectStorage.ts` + `lib/objectAcl.ts`. Express 5 wildcard syntax is
  `*name`, not bare `*`.

Storage tenant isolation:
- Every issued upload URL is logged in an in-memory `pendingUploads` ledger
  keyed by `/objects/<id>` with the requester's schoolId (24h TTL). This
  lets the uploader's school preview the object before any domain row saves
  it (lazy bind doesn't happen until POST/PATCH).
- `bindObjectToSchool(path, schoolId)` writes ACL metadata
  `{ owner: 'school:<id>', visibility: 'private' }` only when (a) no policy
  yet AND a matching pending entry exists, or (b) already owned by the same
  school. It refuses to rebind another school's object — closes the hijack
  vector.
- `GET /storage/objects/*tail` requires `req.staffId` AND `req.schoolId`,
  then allows iff `policy.owner === school:<reqSchoolId>` OR (no policy yet
  AND pending entry's schoolId matches). All other cases 404.
- Both `classroomStore` and `schoolStore` POST/PATCH call
  `bindObjectToSchool` and roll back / 400 if the bind is refused, so we
  never persist an unservable thumbnail.

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

## Multi-tenancy — Pasco County added as 2nd district (Apr 23 2026)

Stood up the second district to actually exercise the silo machinery
end-to-end. Until now Hernando was the only district, so the
silo-per-district + silo-per-school plumbing had never been stressed
against a real second tenant.

**District added.**
- `Pasco County School District` — `id = 37`, `slug = "pasco"`,
  `state_district_code = "51"`, `timezone = America/New_York`.
- 96 schools loaded from the Florida DOE roster (codes ranging from
  `0021` Rodney B. Cox Elementary through `7023` Pasco Virtual
  Instruction Program), all stamped `district_id = 37`, `is_primary
  = false`. Names title-cased from the source spreadsheet (preserving
  `K-8`, `Jr.`, `Dr.`, `O'`, `eSchool`).

**Hernando left untouched.** Still 6 schools at `district_id = 1`
(Parrott=1, Springstead=2, NCT=3, Weeki=4, Powell=5, Test Middle=36).

**Silo smoke test (Apr 23).**
- Inserted a student against a Pasco school_id (`Pasco High School`,
  state code `0031`). Insert succeeded; row's `school_id` resolved to a
  Pasco school via FK join, `district_id = 37`. Rolled back.
- Confirmed: zero rows in `students` where `school_id = 1` (Parrott)
  also belong to a Pasco school. Silo boundary holds.

**What this exposes (intentionally).** Any code path that still assumes
`district_id = 1` will now show wrong-district behavior the first time a
SuperUser switches into a Pasco school. The cross-school sweeps from
D3–D5 only enforced *school* scoping, not *district* scoping. Latent
bugs to expect: any admin/list endpoint that joins through `schools`
without filtering on the actor's `districtId`, any place a SuperUser's
school-switch UI lists *all* schools across districts (it should list
only their district's schools unless they're the one true cross-district
SuperUser).

**Pasco silo is currently empty.** No staff, students, sections, or
settings. SuperUser can switch into any Pasco school via the Tenancy
panel to validate that empty-silo views render cleanly and to start
populating data if needed.

### District-scoping sweep — closing the latent holes (D6, Apr 23 2026)

The cross-school sweeps (D3-D5) only enforced *school* scoping. With
Pasco landed, several SuperUser surfaces were still treating "SuperUser"
as "every school in the database" instead of "every school in the
actor's district". Closed in this batch:

- **`artifacts/api-server/src/lib/scope.ts`** — added two helpers used
  by every district-scoped surface: `getDistrictIdForSchool(schoolId)`
  resolves the actor's district via a single-row lookup on
  `schools.district_id`; `getSchoolIdsForDistrict(districtId)`
  materializes the (small) school-id list for `inArray` filtering.
  Staff has no `district_id` column — district is always derived
  through their `school_id`.

- **`artifacts/api-server/src/routes/tenancy.ts`** —
  `GET /api/tenancy/schools` now district-filters at the SQL level so
  the SuperUser switcher only lists schools in the actor's district.
  `POST /api/tenancy/switch-school` rejects cross-district switches
  with 403 ("Cannot switch into a school in another district") so a
  Hernando SuperUser can't resolve `req.schoolId` to a Pasco school
  for the rest of the session.

- **`artifacts/api-server/src/routes/adminStaff.ts`** — four SuperUser
  surfaces tightened: `GET /admin/staff` (list), `PATCH /admin/staff/:id`
  (target lookup + update WHERE), `POST /admin/staff` (validates the
  target school is in the actor's district), and
  `POST /admin/staff/:id/password`. SuperUser still has district-wide
  reach (the original design intent per old comments), just no longer
  cross-district reach.

- **`artifacts/client/src/components/TenancyPanel.tsx`** — the panel
  was hard-coded to `districts[0]` and would have hidden Pasco from
  the UI entirely. Now iterates every district and renders the
  per-district sections (header, "create school" form, schools table)
  once each. The per-school row-count grid is also filtered to only
  schools that have at least one row — otherwise it would explode to
  100+ columns the moment Pasco was loaded.

- **`artifacts/api-server/src/lib/dailyDigest.ts`** —
  `sendDailyDigestEmail` cron used to iterate every row in `schools`
  and return a "skipped" result for each one with no recipients.
  After Pasco loaded, that meant 96 wasted iterations per weekday
  cron run. Now SQL-pre-filters to schools that have at least one
  active admin/dean/MTSS-coordinator staff and iterates only those.

**Three additional holes caught by post-build review** (same batch):

- **`GET /api/tenancy/status`** was returning every district, every
  school, and per-school row counts unfiltered. That's tenant-metadata
  exposure (not row-level data, but a Hernando SuperUser shouldn't see
  Pasco's name, school list, or counts). Now derives `actorDistrictId`
  and filters districts/schools to that district. Per-table count SQL
  adds `WHERE school_id IN (<district school ids>) OR school_id IS
  NULL`. Orphan rows stay in scope as a system-integrity signal —
  every district admin should see them flagged. Numeric school ids
  come from a trusted DB query, not user input, so the `sql.raw`
  interpolation is safe.

- **`POST /api/tenancy/schools`** accepted any `districtId` in the
  request body and created the school there. A Hernando SuperUser
  could mint a school inside the Pasco silo by submitting
  `{ districtId: 37, ... }`. Now rejects with 403 if `body.districtId`
  doesn't match the actor's home district.

- **`app.ts` request middleware** was honoring
  `staff.activeSchoolOverride` without checking same-district. If a
  pre-D6 cross-district override existed in the DB, it kept resolving
  `req.schoolId` to the wrong-district school until next login.
  Defense-in-depth fix: when an override is present AND the user is
  a SuperUser, look up both the override school's `district_id` and
  the home school's `district_id`, only honor the override if they
  match. Falls back to home school otherwise. Extra DB hops only run
  when an override is actually set (most requests skip them entirely).

**Cleanup:** the `eq(staffTable.id, -1)` no-match fallback used in
`adminStaff.ts` for empty-district-school-list cases was replaced
with `sql\`false\`` for clarity.

**Future escape hatch.** If we ever need a true cross-district
SuperUser (e.g. for Replit-side support), the right shape is a
separate flag — `isCrossDistrictSuperUser` or similar — checked on
top of the existing `isSuperUser`. Deferred until there's a real
caller for it; today every SuperUser belongs to exactly one district
via their home school.

**D6 follow-up #1 — custom-roles district scope.** The
`custom_roles` table is the SuperUser-defined role-preset catalog
(e.g. "Behavior Tech" = `capHallPasses + capHallPassesViewAll +
capPbisAward`). It was previously instance-global, which meant a
Hernando SuperUser editing the catalog also rewrote what Pasco saw,
and the global `UNIQUE(key)` constraint blocked Pasco from creating
a "behavior_tech" preset that already existed in Hernando.

Schema change: added `district_id INTEGER NOT NULL REFERENCES
districts(id) ON DELETE CASCADE` and replaced the global
`UNIQUE(key)` with a composite `UNIQUE(district_id, key)`. Table
was empty so no backfill was required. Drizzle schema updated to
match (`uniqueIndex("custom_roles_district_key_uq")`). The migration
was applied directly because `drizzle-kit push --force` was blocked
on an unrelated interactive prompt (an existing `districts_slug_unique`
constraint that was added earlier but not yet pushed); the next
time someone runs push it'll prompt for that pre-existing drift, not
this change.

Route change (`routes/customRoles.ts`): all four endpoints
(`GET/POST/PATCH/DELETE /api/custom-roles`) now resolve the actor's
district via `getDistrictIdForSchool(actor.schoolId)` through a new
`actorDistrictOr403` helper (returns 403 if the staff row's school
can't be mapped to a district — never silently falls back to "all
districts"). GET filters by `district_id`. POST writes the actor's
`district_id` into the new row (request body `district_id` is
ignored — the client never specifies it). PATCH and DELETE add
`AND district_id = <actor's>` to the WHERE clause; PATCH 404s on
cross-district to avoid id-enumeration leaks, DELETE silently
no-ops to preserve idempotent-delete semantics.

Client (`StaffRolesMatrix.tsx`) needed no changes — the response
shape is unchanged; it just sees a shorter list scoped to the
viewer's district.

**D6 follow-up #2 — TenancyPanel per-district form state.**
The "Create new school" form previously held a single set of refs
(`newName`, `newShort`, `newCode`, `creating`, `createError`,
`createOk`) shared across every rendered district section. With one
district that was fine; once Pasco landed and the panel rendered two
forms, two visible bugs appeared: typing in Hernando's input mirrored
into Pasco's, and submitting against one district painted the
success/error banner under both.

Replaced with per-`districtId` state: `drafts: Record<number,
{name, short, code}>` (populated lazily through a `getDraft` /
`updateDraft` / `clearDraft` trio so an empty district just reads
the shared `emptyDraft`), `creatingDistrictId: number | null`, and
`createMessage: { districtId, kind: "ok" | "err", text } | null`.
The JSX render loop derives `draft`, `isCreating`, and `myMessage`
per district before rendering inputs/button/banner. Submit handler
clears only the affected district's draft on success.

Single-valued `creatingDistrictId` means double-clicking Create in
two districts simultaneously will visually overwrite the "Creating…"
indicator on the first form, but both POSTs still complete
independently and the last response wins the banner. Acceptable
trade-off — onboarding two districts in the same second isn't a real
workflow. Architect review PASSED with no blockers.

**D6 follow-up #3 — school-switcher consistency.** With cross-tenancy
holes closed, an audit turned up a separate class of bug: about half
the routes that touch school-scoped tables were reading
`staff.schoolId` (always the home school) instead of `req.schoolId`
(the active school after middleware resolution). For non-SuperUsers
those are always equal, so nothing was visibly wrong. For SuperUsers
who'd switched into another same-district school, the switcher was
silently ignored — clicking "give a PBIS award" while viewing Pasco
Sunlake from a Hernando SuperUser session still created the entry
under their Hernando home school.

Replaced `staff.schoolId` → `req.schoolId!` in the route handlers of
`pullouts.ts` (5 sites: list / create / by-student / report /
recent-intervention check), `pbis.ts` (~19 sites across leaderboard,
awards, void, home-stats, needs-attention, settings, students, staff,
schedule), `pbisMilestones.ts` (1 site: milestone email log),
`parentEmail.ts` (3 sites: student lookup, school settings, audit
note), and `digest.ts` (2 sites: preview / send-now). The `!`
non-null assertion is safe because every changed call site is
already inside a `requireStaffMW` / `requireAdmin` handler, and the
middleware in `app.ts` guarantees `req.schoolId` is set whenever a
staff session is loaded.

Intentionally NOT changed:

- `kiosk.ts` activation routes — they're unauthenticated (no
  session, no `req.schoolId`); a kiosk's school is intrinsically the
  activating staff member's home school.
- `auth.ts /me` — already returns both `activeSchoolId` and
  `homeSchoolId` so the UI can render the switcher correctly.
- `tenancy.ts` and `app.ts` — those compute the actor's HOME
  district to decide what's in scope; that resolution is intrinsically
  about home, not active.

Architect review PASSED. The verdict noted that because the D6
middleware fix already guarantees `req.schoolId` is same-district
as `staff.schoolId`, swapping one for the other can't introduce a
cross-tenancy leak even theoretically — this change is purely a UX
correctness pass on top of an already-secure foundation.

**Silo migration: complete.** D1–D5 covered the schema columns,
route filtering, UI scoping, SuperUser permissions, and cross-school
sweeps. D6 closed the latent holes that surfaced once Pasco landed
as the second district (8 server endpoints, schema for
`custom_roles`, the request middleware override-school district
check, the TenancyPanel iteration + per-district form state, and
this final school-switcher consistency pass). The system is now
silo-per-district with no documented follow-ups remaining. Two
deferred items, only build them when a real caller appears: a
test harness for the api-server (the architect suggested regression
coverage for tenancy routes; no test framework exists yet — would
be the natural cap once a real caller appears for these tests).

---

## Multi-school dev seed (2026-04-23, late session)

The dev DB is now seeded with realistic multi-school data so the
contracted AWS engineer (who is sizing the AWS backend wiring + CIO
review documentation, not taking over the project) can evaluate the
end-to-end flow.

**Totals:** 396 staff, 9,750 students, 2,730 class sections, 68,250
roster rows, 98 master accommodations (14 per school), 8,112 student
accommodation assignments, 105 locations, 7 bell schedules with 49
periods, 7 school_settings rows.

**Per school:**

| id  | school                              | teachers | students | sections | admin (besides SuperUsers) |
|-----|-------------------------------------|---------:|---------:|---------:|----------------------------|
| 1   | D. S. Parrott Middle School         | 35       | 875      | 245      | Chris Clifford (also Super) |
| 2   | F. W. Springstead High School       | 80       | 2,000    | 560      | Brandon Wright (also Super) |
| 3   | Nature Coast Technical High School  | 60       | 1,500    | 420      | Brad Merschbach            |
| 4   | Weeki Wachee High School            | 65       | 1,625    | 455      | Ed LaRose                  |
| 5   | Powell Middle School                | 55       | 1,375    | 385      | Alex Rastatter             |
| 36  | Test Middle School                  | 35       | 875      | 245      | Luke Skywalker             |
| 220 | Cypress Creek High School (Pasco)   | 60       | 1,500    | 420      | (none — SuperUser only)    |

**Email convention.** All seeded staff use `@hcsb.k12.fl.us`.
Chris and Brandon were renamed from `@school.local` to
`chris.clifford@hcsb.k12.fl.us` and `brandon.wright@hcsb.k12.fl.us`
(IDs 83 and 84 preserved, passwords unchanged: `@Leopards` and
`@GoEagles`). All other generated staff (teachers + 4 named admins)
share the temporary password `PulseDemo!` (bcrypt cost 10) — they
should rotate via Profile on first login.

**Schedule.** Every school has the same 7-period bell schedule,
07:30–14:00, ~47 min periods with 5 min passing and a 35 min lunch
between P5 (ends 11:45) and P6 (starts 12:20). Each teacher has 1
planning period; planning periods are evenly distributed across the
7 periods so each non-planning period has roughly equal teaching
capacity. Students are round-robin assigned so each non-planning
section holds ~25 students.

**Accommodations rule.** 25 % of students are accommodated. Each
accommodated student is assigned EITHER an IEP base OR a 504 base
(never both), drawing 2–4 items from the 7 IEP / 4 504 master
strategies. There is then a 30 % chance to add 1–2 ELL items on top,
capped at 4 total. The "Strategy" category is intentionally not used
at the per-student level (it stays as a school-level master list
only).

**Globally-unique field workarounds.** Three columns still have a
global unique constraint that pre-dates the silo migration; the
seed prefixes values to avoid cross-school collisions, and these
prefixes are the canonical convention until those columns are
relaxed to per-school uniqueness:

- `students.student_id` — prefixed `S{schoolId}-{n}`, e.g. `S1-2000`,
  `S220-2000`.
- `locations.name` — prefixed with the school short name, e.g.
  `Parrott Room 101`, `CCHS Library`. (The schema comment on
  `locations.name` flags this as a known item.)
- `staff.email` — generated emails embed a global teacher sequence
  number (`sarah.rivera117@hcsb.k12.fl.us`) so two schools that
  happen to pick the same first/last pair never collide.

**Schema fix during seeding.** The DB had a stale global partial
unique index `bell_schedules_one_default_idx` from before the silo
migration that allowed only ONE `is_default = true` row in the
entire table — it would have blocked any second school from having
a default bell schedule and was not declared in `bellSchedules.ts`.
Dev was patched in place with:

```sql
DROP INDEX IF EXISTS bell_schedules_one_default_idx;
CREATE UNIQUE INDEX bell_schedules_school_default_idx
  ON bell_schedules (school_id) WHERE is_default = true;
```

The matching `uniqueIndex` declaration is now in
`lib/db/src/schema/bellSchedules.ts` so future `db push` runs do not
re-add the global index.

**⚠ Prod still has the old index** — it was created by the earlier
`db push` runs that built the prod tables, and `drizzle-kit push`
cannot be relied on to drop a legacy index that is no longer
declared. Before the next prod deploy uses bell schedules at all,
run the same two statements above against the prod DB (psql via the
deployed Postgres connection string). Verify after with
`SELECT indexname FROM pg_indexes WHERE tablename='bell_schedules';`
— only `bell_schedules_pkey`, `bell_schedules_school_id_idx`, and
`bell_schedules_school_default_idx` should remain.

**How the seed was applied.** Ad-hoc Node.js script in the code
sandbox (no committed file) using the workspace's `pg` install at
`node_modules/.pnpm/pg@8.20.0/...` and `bcryptjs@3.0.3`. Connection
string `postgresql://postgres:password@helium/heliumdb?sslmode=disable`
(env shows `PGPASSWORD=password`, not `postgres`). The same script
can be re-run safely — it wipes everything except `staff` IDs 83/84
and the static config tables (`schools`, `districts`, `custom_roles`,
`pbis_reasons`, `pullout_reasons`, `intervention_types`,
`polarity_pairs`, `trusted_adult_interventions`,
`district_integrations`) before re-inserting.

## MTSS Plans v1 (2026-04-24)

First slice of the MTSS Intervention Plan system. The Invisible Student
Finder and Teacher Roster page (both spec'd, on hold) will read from
this table.

**Schema.** `lib/db/src/schema/studentMtssPlans.ts` →
`student_mtss_plans` table (id, schoolId, studentId text, title, goals,
tier default 2, pointRangeMin/Max, notes, openedAt/By, closedAt/By,
created/updated). Indexes on `school_id` and `(school_id, student_id)`.
No FK constraint on student_id (matches codebase convention — JS-side
joins, AND-school filter).

**Goals format.** The `goals` column is a single text field, but the
client and server treat it as a **newline-delimited list of 1–5 goals**
(cap 800 chars per goal). `splitGoals` / `joinGoals` in
`MtssPlansAdmin.tsx` and `normalizeGoals` in `routes/mtssPlans.ts` keep
the two sides in sync — both trim, drop empty lines, slice to 5, and
clamp each line. The modal renders 1–5 numbered slots with "+ Add
another goal" (gated at 5) and a per-row remove button; removing the
last row resets to one empty input. The list view renders an `<ol>`
clamped to 3 visible lines. Legacy single-line plans parse cleanly as
a single goal — no migration needed.

**DDL on boot, not via drizzle-kit.** `drizzle-kit push` refuses to
apply this table non-interactively because rename detection confuses it
with legacy `user_sessions` / `check_in_with_options`. Instead, the
table is created idempotently at boot by `ensureMtssPlansSchema()` in
`seed.ts`, which is called from `seedMtssPlansIfEmpty()`. Mirrors the
"always-run schema fix" pattern already used for the bell_schedules
index. Fresh prod deploys self-heal — no manual SQL needed.

**Routes.** `artifacts/api-server/src/routes/mtssPlans.ts`:
- `GET /api/mtss-plans?status=active|closed|all&studentId=...`
- `POST /api/mtss-plans`
- `PATCH /api/mtss-plans/:id` — pass `{closed: true}` to close,
  `{closed: false}` to reopen
- `DELETE /api/mtss-plans/:id`

**Authz — "core team" gate on BOTH read and write.** Allowed:
SuperUser, Admin, BehaviorSpecialist, MtssCoordinator, PbisCoordinator.
Plain teachers get 403. Read is gated the same as write because plans
contain protected intervention notes; a broader read-only view for
classroom teachers can be added later if needed. Mirror flag on the
client is `canManageMtssPlans` in App.tsx — keep both in sync.

**Seed.** `seedMtssPlansIfEmpty()` is idempotent per-school: skips any
school that already has at least one plan. For each empty school it
seeds 20% of the roster with a placeholder Tier-2 plan, attributed to
"System Seed" so coordinators can tell them from real plans. Runs at
boot AFTER `seedIfEmpty()`. Verified: 1,950 plans across 7 dev schools
(175/400/300/325/275/175/300).

**UI.** `artifacts/client/src/components/MtssPlansAdmin.tsx`. Reachable
from two places (no sidebar entry — hub-tile only, like
`schoolStoreManage`):
- BS hub tile "MTSS Plans" (teal)
- MTSS Coordinator hub tile "MTSS Plans" (teal, first tile)

Single-screen list with status filter (active/closed/all), free-text
search across student name/ID/title, +New Plan button, per-row
edit/close/reopen/delete. Modal allows multiple active plans per
student (soft warning, not blocked).

**Open follow-ups (not blocking).**
- Concurrent boot seeding could double-seed if scaled horizontally.
  Single-instance deploy today, so not addressed.
- Sub-level cut points for the FAST PM pills (1.1/1.2/1.3, 2.1/2.2)
  still pending from user — only affects the Teacher Roster pill label,
  not anything in this slice.

## Where we paused (end of session, 2026-04-23)

Migration is done, app is published, but production is unusable
until the prod database is seeded. Picking up tomorrow needs all of
the following context.

**What's deployed.** The publish flow ran twice tonight — both
succeeded. The production environment is live at the user's
`.replit.app` URL (the user can find it in the Deployments pane;
not recorded here on purpose). The build copies code only, not data;
the production database is a brand-new, empty Postgres with all
tables created by `db push` but zero rows in `staff`, `schools`,
`districts`, etc. Logging into the live site fails not because of a
bug but because there is literally nothing to log into. The user
hit this and was confused — explanation in chat history.

## Production seed wired into boot (2026-04-24)

**`artifacts/api-server/src/seed.ts` was rewritten** so the same
multi-school dataset that lives in dev gets produced automatically
on the first prod boot. The two boot-time hooks are unchanged in
shape (`seedTenancy()` + `seedIfEmpty()` from `index.ts` →
`Promise.all`) but their bodies now do:

- `seedTenancy()`: idempotent. Inserts Hernando + Pasco districts
  and all 7 schools (Parrott, Springstead, Nature Coast, Weeki
  Wachee, Powell, Test Middle, Cypress Creek). Safe to re-run.
- `seedIfEmpty()`: marker-guarded on `school_accommodations`. Only
  runs when that table is empty (so dev — which already has 98
  rows — is unaffected). When it does run it:
  1. Drops the legacy `bell_schedules_one_default_idx` and creates
     the per-school `bell_schedules_school_default_idx`. This is the
     same DDL fix dev got patched with manually — baking it into the
     seed makes prod self-correcting.
  2. Wipes every per-school table (in dependency order, including
     bell schedules, school settings, hall pass limits, pullouts,
     ISS, interventions).
  3. For each of the 7 schools, generates: 55 teachers + optional
     SuperUser + optional named admin, 1390 students, 7 sections per
     teacher (one is planning), full roster, 14 master accommodations
     (IEP/504/ELL only — Strategy was excluded), per-student
     accommodation assignments (25% accommodated, IEP-OR-504 base of
     2-4, 30% chance to add 1-2 ELL on top, capped at 4), 15
     locations (school-prefixed names so they're globally unique),
     a 7-period bell schedule (7:30am-2:00pm with lunch between P5
     and P6), and a `school_settings` row.
  4. Resets the `students` and `staff` sequences.

Logins it produces in prod (same as dev):
- `chris.clifford@hcsb.k12.fl.us` / `@Leopards` (SuperUser, Parrott)
- `brandon.wright@hcsb.k12.fl.us` / `@GoEagles` (SuperUser, Springstead)
- `brad.merschbach@hcsb.k12.fl.us` / `PulseDemo!` (Admin, Nature Coast)
- `ed.larose@hcsb.k12.fl.us` / `PulseDemo!` (Admin, Weeki Wachee)
- `alex.rastatter@hcsb.k12.fl.us` / `PulseDemo!` (Admin, Powell)
- `luke.skywalker@hcsb.k12.fl.us` / `PulseDemo!` (Admin, Test Middle)
- All 385 generated teachers: `<first>.<last><N>@hcsb.k12.fl.us` /
  `PulseDemo!` (N is a global counter so emails are unique)

**Prod IDs will differ from dev.** Dev has school IDs 1-5, 36, 220
(historical accidents). Prod will assign 1-7 in `SCHOOL_SPECS`
order. The UI never exposes school IDs to principals so this is
cosmetic, but is worth knowing if you debug by ID in prod.

**Re-seeding prod.** The marker is "is `school_accommodations`
empty?" — so to force a reseed in prod, run
`TRUNCATE school_accommodations` against the prod DB (read-only
query tool can't do this; you'd need direct psql access via the
deployment's connection string). On the next app restart the seed
fires again. Don't truncate while principals are mid-session.

**Dev DB state, end of session.** Two SuperUser accounts, both with
known passwords (set this session, in chat history; both should be
rotated by the user via the Profile page on next login):

| id | email                          | display_name    | school_id | is_admin | is_super_user | password   |
|----|--------------------------------|-----------------|-----------|----------|---------------|------------|
| 83 | chris.clifford@school.local    | Chris Clifford  | 1 (Parrott)     | t  | **t** | `@Leopards` |
| 84 | brandon.wright@school.local    | Brandon Wright  | 2 (Springstead) | t  | **t** | `@GoEagles` |

Bcrypt cost 10 (matches `auth.ts` and `change-password.ts`); reset
via direct UPDATE using bcryptjs from
`node_modules/.pnpm/bcryptjs@3.0.3/...` (the workspace package is
`bcryptjs`, not `bcrypt` — `import('bcrypt')` from the code
sandbox throws ERR_MODULE_NOT_FOUND).

**Two open decisions waiting on the user.** Do not act on these
without confirmation — both were explicitly raised at end of
session and the user replied "let's rest":

1. **Drop Brandon's `is_super_user` flag.** The user's stated mental
   model is "Brandon will be the *admin* on Springstead, I'll be the
   sole Hernando SuperUser." Brandon currently still has
   `is_super_user = true` (carried over from before this session;
   only his school_id, is_admin, password, and active_school_override
   were touched). If the user confirms, run
   `UPDATE staff SET is_super_user = false WHERE id = 84;` That
   leaves him as a school-scoped admin at Springstead.
2. **Seed production.** Prod has none of: districts (Hernando=1,
   Pasco=37), Hernando schools (Parrott=1, Springstead=2, NCT=3,
   Weeki=4, Powell=5, Test Middle=36), or staff. Decide with the
   user: (a) mirror dev exactly (same emails, same school IDs,
   same passwords — fastest, but `@school.local` emails are obvious
   placeholders); (b) seed with real `@hernandoschools.org`-style
   emails and a fresh starter password; (c) seed Hernando only and
   defer Pasco's 96 schools until ready to onboard them with real
   data. The user has not chosen. Pasco's school list isn't in dev
   either — D6 set up the *district* row but no schools were ever
   imported, so seeding Pasco for prod still requires their actual
   school roster (CSV / SIS export / Florida DOE list).

**Next session, start by asking:**

1. "Do you want me to drop Brandon's SuperUser flag so he's the
   Springstead admin only and you're the sole Hernando SuperUser?"
2. "How do you want me to seed production — same setup as dev, or
   do you want to use real district email domains and start with a
   fresh password? And do you have Pasco's school list yet, or
   should we seed Hernando only for now?"

Then act on the answers and the production deploy is actually
useful. Until then, the live URL exists but no one can log in.
require setting up vitest + supertest + a test database strategy),
and an `isCrossDistrictSuperUser` flag for a Replit-side support
persona that needs to move between districts.

## Teacher Roster v1 (2026-04-24)

**What shipped.** A new "Teacher Roster" page that lists each teacher's
students with their FAST PM1/PM2/PM3 scores rendered as colored
sub-level pills, a bucket icon showing how many points away the
student is from the next achievement level, and a Bottom Quartile (BQ)
flag based on the student's prior-year final scale score.

**Schema.** New `student_fast_scores` table (`lib/db/src/schema/
studentFastScores.ts`):

- `(id, schoolId, studentId text, subject 'ela'|'math', pm1, pm2, pm3,
  priorYearScore, priorYearBq, timestamps)`
- `UNIQUE(schoolId, studentId, subject)` — CSV import (deferred) will
  upsert on this key.
- Boot-time `ensureFastScoresSchema()` self-creates the table with
  `CREATE TABLE IF NOT EXISTS` (same workaround as MTSS plans — drizzle
  push is non-interactive and gets confused by legacy renames).
- Re-exported from `lib/db/src/schema/index.ts`.

**Cut-score chart + helpers.** `artifacts/api-server/src/lib/
fastCutScores.ts` encodes:

- ELA Table 6 grades 3-10 (full L1/L2 sub-bands + L3/L4/L5).
- Math Table 8 grades 3-8 only. Algebra 1 / Geometry are deliberately
  NOT in v1 — students taking those courses just won't have a Math
  chart, and the bucket icon is suppressed.
- `placeOnChart(score, subject, grade)` → `{level, subLevel}`.
- `placePm3(score, subject, currentGrade)` → uses the **prior-grade**
  chart (so PM3 represents end-of-prior-year mastery). Falls back to
  current grade for 3rd graders (no prior).
- `bucketTarget(subject, currentGrade, level)` → next-level min on the
  current-grade chart, or `null` for L5 / grade 3 / no-chart subjects.
- `bucketColor(gap)` → green ≤ 0, orange 1-5, red > 5.
- `bucketFor(pm3, subject, grade)` → one-shot `{targetScore, gap, color}`
  used by the API.

**Placeholder seed.** `seedFastScoresIfEmpty()` in `seed.ts`:

- Per student per subject, picks a "true level" with a middle-skewed
  weighted distribution (20% L1 / 35% L2 / 25% L3 / 15% L4 / 5% L5),
  then generates PM1/PM2/PM3 with mild positive drift to mimic
  learning gains. Prior-year score is generated on the prior-grade
  chart at the same level. BQ flag probability is 85% at L1, 45% at
  L2, 5% otherwise (yields ~25% BQ overall).
- Idempotent per school (same skip-if-non-empty pattern as MTSS plans).
- Math rows skipped for grades 9-10 (no chart).
- First boot seeded ~9,600 rows across 7 schools.

**API.** `routes/teacherRoster.ts`:

- `GET /api/teacher-roster?teacherId=&period=` — returns enriched
  rows with placement + bucket computed server-side.
  - No `teacherId` → caller's own roster.
  - `teacherId` ≠ caller → core-team gate (admin / superuser / ESE /
    behavior specialist / MTSS coordinator). Mirrors the
    schedule.ts `?all=1` gate.
  - Optional `period` filter; response always includes
    `availablePeriods` so the client can render the period chip row
    even when the current filter is empty.
- `GET /api/teacher-roster/teachers` — picker source. Plain teachers
  get a single-entry list (themselves); core-team members get every
  staff in their school who teaches at least one section.
- Mounted in `routes/index.ts` after `mtssPlansRouter`.

**Client.** `artifacts/client/src/components/TeacherRosterPage.tsx`:

- Mirrors the MtssPlansAdmin pattern (component file under `components/`,
  authFetch, local state, no global store).
- Teacher picker (core team only) + period chip row + legend +
  summary line + table (Student | Grade | ELA | Math | BQ).
- Each subject cell renders 3 PM pills (PM1/PM2/PM3) with the
  sub-level shown on the pill, color-coded by level (red/orange/yellow/
  green/blue), plus a circular bucket icon (green ✓ at-or-above target,
  otherwise the gap value in orange or red).
- Hover tooltips on every pill explain "PM• Level x.y • Scale score N".
- BQ column shows red `BQ ELA` / `BQ Math` chips (only when the
  prior-year flag is set).
- Wired into App.tsx in three places: sidebar nav (visible to everyone),
  BS hub tile, MTSS hub tile. `activeSection: "teacherRoster"`.

**Scope rules (the four rules the user confirmed at the start of the
session).**

1. Seed placeholder FAST scores now; CSV import in Settings is a
   deliberate follow-on (deferred).
2. Teachers see their own roster; core team (Admin / SuperUser / ESE /
   BS / MTSS) can pick any teacher.
3. BQ is the Bottom Quartile based on prior-year final scale score
   (not a current-year computation).
4. For 3rd graders and for Algebra 1 / Geometry students, the bucket
   icon is hidden and only the level pill renders. (3rd graders have
   no prior-grade chart; Algebra/Geometry have no chart at all.)

**Deferred follow-on: CSV import.** Settings → "FAST Scores" with a
file picker that upserts `student_fast_scores` on
`(schoolId, studentId, subject)`. CSV columns expected to be at least
`student_id, subject, pm1, pm2, pm3, prior_year_score`. Not built yet.

---

## Per-school feature toggles (two-tier model)

Six top-level features have per-school on/off switches behind a
two-tier model: a SuperUser-level "allowed" flag (the billing /
availability gate) and an admin-level "enabled" flag (the school's
day-to-day on/off). A feature is **effective** when both are ON.

**Schema (`school_settings`).** Twelve booleans, all
`NOT NULL DEFAULT TRUE` so existing schools keep current behavior:

- `feature_family_comm` / `super_feature_family_comm`
- `feature_pbis` / `super_feature_pbis`
- `feature_school_store` / `super_feature_school_store`
- `feature_accommodations` / `super_feature_accommodations`
- `feature_log_intervention` / `super_feature_log_intervention`
- `feature_request_pullout` / `super_feature_request_pullout`

Added at boot via `ensureSchoolSettingsFeatureFlagsSchema()` in
`seed.ts` using `ALTER TABLE … ADD COLUMN IF NOT EXISTS … DEFAULT TRUE`,
wired into the existing `seedFastScoresIfEmpty` boot chain. Idempotent —
safe on every restart, and back-fills existing rows to TRUE.

**API (`routes/schoolSettings.ts`).**

- `FEATURE_KEYS` central list keeps GET, PUT, and the derived map in
  sync.
- GET `/api/school-settings` returns the row plus
  `effectiveFeatures: { FamilyComm, Pbis, SchoolStore, Accommodations,
  LogIntervention, RequestPullout }` where each value is
  `super_* && feature_*`.
- PUT `/api/school-settings` accepts `featureX` (admin or SuperUser)
  and `superFeatureX` (SuperUser only). Returns 403 if a non-SuperUser
  tries to flip a `super_*` flag, or if an admin tries to enable a
  `feature_*` whose `super_*` counterpart is currently false (and not
  also being flipped on in the same payload). Server-side teeth behind
  the locked-checkbox UX.

**Client.**

- `schoolSettings` state (App.tsx) carries all 12 fields; load + save
  round-trip them. Defaults to true so the first paint matches the
  server for every existing school.
- New `effectiveFeatures` computed near `baseNavSections` and used to:
  - filter the six gated sidebar entries (`student`,
    `pbis`, `schoolStore`, `accommodations`, `logIntervention`,
    `requestPullout`); Hall Passes / Tardy Pass / Teacher Roster are
    never gated.
  - hide the `schoolStoreManage` tile in the PBIS, BS, and MTSS hubs
    when SchoolStore is off. (The PBIS Hub previously had a separate
    `pbisStore` placeholder tile; that was retired in favor of pointing
    all three hubs at the same `schoolStoreManage` view, since the
    rewards catalog is school-wide rather than PBIS-only.)
  - hide the `logIntervention` tile in the BS hub when LogIntervention
    is off.
- New "School Features" tile in `SettingsHub` (admin + SuperUser),
  `SettingsTileId = "schoolFeatures"`. Panel renders one row per
  feature: admin sees a single checkbox (locked + greyed when
  `super_* = false`, with a "Disabled by your district SuperUser"
  tooltip); SuperUser sees both Allowed and Enabled checkboxes.
  Subtitle on the tile shows `<live>/6 live` at a glance.

**Out of scope (intentional).** Verify Pullouts has **no** dependency
on Request Pullouts here. The user explicitly kept them separate: a
school could turn off teacher-driven pullout requests while still
verifying pullouts created by other paths. If we ever want to gate
Verify Pullouts too, add a 7th `feature_verify_pullout` /
`super_feature_verify_pullout` pair and another `effectiveFeatures`
entry — do not piggy-back on `RequestPullout`.

---

## HeartBEAT Snapshot — Parent Portal v1 (shipped Apr 24, 2026)

Parents log into a separate portal to see their student's HeartBEAT
data (PBIS, hall passes, tardies, accommodations, staff notes). Admin
sends invites from Settings → Parent Access; parent clicks the email
link, sets a password, sees their kid.

**Decisions made (don't re-ask):**
1. Parents only in v1. Students later via ClassLink (deferred).
2. Email + self-set password. Invite link is the bootstrap.
3. Linking is admin-driven: admin uploads parent emails on the student
   roster (or types them inline in Parent Access), parent accepts the
   invite — that creates the `parents` row and the `parent_students`
   link. **Never written back to `students` table.**
4. Per-row email override + "+ Add another email" button supports
   mom/dad/grandma — each adult gets their own invite for the same
   student; all of them land on the same Snapshot when accepted.
5. Sibling switcher lives in the dashboard header (reads `parent_students`).
6. Section visibility is gated by `school_heartbeat_settings`.

**DB tables (migration: `pnpm db:push --force` already run):**
- `parents` — id, email, passwordHash, displayName, schoolId
- `parent_students` — M:N (parentId, studentId)
- `parent_invites` — id, schoolId, studentId, email, token, status
  (pending/accepted/expired/revoked), sentAt, expiresAt, acceptedAt,
  acceptedParentId, resendCount, sentByStaffId
- `school_heartbeat_settings` — per-school visibility flags for each
  Snapshot section
- `parent_heartbeat_prefs` — per-parent saved toggles (used later by
  HeartBEAT Report PDF)

**Backend routes:**
- `artifacts/api-server/src/routes/parentAuth.ts` — login, me, logout,
  accept-invite, change-password, request-password-reset. Session key
  is `req.session.parentId` (separate from staff `staffId`). Bearer
  token variant for iframe stored in sessionStorage `pulseed.parentToken`.
- `artifacts/api-server/src/routes/parentInvites.ts` — admin endpoints:
  - `GET /api/admin/parent-invites` — one row per student, with **all**
    invites for that student (latest-first) so multi-parent shows up.
  - `POST /api/admin/parent-invites/send` — bulk send to every eligible
    student (uses `students.parent_email`).
  - `POST /api/admin/parent-invites/send-one` `{studentId, email}` —
    single send with email override; powers the per-row form and the
    "+ Add another email" button.
  - `POST /api/admin/parent-invites/:id/resend` and `/revoke`.
- `artifacts/api-server/src/routes/parentSnapshot.ts` —
  `GET /api/parent/snapshot?studentId=…` returns identity, PBIS (with
  sparkline + week stats), hall passes, tardies, accommodations, staff
  notes. Each section is gated by `school_heartbeat_settings`.
- `artifacts/api-server/src/lib/parentInviteEmail.ts` — Resend wrapper
  with branded subject/body using school name + signature.

**Frontend:**
- `artifacts/client/src/parent/` — standalone parent app:
  - `ParentApp.tsx` — path-based router (login / accept-invite /
    forgot / reset / dashboard). No staff sidebar.
  - `api.ts` — `parentFetch()` + redirect-on-401.
  - `ParentLogin.tsx`, `AcceptInvite.tsx`, `Dashboard.tsx`
    (real-data port of the Snapshot mockup, sibling switcher in header).
- `artifacts/client/src/main.tsx` — `path.includes("/parent")` →
  `ParentApp` (else `App` for staff, `/kiosk` → `Kiosk`).
- `artifacts/client/src/components/ParentAccess.tsx` — the admin tile
  (Settings → 👪 Parent Access). Per-student card: name + grade,
  status pill, list of invites with Resend/Revoke per email, inline
  "Send invite" form (pre-fills with Skyward parent_email if no
  invite yet), "+ Add another email" for multi-parent.
- `artifacts/client/src/components/SettingsHub.tsx` — added
  `"parent-access"` to `SettingsTileId`.

**Tailwind wiring (important):** parent components use Tailwind
utilities; staff app does NOT. Resolved with a top-of-file import in
`artifacts/client/src/index.css`:
```css
@import "tailwindcss/theme.css";
@import "tailwindcss/utilities.css";
```
**Preflight is intentionally NOT imported** — that would clobber the
staff app's existing custom CSS. Verified parent login + staff app both
render correctly.

**Deferred (revisit later):**
1. ClassLink SSO for students.
2. School-level "available sections" admin toggle UI (rows exist,
   admin UI not built).
3. Per-parent toggle UI for what's in their HeartBEAT Report.
4. PDF export of the HeartBEAT Report.
5. Optional weekly emailed PDF (Resend already wired).

**Mockup files (do not delete — referenced when iterating):**
- `artifacts/mockup-sandbox/src/components/mockups/heartbeat/Snapshot.tsx`
- `artifacts/mockup-sandbox/src/components/mockups/heartbeat/ReportToggle.tsx`

## Parked: Bathroom Queue (kiosk station)

User wants a kiosk-style "bathroom queue" tied to the existing kiosk
system. While a pass is active, the green countdown screen also accepts
keyboard input — pressing spacebar pops a small field for a student ID,
which adds them to a queue shown on the side. When the current pass
ends, the next queued student is auto-promoted to "Up Next" and they
press spacebar to start their own pass.

**Status (Apr 24, 2026):** Idea captured, parked. User wants to keep
working on HeartBEAT first.

**Decisions already made (don't re-ask):**
1. Kiosk is the pass issuer — no teacher step. Walk up → queue →
   spacebar → pass starts.
2. One shared queue per kiosk (no boys/girls split).
3. Auto-skip "Up Next" after 60 seconds with no spacebar; promote next.
4. Queue resets at the end of each period. **No new passes can be
   created during the last 10 minutes of any period.**
5. Must preserve the existing big green countdown screen — the queue
   lives alongside it, not in place of it.

**Still open (ask when un-parking):**
- Where the queue panel lives visually on the green screen (right
  rail? bottom strip?).
- Whether teachers/admins see the queue from their dashboards too.
- What "end of period" means when the school's bell schedule isn't
  fully wired (does it use existing bell schedule, or a per-kiosk
  timer?).

---

## 2026-04-26 — Phase 3: rosters + behavior importers (architect Pass)

Extended the importer beyond assessments. Same `KIND_CONFIGS` registry
pattern, two new kinds:

- **rosters** writes to `students`. Insert uses `onConflictDoNothing` on
  `(school_id, student_id)` so re-uploading a roster file is idempotent;
  the diff between `validRows` and `committedRows` surfaces as
  `skippedRows` in the response (warnings, not errors).
- **behavior** writes to `support_notes`. Pure INSERT (no de-dup —
  every row is a distinct event). Defaults `note_type='concern'`,
  `staff_name='CSV Import'`, `created_at=now()` when not mapped.

Both kinds are **school-scope only** for now (no district variant).
Rollback uses `KIND_CONFIGS[kind].rollback(tx, importJobId, schoolId)` —
the dispatcher in DELETE rollback now routes through the registry, with
the legacy assessments branch retained for the district-scope case.

Schema additive: `students.import_job_id` and
`support_notes.import_job_id` (both nullable integer) added via psql
ALTER + mirrored in `lib/db/src/schema/{students,supportNotes}.ts`. No
FK — same convention as `assessments.import_job_id`.

Frontend (`DataImports.tsx`):
- `Kind` widened to `"assessments" | "rosters" | "behavior"`.
- `KIND_DEFS` metadata table drives the radio selector + targets dict.
- `effectiveScope` clamps to "school" for kinds without district
  support; the scope toggle hides for those kinds.
- `kind` is now a useEffect dep for `loadJobs` / `loadTemplates` so
  switching kinds refreshes the History list and template dropdown.

Backend `validateTemplateMapping(mapping, kind)` is now kind-aware:
assessments preserves the legacy `VALID_TARGETS` set; rosters/behavior
look up `KIND_CONFIGS[kind].validTargets`. This unblocks saving
templates for the new kinds.

Architect Pass on second review. Attendance importer **deferred** — no
`daily_attendance` table exists; needs schema discussion before
proceeding. Next: eduClimber-style Insights module.

### Future direction — attendance via Skyward + ClassLink (2026-04-26)

User signaled intent to eventually pull attendance from **Skyward** (the
SIS) and **ClassLink** (identity / OneRoster rostering provider). This
informs the deferred attendance importer design:

- Don't ship attendance as "CSV only." Build a source-adapter layer
  where CSV is one adapter; Skyward (REST or SFTP nightly drop,
  contract-dependent) is another; ClassLink OneRoster is another (best
  for roster + enrollment sync, less for live attendance).
- All adapters should feed into the same `import_jobs` pipeline so
  preview, commit, rollback, and audit work uniformly regardless of
  source.
- ClassLink overlap with Replit Auth / Clerk: ClassLink also does SSO,
  so when we wire it up we'll need to decide whether ClassLink replaces
  or supplements the current sign-in path.

Schema decision to revisit when we start: per-day vs per-period
attendance, the code dictionary (P / A / T / E / U / ISS / OSS), and
excused-reason free-text vs enum.
