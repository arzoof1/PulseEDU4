# Future work (open backlog)

Detailed, deferred work items. Summaries live in `replit.md` → "Future work".
When something ships, remove it here and add a bullet to the top of
`docs/shipped.md`.

---

- **Family Messages — multi-contact email (Phase 2).** Phase 1
  SHIPPED: Core Team broadcast → Parent Portal inbox + Resend email
  nudge; audience whole-school/grade/house/CSV(local_sis_id);
  Sent→Reached→Got it counters; derived **Power Reader** badge
  (non-points). Core design decision to preserve: **deliver to many,
  attribute to one** — delivery may fan out to every authorized
  contact, but acknowledgment/Power Reader rolls up to ONE primary
  per family (today = the portal account, since `parents` is already
  an email-keyed adult identity grouped across siblings via
  `parent_students`). Phase 2 = true multi-contact email, deferred
  because **ClassLink/the SIS adapter does not feed guardian emails
  today** (the `RosterAdapter` only pulls staff/students/rooms;
  `student_emergency_contacts` holds phone only, no email). To build:
  (a) extend the SIS adapter to pull guardian contacts WITH email +
  a primary/authorized flag; (b) add `email` + `is_primary` /
  `portal_authorized` columns to `student_emergency_contacts` (or a
  new `student_contacts`); (c) fan delivery out to all authorized
  contact emails; (d) keep attribution rolling up to the one primary
  so the badge stays a single family-level signal. Interim option if
  needed sooner: let staff add extra contact emails manually / via
  the Data Importer and mark one primary (no ClassLink dependency,
  but manual upkeep).

- **E-sign signing campaigns (bulk send → per-student return).**
  Idea only (no build yet). Today e-sign is 1 doc = 1 link = 1
  signer with NO student tie by design. For field-trip-style
  workflows, wrap the existing per-document signing flow in a
  "campaign": upload the slip once (template), fan out one signing
  COPY per student (each copy carries `student_id`, grouped under a
  campaign id), and aggregate returns onto one "field trip list"
  dashboard (Not sent → Sent → Signed, reminders, bulk signed-PDF
  download). Recipient selection two ways: (A) pick a teacher
  class/period — expand `section_roster`/`class_sections`
  (read-only; Skyward is source of truth) — lead with this, zero
  effort; (B) CSV via the Data Importer pattern for cross-class
  lists. Delivery: Resend email (parent addresses from
  `parents`/`parent_email`) + printable per-student QR fallback
  (reuse kiosk/badge QR) because recipient email is often blank.
  Key decisions/caveats: the per-copy `student_id` link is the one
  real schema change (intentionally absent today); siblings/shared
  parents need distinct links per child; list + CSV/PDF exports
  show `local_sis_id` ONLY (never FLEID); base62 token +
  `publicAppOrigin` URL resolution carry over from the existing
  sign flow. Cleanest first slice: Option A + email + status
  dashboard; CSV + QR as fast follow.

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
