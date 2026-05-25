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
- **Intensive Group Insights**: Read-only Class Composer (Insights → Class Composer, admin/Core Team) that proposes intensive-group sections from FAST item-level weakness — pick subject + grade + section/seat count + eligibility cap, get deterministic groups with a dominant skill focus, cohesion %, print + CSV. Plus a Group Insights tab on Teacher Roster for intensive-flagged sections (course-name heuristic: Intensive/Lab/Tier 2-3/Read 180/Math 180/Saxon) showing section profile, recommended focus standards, suggested small-group sub-groupings, and PM-window drift (who outgrew the focus skills, who would now fit). Skyward / RosterOne stays the source of truth — nothing writes to `section_roster` or `class_sections`. Post-PM nudge: Admin Hub shows a dismissible "PM3 data complete — view suggested groupings (read-only)" banner once ELA + Math PM3 are loaded, and the onboarding checklist has a matching "Run Class Composer after PM3 upload (suggestions only)" step. Dismissal is per `<schoolYear>|pm3` token (`school_settings.class_composer_banner_dismissed_sy`) so the banner re-appears automatically each new PM cycle without disturbing schools that don't reshuffle mid-year.
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

### Recently shipped

Archived to `docs/shipped.md` to keep this file focused on active
work. Most recent entries:

- Class Composer Skill-cluster mode + PM-refresh workflow — 4th composer mode; per-group focus standards (3–7, default 5); locked rosters never re-shuffle; PM1 check-fit / PM2+PM3 refresh-focus endpoints; Admin Hub PM-keyed banners; focus_standard_N columns on both server + client CSVs.
- Multi-year FAST history chip (Teacher Roster + Student Profile + MTSS Tier-2 suggestions) — surfaces FL Florida historical-importer rows.
- Bulk feature picker + admin "reset to temp password".
- Two-tier feature flag AND fix (loadEffectiveFeatures).
- Per-school plan editor + plan picker on onboarding.
- Edit + soft-delete districts / schools.
- Onboard-a-School (existing district).
- SuperUser Audit & Health panel.
- SuperUser + District Overview landing rollups + Onboard-a-District wizard.
- (older: FAST coverage, AI Consistency Check, ISS log edit/delete,
  Parent Pick-Up Module, Feature licensing Phases 1–3, witness statement
  numbering data layer, AST MVP + lapse cron.)

When you ship something new, add a bullet to the top of
`docs/shipped.md` (most recent first) and, if helpful, a one-line
pointer here.

### Open work

- **LG subject-band promotions (Algebra I etc.).** Phase 1 +
  Phase 2 of the LG green-check are SHIPPED. Phase 2 extended
  the `learningGain` branch in `buildSubjectBlock`
  (`routes/teacherRoster.ts`) to credit within-level moves in
  L1/L2 by sub-tier, e.g. 1.1 → 1.2, 1.2 → 1.3, or 2.1 → 2.2.
  Same/lower sub-tier = no check. Sub-tier comes from
  `placeOnChart` in `lib/fastCutScores.ts`: L1 is split into
  thirds (1.1/1.2/1.3), L2 currently only into halves (2.1/2.2).
  If FLDOE confirms a Level-2 Upper third, extend the L2 ranges
  in `fastCutScores.ts` and the LG branch picks it up for free.
  Still open: subject-band promotions (Algebra I etc.) remain
  uncredited — out of scope until the FL importer captures
  prior course code.

- **Historical FAST data + Algebra I placement review.**
  Phase 1 (~1.5 wk): extend the existing FAST importer with a
  "prior school year" toggle (PM3-only, score + level + grade,
  no strand). Add `fast_results.is_historical` + new
  `algebra_placement_overrides` table. Per-school
  `fast_history_years_visible` setting (default 3, min 2,
  max 5 — 5 cap because FAST only launched in FL 22-23; older
  data would be FSA on a different scale). Imports older than
  the visible window stay dormant, never deleted. (Multi-year
  FAST history chip on student profile + teacher roster + MTSS
  plan editor — SHIPPED, see `lib/fastHistory.ts`.) Add
  "Algebra I Placement Review"
  admin report (admin + Core Team + Counselor view; admin +
  Counselor override) listing every current L3+ 7th-grader with
  their multi-year PM3 trajectory + a "Move to Regular 8th
  Math" override modal requiring justification + parent-opt-out
  checkbox + optional opt-out PDF upload (reuses object
  storage). All overrides audit-logged. Report exports as CSV +
  printable PDF (reuses Class Composer PDF infra). Class
  Composer gets a `trajectoryFilter` param so cusp recipes can
  optionally fold in first-time L3s.
  Phase 2 (later, after schools have 2–3 yrs of data
  accumulating naturally): longitudinal teacher / school
  dashboards — year-over-year cohort growth per teacher, cohort-
  following views, multi-year subgroup equity trends. Surface as
  a "Multi-year" toggle on existing Insights pages, not new
  pages. Teacher-level rollups admin-only by default, framed as
  "growth context" not evaluation, never exposed to parent
  portal or teacher-facing views without explicit admin enable.
  Gracefully tag rollups attributed to deleted/transferred staff
  as "former staff member" rather than dropping the data.
  Pays off in: Algebra placement defensibility, MTSS tier exit
  decisions, 3rd-grade retention good-cause portfolios, gifted
  referral flags, summer-school seat targeting, ELL post-exit
  monitoring, IEP annual review prep.

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
