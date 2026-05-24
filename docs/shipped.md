# PulseEDU — Recently shipped (archive)

Reference only — no remaining action on items below. Most-recent first.
For active follow-ups, see the **Open work** section in `replit.md`.

- Multi-year FAST history chip — surfaces prior-year PM3 rows written
  by the FL Florida importer's "Import as historical (prior school
  year)" toggle, without re-importing. New helper
  `artifacts/api-server/src/lib/fastHistory.ts` (`loadFastHistory`,
  `pickHistory`, `loadFastHistoryYearsVisible`,
  `priorSchoolYearLabels`): PM3-only, schoolId-scoped, strictly older
  than current SY, gated to `is_historical=true` rows only, window
  capped at 5 / default 3 via `school_settings.fast_history_years_visible`.
  Wired into three surfaces with batched single-query loads (no N+1):
  Teacher Roster API attaches `history` to each ELA/Math `SubjectBlock`
  (rendered as a subtle line under the PM3 ScorePill on
  `TeacherRosterPage.tsx`); Student Profile `/api/insights/students/:id/profile`
  attaches `history` per subject (rendered as a "History PM3:" sub-row
  under each subject row in `StudentProfile.tsx`); and the MTSS
  `/api/mtss-plans/fast-suggestions` route attaches `priorYearPm3`
  per suggestion (rendered as a small line under the student name in
  `MtssPlansAdmin.tsx`). Source of truth: `student_fast_scores` rows
  keyed `(student, subject, school_year)` with `is_historical=true`.
- Class Composer post-PM nudge — dismissible Admin Hub banner +
  matching onboarding step "Run Class Composer after PM3 upload
  (suggestions only)" under Interventions & MTSS. Auto-detects when
  ELA + Math PM3 are loaded for the current school year via new
  `GET /api/intensive-groups/pm-readiness`; per-school dismissal
  recorded as `<schoolYear>|pm3` token in new column
  `school_settings.class_composer_banner_dismissed_sy` so the banner
  re-appears each new PM cycle without nagging schools that don't
  reshuffle mid-year. Banner copy emphasizes "read-only suggestion —
  nothing is written to your roster." Admin/Core-Team gated; wired
  through `App.tsx onOpenClassComposer` → `activeSection="classComposer"`.
- Student House Placement — admin bulk-sort UI (preview + commit with
  per-house current/proposed/Δ counts, 24-hour undo) on the "House
  Rankings" page above the public signage; balanced largest-group-first
  placement with union-find sibling clustering through `parent_students`;
  `student_house_sort_jobs` (snapshot of prior `house_id` per change)
  and append-only `student_house_changes` audit table; routes
  `POST /api/houses/sort/preview|commit`, `POST /api/houses/sort/undo/:jobId`,
  `GET /api/houses/changes` (200-row feed + undoable banner), all
  admin/superuser-gated. Single-student `PATCH /api/students/:studentId/house`
  with reason ≥10 chars + cross-tenant guards, surfaced from the
  Student Profile header via a house pill + "Change house" modal.
  Roster importer accepts an optional `house_name` column; unmapped
  brand-new rows fall back to a rotating smallest-house default
  (existing students are never auto-reassigned by re-uploads). Shared
  `recommendNextHouse(schoolId)` helper exported from
  `routes/houses.ts`. Student Profile API now returns the active
  house (id/name/color) on the header payload.

- Kiosk Phase 3 — printable Student ID badges (Letter PDF, QR to
  `/kiosk?signin=<studentId>`, house ribbon via shared
  `pdfColors.normalizeHex`); real "Sign in to class" arrival flow
  with school-specific welcome card (Mustache-style template with
  `{firstName}/{lastName}/{house}/{grade}`, per-house JSONB override
  map on `school_settings`, 5-second auto-dismiss); append-only
  `class_signins` ledger (composite indexes on `school_id, signed_in_at`
  and per-student); `POST /api/kiosk/class-signin` (kiosk-session auth,
  school-scoped student lookup, in-memory rate-limit 40/min per
  activation); `GET /api/students/id-badges.pdf` (admin-gated; now
  hard-rejects mixed cross-school ID lists with `missingStudentIds`
  in the body instead of silent partial success); `PATCH
  /api/school-settings` extended with hard 240-char limit on template +
  per-house overrides (was silently truncating); `KioskWelcomePanel`
  editor with live preview; in-browser `CameraScanner` using
  `BarcodeDetector` with `@zxing/browser` fallback wired into both the
  pass-creation field and the sign-in tab; admin "Print badges"
  surfaces on `StudentBadgesPanel` (bulk) + `StudentProfile` (per
  student).

- Parent HeartBEAT period-level on-time streak — attendance % YTD +
  last-30d tiles plus three streak tiles (current / longest YTD /
  on-time % YTD) backed by `bell_schedule_periods.included_in_on_time_streak`
  (per-period checkbox in Bell Schedules so lunch / advisory / passing
  can opt out). Walks YTD attendance days, skips excused/unexcused, and
  resets the run on any tardy in a counted period. Tardy period match
  normalizes "1" / "01" / "P1" to integer 1 so SIS-variant rows count
  correctly. Whole streak block returns `null` when the school has no
  active default bell schedule (UI hides the three tiles); a default
  schedule with zero counted periods still returns a non-null
  zero-filled block so "not set up" and "everything opted out" are
  distinguishable. PDF parity in `parentSnapshotPdf`.

- AST district-wide bank: `balanceQuarterHoursForDistrict(staffId,
  districtId)` SUMs ledger rows only for schools in the caller's
  district (intra-district transfers carry the bank; cross-district
  transfers start fresh). Wired into `/ast/me`, soft submit check,
  and approval hard check. New admin-gated `GET
  /api/ast/staff/:id/ledger` returns the per-staff ledger drilldown
  with originating school name (innerJoin schools + district filter
  so cross-district rows can't leak). Race fixes on
  `/ast/use/:id/decide`: `FOR UPDATE` lock on staff row is now by
  `staff.id` only (was scoped to current schoolId — broke
  serialization after intra-district transfer); UPDATE is
  compare-and-swap on `state='pending_preapproval'` so a concurrent
  second approver gets 409 instead of double-debiting.

- Packet A follow-ups: witness statement formatted-ID surfacing
  (PlayerDrawer pill + StatementDetailsModal header `formattedCaseId`
  + audit payloads on reminded/requested/edited/completed + one-shot
  boot backfill); per-school IANA timezone threaded through seed case
  backfill, AST lapse cron, watchlist case-create (x2), and kiosk
  `/class-signins/today` + `resolveActivePeriod` (replaces the
  hardcoded `America/New_York` + bogus `-05:00` offset, now uses a
  DST-correct `startOfDayUtc()` helper); pickup module design
  decisions captured in code (in-app chime stays visual-only,
  5-digit expansion deferred until the 80%-of-range warn fires with
  the exact change recipe inlined).

- Kiosk Phase 4 packet: rectangle student photos on lanyard badges
  (with house-color frame + initials-bubble fallback), roster-inline
  admin "Print badge" button on StudentProfile, student picker
  (replaces pasted-ID textarea) + recent-prints audit table in
  StudentBadgesPanel, sign-in roll-call settings tile reading
  `class_signins` via new admin-gated `GET /api/class-signins/today`
  (school-TZ aware), `{teacher}` + `{period}` welcome-message
  variables (period resolved from default bell schedule in school
  TZ), and new `badge_print_events` audit table with append-only
  per-print logging.

- **Kiosk Phase 3 — printable student ID badges + class sign-in +
  per-school welcome messages + in-browser camera scanning.**
  Four kiosk gaps closed: (1) `GET/POST /api/students/id-badges.pdf`
  generates Letter-size badges with QR (`/kiosk?signin=<id>`), house
  ribbon, and initials-bubble fallback; shared `pdfColors.ts` defends
  against bad hex. (2) New `class_signins` ledger + `POST
  /api/kiosk/class-signin` with kiosk-session auth, per-school
  tenant scoping, and per-activation rate limiting; full-screen
  `WelcomeOverlay` greets the student with house-tinted accent
  and 5-second auto-dismiss. (3) `school_settings.kiosk_welcome_template`
  + `kiosk_welcome_messages` JSONB (per-house overrides) editable via
  `KioskWelcomePanel` Settings tile with live preview; PUT validates
  length ≤ 240. (4) `CameraScanner.tsx` uses native `BarcodeDetector`
  where available, lazy-loads `@zxing/browser` elsewhere; wired into
  the kiosk's student-ID input for both pass + sign-in flows. URL
  `?signin=<id>` param is also parsed on load and auto-submits when
  an activation is present. Route ordering fix: `studentIdBadgesRouter`
  is mounted before `studentsRouter` to avoid `/students/:studentId`
  shadowing the badge PDF endpoint. Drift: T007 "Print badges" surface
  is a dedicated Settings tile (Print all + numeric ID list) rather
  than inline on the roster page — same admin gate, same PDF.

- **SuperUser Home Phase 5 trio + roadmap cleanup.**
  Three roadmap cards (District Switcher, Cross-District Reports,
  Global Feature Flags) all promoted from placeholder to live, and
  the two stale cards (Onboard a District, Audit & Health — both
  already shipped above the dropdown) removed. (1) **District
  Switcher**: when `ALLOW_CROSS_DISTRICT_SUPERUSER=1` the
  `GET /api/tenancy/schools` response spans every district, the
  switcher popover groups by district, and the active pill prefixes
  the district name. `POST /api/tenancy/switch-school` + the
  `app.ts` override-resolution middleware both honor cross-district
  switches under the same env flag; without the flag they keep
  refusing cross-district reach (defense-in-depth preserved).
  (2) **Cross-District Reports** (`GET /api/superuser/cross-district-reports`):
  per-district 7-day rollup of PBIS points / hall passes / ISS days
  / intervention entries, four grouped queries (no N+1), env-gated
  cross-district reach with safe fallback to single-district view.
  Rendered as `CrossDistrictReports.tsx` table on SuperUser Home.
  (3) **Global Feature Flags** (`POST /api/feature-licensing/bulk-overrides`):
  scope = "platform" | "district", fans out the existing per-school
  override upsert + `reapplyLicensingToSchool` inside one tx so
  partial fan-outs can't desync the runtime booleans. Platform
  scope requires `requireCrossDistrictSuperUser`; district scope
  allows caller's own district without the env flag. Rendered as
  `BulkOverridesPanel.tsx` (scope + district + feature + on/off +
  expiration + reason). The placeholder `SUPER_USER_HOME_CARDS`
  const + `<details>` roadmap dropdown are gone — the page now
  leads with live tiles end-to-end.

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
