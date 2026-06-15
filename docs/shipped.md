# PulseEDU — Recently shipped (archive)

Reference only — no remaining action on items below. Most-recent first.
For active follow-ups, see the **Open work** section in `replit.md`.

- PulseDNA Studio — **Phase 1 (profile + AI drafting)**. A per-school saved
  "communication profile" (PulseDNA) that schools upload (client-side parse of
  .txt/.md/.pdf/.docx) and/or paste, edit/replace anytime, with an
  enable/disable toggle; the AI uses it as background context. New **PulseDNA
  Studio** (Profile + Create tabs) under the Family nav group, Core-Team gated
  (`isCoreTeam` / `requireFamilyMessenger`) under the existing `FamilyComm`
  feature flag. AI drafting via `@workspace/integrations-anthropic-ai`
  (`anthropic.messages.create`, claude-sonnet-4-6 — same pattern as
  helpAssistant.ts, no API key), rate-limited 12/min/staff and logged to
  `pulse_dna_generations`. Tables `pulse_dna_profiles` (one-per-school unique
  index) + `pulse_dna_generations` in `lib/db/src/schema/pulseDna.ts`; route
  `routes/pulseDna.ts` (GET/PUT `/pulse-dna` atomic upsert on `school_id`,
  PATCH `/pulse-dna/toggle`, POST `/pulse-dna/draft`). Phases 2–4 (in-app video
  recording studio + teleprompter, ffmpeg transcode / object-storage video
  attach / two-tier retention purge, and accessibility: captions, transcript
  send, translation, readability, approval workflow) were **scoped but not
  built** — deferred by user decision.

- Pickup car-tag PDF — **landscape fold-over plain-paper sheet** + **legacy
  letterless code upgrade**. (1) Tag PDF rewritten to an 8.5×11 LANDSCAPE
  sheet, one tag/page: bottom panel upright + top panel rotated 180° around a
  mid-page fold line ("FOLD HERE — drape over the hanger's top bar and tape")
  so both halves read upright when folded over a kid's clothes-hanger bar and
  taped (hang-tag stock was too expensive). Office reference strip unchanged;
  caller interfaces unchanged. (2) Bulk **"Assign pickup codes"** now upgrades
  LEGACY letterless rows (created before per-adult letters: active,
  `letter IS NULL`, bare `pickup_number` like `1026`) IN PLACE — assigns the
  student's base + next free A–H letter, rewrites the full code (reusing the
  old bare number as the base when it's a valid free number, `1026 → 1026A`,
  else mints fresh), and backfills a missing `adultKey` from the guardian
  label so curb adult-lookup groups it. Runs before new issuance (no
  duplicates), idempotent, soft-cap respected. Codes change → those tags must
  be reprinted; surfaced via an `upgraded` count + a reprint warning in the
  confirm dialog and result toast.

- Tardy metrics — **Total tardies + lost-instruction minutes (YTD)**.
  The staff Hall Passes "Tardy / Check-In History" tab now shows two
  school-year-to-date summary tiles (Total Tardies, Lost Instruction
  minutes) plus a per-row "Min Lost" column; the parent HeartBEAT
  attendance section + PDF show the same two totals per-child. Window is
  Aug-1 school-year-to-date (matches the parent `schoolYearBounds`).
  Lost-instruction minutes = tardy check-in time (`tardies.createdAt`,
  in the school's tz) − scheduled period start from the school's DEFAULT
  active bell schedule, clamped to `[0, period length]` with a 90-min
  fallback cap. New shared helper `artifacts/api-server/src/lib/
  lostInstruction.ts`; `GET /api/tardies` enriches each row with
  `lostMinutes` (null when the period isn't on the default schedule or no
  default schedule exists — surfaced as a "not counted — no bell time"
  note rather than a fake 0). `parentSnapshot.ts` computes per-student
  `tardiesYtd` + `lostInstructionMinutesYtd`. Staff totals are computed
  client-side from the enriched rows with an exclusive Aug-1→next-Aug-1
  window. Per-school timezone threaded via `getSchoolTimezone`.

- School Grade Estimated Calculator — **PM3 result-upload request**.
  When PM3 is selected from the window dropdown, the calculator surfaces a
  dedicated "PM3 result uploads" card requesting the Civics (Gr 7), Science
  (Gr 8), Algebra I (EOC), and Geometry (EOC) result files. These are
  stored as Phase-1 placeholders in the existing `school_grade_surveys`
  ledger (no schema change — `survey` is free text; new kinds `pm3_civics`,
  `pm3_science`, `pm3_algebra`, `pm3_geometry` validated by the
  `UPLOAD_KINDS` union in `routes/schoolGrade.ts`) — accepted and retained
  with raw CSV + metadata but not yet parsed into the calculation (Phase 2).
  The card is hidden at PM1/PM2; existing Survey 2/3 uploads reuse the same
  endpoint and are unchanged.

- Event Ticketing — **Phase 1 (free-ticket events, QR delivery, gate
  scanning)**. Schools create FREE-ticket events (8th-grade promotion,
  graduation, etc.), allocate a per-student quota by grade with
  per-student overrides and excludes, and email each student's guardian
  their QR tickets. **A separate email is sent per student** — siblings
  get one email each, never a combined family email.
  - **Data model** (`lib/db/src/schema/`, ensured additively in
    `seed.ts`): `ticket_events` (name, date, optional start time +
    location, capacity cap, status draft/published/closed, optional
    event-day-only window), `ticket_grants` (one per student per event,
    carries the quota + an email-status snapshot: sent/bounced/failed/
    no_email + printed_at), `tickets` (one row per seat, unguessable
    base64url token ~192 bits **not derived from any student id**, `seq`
    X of N, status valid/used/void), append-only `ticket_scan_events`
    audit (who/when/where/result), and no-login `ticket_scanner_links`
    (token-scoped volunteer access). All composite-school-indexed and
    tenant-scoped by `school_id`.
  - **Delivery is all three**: inline QR images in the email body + a
    printable **PDF attachment** + **Parent Portal** view/download. Every
    surface carries the responsibility verbiage (scanning permanently
    uses a ticket; the guardian owns not over-sharing). Shared copy +
    short-code live in `lib/ticketCopy.ts`
    (`TICKET_RESPONSIBILITY_HEADLINE/LINES`, `ticketShortCode`); email in
    `lib/ticketEmail.ts` (Resend integration, env-gated), PDFs in
    `lib/ticketPdf.ts`.
  - **No-guardian-email students** get **both** a printable office
    handout sheet AND a "couldn't send" report; the **front office can
    print any family's tickets** on demand regardless of email status.
    All authed PDFs **download to disk** (Content-Disposition) per the
    preview-iframe blob gotcha, never open/print in a tab.
  - **Scanning is both**: the staff app (logged-in, `/scan` dispatched in
    `main.tsx` → `scan/ScannerApp.tsx`) AND a **no-login volunteer
    "scanner link"** (token-scoped). First scan **admits**, rescans show
    **"already used"**, via atomic first-scan-wins (single SQL
    conditional `UPDATE ... WHERE status='valid'`) so concurrent scans
    cannot double-admit. Results cover admitted / already_used / invalid
    / void / wrong_event with who/when/where; manual name-lookup fallback
    when a camera fails. Live **"X of Y admitted"** count + near-full
    capacity warning. QR encodes the **bare token**.
  - **Admin module** (`components/TicketingAdminPage.tsx`, Settings tile
    `event-tickets`, group `family-signage`): events list/create,
    allocation preview with overrides + excludes (grades as `number[]`,
    K=0), send + delivery dashboard, per-family print, void/reissue,
    attendee CSV (built client-side), scanner-link management. Uses
    `authFetch` directly (not OpenAPI codegen), matching Displays/Tours.
  - **Role gate** `canManageTickets` (`lib/coreTeam.ts`) admits admin +
    Core Team + counselor + front-office; teachers excluded. Gate
    scanning is any signed-in staff plus the no-login scanner links.
    Gate scanning is **online-only** in Phase 1 (offline deferred).
  - **Phase 2 room left** for paid tickets (Stripe), reserved seating,
    transfer tracking, and waitlists.
  - **Gate-scanner follow-ups (shipped after Phase 1).** (1) A
    "Clear · ready for next" button on the gate `ScannerApp` —
    volunteers release the last scan result on demand, which resets the
    result, resumes the camera, and clears the dedupe token so the next
    ticket scans immediately. (2) A read-only **Scan history** gate-audit
    view in the admin module (`GET /ticketing/events/:id/scan-history`,
    `ScanHistoryPanel` in `TicketingAdminPage.tsx`) — collapsible,
    result + gate filters, CSV export (blob + `a.download` per the
    iframe gotcha). School + event scoped, `requireTicketManager`;
    joins to `tickets`/`students` carry explicit `school_id` predicates
    for tenant defense-in-depth and the CSV serializer neutralizes
    spreadsheet formula-injection (leading `= + - @` / tab / CR). The
    volunteer-name prompt was declined — named gate links + staff login
    already attribute each scan.

- Display Management — **live remote control for signage**. A presenter
  can drive every TV on a playlist PowerPoint-style without ever
  re-entering a URL — TVs keep their existing `/display/:id` URL and
  poll a tiny live-control endpoint (~2s). State is **per-playlist**
  (keyed by `playlist_id`) in a new `display_live_control` table
  (`mode`, `item_index`, `page_index`, `presentation_playlist_id`,
  `presentation_url`, `revision`, `updated_by_staff_id`). Three modes:
  `auto` (existing timed cycling), `manual` (step THIS playlist's items
  only, timers off), and `presentation` (take the same TVs over with a
  chosen **deck playlist** OR an ad-hoc **live URL** — Google
  Slides/Canva present link — then "End session" reverts to Auto).
  Position model is `{itemIndex, pageIndex}` + monotonic `revision`;
  PDF items are page-controllable (the cycler drives `PdfSlide`
  externally and reports `numPages` back to the controller via an
  `onPdfMeta` callback; non-PDF items are 1 page). Public
  `GET /displays/public/live/:id` (no auth, defaults to auto/revision 0
  when no row) feeds the TVs; staff `PUT /displays/playlists/:id/live`
  (`canManageDisplays` + `loadPlaylistForEdit`) upserts and bumps the
  revision, validating mode, that the deck belongs to the same school,
  and the URL via `isValidEmbedUrl`. Controller is a mobile-friendly
  **Remote / Present** panel per playlist card in `Displays.tsx`
  (Auto/Manual/Present tabs, deck picker, live-URL input, First/Prev/
  Next, "slide x of y", live preview reusing `ControlledItemSlide`).
  TV cycler short-circuits to a `LiveControlledView` when mode ≠ auto.
  WebRTC screen mirroring deferred. Module uses `authFetch` directly
  (not OpenAPI codegen), matching the rest of Displays.

- School Tours — **fixed dead post-tour survey QR code**. The
  post-tour PDF's QR (and the brag-page link + lead-notify email
  link) is built by `publicAppOrigin()` in `routes/tours.ts`, which
  previously used only `$REPLIT_DEV_DOMAIN` — the *development* host,
  which is often unset in production and made published QR codes point
  at the dev URL or fall back to `http://localhost:5000`, landing
  families on a dead page. Rewrote it to mirror `kioskBaseUrl`: prefer
  `PUBLIC_APP_URL`, then the first `$REPLIT_DOMAINS` host (the
  published production domain in prod, the dev/preview host in dev),
  then the inbound request's forwarded host, and only finally
  localhost. `surveyUrlFor`/`pipelineUrlFor`/`publicAppOrigin` now take
  the request so the resolved origin is always externally reachable
  (including custom domains).

- School Tours — **family checkpoints on the Brag-sheet PDF + new
  Tour Note Catcher PDF**. (1) The Brag-sheet PDF
  (`lib/tourBragSheetPdf.ts`) now lists the family's selected checkpoint
  labels as a bulleted list inside the "WHAT THEY WANT TO SEE" box,
  above the free-text "anything else" note — the box height is measured
  from content so long lists don't clip. The route resolves
  `interest_selections` → current checkpoint labels (page order) and
  passes them as `selectedStops`. (2) New family-facing **Tour Note
  Catcher** PDF (`lib/tourNoteCatcherPdf.ts`,
  `GET /tours/requests/:id/note-catcher.pdf`, staff-gated download from
  the lead drawer) — general tour info (family, scheduled time, contact)
  up top, then a labelled note area with ruled lines for each stop the
  family selected so they can jot follow-up questions during the visit,
  plus a general follow-up section and a contact footer. Family-facing,
  so it shows the checkpoint **label only** — never the staff-only
  location/talking-points/minutes. Falls back to an open notes area when
  no stops were selected. Also fixed the roadmap PDF's location line,
  which rendered a `📍` emoji as mojibake (`Ø=ÚÍ`) because pdfkit's
  built-in Helvetica has no emoji glyph — now plain italic text.

- School Tours — **auto-translated public brag page (EN→ES)**. When a
  family toggles the public page (`/tour/:schoolId`, `TourApp.tsx`) to
  Spanish, the admin-authored free text (headline, subheadline, intro,
  sections, programs, electives, proudOf, ctaText, checkpoint labels) is
  machine-translated server-side, not just the static UI strings. EN is
  always the source of truth, served raw; ES is generated on demand and
  cached on a new `translations` jsonb column on `tour_pages`
  (`TourTranslation` type in `lib/db/src/schema/tours.ts`), keyed by
  language with a `sourceHash` so an admin edit transparently
  invalidates the cache. Translation runs through the existing Anthropic
  AI integration (`claude-sonnet-4-6`, `lib/tourTranslate.ts`) — the
  source strings are collected into a flat ordered list, translated as a
  JSON array, and reassembled (checkpoint `key`s preserved so family
  selections survive). The public GET `/tours/public/:schoolId/page` now
  takes `?lang=es`; a translation failure or unsupported language
  transparently falls back to the English source so the page never
  breaks. Client caches each language in-memory and shows a brief
  "Translating…" badge on the first non-English view. Only Spanish is
  wired today (`SUPPORTED_TARGET_LANGS`); adding a language is a one-line
  change plus a prompt name.

- School Tours — admin-configured **Tour Checkpoints** + a both-in-one
  **Tour Roadmap PDF**. Admins define stops per-school in the Tour page
  editor (`CheckpointEditor` in `TourAdminPage.tsx`): each checkpoint has
  a family-facing `label` plus staff-only `location`, `talkingPoints`,
  and `minutes`. Stored as `checkpoints` jsonb on `tour_pages`
  (`TourCheckpoint` type in `lib/db/src/schema/tours.ts`); keys are
  minted server-side by `sanitizeCheckpoints` (stable 12-char keys, max
  30) so reorders/relabels never orphan a family's selection. The public
  brag page (`TourApp.tsx`) renders checkpoints as checkboxes on the
  Request-a-Tour form ("What would you like to see on your tour?",
  EN/ES); the old free-text box stays as an optional "Anything else?".
  Selections post as `interestSelections` (validated against current page
  keys, page-order, deduped) and store as `interest_selections` jsonb on
  `tour_requests`. The lead drawer shows the selected stops as chips and
  resolves keys→current labels server-side (`selectedCheckpoints`). New
  route `GET /tours/requests/:id/roadmap.pdf` builds the roadmap via
  `lib/tourRoadmapPdf.ts` (pdfkit): prep block at top (family / children
  / grades / language / scheduled time / assigned staff / contact + the
  free-text note) then the family's selected stops as a check-off
  checklist (location, talking points, minutes + blank note lines staff
  fill during the tour). Downloads to disk like the other lead-drawer
  PDFs (preview-iframe blob gotcha). Module still uses `authFetch`
  directly (no OpenAPI codegen); schema added via additive `ALTER TABLE`.
- School Tours — flyers as full inline documents on the public brag
  page, **moved to the top** of the content; photo gallery moved to the
  **bottom**. Replaced the small cropped flyer thumbnail grid with a
  vertical stack of full-width cards "where the complete document lives":
  image flyers render at full width (no crop), PDF flyers embed in an
  inline `<iframe>` viewer on desktop with a tappable view/download
  fallback card on phones (UA sniff `/Mobi|Android|iPhone|iPod/`, because
  some mobile browsers blank out embedded PDFs). Each card header carries
  the flyer label plus an "Open in new tab" link and an explicit
  "Download" button (same-origin `<a download>` against the existing
  public `/api/tours/public/:schoolId/flyer/:idx` stream; PDF filenames
  get a `.pdf` extension unless the label already has one). Multiple
  flyers are fully supported — a school can upload one per program; they
  stack vertically in upload order. New content order in `TourApp.tsx`:
  flyers → intro → custom sections → programs/electives/proud-of grid →
  photo gallery. The existing per-school `textPlacement` toggle still
  works: default keeps the intro at the top under the flyers; "bottom"
  moves the intro down to sit just above the gallery. New EN/ES i18n keys
  `downloadFlyer` / `openFlyer` / `pdfMobileHint`. Public page only — no
  server, schema, or PDF-generation changes.

- School Tours — district-level branding (logo + tagline). Set
  ONCE by a SuperUser via the Edit-district modal; every school
  in the district inherits identical branding and schools cannot
  change it. Four independent placement toggles, each on/off:
  hero-top strip (default ON), printed documents (default ON),
  footer band (default OFF), hero corner watermark (default OFF).
  Six additive columns on `districts` (`logo_object_key`,
  `tagline`, `brand_hero_top`/`_documents`/`_footer`/`_watermark`)
  ALTERed in by `seedTenancy` BEFORE the district insert (the
  drizzle-generated INSERT references the new columns, so the
  ALTERs must precede it or the seed throws "column does not
  exist"). Logo is stored in object storage and streamed publicly
  by ACL-bypass like tour photos: public page reads
  `/api/tours/public/:schoolId/district-logo`, admin previews via
  `/api/tours/admin/district-logo`. PATCH `/tenancy/districts/:id`
  validates tagline (≤200), the 4 bools, and `logoObjectPath`
  (bound to the staff's school via `bindObjectToSchool`; `""`
  clears). Branding fields also surface on the
  `/api/superuser/overview` district rollup that feeds the modal.
  Brag-sheet + post-tour PDFs embed the logo (downloaded to a
  Buffer) + tagline only when the documents toggle is on; a
  missing/unreadable logo degrades to tagline-only. Module uses
  `authFetch` directly (not OpenAPI codegen), matching the rest
  of the Tours module.

- School Tours — header font color + post-tour document print.
  (1) Per-school `tour_pages.header_text_color` (text, default
  `#ffffff`, hex-validated server + client) with a "Header font
  color" picker in the brag-page editor. Applied INLINE on the
  hero `<h1>` / subheadline `<p>` / school-name `<div>` in
  `TourApp.tsx` — a global `h1` CSS rule was overriding the
  inherited hero color, which is why a dark-purple accent showed
  a black (unreadable) headline. Seed `ensureToursSchema` ALTERs
  the column in additively. (2) Renamed the "QR leave-behind"
  lead-drawer button + PDF filename to "Post-tour document".
  (3) Added a "Print post-tour document" button that prints the
  PDF via a hidden iframe (`contentWindow.print()`) with a
  new-tab fallback. No changes to the QR/survey flow itself.

- School Tours — school-side photo + flyer uploads on the brag
  page (replaces the old "Photo URLs" text box). Admin editor:
  drag-drop/tap multi-photo upload with reorder / delete /
  pick-cover (index 0 = cover) + a per-school text-placement
  toggle (headline & intro above/below photos, default above) +
  multiple labeled flyers (PNG/JPG/PDF ≤10MB). Public page: a
  swipeable photo carousel (touch swipe + desktop arrows/dots)
  and a tap-to-view/download/print flyers section lower on the
  page (image thumb or PDF card). Schema: `tour_pages.text_placement`
  ('top'|'bottom') + `flyers` jsonb (`TourFlyer[]` = `{key,label,kind}`);
  seed `ensureToursSchema` ALTERs both in. Uploads use the existing
  presigned-URL flow (`/api/storage/uploads/request-url` → direct
  PUT) and are claimed for the school via `bindObjectToSchool` on
  PUT `/tours/page` (400 if any object fails to bind). Families are
  unauthenticated, so the public page never sees object keys —
  photos/flyers stream by index through new public routes
  `/api/tours/public/:schoolId/photo|flyer/:idx` (`streamTourAsset`
  redirects legacy http URLs, else streams `/objects/` bytes;
  ACL-bypass is by-design since only published pages stream).
  Admin previews use an `AuthImage` (authFetch blob → object URL).
  Bilingual flyer labels (EN/ES). Legacy http(s) photo URLs still
  render everywhere.

- School Tours (Enrollment Leads) — new module. Public per-school
  bilingual (EN/ES) "brag page" (`/tour/:schoolId`) with admin
  editor + publish toggle and a sibling-aware "Request Your Tour"
  form. Submissions become leads in a sales pipeline
  (New→Contacted→Scheduled→Toured→Closed, outcome Enrolled/
  Deciding/Chose elsewhere) with assignable owner, append-only
  timeline (`tour_request_events`), response-time clock + >24h
  overdue flag, family auto-ack, email + in-app notify to the
  tour-notify audience (per-staff `capTourNotify`), app-wide red
  new-lead banner, brag-sheet + QR leave-behind PDFs (QR →
  post-tour survey `/tour/survey/:token` tied to the lead), and an
  outcome/source conversion report. Schema in
  `lib/db/src/schema/tours.ts` (tour_pages, tour_requests,
  tour_request_events, tour_surveys); routes in `routes/tours.ts`;
  client in `tour/TourApp.tsx` (public) + `components/
  TourAdminPage.tsx` (staff). SMS stubbed via reusable env-gated
  AWS SNS helper `lib/sms.ts`. Deviations: bespoke module uses
  `authFetch` directly (not OpenAPI codegen); brag-page photos are
  URLs — image upload is a noted follow-up.

- Reteach log — parent-portal surfacing. Counts-only rollup on the
  Parent HeartBEAT dashboard + PDF ("Extra Support — Focused
  Reteach"), grouped by benchmark with 1:1 and small-group counts.
  Gated by three independent flags ALL of which must be true:
  school-wide `school_heartbeat_settings.show_reteach` (admin),
  per-parent `parent_heartbeat_prefs.show_reteach` (parent), and
  per-student `students.reteach_logs_parent_visible` (admin via
  `PATCH /api/students/:studentId/reteach-visibility`, modeled on
  the photo-consent toggle). Server payload is a strict whitelist
  (benchmarkCode / format / createdAt) so teacher notes, strategy,
  and teacher_staff_id can never leak. Scoped to current school
  year, soft-deleted rows excluded.

- Reteach Activity school-wide rollup (Insights → 🔁 Reteach
  Activity, admin / Core Team / counselor) — 30-day summary tiles
  (🔁 1:1, 👥 small-group, students reached, benchmarks targeted),
  top loggers + top benchmarks, full filterable detail table (date
  range, teacher, grade, benchmark, format) with CSV export. Backed
  by `GET /api/reteach-activity/summary` + `GET /api/reteach-activity`
  in `routes/reteachActivity.ts`. Insights hub entry gate
  (`canAccessInsightsHub`) broadened to include counselor / guidance
  / school-psych so the new tile (and Algebra Placement) are
  reachable. Per-teacher view: indigo "Reteach activity on this
  roster" footer banner on the Benchmark Progress Report modal
  showing per-roster totals.

- Class Composer — Skill-cluster mode + PM-refresh workflow.
  Fourth composer mode "Skill-cluster (focus standards)" alongside
  Intensive / Regular / Cusp. Groups built from per-student benchmark
  deficit vectors (`clusterByBenchmarkDeficit` + `pickFocusStandards`
  in `lib/skillProfile.ts`) — each group publishes N focus standards
  (default 5, range 3–7) with friendly labels + group-average % +
  coverage. L1/L2 gate same as Intensive. Locked roster is never
  re-shuffled; focus standards refresh independently per PM window.
  New endpoints under `/api/intensive-groups/plans/:id/groups/:gid/`:
  `refresh-focus` (rewrites focus standards, audit-logs, blocks below
  70% coverage), `check-fit` (read-only drift report — flags moves
  with ≥25% deficit-distance improvement), `dismiss-check` (silences
  banner per PM window). Append-only audit trail in
  `class_composer_plan_group_refreshes` (action: refresh / dismiss /
  suggest_schedule). Admin Hub surfaces three PM-keyed banners:
  PM1 "review schedule fit", PM2/PM3 "refresh focus standards" —
  dismissal token `<schoolYear>|<pmWindow>|skillcluster_refresh`.
  Result cards render bullet-list focus standards w/ friendly labels;
  cohesion definition flips to "% of group with ≥ N of focus in
  their personal bottom 7." Plan PDF gets per-group focus-standards
  block; both server `/plans/:id/csv` AND client preview CSV widen
  to `focus_standard_1..N` + `focus_avg_pct_1..N` columns. See
  `routes/intensiveGroups.ts`, `lib/skillProfile.ts`,
  `lib/composerPlanPdf.ts`, `components/IntensiveGroupComposerPage.tsx`,
  `components/AdminHubPage.tsx`. Schema additions in
  `lib/db/src/schema/classComposerPlans.ts` (focus_standards JSONB
  on plan groups; class_composer_plan_group_refreshes table).

- Student ID badge redesign + per-house logo upload. Both
  lanyard (portrait) and CR80 (landscape) badges are now visually
  consistent: square student photo (not initials disc on CR80),
  uploaded house logo in place of the first-letter circle, house
  name + color, school name, grade · dismissal-mode, QR (kiosk
  sign-in deep link), Code 128 barcode of `student_id`, and both
  FL HB 383 crisis lines (988 + Crisis Text Line 741741) on every
  badge. New `houses.icon_object_key` column + admin "House logos"
  tab under Houses (PNG/JPEG/WebP, 2 MB cap; SVG rejected because
  pdfkit can't rasterize it). Upload uses the standard
  `/api/storage/uploads/request-url` → PUT → bind pipeline.
  `bindObjectToSchool` enforces school-scoped ACL on every logo.
  Badge route pre-fetches all referenced house logos in a single
  `Promise.all` (no N+1). Corrupt-image bytes fall back silently
  to the initials disc. See `lib/studentIdBadgesPdf.ts`,
  `routes/studentIdBadges.ts`, `routes/houses.ts` (new
  POST/DELETE `/houses/:id/logo`), and `components/HousesPanel.tsx`
  ("House logos" tab).

- **LG green-check on Teacher Roster (Phase 1).** The LG column now
  swaps the bucket bubble for a green check ✓ when the student met
  the FAST Learning Gain rule, computed server-side in
  `buildSubjectBlock` (`artifacts/api-server/src/routes/teacherRoster.ts`)
  using the prior-year PM3 already loaded by `lib/fastHistory.ts`.
  Rule: moved up a performance level → MET; maintained L5 → MET;
  maintained L3 or L4 with this year's PM3 ≥ last year's PM3 + 1 →
  MET; everything else (flat L3/L4, L1/L2 maintain, dropped level) →
  bucket stays. Missing prior or current PM3 → bucket stays (no
  false signal). Client renders the check via `LgCheck` in
  `components/TeacherRosterPage.tsx` with a tooltip explaining
  the trigger (e.g. "Moved L3 → L4 — FAST Learning Gain met").
  Help copy + Open-work note updated; L1/L2 within-level point
  threshold tracked in `replit.md` for Phase 2.

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
