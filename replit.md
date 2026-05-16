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

- **🚩 PRE-DEPLOYMENT BLOCKER — FAST scale-score coverage gaps.**
  Partially shipped. Remaining blocker is cut-score data only.
  - **SHIPPED — 3rd-grade bucket fallback (Option B).** 3rd graders
    now place PM3 on the G3 chart and compute the bucket from there.
    `bucketTarget` no longer suppresses grade 3.
  - **SHIPPED — EOC scaffolding.** `Subject` union extended to
    `"ela" | "math" | "algebra1" | "geometry"`. `chartFor()` routes
    EOC subjects to their own charts (grade-agnostic). `ALGEBRA1_EOC`
    + `GEOMETRY_EOC` exist as `FastChart | null` placeholders —
    today they short-circuit to "n/a" the same way as before, but
    populating the constants is now the only change needed.
  - **SHIPPED — FAST Coverage telemetry tile** (Settings →
    "📊 FAST Coverage", admin-gated). Backed by
    `GET /api/insights/fast-coverage` in `routes/fastCoverage.ts`.
    Per-(subject, grade) status: Complete / Partial PM3 / Missing
    PM3 / No chart. Warns admins about Algebra1/Geometry rostered
    students whose buckets won't render until cut scores land.
  - **OPEN — Wire the FL DOE FAST Table 8 continuation values into
    `ALGEBRA1_EOC` and `GEOMETRY_EOC`.** User to supply cut-score
    doc/URL. Once the constants are populated, the importer +
    insights + teacher-roster paths still need their `ela | math`
    string literals widened to the new `Subject` union (~11 file
    blast radius — held until values arrive so it's testable in a
    single pass).


- **AI Consistency Check — onboarding step + admin telemetry tile.**
  Phase 3 shipped the runtime feature (header pill, side panel,
  per-row dot, dismiss-with-justification, "What the AI saw"
  drawer). Two follow-ups remain from the original session plan:
  - Add a "Review Consistency Check guardrails" step in the
    Behavior & PBIS onboarding phase. This is server-side step
    registration in `artifacts/api-server/src/lib/onboardingSteps.ts`
    plus an "I understand" school setting marker. Informational
    only — closes by acknowledging that Core Team is the only
    audience and that dismissals are persistent suppressions.
  - Add a Settings tile "Consistency Check — this month" with
    a small ConsistencyTelemetryPage showing runs, open findings,
    dismissed findings, and total tokens spent. Backed by a new
    `GET /api/watchlist/consistency-telemetry` aggregate route
    (admin-gated). Cheap COUNT/SUM over the runs + findings tables
    grouped by current month.

- **School-local timezone — per-school IANA column.** Canonical
  `America/New_York` (`DEFAULT_SCHOOL_TZ` in `lib/schoolYear.ts`) is
  used by `schoolYearLabelFor`, seed case backfill, AST insights, and
  the lapse cron. Before onboarding the first non-Eastern school, swap
  the constant for a per-school IANA column and thread it through all
  four callers.

- **Refresh Core Team "How this works" / directions copy after the 4-phase
  case enhancement suite ships.** Mention tagging, video evidence panel,
  AI consistency check, and Case Insights dashboard each need a blurb in
  the Core Team-facing help/directions panels. Do as a single pass after
  Phase 4 — piecemeal invites drift.

- **Admin Hub ISS log: view detail + edit/delete with audit guardrails**
  Click into a row in the Admin Hub recent feed to see the full assignment.
  - **Delete entire assignment**: only allowed if **no day has been served yet** (no `iss_attendance_day` rows for that `admin_log_id` show any served signal — present periods, marked-served, or rolled-from). Audit retention for partially-served assignments is intentional.
  - **Trim the tail**: even on a partially-served assignment, the user should be able to remove **future** day rows (and **today's** row only while it has not yet been served — i.e. `present_periods` is empty AND `marked_served = false`). Already-served past days are immutable.
  - **Edit reason / notes / dates**: future days can be re-dated; past served days cannot. Reason and notes are editable on any non-cancelled assignment, with the change recorded in an audit trail.
  - **Required "reason for edit"**: every edit/trim/delete prompts the user for a short justification ("why are you changing this?") that is stored on the audit row. This is the column auditors will read first to understand whether a change was a typo correction, a legitimate behavior update, or something that needs follow-up. Should be required (non-empty, min ~5 chars), not optional.
  - Needs a server-side audit log table for who/when/what/why changed before shipping (columns at minimum: `admin_log_id`, `actor_staff_id`, `actor_display_name`, `action` enum [`edit_reason` | `edit_notes` | `edit_dates` | `trim_days` | `delete_assignment`], `before_json`, `after_json`, `edit_reason TEXT NOT NULL`, `created_at`).

- **Parent Pick-Up Module — remaining work.** Tag-management
  (bulk-assign, reissue, single + batch PDF with QR, capacity warn)
  shipped; QR scan on the curb page and photo verification on the
  walker gate are the open items.
  - **QR scan branch on `/pickup/lookup`.** Tags already print with
    a plain-number QR (Phase 1). Phase 2 swaps the encoding to a
    signed `{schoolId, authId, hmac}` payload (school-salt) and
    wires `@zxing/browser` into the curb page's currently-disabled
    "Scan QR" affordance. New signed-token verifier branch on the
    lookup endpoint accepts either a typed number OR a scanned
    token.
  - **Photo verification on the walker gate.** Depends on the
    Student Photos work below — today the walker page shows initials
    bubbles. Once `students.photo_object_key` lands, swap the bubble
    for the real photo on the walker row + curb confirmation card.
  - **5-digit expansion path.** 4-digit range (1001–9999 = 8999
    slots/school) is plenty until a tenant exceeds ~7200 active
    tags (80% warn). When that fires for the first real tenant,
    bump `NUMBER_RANGE_MAX` in `routes/pickup.ts` to 99999, widen
    the PDF tag font down a notch, and have the curb keypad accept
    4 OR 5 digit input. Schema is already TEXT so no migration.
  - **Open design question (deferred).** Whether "added to line"
    should ping the classroom with an in-app chime or stay
    visual-only. Lean visual-only — schools with 30 cars/min in the
    queue would have chimes overlapping nonstop.

- **Feature licensing — Phase 2 SHIPPED. Phase 3+ open.** Phase 1
  shipped: Plans table, per-school Overrides with expiration + audit,
  SuperUser admin UI, AST + Parent Portal gated end-to-end, and
  page-level `<FeatureGate>` wraps for MTSS Plans, ISS Dashboard,
  Displays, and House Rankings. Phase 2 shipped:
  - Nav-item HIDE for off+no-upsell features (MTSS Plans, ISS
    Dashboard, Displays — wraps `renderGatedNavItem` in App.tsx).
  - Daily expired-override sweep cron + append-only
    `feature_licensing_audit_log` table with a partial unique index
    on `override_id WHERE action='override_expired_sweep'` for
    idempotency (`cron/featureLicensingOverrideSweep.ts`, scheduled
    at 02:15 UTC; override via `FEATURE_LICENSING_SWEEP_CRON`).
  - First quota consumer wired:
    `parentPortal.maxParentAccounts` enforced in
    `routes/parentInvites.ts` on both single (`/send-one`) and bulk
    (`/send`) paths via `checkParentAccountQuota` +
    `enforceParentAccountQuota` in `lib/featureLicensing.ts`.
    Quota count = accepted parents + live pending invites. Single
    returns 403 `quota_exceeded`; bulk emits per-row
    `skipped/quota_exceeded` so partial batches still succeed
    cleanly. Undefined / non-positive quotas treated as unlimited.

  Phase 3 candidates (not blocking deploy):
  - Wire `maxDisplayPlaylists` (second quota consumer) to validate
    the registry pattern with a non-parent feature.
  - SuperUser-facing audit-log viewer in
    `SchoolLicensingPage.tsx` — today the audit table is
    write-only from the cron's perspective; admins have no UI to
    see "what was swept when, and on which override".
  - Telemetry tile on the SuperUser dashboard:
    schools-near-quota count (e.g. ≥80% on any seat-style quota)
    so the sales/CS team has lead time to upsell before tenants
    hit the wall.

- **Student Photos — prerequisite for walker verification, also useful
  app-wide.** New work item, separate from the pickup module but
  required before the walker gate's photo-verification UX is real
  (today the walker page would render placeholders).
  - **Storage**: re-use existing object storage routes
    (`/api/storage/*`), bound to school via `bindObjectToSchool`.
    New `students.photo_object_key TEXT NULLABLE` column. ACL:
    school-scoped, staff-only read, no parent-portal exposure (a
    parent should not see other students' photos).
  - **Two ingestion paths**:
    1. **Bulk yearbook upload** — admin page that accepts a ZIP of
       photos named by `student_id` (most yearbook companies export
       this format), or a CSV mapping filename → student_id for
       legacy exports. Preview + commit + rollback, mirroring the
       existing data importer pattern.
    2. **Staff snapshot** — per-student "Take photo" button on the
       student profile page that opens the device camera (use
       `getUserMedia`, no library), crops to a square, uploads.
       Useful for new mid-year transfers before the next yearbook
       cycle.
  - **Surface in**: student profile page (primary), PBIS Hub student
    cards, teacher roster row avatars, Spotlight reveal card,
    pickup curb confirmation card, walker gate row, safety plan
    student picker.
  - **Fallback**: when `photo_object_key` is null, render the
    existing initials-bubble component already used elsewhere — no
    broken-image icons.
  - **Privacy/consent**: add a `students.photo_consent BOOL DEFAULT
    true` column with an admin-side toggle. When false, all
    rendering paths show initials regardless of whether a photo is
    on file. Photo data stays on disk (don't delete on consent
    revocation — schools sometimes flip it back) but is gated at
    render time. Document this in the school-settings privacy page.

- **Witness statement chronological numbering — UI surfacing.**
  Data layer shipped: `witness_statements.ws_seq` column + composite
  numbering via `assignWitnessSeqForInteraction()` in
  `lib/witnessStatementId.ts`, wired into both promote-to-case and
  PATCH-interaction-caseId paths under tx lock. Format helper
  `formatWitnessStatementId({yearLabel, caseNumber, wsSeq})` returns
  `CASE-26-27-0042-WS-03`. Still TODO: surface the formatted ID in
  the PlayerDrawer header, Case Detail statements list, witness
  statement PDF/print, and the audit log payload (make it
  copy-on-click). Also backfill existing already-attached statements
  once at deploy time using `created_at ASC` order within each case.

- **AST (Alternate Schedule Time) — follow-ups after MVP ship.**
  Phase 1 shipped: `staff_ast_requests` + `staff_ast_ledger` schema
  with quarter-hours stored as INT (no float drift), full earn/use
  state machine in `routes/ast.ts` with tx-locked balance checks,
  `canApproveAst` per-staff flag (any admin OR confidential
  secretary), `StaffAstPage` + `AdminAstQueuePage`, top-level "AST"
  nav for staff + "AST Approvals" admin nav, Admin Hub "AST: N"
  tile deep-linking to the queue. Bell-only notifications via
  `/api/ast/admin-pending-count` polling — no email dispatch.
  Year-end lapse cron shipped (`cron/astLapse.ts`, `5 0 1 7 *` ET,
  tx + advisory-lock idempotent; env overrides `AST_LAPSE_CRON` /
  `AST_LAPSE_TZ`). What remains:
  - **Voluntary mid-year transfer zero-out hook.** When a staff
    record is moved to a different school (or marked inactive),
    the AST bank should be zeroed at the source school with a
    `transfer_out` ledger entry. Currently the bank silently
    "follows" the row because the ledger is keyed to `staff_id`,
    not `(school_id, staff_id)`. Fix by enforcing zero-out in the
    staff-transfer admin path and adding a guard in
    `/api/ast/me` that filters by current school.
  - **Optional weekly email digest for admins.** Bell-only is the
    primary notification channel, but a weekly Friday-morning
    "5 pending AST approvals" email is cheap insurance for admins
    who don't open the Admin Hub daily. Gate behind a per-school
    `ast_email_digest_enabled` setting (default OFF). Re-uses the
    existing Resend integration.
  - **Per-staff ledger drilldown.** Today the staff page shows
    request history; admins have no way to audit a specific
    staffer's full ledger (credits, debits, lapses) in one view.
    Add `GET /api/ast/staff/:id/ledger` (admin-gated) and a small
    drilldown modal accessible from the Staff & Roles page.
    Useful when a teacher disputes their balance or when prepping
    end-of-year reports for the bargaining unit.

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
