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

## Multi-tenancy — Day 1 (April 2026)

PulseEDU is migrating from single-tenant to silo-per-district. Day 1 of the
Week 1 plan added the foundation tables; data tables remain unscoped until
Day 2.

- New tables: `districts`, `schools` (`lib/db/src/schema/{districts,schools}.ts`).
- Seeded: `Hernando County School District` (slug `hernando`, state code `27`)
  with 5 schools — D. S. Parrott Middle (PRIMARY, code 0241), F. W. Springstead
  High (0181), Nature Coast Technical High (0351), Weeki Wachee High (0391),
  Powell Middle (0221).
- New SuperUser-only Settings tile: **Tenancy** (`TenancyPanel.tsx`) showing
  the registered district + schools and current district-wide row counts.
- API: `GET /api/tenancy/status` (SuperUser-gated) — `routes/tenancy.ts`.
- Tables created via direct SQL because drizzle-kit push prompts on rename
  detection between unrelated existing tables (same workaround used for the
  PBIS thresholds columns).

Day 2 will add `school_id` to all ~22 tenant-scoped tables, backfill every
existing row to D. S. Parrott (`is_primary = true`), make `school_id` NOT
NULL, carry `schoolId` on the auth session, and scope every route query.

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
