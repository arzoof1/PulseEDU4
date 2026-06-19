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

Concise feature list. Full implementation detail (most-recent first) lives in `docs/shipped.md`.

- **Display Management**: Per-school digital-signage playlists (image/video/audio/PDF) with scheduling, PBIS house standings, active hall passes, and Heartbeat signage. Includes **Live Remote Control** — drive every TV on a playlist PowerPoint-style (auto / manual / presentation modes) without re-entering URLs.
- **Hall Pass / Kiosk**: Door kiosk (`/kiosk`) for student self-serve passes with destinations, a period-aware waiting queue (cap 5, resets on the default bell schedule), keep-apart + daily-limit blocking, a teacher Companion Queue panel, and printable activation cards + student badges. Demo guide: `docs/hall-pass-demo-runbook.md`.
- **Safety Plans**: Per-student behavioral/physical safety checklists with library items, audit logs, and role-based access (Guidance Counselor/Core Team edit, all staff view).
- **PBIS Hub & Store**: PBIS point tracking, student recognition, and two reward catalogs (Classroom Store + School Store). School Store is school-wide, read-only for teachers, full edit for admins/PBIS coordinators. **Invisible Student alert is TIER-AWARE**: a student is "invisible" (0 non-voided recognitions) within the window for their highest active MTSS tier — Tier 1 (no active plan)/2/3 default to 8/5/3 school days, all school-configurable (`schoolSettings.pbisInvisibleDaysTier1/2/3`; legacy flat `pbisInvisibleStudentDays` retained but unused). **Invariant: the two surfaces that flag invisibility — `/pbis/needs-attention` and the Teacher Roster — must use identical logic so they always agree on who is invisible.**
- **MTSS Intervention Plans**: Behavior + Academic Tier 2/3 plan tracking — goal setting, weekly progress monitoring, strategy categories, completion reports, tier-aware launcher, bell notifications. Academic plans are keyed by `fastSubject` (ela|math): Tier 2 academic is LIGHT (intensive class is the monitoring — no bell/check-ins); Tier 3 academic is closely monitored on configurable `meetingDays` (bell + per-meeting-day check-ins, week incomplete until each scheduled day logged). "Generate suggestions" runs a **Tier 3 Academic** dual-gate engine: a student surfaces only when FAST **PM1 = Level 1** AND iReady **AP1** is below a per-grade per-subject cut (coordinator fills a cut-score grid; `schoolSettings.ireadyAp1Cuts`). One row per student+subject (expandable weak standards) for one-click Tier 3 academic plan creation. (The earlier light-Tier-2 list was removed from this panel.)
- **Parent Portal**: Secure portal for a student's HeartBEAT data (PBIS, hall passes, tardies, accommodations, staff notes) with admin invites, sibling switching, configurable section visibility, and PDF export.
- **Insights Dashboards**: Engagement, Behavior, Academics, SEB/SEL, Equity, Early Warning — aggregates, trends, top-N, grade/window filters, demographic disaggregation, and drill-down to student profiles.
- **Teacher Roster**: Per-teacher student view with FAST scores, ESE/504/ELL flags, safety-plan indicators, and the FAST learning-gain green-check. Core Team can view any teacher's roster.
- **Data Importer**: Generic CSV importer for assessments/rosters/behavior with template mapping, preview, commit, and rollback.
- **Intensive Group Insights**: Read-only Class Composer (proposes intensive-group sections from FAST item-level weakness) plus a Group Insights tab on Teacher Roster. Never writes to `section_roster`/`class_sections` — Skyward/RosterOne stays the source of truth.
- **School Tours (Enrollment Leads)**: Public bilingual (EN/ES) per-school brag page (`/tour/:schoolId`) with a tour-request lead pipeline (owners, timeline, overdue clock, conversion report), brag-sheet/post-tour PDFs, flyer/photo uploads, district branding, and admin-configured tour checkpoints. **Live Tour Capture (Phase 4)**: a QR on the roadmap (printed PDF + on-screen lead view) opens a token-gated, guide-facing, offline-first live-walk screen (`/tour/walk/:token`) — guide confirms/changes who is guiding (default = lead owner), taps once per checkpoint (client-timestamped, localStorage-buffered, synced when online), and jots optional staff-only per-stop notes. Captured timings feed the lead drawer (per-stop planned-vs-actual in chronological completion order, total length, follow-up notes) and outcomes metrics (avg tour length + per-guide rollup). **Invariant: walk step taps validate against the lead's eligible stops (family selections + always-included), not the whole school checkpoint catalog.**
- **Parent Pick-Up Module**: Curb keypad (`/pickup/curb`), walker gate (`/pickup/walkers`), admin tag authorization + QR tag PDFs, classroom signage tile, and an Admin Hub "still on campus" reconciliation tile. Role gate `canManagePickup`.
- **Event Ticketing (Phase 1)**: Free-ticket events with per-grade quotas, QR tickets emailed per student (inline + PDF + Parent Portal delivery), in-app and no-login volunteer scanning (atomic first-scan-wins), capacity caps, and a scan-history audit. Role gate `canManageTickets`.
- **School Grade Estimated Calculator (Phase 1)**: Admin/Core-Team estimate of the Florida MS school grade per PM window (9 components ×100). FAST components auto-computed; LG is a projection at PM1/PM2 and strict PM3-to-PM3 at PM3. Role gate `canManageSchoolGrade`. **Invariant: LG prior-year evidence comes from `loadFastHistory` historical PM3 (same source as the Teacher Roster green-check), never `priorYearScore` — the two surfaces must agree.**

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

Archived to `docs/shipped.md` (most-recent first; reference only, no
remaining action). When you ship something new, add a bullet to the top
of `docs/shipped.md`.

### Open work

Full detail for each item lives in `docs/future-work.md`. Summaries:

- **Family Messages — multi-contact email (Phase 2).** True multi-contact email; preserve "deliver to many, attribute to one." Blocked on SIS adapter not feeding guardian emails.
- **E-sign signing campaigns (bulk send → per-student return).** Wrap per-doc signing in a campaign with one copy per `student_id`; field-trip-list dashboard.
- **LG subject-band promotions (Algebra I etc.).** Within-level LG credit SHIPPED; subject-band promotions still uncredited until the importer captures prior course code.
- **Historical FAST data + Algebra I placement review.** Prior-year FAST import toggle + placement-review report/override; later longitudinal multi-year dashboards.
- **AI Consistency Check — onboarding step + admin telemetry tile.** Guardrails onboarding step + admin "this month" telemetry tile.
- **School-local timezone — per-school IANA column.** Replace `DEFAULT_SCHOOL_TZ` constant with a per-school column before onboarding a non-Eastern school.
- **Refresh Core Team "How this works" copy after Phase 4 case enhancements ship.** One help-copy pass after Phase 4.
- **Pickup module — small follow-ups.** 5-digit number expansion path; optional in-line chime.
- **Student Photos.** Object-storage-backed student photos (bulk ZIP + per-student capture) with consent flag; prerequisite for walker verification.
- **Witness statement numbering — UI surfacing.** Surface the formatted ID across drawers/PDF/audit log; backfill existing.
- **AST follow-ups.** Transfer zero-out hook, optional Friday digest email, per-staff ledger drilldown.
- **Feature licensing Phase 4 candidates.** Wire a third quota consumer; per-feature usage charts.

## Gotchas

- **Timezone handling**: Be careful with date comparisons and `new Date()` as it can lead to UTC pitfalls. Use local `YYYY-MM-DD` strings for comparisons.
- **Multi-tenancy on unique indexes**: `student_id` and `displayName` are not globally unique. Ensure every query touching tenant-scoped tables includes `eq(table.schoolId, schoolId)`. Unique indexes are typically composite `(school_id, column)`.
- **API route shadowing**: When adding new API routes, especially with dynamic segments, ensure more specific routes are defined before broader ones to prevent shadowing.
- **Cron jobs and environment variables**: Cron jobs are often conditional on `NODE_ENV` and other environment flags. Verify `EMAIL_REMINDERS_ENABLED` and `RESEND_FROM_ADDRESS` for email functionality.
- **Drizzle-kit `db push`**: It can be blocked by interactive prompts on rename detection. For additive schema changes, direct `ALTER TABLE` SQL is often used as a workaround. Ensure `lib/db/src/schema/*.ts` files are updated to reflect the true schema.
- **NO FLEID forward-facing — EVER (use `local_sis_id`).** The canonical `students.student_id` (the FLEID, e.g. `FL000000539119`) is an INTERNAL identifier — a foreign key only. It must NEVER be rendered as visible text to any user (staff, parent, student) anywhere: table cells, labels, badges, tooltips, headings, search results, @mention tokens, graph nodes, kiosk/signage, AND CSV/PDF exports. The ONLY display ID is `students.local_sis_id` (the local SIS ID). When a surface needs a student ID label, the server response must carry `localSisId` and the UI renders `localSisId ?? "—"` — never fall back to `studentId`. Keep using `student_id` for FKs, API path params, React keys, and lookups (it is the join key; remember it is NOT globally unique — always pair with `school_id`). When adding ANY student-facing surface or export, audit it for raw `studentId` rendering before shipping. See `lib/fleid` boundary precedent in `routes/kiosk.ts` (kiosk/badges) and `routes/safetyPlans.ts` (`/safety-plans/list` returns `localSisId`).
- **Public-facing URLs / QR codes (`publicAppOrigin`)**: Links families open OUTSIDE the workspace (post-tour survey QR, brag-page link, lead-notify email) must NOT be built from `$REPLIT_DEV_DOMAIN` — it is the *development* host and is often unset in production, so QR codes ended up pointing at the dev URL or `http://localhost:5000` (a dead page). Resolve origin as: `PUBLIC_APP_URL` → first `$REPLIT_DOMAINS` host (published prod domain in prod, dev/preview host in dev) → inbound request forwarded host → localhost. See `publicAppOrigin(req)` in `routes/tours.ts` and `kioskBaseUrl` in `routes/kiosk.ts`.
- **PDFs / blobs in the preview iframe**: The session cookie is blocked inside the Replit preview iframe (the app falls back to a Bearer token in sessionStorage, `pulseed.authToken`). A blob URL opened in a new tab renders blank, and `window.open(...).print()` can deadlock and freeze the app. For authed PDFs, trigger a blob **download** (`a.download`) from the current document instead of opening/printing in a tab — this is why the Tours lead-drawer PDFs download to disk.

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
