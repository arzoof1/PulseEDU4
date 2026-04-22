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
