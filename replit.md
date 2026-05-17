# PulseEDU

PulseEDU is a multi-tenant application providing tools for school operations, student support, and insights.

## Run & Operate

- `pnpm run typecheck`: Full typecheck across all packages.
- `pnpm run build`: Typecheck + build all packages.
- `pnpm --filter @workspace/api-spec run codegen`: Regenerate API hooks and Zod schemas from OpenAPI spec.
- `pnpm --filter @workspace/db run push`: Push DB schema changes (dev only).
- `pnpm --filter @workspace/api-server run dev`: Run API server locally.

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

## Where things live

- `lib/db/src/schema/`: Database schemas (source of truth).
- `artifacts/api-server/src/routes/`: API endpoints.
- `artifacts/client/src/`: Frontend application code.
- `artifacts/client/src/index.css`: Global CSS, including UI style conventions.
- `artifacts/api-server/src/lib/scope.ts`: Multi-tenancy and school-scoping helpers.
- `artifacts/api-server/src/seed.ts`: Database seeding logic.
- `artifacts/api-server/src/lib/coreTeam.ts`: Core team role definitions.
- `artifacts/client/src/parent/`: Standalone parent portal application.
- `artifacts/mockup-sandbox/src/`: Mockup components for design review.

## Architecture decisions

- **Multi-Tenancy**: `school_id` is central to data isolation, filtering every read/write. SuperUser role is district-wide, others are school-scoped. `req.schoolId` in middleware ensures correct context.
- **API Versioning/Schema Evolution**: Drizzle-kit is not used for non-interactive schema changes; direct SQL `ALTER TABLE IF NOT EXISTS` is preferred for additive changes to avoid blocking interactive prompts.
- **Object Storage**: Custom object storage routes (`/api/storage/*`) with ACLs enforce school-level tenant isolation for uploaded assets (e.g., store item thumbnails) using `bindObjectToSchool` and `pendingUploads` ledger.
- **Client-Side Routing/Bundling**: The application uses a single Vite client with path-based dispatch (`/signage/*`, `/parent/*`, `/*`) handled in `main.tsx` to serve different user experiences (signage, parent portal, staff app) from a unified bundle.
- **UI Design Philosophy**: Screenshots from other products are treated as conceptual references for "what" to build, not "how" to build it. PulseEDU designs from scratch, focusing on improved functionality and distinct visual identity.

## Product

- **Display Management**: Per-school playlists for digital signage TVs, supporting image, video, audio, and PDF items. Includes scheduling, PBIS house standings, active hall pass displays, and Heartbeat signage.
- **Safety Plans**: Per-student behavioral/physical safety checklists with library items, audit logs, and role-based access (Guidance Counselor/Core Team for editing, all staff for viewing). Integrated into student rosters and profiles.
- **PBIS Hub & Store**: PBIS point tracking, student recognition, and two reward catalogs (Classroom Store, School Store). School Store is school-wide and read-only for teachers, with full edit controls for admins/PBIS coordinators.
- **MTSS Intervention Plans**: Tier 2/3 intervention plan tracking for students, including goal setting, weekly progress monitoring, strategy categories, and completion reports. Features a tier-aware launcher and bell notification system.
- **Parent Portal**: Secure portal for parents to view their student's HeartBEAT data (PBIS, hall passes, tardies, accommodations, staff notes). Features admin-managed invites, sibling switching, configurable section visibility, and PDF export of reports.
- **Insights Dashboards**: Suite of analytics dashboards (Engagement, Behavior, Academics, SEB/SEL, Equity, Early Warning) providing aggregate data, trends, and top-N lists. Features grade/window filters, demographic disaggregation, and drill-down to student profiles.
- **Teacher Roster**: Comprehensive view for teachers of their students, including FAST scores, ESE/504/ELL program flags, and safety plan indicators. Core Team members can view any teacher's roster.
- **Data Importer**: Generic importer for assessments, rosters, and behavior data, supporting CSV uploads with template mapping, preview, commit, and rollback functionality.
- **Parent Pick-Up Module**: Curb keypad (`/pickup/curb`) with phone-first numeric entry + sibling roll-up scoped to the typed parent's authorizations, restricted-tag override-with-justification, walker gate (`/pickup/walkers`) with bell-window enforcement, admin authorization issuer (bulk start-of-year assign, lost-tag reissue, extra-guardian splits, single + batch PDF tag printing with QR codes, 80%-of-range capacity warning), classroom signage tile (filtered to playlist owner's roster), and Admin Hub "Still on campus" reconciliation tile (post-cutoff, grouped by dismissal mode). Tag-management role gate (`canManagePickup` in `lib/coreTeam.ts`) admits admin + Core Team + counselor + front-office + confidential secretary; teachers are excluded. Audit trail in `pickup_queue_events` is append-only.

## User preferences

_Populate as you build_

## Onboarding (critical setup notes)

- **Configure a default bell schedule before enabling Hall Pass Queue.** The
  queue auto-resets when the bell-schedule period changes, giving each
  period a clean line. If no default bell schedule is configured, the
  queue falls back to 45-minute idle buckets — usable, but the period-aware
  reset is the intended UX. School Settings → Bell Schedules → mark one
  schedule as the default.

## Future work

### Recently shipped (reference only — no remaining action)

- **Bulk feature picker + admin "reset to temp password".**
  (1) `FeaturePickerModal` in `FeatureLicensingAdminPage.tsx`
  — per-school "Pick features…" button opens a 2-col checkbox
  grid pre-checked to current effective state (override else plan
  default), All on / All off shortcuts, optional reason, serial
  POSTs to existing `/api/feature-licensing/schools/:id/overrides`
  for every feature (preserves existing `showUpsell`). Fixes the
  field UX gap where Overrides drawer required N manual disable
  rows to get "only these features live for this school."
  (2) Shared CSPRNG helper `lib/tempPassword.ts`
  (`generateAndHashTempPassword`) — tenancy onboard-district +
  onboard-school both switched over; identical alphabet/length/cost.
  (3) `POST /admin/staff/:id/reset-temp-password` in `adminStaff.ts`
  — generates fresh temp password, returns it ONCE in response.
  Mirrors every gate from `/admin/staff/:id/password` (Admin/Super
  only, non-self, same-school for admin / district for super,
  cannot reset Super/DA unless caller is Super, active only).
  Surfaced as "Reset to temp" button in `StaffRolesMatrix` with
  confirm + one-time reveal modal (copy button, monospace, "you
  won't see it again" warning). Use cases: lost first-login
  credential, resend invite. No email-invite table yet — that's
  the long-term path (see Open work).

- **Two-tier feature flag AND fix.** `loadEffectiveFeatures` in
  `lib/featureLicensing.ts` now ANDs admin `feature_*` with
  `super_feature_*` (derives admin key by stripping "super"
  prefix; defaults true if admin column absent for AST-style
  features). Closes the bug where Parrott Middle SuperUser
  toggled overrides but teachers still saw every feature
  (Enterprise plan defaults all-on, overrides only set the
  super tier — admin tier remained true, so AND was redundant).

- **Per-school plan editor + plan picker on onboarding.**
  Server: `POST /api/tenancy/onboard-district` and `POST
  /api/tenancy/onboard-school` now accept optional `planKey`
  (defaults to `enterprise`; unknown key 400s before tx; plan
  lookup + `applyPlanToSchool` happen inside the same tx as
  school creation, no partial state on failure).
  `/api/district-admin/overview` SchoolRow now exposes
  `planId`/`planKey`/`planLabel` via a single bulk `plansTable`
  read joined in a `Map` (no N+1). Client: `usePlans` hook,
  `ChangePlanModal` (reuses existing `PATCH
  /api/feature-licensing/schools/:id/plan`), plan `<select>` in
  both onboard modals, new "Plan" column + per-row "Plan" button
  in `DistrictOverviewRollups` (SuperUser-gated column, colSpan
  bumped 3→4). Security: added `assertSchoolInCallerDistrict`
  helper (mirrors tenancy.ts `ALLOW_CROSS_DISTRICT_SUPERUSER`
  env gate) to all three per-school licensing writes: `PATCH
  /feature-licensing/schools/:id/plan`, `POST
  /feature-licensing/schools/:id/overrides`, `DELETE
  /feature-licensing/schools/:id/overrides/:overrideId`. Also
  scoped the `PATCH /feature-licensing/plans/:id` reapply
  fan-out to caller-district schools only (returns
  `skippedCrossDistrictCount`). Known follow-up below.

- **Edit + soft-delete districts.** `PATCH /api/tenancy/districts/:id`
  in `routes/tenancy.ts` — SuperUser-only, same cross-district env
  gate. Partial patch over `name`, `slug` (validated `^[a-z0-9-]+$`),
  `stateDistrictCode`, `timezone`, `active`. 23505 → 409 on slug
  collision. Soft-delete enforced in `app.ts`: the home-school
  lookup is now a leftJoin to `districts` and the request-context
  guard requires BOTH `school.active` and `district.active`; either
  false clears `req.schoolId`. Client `EditDistrictModal.tsx` +
  per-card Edit / Deactivate-Reactivate buttons in
  `SuperUserHomeRollups`. "+ Add school" disabled with tooltip on
  inactive districts.

- **Edit + soft-delete schools.** `PATCH /api/tenancy/schools/:id`
  in `routes/tenancy.ts` — SuperUser-only, same cross-district env
  gate as onboard-school. Partial patch over `name`, `shortName`,
  `stateSchoolCode`, `active`; null/empty clears the optional
  strings. 23505 → 409 with composite-unique-index message.
  Refuses to deactivate `isPrimary` schools (409 — deactivate the
  district instead). Hard-delete intentionally not offered (too
  many FK dependents). Soft-delete is enforced at request-context
  resolution in `app.ts`: if the staff's home school is `active=false`,
  `req.schoolId` is cleared so downstream route guards 4xx; the
  override branch also requires `overrideSchool.active`. Client
  modal `components/districtOverview/EditSchoolModal.tsx` + new
  inline "Edit" / "Deactivate"-"Reactivate" buttons in the
  SuperUser-gated action column of `DistrictOverviewRollups`.
  Overview now returns `active` per school and includes inactive
  schools for SuperUsers (so they can reactivate from the row).

- **Onboard-a-School (existing district).** `POST
  /api/tenancy/onboard-school` in `routes/tenancy.ts` — SuperUser-only,
  tx-wrapped school → schoolSettings → applyPlan → first admin under
  an existing `districtId`. Reuses the same CSPRNG temp-password +
  23505 → 409 patterns from `onboard-district`. New schools default
  to `isPrimary: false` (the district's primary was created at
  district onboarding). Client modal
  `components/districtOverview/OnboardSchoolModal.tsx` is launched
  from a per-card "+ Add school" button in `SuperUserHomeRollups`.
  TODO when per-district plan selection lands: replace the hard-coded
  `enterprise` lookup with the district's actual current plan.

- **SuperUser Audit & Health panel.** `GET /api/superuser/audit-health`
  in `routes/districtOverview.ts` returns per-district health
  (schools active/inactive, active staff, audit events in last 7d
  across `feature_licensing_audit_log` + `iss_admin_log_audit` +
  `interaction_audit_log`) plus a merged recent-activity timeline
  (last 25 events, joined to district via `schoolsTable`, missing
  actor names backfilled from `staffTable` in one bulk lookup —
  no N+1). Scope reuses the `ALLOW_CROSS_DISTRICT_SUPERUSER` env
  gate from `/superuser/overview`. Client component
  `components/districtOverview/AuditHealthPanel.tsx` mounts below
  `<SuperUserHomeRollups />`. Schema unchanged; no "login activity"
  or "error rates" surfaced (no source data — drop or add new
  schema later). 7-day count uses fully parameterized `sql.join`
  for school IDs (no `sql.raw` string assembly).

- **SuperUser + District Overview landing rollups + Onboard-a-District
  wizard.** `routes/districtOverview.ts` (GET `/api/superuser/overview`,
  GET `/api/district-admin/overview`) + POST
  `/api/tenancy/onboard-district` (tx-wrapped district + first school +
  schoolSettings + enterprise plan + first admin; CSPRNG temp password
  returned once; 23505 → 409). Client components in
  `components/districtOverview/` replace the placeholder card grids on
  superUserHome + districtAdmin; roadmap cards moved into collapsed
  `<details>`. Cross-district SuperUser reach is gated behind
  `ALLOW_CROSS_DISTRICT_SUPERUSER=1` (defaults to caller's district);
  swap for a per-staff `isCrossDistrictSuperUser` flag when that tier
  lands. "Switch to school" row action hidden for non-SuperUser
  (server returns `caller.isSuperUser`).

- **FAST scale-score coverage.** 3rd-grade bucket fallback;
  EOC scaffolding + `ALGEBRA1_EOC` / `GEOMETRY_EOC` cut scores from
  FL DOE Table 8; `Subject` union widened to
  `"ela" | "math" | "algebra1" | "geometry"`; admin FAST Coverage
  telemetry tile.
- **AI Consistency Check runtime.** Header pill, side panel,
  per-row dot, dismiss-with-justification, "What the AI saw" drawer.
- **Admin Hub ISS log — view + edit/delete with audit guardrails.**
  `IssLogDetailDrawer` (Detail + History), `iss_admin_log_audit`
  table, all mutation handlers tx-locked via `SELECT ... FOR UPDATE`
  on parent + day rows. Helpers: `isDayServed()` (server) mirrored
  by client `isServed()` — keep these two in sync. OSS edit/delete
  intentionally not implemented.
- **Parent Pick-Up Module.** Curb keypad, walker gate with photo
  rendering, curb-page photo verification, tag management
  (bulk-assign + reissue + PDF + capacity warn), classroom signage
  tile, Admin Hub "Still on campus" reconciliation. QR scan dropped
  as a product decision.
- **Feature licensing Phases 1–3.** Plans + per-school Overrides
  (expiration + audit), SuperUser admin UI, AST + Parent Portal
  gated end-to-end, page-level `<FeatureGate>` + nav HIDE for
  off-no-upsell features, daily expired-override sweep cron
  (`cron/featureLicensingOverrideSweep.ts`, 02:15 UTC, idempotent
  via partial unique index on the audit table), two quota consumers
  (`parentPortal.maxParentAccounts` in `routes/parentInvites.ts`,
  `displays.maxPlaylists` in `routes/displays.ts` POST + PATCH
  re-activation), SuperUser audit-log viewer, schools-near-quota
  telemetry tile (walks `KNOWN_SEAT_QUOTAS` in
  `lib/featureLicensing.ts` — adding a third quota is a one-line
  append). All quota helpers: undefined / non-positive = unlimited.
- **Witness statement chronological numbering — data layer.**
  `witness_statements.ws_seq` + composite numbering via
  `assignWitnessSeqForInteraction()` in `lib/witnessStatementId.ts`,
  wired into promote-to-case and PATCH-interaction-caseId paths
  under tx lock. Format helper `formatWitnessStatementId({...})`
  returns `CASE-26-27-0042-WS-03`. UI surfacing still open (below).
- **AST (Alternate Schedule Time) MVP + year-end lapse cron.**
  `staff_ast_requests` + `staff_ast_ledger` (quarter-hours as INT,
  no float drift), full earn/use state machine, `canApproveAst`
  flag (admin OR confidential secretary), Admin Hub "AST: N" tile,
  bell-only notifications. Lapse cron: `cron/astLapse.ts`,
  `5 0 1 7 *` ET, tx + advisory-lock idempotent.

### Open work

- **Global plan CRUD — cross-district scoping.** Plan rows are
  global, but `POST/PATCH/DELETE /api/feature-licensing/plans`
  are currently `requireSuperUser`-only with no district gate.
  A district-scoped SuperUser editing a shared plan row mutates
  global metadata used by other districts (though the reapply
  fan-out is now scoped to the caller's district). Fix: either
  gate global plan CRUD behind `ALLOW_CROSS_DISTRICT_SUPERUSER=1`
  outright, OR introduce a real `isCrossDistrictSuperUser` staff
  flag (the same flag the tenancy/audit routes will need when
  the platform-tier role lands) and require it on these endpoints.
  Per-school plan assignment + overrides are already scoped
  correctly via `assertSchoolInCallerDistrict`.

- **AI Consistency Check — onboarding step + admin telemetry tile.**
  (1) Register a "Review Consistency Check guardrails" step in
  `lib/onboardingSteps.ts` (Behavior & PBIS phase) with an
  "I understand" school-setting marker — informational only,
  Core Team is the sole audience. (2) Add Settings tile
  "Consistency Check — this month" backed by
  `GET /api/watchlist/consistency-telemetry` (admin-gated;
  cheap COUNT/SUM grouped by current month over runs + findings).

- **School-local timezone — per-school IANA column.** Canonical
  `America/New_York` (`DEFAULT_SCHOOL_TZ` in `lib/schoolYear.ts`)
  is used by `schoolYearLabelFor`, seed case backfill, AST
  insights, and the lapse cron. Before onboarding the first
  non-Eastern school, swap the constant for a per-school IANA
  column and thread it through all four callers.

- **Refresh Core Team "How this works" copy after Phase 4 case
  enhancements ship.** Tagging, video evidence panel, AI consistency
  check, and Case Insights dashboard each need a blurb in the Core
  Team-facing help/directions panels. Do as a single pass after
  Phase 4 — piecemeal edits drift.

- **Pickup module — small follow-ups.** (1) 5-digit expansion path:
  4-digit range (1001–9999, 8999 slots/school) is plenty until a
  tenant exceeds ~7200 active tags (80% warn). When that fires, bump
  `NUMBER_RANGE_MAX` in `routes/pickup.ts` to 99999, narrow the PDF
  tag font, accept 4-or-5-digit input on the curb keypad. Schema
  already TEXT — no migration. (2) Open design question: in-app
  chime when a car is "added to line." Leaning visual-only since
  high-volume schools (30 cars/min) would have overlapping chimes.

- **Student Photos — prerequisite for walker verification + useful
  app-wide.** Today walker page renders placeholders. Storage:
  re-use `/api/storage/*` via `bindObjectToSchool`, new
  `students.photo_object_key TEXT NULLABLE` column, school-scoped
  staff-only ACL (no parent-portal exposure). Two ingestion paths:
  (a) bulk yearbook ZIP named by `student_id` (or CSV mapping) via
  the data-importer pattern; (b) per-student "Take photo" using
  `getUserMedia`, cropped to square. Surface in student profile,
  PBIS Hub cards, teacher roster avatars, Spotlight reveal, pickup
  curb confirmation, walker gate, safety-plan picker. Fallback:
  existing initials bubble when null. Privacy: `students.photo_consent
  BOOL DEFAULT true` — when false, render initials regardless;
  don't delete the file (schools flip the toggle back).

- **Witness statement numbering — UI surfacing.** Data layer
  shipped. Still TODO: surface the formatted ID in PlayerDrawer
  header, Case Detail statements list, witness statement PDF/print,
  and the audit log payload (copy-on-click). Backfill existing
  attached statements once at deploy time using `created_at ASC`
  per case.

- **AST follow-ups.** (1) Voluntary mid-year transfer zero-out
  hook: ledger is keyed to `staff_id`, not `(school_id, staff_id)`,
  so the bank silently follows on transfer. Enforce a
  `transfer_out` ledger entry in the staff-transfer admin path and
  add a current-school filter in `/api/ast/me`. (2) Optional weekly
  Friday digest email (per-school `ast_email_digest_enabled`,
  default OFF; uses existing Resend integration). (3) Per-staff
  ledger drilldown: `GET /api/ast/staff/:id/ledger` (admin-gated)
  + modal from Staff & Roles for balance disputes / bargaining-unit
  reports.

- **Feature licensing Phase 4 candidates.** (1) Wire a third quota
  consumer to keep `KNOWN_SEAT_QUOTAS` honest (good candidate:
  `mtss.maxActivePlans` or `displays.maxConcurrentSchedules`).
  (2) Per-feature usage charts in the SuperUser admin page (sparkline
  over 30 days, fed by the existing audit log).

## Gotchas

- **Timezone handling**: Be careful with date comparisons and `new Date()` as it can lead to UTC pitfalls. Use local `YYYY-MM-DD` strings for comparisons.
- **Multi-tenancy on unique indexes**: `student_id` and `displayName` are not globally unique. Ensure every query touching tenant-scoped tables includes `eq(table.schoolId, schoolId)`. Unique indexes are typically composite `(school_id, column)`.
- **API route shadowing**: When adding new API routes, especially with dynamic segments, ensure more specific routes are defined before broader ones to prevent shadowing.
- **Cron jobs and environment variables**: Cron jobs are often conditional on `NODE_ENV` and other environment flags. Verify `EMAIL_REMINDERS_ENABLED` and `RESEND_FROM_ADDRESS` for email functionality.
- **Drizzle-kit `db push`**: It can be blocked by interactive prompts on rename detection. For additive schema changes, direct `ALTER TABLE` SQL is often used as a workaround. Ensure `lib/db/src/schema/*.ts` files are updated to reflect the true schema.

## Pointers

- [pnpm-workspace skill](https://replit.com/path/to/pnpm-workspace-skill-docs): For workspace structure, TypeScript setup, and package details.
- [Drizzle ORM documentation](https://orm.drizzle.team/docs/overview): For database schema and query building.
- [Zod documentation](https://zod.dev/): For data validation.
- [Orval documentation](https://orval.dev/): For OpenAPI-based API code generation.
- [Recharts documentation](https://recharts.org/en-US/guide/GettingStarted): For charting components used in dashboards.
- [pdfkit documentation](http://pdfkit.org/docs/getting_started.html): For server-side PDF generation.

## Spotlight governor (v2)

Quartile-tiered point pool that activates only when the house
standings gap exceeds `RUNAWAY_LEADER_THRESHOLD` (1500). Pools by
rank when active: top `{1,2,3}` / upper-mid `{2,4,6}` / lower-mid
`{4,6,8}` / bottom `{6,8,10}`; healthy race draws `{1..10}`.

Key invariant: **the value the teacher sees IS the value the DB
stores** — `/spotlight/pick` bakes the pool-correct value into the
reveal; `/spotlight/award` re-validates and returns 409 ("re-spin")
if standings shifted. Strict integer 1..10 validation; no coercion.

Helpers + per-house rotation in `routes/spotlight.ts`
(`isRebalancerActive`, `poolForHouse`, `pickFromPool`,
`computeHouseTotalsForCap`).
