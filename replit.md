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

- **FAST scale-score coverage — SHIPPED.**
  - **SHIPPED — 3rd-grade bucket fallback (Option B).** 3rd graders
    now place PM3 on the G3 chart and compute the bucket from there.
    `bucketTarget` no longer suppresses grade 3.
  - **SHIPPED — EOC scaffolding + cut-score data.** `Subject` union
    extended to `"ela" | "math" | "algebra1" | "geometry"`.
    `chartFor()` routes EOC subjects to their own charts
    (grade-agnostic). `ALGEBRA1_EOC` + `GEOMETRY_EOC` populated
    from FL DOE FAST Table 8. Subject literal widening done in
    `dataImports.ts` (FAST_SCORES_CONFIG + FAST_PRIOR_YEAR_CONFIG
    accept algebra1/geometry + aliases) and the insights export
    filter — full typecheck clean.
  - **SHIPPED — FAST Coverage telemetry tile** (Settings →
    "📊 FAST Coverage", admin-gated). Backed by
    `GET /api/insights/fast-coverage` in `routes/fastCoverage.ts`.
    Per-(subject, grade) status: Complete / Partial PM3 / Missing
    PM3 / No chart.


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

- **Admin Hub ISS log: view detail + edit/delete with audit guardrails — SHIPPED.**
  Click an ISS row in the Admin Hub recent feed to open
  `IssLogDetailDrawer` with Detail + History tabs. Backend audit
  table `iss_admin_log_audit` (created by `ensureAdminHubSchema` in
  `seed.ts`) captures every mutation with `actor_staff_id`,
  `actor_display_name`, `action` enum (`edit_reason` |
  `edit_notes` | `edit_dates` | `trim_days` |
  `delete_assignment`), `before_json`, `after_json`,
  `edit_reason TEXT NOT NULL` (min 5 chars enforced
  client + server), and `created_at`. Routes added to
  `routes/adminHub.ts`:
  - `GET /admin-hub/iss-logs/:id` (log + day rows)
  - `GET /admin-hub/iss-logs/:id/audit`
  - `PATCH /admin-hub/iss-logs/:id` (edit reason and/or notes)
  - `PATCH /admin-hub/iss-logs/:id/dates` (add and/or trim day rows
    via diff; emits `edit_dates` for adds and `trim_days` for
    removes — both can fire in one diff)
  - `DELETE /admin-hub/iss-logs/:id` (gated to zero-served days)

  All three mutation handlers run validation **inside** the tx via
  `SELECT ... FOR UPDATE` on both the parent log and its day rows
  (concurrency-safe: prevents the "served-between-check-and-delete"
  TOCTOU). `.returning()` on the day insert/delete means audit rows
  reflect the *actual* post-mutation DB state, not intent — important
  because `onConflictDoNothing` on the (school, student, day)
  unique index can lose a write to a parallel ISS Teacher walk-in.

  Served-day check helper `isDayServed()` lives in `adminHub.ts`
  and is mirrored exactly by client-side `isServed()` in
  `IssLogDetailDrawer.tsx` (present periods non-empty OR
  `marked_served` true OR `rolled_from_date` non-null) — keep these
  two in sync if the servedness signals ever change.

  OSS edit/delete intentionally NOT implemented yet — only ISS per
  the original spec. OSS rows in the recent feed remain non-clickable.

- **Parent Pick-Up Module — remaining work.** Tag-management
  (bulk-assign, reissue, single + batch PDF, capacity warn),
  walker-gate photo rendering, and **curb-page photo verification on
  the lookup matches** all shipped. QR scan is **dropped** as a
  product decision — typed numbers only, and the disabled "Scan QR"
  button stays as-is until/unless we revive it. Remaining items:
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

  Phase 3 SHIPPED:
  - **Second quota consumer wired** — `displays.maxPlaylists`
    enforced in `routes/displays.ts` POST `/displays/playlists`
    via `checkDisplayPlaylistQuota` + `enforceDisplayPlaylistQuota`
    in `lib/featureLicensing.ts`. Quota count = active=true
    playlists (inactive/kill-switched rows do NOT consume a slot).
    Returns 403 `quota_exceeded` with the same shape parent
    invites use so the client toast is uniform. Undefined /
    non-positive quotas = unlimited.
  - **Audit-log viewer** — `GET /api/feature-licensing/audit`
    (recent across all schools) + `GET /api/feature-licensing/schools/:id/audit`
    (per-school filter), both SuperUser-gated. Surfaced as a new
    "Audit log" section at the bottom of `FeatureLicensingAdminPage.tsx`
    with school/action/feature/actor/payload columns and a
    25/50/100/250 row-limit selector. Read-only.
  - **Schools-near-quota telemetry tile** —
    `GET /api/feature-licensing/quota-telemetry?threshold=0.8`
    walks every school × every entry in `KNOWN_SEAT_QUOTAS`
    (today: parentPortal/maxParentAccounts +
    displays/maxPlaylists) and returns rows where usage ≥ the
    threshold. Renders as the top section of the SuperUser
    admin page with a 50/70/80/90/100% threshold selector and
    color coding (≥90% bold amber, ≥100% red). Sorted worst-first
    so the loudest schools surface immediately. Adding a third
    seat-style quota in the future is a one-line append to
    `KNOWN_SEAT_QUOTAS`.

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
