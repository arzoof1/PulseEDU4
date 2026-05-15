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
- **Parent Pick-Up Module**: Curb keypad (`/pickup/curb`) with phone-first numeric entry + sibling roll-up scoped to the typed parent's authorizations, restricted-tag override-with-justification, walker gate (`/pickup/walkers`) with bell-window enforcement, admin authorization issuer, classroom signage tile (filtered to playlist owner's roster), and Admin Hub "Still on campus" reconciliation tile (post-cutoff, grouped by dismissal mode). Audit trail in `pickup_queue_events` is append-only.

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
  Before going public, the cut-score table in
  `artifacts/api-server/src/lib/fastCutScores.ts` and the seed/import
  data must cover every grade a real tenant will roster.
  - **Add Algebra 1 EOC and Geometry EOC scale charts** (FL DOE FAST
    Table 8 continuation). Today these subjects render "n/a" for every
    HS Math student; without them, a 9th/10th grader taking Algebra 1
    or Geometry has no PM pills and no LG bucket. Wire the new charts
    into the `MATH` record and update `hasChart()` accordingly.
  - **Decide and implement 3rd-grade bucket behavior.** Today 3rd
    graders are deliberately suppressed (no prior-grade chart). For a
    K–5 tenant this means the entire 3rd-grade roster shows "—" in the
    LG column. Either (a) document this as intended and add a tooltip
    explaining "Bucket starts in 4th grade" or (b) fall back to placing
    PM3 on the **current** (3rd) grade chart and computing the bucket
    from there, accepting that the gap will be optimistic since no
    grade-jump is involved.
  - **Verify scale-score data coverage at onboarding.** Today only
    grades 6–10 ELA and 6–8 Math have student PM1/PM2/PM3 in the seed.
    Any tenant rostering grades 3–5 needs FAST data uploaded for those
    grades; if missing, pills + bucket silently render blank rather
    than warning the admin. Add an onboarding check (or Settings
    telemetry tile) that flags "FAST scores missing for grades X, Y,
    Z" so admins know to import before showing the roster to teachers.


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

- **School-local timezone for case-number school-year derivation.**
  Today `schoolYearLabelFor(new Date())` (server) and the seed
  migration's `EXTRACT(MONTH FROM opened_at)` both use server-local
  time. Single-TZ deployments are fine, but the moment a cross-TZ
  tenant is onboarded a case opened late on June 30 in Pacific time
  will be stamped `26-27` instead of `25-26` (and similarly the year
  portion at the Dec/Jan boundary). Fix by either (a) adding a
  per-school IANA timezone column and threading it into the helper +
  migration, or (b) explicitly forcing one canonical TZ
  (`AT TIME ZONE 'America/New_York'`) and documenting it. Schedule
  before onboarding the first non-Eastern school.

- **Refresh Core Team "How this works" / directions copy after the 4-phase
  case enhancement suite ships.** Each new feature (mention tagging,
  video evidence panel, AI consistency check, Case Insights dashboard)
  needs its blurb added to the Core Team-facing help/directions panels
  so a new admin onboarding mid-year understands what each affordance
  does and where the admin-only gating starts/stops. Do this as a single
  pass after Phase 4 — writing it piecemeal per phase invites drift.

- **Witness statement chronological numbering (raise at end of 4-phase case enhancement rollout).**
  Today witness statements are addressable only by internal DB id. Admins
  asked for a human-readable identifier they can write on a printed copy
  or quote to a parent/officer when the original is requested later.
  Recommended approach: per-case sequence rather than a global counter —
  format `CASE-{year}-{caseNumber}-WS-{seq}` (e.g. `CASE-2026-0042-WS-03`).
  - Assign `ws_seq INT` on the witness_statements row at the moment the
    owning interaction is attached to a case (promote-to-case OR PATCH
    interaction caseId). Statements on still-loose interactions stay
    un-numbered until promotion, which matches investigative reality.
  - Composite unique index `(school_id, case_id, ws_seq)`. Sequence is
    derived as `MAX(ws_seq) + 1` within the case under the same `FOR
    UPDATE` lock the promote/attach flow already takes, so two concurrent
    attaches can't collide.
  - Surface the formatted ID in: PlayerDrawer header, Case Detail
    statements list, witness statement PDF/print, and the audit log
    payload. Make it copy-on-click.
  - Backfill existing already-attached statements once at deploy time
    using `created_at ASC` order within each case.
  - A separate global statement number (`WS-2026-04412`) was considered
    and rejected: admins look up by case first, and a global counter
    duplicates the cross-reference work case# already does.

- **Admin Hub ISS log: view detail + edit/delete with audit guardrails**
  Click into a row in the Admin Hub recent feed to see the full assignment.
  - **Delete entire assignment**: only allowed if **no day has been served yet** (no `iss_attendance_day` rows for that `admin_log_id` show any served signal — present periods, marked-served, or rolled-from). Audit retention for partially-served assignments is intentional.
  - **Trim the tail**: even on a partially-served assignment, the user should be able to remove **future** day rows (and **today's** row only while it has not yet been served — i.e. `present_periods` is empty AND `marked_served = false`). Already-served past days are immutable.
  - **Edit reason / notes / dates**: future days can be re-dated; past served days cannot. Reason and notes are editable on any non-cancelled assignment, with the change recorded in an audit trail.
  - **Required "reason for edit"**: every edit/trim/delete prompts the user for a short justification ("why are you changing this?") that is stored on the audit row. This is the column auditors will read first to understand whether a change was a typo correction, a legitimate behavior update, or something that needs follow-up. Should be required (non-empty, min ~5 chars), not optional.
  - Needs a server-side audit log table for who/when/what/why changed before shipping (columns at minimum: `admin_log_id`, `actor_staff_id`, `actor_display_name`, `action` enum [`edit_reason` | `edit_notes` | `edit_dates` | `trim_days` | `delete_assignment`], `before_json`, `after_json`, `edit_reason TEXT NOT NULL`, `created_at`).

- **Parent Pick-Up Module — remaining work after MVP ship.**
  Phases A–F + H shipped (schema, curb keypad with sibling roll-up,
  walker gate, admin authorizations, classroom signage tile, Admin
  Hub reconciliation tile). What's still open:
  - **QR generation + scan (Phase G).** Install `qrcode` +
    `@zxing/browser`. Admin "Print pickup tags" page batch-renders
    one PDF tag per `student_pickup_authorizations` row using the
    existing pdfkit setup. QR encodes `{schoolId, authId, hmac}`
    signed with school-salt; new signed-token verifier branch on
    `/pickup/lookup` accepts either a typed number OR a scanned
    token. The curb page already has a disabled "Scan QR" placeholder.
  - **Photo verification on the walker gate.** Depends on the
    Student Photos work below — today the walker page shows initials
    bubbles. Once `students.photo_object_key` lands, swap the bubble
    for the real photo on the walker row + curb confirmation card.
  - **Pick-up cutoff in school settings.** Today the "Still on
    campus" tile uses a hard-coded 3:30 PM client-local cutoff.
    Move to a per-school setting + server-derived gating (folds into
    the school-local timezone item below).
  - **Teacher "Released to walk out" from the signage tile.** TVs
    aren't authenticated, so the slide is read-only today. If a
    teacher action is needed beyond the curb page, build a separate
    `/pickup/teacher` authenticated page that writes the
    `released_to_walk` event scoped via section_roster ownership
    (the gate currently requires curb access for the same reason).
  - **Open design question (deferred).** Whether "added to line"
    should ping the classroom with an in-app chime or stay
    visual-only. Lean visual-only — schools with 30 cars/min in the
    queue would have chimes overlapping nonstop.

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
## Spotlight governor (v2 — shipped)

Replaces the old binary "capped house" cap. The point pool is now
quartile-tiered by house standing and only activates when the leader
is >`RUNAWAY_LEADER_THRESHOLD` (1500) points ahead of #2:

- Healthy race (gap ≤ 1500): every house draws from `{1..10}`.
- Rebalancer active (gap > 1500): per-rank pools
  - top quartile  → `{1, 2, 3}`
  - upper-middle  → `{2, 4, 6}`
  - lower-middle  → `{4, 6, 8}`
  - bottom quart. → `{6, 8, 10}`

Quartile boundaries (`<0.25 / <0.5 / <0.75 / else`) work for any
house count — 2/3/4/5+ all map cleanly with no gaps.

Key invariant: **the value the teacher sees IS the value the DB
stores.** No silent downgrade, no `chosen=X, awarded=Y` audit note.
`/spotlight/pick` bakes the pool-correct value into the reveal;
`/spotlight/award` re-validates it and returns 409 ("re-spin") if
standings shifted in the meantime. Strict integer 1..10 validation
on `points` — no abs/floor coercion of tampered input.

Helpers live in `artifacts/api-server/src/routes/spotlight.ts`:
`isRebalancerActive`, `poolForHouse`, `pickFromPool`,
`computeHouseTotalsForCap`. Per-house rotation per session
(`servedHouseIds[]` filter) still in effect.
