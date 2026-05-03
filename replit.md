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

## Display overrides — date-range scheduling + calendar (May 2026)

Override rows now carry an optional `effective_from` / `effective_until`
date pair that gates *which* dates the row fires on, on top of the
existing `day_of_week` weekly recurrence.

Schema (`display_playlist_overrides`):
- `effective_from date` / `effective_until date` (drizzle `mode:"string"`,
  both nullable). Three legal states (validator enforces — one-sided
  bounds are rejected):
  - `(null, null)` → recurring weekly forever ("until removed")
  - `(d, d)` → one specific date
  - `(from, until)` with `from < until` → bounded date range
    (typically Mon–Sun for "one specific week")
- Stored as strings to compare directly against today's local
  `YYYY-MM-DD`; we never `new Date("YYYY-MM-DD")` them (UTC pitfall).

Server (`displayOverrides.ts`):
- `parseOptionalDate` checks both regex AND real-calendar validity
  (rejects 2026-02-31 etc., which `new Date(y,m-1,d)` would silently
  roll over).
- `validateOverrideInput` enforces the 3 legal recurrence states and
  is wired into single POST, bulk POST, single PATCH (with merge
  from existing), and group PATCH.
- Group PATCH (`/group/:groupId`) intentionally does NOT touch
  `effective_from` / `effective_until`. Each row in a passing-period
  group keeps its own date range; collapsing them all to one value
  would silently lose per-row bounds the user can't see in the
  group-scope edit dialog.
- New `GET /displays/calendar?fromDate=YYYY-MM-DD&days=28` (max 56,
  `canManageDisplays`-gated) does the (date × display) rollup
  server-side: walks each date in the range, matches each override
  against `dayOfWeek === weekday(date)` AND date ∈ [from, until],
  and returns `{ fromDate, days, displays, cells: [{date, dayOfWeek,
  displayId, displayName, windows: [...] }] }`. Each window is
  flagged `isOneOff` (from===until) or `isBoundedWeek` (from<until).

Public read API (`displays.ts`):
- `/displays/public/playlists/:id` includes `effectiveFrom` /
  `effectiveUntil` on every override so the cycler can apply the
  same date-gate offline.

Cycler (`DisplayShow.tsx`):
- `pickActiveOverride` skips rows where today's local
  `YYYY-MM-DD` is outside the row's bounds. `toLocalISODate(now)`
  formats today without a UTC trip.

Client UI (`Displays.tsx`):
- `AddOverrideDialog` gained a "Repeat" picker with three pills:
  - "Every week (until removed)" → `(null, null)`
  - "One specific week" → snaps the picked date to that ISO week's
    Monday and sets `until = from + 6` days; the day-picker still
    applies inside that week
  - "One specific day" → `from = until = picked date`; the
    day-picker is hidden and `dayOfWeek` is auto-derived from the
    picked date's weekday
- The picker is hidden in group-scope edit (per-row dates preserved
  server-side regardless).
- New 📅 Calendar button on the displays-list header opens
  `DisplaysCalendarModal` — read-only 4-week grid (current week +
  3 ahead, Mon–Sun rows) showing every display × every day with
  resolved override windows. Today is highlighted; windows render
  with badges: ⛓ (group), ★ (one-off), ⏳ (bounded week).

## Per-display overrides — passing-period groups (May 2026)

Bulk-add now stitches the inserted rows together as a "passing period
group" so admins can manage them as one unit instead of N independent
rows.

Schema (`display_playlist_overrides`):
- `group_id text` (nullable, indexed) — UUID stamped on every row in
  one bulk insert. Null for one-off single-day adds.
- `group_name text` (nullable) — friendly label ("1st period
  passing"). Stored on every row in the group; mirrored to the cell
  badge in the weekly view.

API (`/api/displays/playlists/:id/overrides`):
- POST `/bulk` accepts an optional `groupName` and stamps every row
  with a fresh `randomUUID()` group_id and the same name.
- New PATCH `/group/:groupId` updates `playlistId` / `startTime` /
  `endTime` / `groupName` for every row sharing the group_id.
  `dayOfWeek` is intentionally not patchable here — group rows keep
  their own day; if the admin needs to change a single day's window
  they edit that one row.
- New DELETE `/group/:groupId` removes every row in the group at
  once. Both group endpoints are scoped to the requesting display so
  one display can't touch another's rows.

Client (`Displays.tsx` → `OverridesEditor` + `AddOverrideDialog`):
- Bulk dialog shows a "Passing period name" field; the group label
  appears as a small ⛓ pill on every day's tile.
- Edit on a grouped row opens a scope toggle: "Entire passing period"
  (PATCH /group/...) vs "Just this day" (PATCH /:overrideId). Group
  scope hides the day picker since each row keeps its own day.
- Delete on a grouped row prompts: OK = delete the whole period
  (group DELETE), Cancel = fall through to per-row confirm.

## Per-display schedule overrides — edit + URL slides (May 2026)

Follow-on to the override feature below. Two additions:

1. **Editable overrides** — each row in the weekly grid now has Edit
   and Delete. Edit reuses `AddOverrideDialog` in a new `mode="edit"`
   variant that PATCHes the existing row instead of POSTing a new one.
2. **URL slides** — playlist items now support `kind = "url"`. The
   "+ Add URL" button next to "+ Upload file" prompts for an
   https:// URL + label and registers a URL slide. The cycler
   embeds it via a sandboxed iframe (`allow-scripts allow-forms
   allow-popups`, *no* `allow-same-origin` — combining those two
   defeats the sandbox) and advances after the per-item duration.
3. **Quick-create playlist from the override dialog** — "+ New
   playlist" inside `AddOverrideDialog` POSTs `/displays/playlists`,
   auto-selects the new playlist, and bubbles a refresh up so the
   dropdown updates. Designed for the "make a passing-period playlist
   in seconds" workflow.

Schema changes:
- `display_playlist_items`: added `url text` (nullable), dropped
  `NOT NULL` on `object_path` / `original_filename` / `mime_type`,
  added CHECK constraint
  `display_playlist_items_url_xor_object_check` enforcing
  `(kind='url' AND url IS NOT NULL AND object_path IS NULL)
   OR (kind<>'url' AND object_path/original_filename/mime_type IS NOT NULL AND url IS NULL)`.

Server changes (`routes/displays.ts`):
- `isValidEmbedUrl()` enforces http/https AND blocks
  `localhost`/`*.localhost`/`0.0.0.0`/`127.x`/`10.x`/`192.168.x`/
  `172.16-31.x`/`::1`/`fe80:`/`fc*`/`fd*` so an admin can't embed an
  internal admin panel reachable from the TV's switch port.
- POST `/playlists/:id/items` now branches: `{kind:"url", url, originalFilename?}`
  inserts a url-kind item; the legacy upload payload still works
  unchanged.
- Public fetch returns `url` on every item (and on every override
  target item).
- `GET /displays/public/media/:itemId` short-circuits with 404 for
  url-kind items (they have no backing object_path).

## Per-display schedule overrides (May 2026)

A display (a `display_playlists` row whose public URL the TV opens) plays
its own items as the BASE loop. Admins can now define weekly override
windows that swap in a different playlist's items during a `(dayOfWeek,
startTime, endTime)` window — e.g. "weekdays 8:30–9:00 play the
morning-announcements playlist; the rest of the day play the lobby
slideshow".

- Schema: new `display_playlist_overrides` table — `display_id` +
  `playlist_id` (both FK `display_playlists`, ON DELETE CASCADE),
  `day_of_week` (0=Sun..6=Sat), `start_time`/`end_time` text HH:MM.
- API (admin, `canManageDisplays` + same-school + owner gates, mounted
  in `routes/displayOverrides.ts`):
  `GET/POST /api/displays/playlists/:id/overrides`,
  `POST .../overrides/bulk`, `PATCH/DELETE .../overrides/:overrideId`.
  Validation: HH:MM regex, `endTime > startTime` (overnight wraps must
  be split into two rows), override target must be at the same school.
- Public fetch (`/api/displays/public/playlists/:id`) now returns
  `overrides: [{id, playlistId, dayOfWeek, startTime, endTime, items[]}]`
  with items pre-resolved (single batched `inArray` query).
- Cycler (`DisplayShow.tsx`): `pickActiveOverride()` picks the row whose
  window contains "now"; tie-break is lowest `startTime`. Recomputed on
  every minute tick. On scope change (base ↔ override or override A ↔
  override B) `lastScopeRef` resets `slideIdx` to 0 so staff get a
  predictable loop start. During an override the house / hall-passes /
  heartbeat injections are intentionally dropped — what the admin
  uploaded is exactly what plays.
- Admin UI (`Displays.tsx` `OverridesEditor`): weekly 7-column grid +
  Add (single day) and Bulk add (one window applied to N days at once)
  modal. v1 is delete + re-add, no inline edit.
- **Per-display Active/Inactive kill switch** (`display_playlists.active`,
  default TRUE): each display URL card on the admin list shows a green
  "Active" / red "Inactive" pill plus a Turn off / Turn on button.
  When flipped OFF the public cycler endpoint returns a minimal
  off-air payload (no items, all synthetic slides disabled) so any TV
  pointed at `/display/<id>` shows its built-in Off-air card without
  breaking its poll. Items, schedule, and overrides are preserved.
  The cross-display **Calendar modal** (`GET /api/displays/calendar`)
  filters to active displays only and resolves override target names
  against the same active-only list, so an inactive playlist never
  appears in the grid even if another display has an override pointing
  at it.

## Safety Plans (May 2026)

Per-student behavioral / physical safety checklist owned by the school's
Guidance Counselor + Core Team.

- **Schema** (`lib/db/src/schema/safetyPlans.ts`):
  - `safety_plan_library` — school-scoped catalog of preset items
    (Clear backpack, No sharp objects, Escort to bathroom, …).
    Built-in items can be deactivated but not renamed.
  - `safety_plans` — one row per (school, student); checklist stored
    inline as `items JSONB` (array of `{label, active, note?}`). Status
    `active` drives the red SP pill; `inactive` is history.
  - `safety_plan_audit` — every create / update / activate / deactivate
    logged with actor + JSON snapshot.
- **New role**: `staff.is_guidance_counselor`. Combined gate
  `canEditSafetyPlan(staff)` in `lib/coreTeam.ts` = guidance counselor
  OR core team. View access is open to any signed-in staff (every
  teacher needs to know what's on a student's safety plan).
- **API** (`/api/safety-plans/*`): library CRUD, per-student GET/PUT/
  deactivate, audit, and a lightweight `/active-summary` bulk endpoint.
- **Roster integration**: `/api/teacher-roster` now attaches
  `safetyPlan: {itemCount, items, notes, updatedAt, updatedByName} | null`
  per row. The TeacherRosterPage renders a red "SP" pill immediately
  after each student's name with a hover popover listing the active
  items + notes. The pill is **read-only for every role** (teachers and
  counselors alike); the hover popover always works because the pill
  degrades from `<button>` to `<span>` when no `onOpen` handler is
  passed. Counselors / Core Team manage plans from the dedicated Safety
  Plans page or from Student Profile, not from the teacher roster.
- **Dedicated admin page** (`SafetyPlansAdminPage.tsx`, sidebar entry
  "Safety Plans", section key `safetyPlans`): mirrors the MTSS Plans
  workflow. Status filter (Active / Archived / All), name+ID search,
  "+ New Safety Plan" opens a student picker (students with an active
  plan are disabled). Edit button opens `SafetyPlanEditor` per row.
  Backed by new `GET /api/safety-plans/list?status=active|inactive|all`
  which joins `students` for name + grade. Sidebar entry + render are
  gated by `canEditSafetyPlanClient` = Guidance Counselor / Admin /
  Behavior Specialist / MTSS Coordinator / School Psychologist /
  SuperUser, mirroring `canEditSafetyPlan` in `lib/coreTeam.ts`.
- **Student Profile entry**: header card now shows an "Edit safety
  plan" / "View safety plan" button next to the demographic chips.
  Visible to every staff member (so teachers always have an in-context
  read-only view); writes are still server-gated by `canEditSafetyPlan`.
- **Hidden from Parent Portal** — no parent-facing surfaces touch
  these tables. No automatic family messages on plan creation.
- **Demo seed** (`seedSafetyPlanLibraryIfEmpty` +
  `seedSafetyPlansIfEmpty`): seeds the 7 built-in library items per
  school, then creates active plans for ~10% of each demo school's
  students with a guarantee of ≥1 plan student per teacher's roster
  so the SP pill shows up on every teacher's roster on day-1.

## Pulse signage screens (April 2026)

Three live signage/dashboard surfaces for the School Operations app, served
from the same Vite client under `/signage/*`:

- `/signage/heartbeat` — `signage/HeartbeatSignage.tsx`. Live mood meter +
  unified event feed (PBIS / tardies / pullouts / interventions). Polls
  `/api/pulse/heartbeat` and `/api/pulse/events` every 30s. Public-kiosk OK
  via `?schoolId=N` — server **redacts** free-text `detail` and replaces
  `staffName` with `"Staff"` for unauthenticated callers.
- `/signage/houses` — `signage/HousesSignage.tsx`. Four-house leaderboard
  (Falcon=blue, Phoenix=red, Stag=green, Wolf=violet) with per-house
  red-left / green-right mini mood meters under each bar. Polls
  `/api/houses` every 30s. Kiosk OK.
- `/signage/student?studentId=N` — `signage/StudentTimelineSignage.tsx`.
  Per-student deep-dive timeline used for parent conferences / MTSS.
  **REQUIRES staff session** — `/api/pulse/student-timeline` ignores
  `?schoolId=` and only reads `req.schoolId` from the session, since this
  screen surfaces full PII (real student names, free-text behavior notes,
  staff names).

Path dispatch lives in `signage/SignageApp.tsx`; `main.tsx` routes
`/signage*` paths to it. Polling helper: `signage/usePolling.ts`.

Schema additions (`lib/db/src/schema/houses.ts`):
- `housesTable` (id, schoolId, name, color hex, motto, createdAt) seeded
  idempotently in `seed.ts` via `ensureHousesSchema` + `seedHousesIfEmpty`.
- `studentsTable.houseId` nullable column; existing students round-robin
  assigned at seed time.

Parent dashboard (`parent/Dashboard.tsx`) gained a `<ParentMoodMeter>` card
above the Pulse cards. It reads `snapshot.pbis.weeklyCounts` (computed by a
dedicated SQL aggregate in `routes/parentSnapshot.ts` so it isn't truncated
by the 50-row recent-PBIS sample), with a fallback to filtering
`snapshot.pbis.recent` for older API servers.

API endpoints (all in `routes/pulse.ts` + `routes/houses.ts`):
- `GET /api/houses` — leaderboard + per-house counts (kiosk OK).
- `GET /api/pulse/heartbeat` — aggregate counts + trend vs yesterday.
  `positivePct = positive / (positive + negative)` (neutral concerns are
  surfaced separately, not folded into the bar).
- `GET /api/pulse/events` — unified event feed; redacted for public callers.
- `GET /api/pulse/student-timeline` — staff-only per-student timeline.

### Signage visuals (April 2026 update)

`HeartbeatSignage` defaults to a "Trunk" view: a vertical red gradient
trunk with a CSS pulse animation; each pulse event branches LEFT for
negative/neutral (concern) and RIGHT for positive, terminating in a pill
(`PulsePill`) sized for TV viewing distance (text-base / text-xl for
points, h-12 avatar). Newest events render at the bottom and push older
events upward; capped at 24 (the events fetch is `limit=24` to match).
The header has a small Trunk/List toggle so admins can fall back to the
original list layout.

`HousesSignage` adds two surfaces above the existing bar chart:
- A horizontal "Live action feed" strip (most recent 6 point-bearing
  events from `/api/pulse/events?windowMinutes=120&limit=24`).
- A `FeaturedPopup` card pinned inside the **leading** house's bar.
  It cycles through the most recent positive PBIS events on a 5-second
  timer (queue), resetting whenever the underlying event list changes.
  The popup's vertical position uses
  `clamp(56px, calc(${100-pct}% + 12px), calc(100% - 88px))` so it
  always sits at the top of the colored bar fill, regardless of how
  short or tall the leader's bar is.

### Pulse Insights mockups — Program Effectiveness (April 2026)

Two design-review mockups for the upcoming "Insights · MTSS" surface live
in the mockup-sandbox under `pulse-screens/` and are embedded as live
iframes on the Canvas (artifact id `XegfDyZt7HqfW2Bb8Ghoy`) in the
signage row at `y=-540`:

- `ProgramEffectivenessSankey.tsx` (iframe at `x=12720`) — Educlimber-style
  alluvial flow. PM1 → PM3 by default, with PM1→PM2 / PM2→PM3 toggles.
- `ProgramEffectivenessTrajectory.tsx` (iframe at `x=14060`) — sister view
  that buckets the same students into 6 journey archetypes:
  Climbed / Held the line at At/Above / Slipped / Stuck at Well Below /
  Volatile / Untested at PM3. Each tile click reveals an in-component
  drill view with 3–4 actionable sub-archetypes (e.g. for Stuck:
  Closest to escape, Deeply stuck, No active intervention, Chronic
  absence). The drill state is local `useState`; back button returns
  to the parent grid.

Both screens use synthetic `Matrix` data (the `BASE_MATRIX_ELA/MATH`
constants are duplicated at the top of each file). Totals tie out to
4,705 students across the two screens so they can be reviewed
side-by-side. Data is mock-only — graduation to live `studentFastScores`
is a separate task. Sub-archetype counts inside the drill view are
deterministic ratios of the parent count, so they respond to the
subject/grade filter chips at the top.

**Update — Trajectory mockup graduated (Apr 26, 2026).** The Trajectory
screen has been ported into the live `@workspace/client` app at
`activeSection = "academicsTrajectory"`, surfaced as a new "Academic
Trajectories" tile in the Insights hub (group: `domains`, sibling of
Academics). Backed by two new endpoints in
`artifacts/api-server/src/routes/insights.ts`:
`GET /insights/academics/trajectory` returns the 4×4 PM1×PM3 band
matrix, six parent counts, and disjoint sub-archetype counts (3 per
archetype). `GET /insights/academics/trajectory/students` returns the
matching student list (capped at 200) for `BandStudentsDrawer`. Both
share the same auth + filter parsing as `/insights/academics`. The live
component is `artifacts/client/src/components/AcademicsTrajectory.tsx`;
the mockup file remains for the Sankey side-by-side review on the
canvas. Honest-data invariants: parent counts sum to total, sub-counts
within each parent sum to the parent — verified live against the
seeded Parrott school (875 students, both subjects). The Sankey screen
has not yet been graduated.

## Classroom Store + School Store + Object-storage thumbnails (April 2026)

PbisPointsHub now has two reward catalogs that share a single generic
`StoreView` component (in `PbisPointsHub.tsx`):

- **Classroom Store** (`tab === "rewards"`, `<ClassroomStoreView />`) —
  per-teacher catalog. Each staffer manages their own list. Anyone signed
  in can add to their own store; admins can edit anyone's row.
- **School Store** — school-wide catalog. Reachable from **three** places
  depending on role:
  - **Sidebar "School Store"** (`activeSection === "schoolStore"` in
    App.tsx, `baseNavSections`) — **always read-only** for everyone, even
    admins. This is the teacher-facing browse surface.
  - **PBIS Hub → "School Store" tab** (`tab === "rubric"`,
    `<SchoolStoreView canEdit={...} />`) — full edit controls if the
    viewer can edit.
  - **BS hub tile + MTSS hub tile** (`activeSection === "schoolStoreManage"`)
    — full edit controls.

  Edit access (`canEditSchoolStore` in App.tsx, `requireWriteAccess` in
  routes/schoolStore.ts) = `isSuperUser || isAdmin || isBehaviorSpecialist
  || isMtssCoordinator || isPbisCoordinator`. Plain teachers get 403 on
  writes and don't see edit/delete/+ controls anywhere. The two gates are
  intentionally mirrored — keep them in sync if either changes.

Both use the same `StoreItemCard`, `StoreItemModal`, image-upload flow, and
local blob preview (instant in-modal preview before Save). They differ only
in apiPath, header copy/gradient/icon, and `canEdit`. Cleanest place to
add a third reward catalog later is another `StoreConfig` + thin wrapper.

Backend pieces:
- Tables `classroom_store_items` and `school_store_items`
  (`lib/db/src/schema/{classroomStoreItems,schoolStoreItems}.ts`): same
  shape (name/description/points_cost/image_url/sort_order/archived) — the
  classroom variant has `owner_staff_id`, the school variant doesn't. Hard
  delete (no redemption history yet).
- `/api/classroom-store` GET/POST/PATCH/DELETE
  (`artifacts/api-server/src/routes/classroomStore.ts`): scoped by
  schoolId+ownerStaffId on read; per-row write gated to admin OR owner.
- `/api/school-store` GET/POST/PATCH/DELETE
  (`artifacts/api-server/src/routes/schoolStore.ts`): scoped by schoolId on
  every read/write; **all writes require `staff.isAdmin`** (`requireAdmin`
  helper returns 403 otherwise). GET is open to any signed-in staffer.
- `/api/storage/uploads/request-url`, `/api/storage/objects/*tail`,
  `/api/storage/public-objects/*tail`
  (`artifacts/api-server/src/routes/storage.ts`) on top of
  `lib/objectStorage.ts` + `lib/objectAcl.ts`. Express 5 wildcard syntax is
  `*name`, not bare `*`.

Storage tenant isolation:
- Every issued upload URL is logged in an in-memory `pendingUploads` ledger
  keyed by `/objects/<id>` with the requester's schoolId (24h TTL). This
  lets the uploader's school preview the object before any domain row saves
  it (lazy bind doesn't happen until POST/PATCH).
- `bindObjectToSchool(path, schoolId)` writes ACL metadata
  `{ owner: 'school:<id>', visibility: 'private' }` only when (a) no policy
  yet AND a matching pending entry exists, or (b) already owned by the same
  school. It refuses to rebind another school's object — closes the hijack
  vector.
- `GET /storage/objects/*tail` requires `req.staffId` AND `req.schoolId`,
  then allows iff `policy.owner === school:<reqSchoolId>` OR (no policy yet
  AND pending entry's schoolId matches). All other cases 404.
- Both `classroomStore` and `schoolStore` POST/PATCH call
  `bindObjectToSchool` and roll back / 400 if the bind is refused, so we
  never persist an unservable thumbnail.

## Multi-tenancy / Cross-school Isolation (April 2026)

PulseEDU is multi-tenant by `school_id` (Hernando County: Parrott=1,
Springstead=2, NCT=3, Weeki=4, Powell=5, Test Middle=36). The session sets
`req.schoolId`; routes call `requireSchool(req,res)` from
`artifacts/api-server/src/lib/scope.ts` and AND-filter every read/write by
that id. SuperUser is intentionally district-wide and is the only role that
escapes school scoping.

SuperUser also implicitly inherits all privileges: every role-OR gate on the
server (and the client's `isAdmin` derivation in App.tsx) treats
`isSuperUser === true` as satisfying the check. New role-gated routes MUST
include `isSuperUser` in their OR chain. The carve-outs are role-management
code in `adminStaff.ts:238/270/385` (which intentionally distinguishes
admin vs super) and `auth.ts:25` (field passthrough). Sweep last
completed 2026-04-29 — see git log for the patch set.

`student_id` and `displayName` are NOT globally unique across schools, so
membership filters in JS are not sufficient — every query that touches
`students`, `class_sections`, `section_roster`, `student_accommodations`,
`accommodation_logs`, `pbis_entries`, `staff_defaults`,
`teacher_destination_allowlist`, or `location_allowed_destinations` must
include `eq(table.schoolId, schoolId)` in SQL.

Per-school uniqueness on master lists — composite `(school_id, name)`
unique indexes on `school_accommodations`, `pullout_reasons`,
`intervention_types`, `trusted_adult_interventions`, and `pbis_reasons`
so each school can carry its own copy of "Extended Time" / "Verbal
Redirect" / etc. without colliding with another school. Routes that
consume these lists by id (e.g. `/interventions` POST validating
`interventionTypeId`) must AND the FK lookup by `schoolId` to prevent a
caller from attaching another school's master-list id to their own row.

`adminStaff.ts` carve-out: SuperUser sees/edits district-wide; all other
admins (incl. `cap_staff_roles` holders) are hard-scoped to
`actor.schoolId` for LIST, PATCH, POST, and password-reset.

`schedule.ts` identity is session-only — the prior `?staffId=` query
fallback was an intra-school impersonation surface and has been removed.
Clients always rely on the session cookie; `?all=1` is the only
documented variant, still tenant-scoped to the caller's school, and
gated server-side to `isAdmin || isEseCoordinator` so the UI gate is
mirrored at the API boundary.
`accommodationsAdmin.ts` no longer accepts `?staffId` / body `staffId` as an
actor identity — only the signed-in `req.staffId` is used.

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

## Working Preferences (April 2026)

### Reference screenshots from other software = concept, not layout

When the user shares a screenshot from another product (eduCLIMBER,
PowerSchool, Skyward, FastBridge, anything else they're researching),
treat it as a **concept reference** only. Extract:

- What insight is this trying to deliver?
- What signal/data is it surfacing?
- What problem is it solving for the user?

Then design Pulse's version from scratch. **Do not copy the visual
layout, color palette, or component grouping.** Pulse should look
distinct from those tools and ideally improve on the underlying
functionality (better defaults, fewer clicks, more honest empty states,
catching signals the source product missed).

The reference is a starting point for **what**, never **how**.

If a screenshot's layout choice happens to be objectively the right
answer for a piece of Pulse, fine — but justify it on its own merits,
don't default to it because that's how the reference did it.

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

## Multi-tenancy — Day 1 + Day 2 (April 2026)

PulseEDU is migrating from single-tenant to silo-per-district.

**Day 1 — foundation tables.**
- New tables: `districts`, `schools` (`lib/db/src/schema/{districts,schools}.ts`).
- Seeded: `Hernando County School District` (slug `hernando`, state code `27`)
  with 5 schools — D. S. Parrott Middle (PRIMARY, code 0241), F. W. Springstead
  High (0181), Nature Coast Technical High (0351), Weeki Wachee High (0391),
  Powell Middle (0221).
- New SuperUser-only Settings tile: **Tenancy** (`TenancyPanel.tsx`).
- API: `GET /api/tenancy/status` (SuperUser-gated) — `routes/tenancy.ts`.
- Idempotent boot-time seed: `seedTenancy()` in `seed.ts`.
- Tables created via direct SQL because drizzle-kit push prompts on rename
  detection between unrelated existing tables (same workaround used for the
  PBIS thresholds columns).

**Day 2 — `school_id` on every tenant-scoped table + backfill.**
- 32 tables now have `school_id INTEGER NOT NULL DEFAULT 1` with a foreign key
  to `schools(id) ON DELETE RESTRICT` and a `school_id` index. Tables scoped:
  `students, staff, hall_passes, tardies, pbis_entries, pullouts,
  accommodation_logs, support_notes, intervention_entries, iss_roster,
  iss_attendance_day, record_edits, pbis_goals, pbis_milestones,
  pbis_milestone_emails, pbis_reasons, locations,
  location_allowed_destinations, bell_schedules, class_sections,
  section_roster, kiosk_activations, admin_notifications, staff_defaults,
  student_accommodations, school_accommodations, intervention_types,
  pullout_reasons, teacher_destination_allowlist, student_hall_pass_limits,
  trusted_adult_interventions, polarity_pairs`.
- All existing rows backfilled to D. S. Parrott (`school_id = 1`). 0 orphans
  across all 32 tables.
- DEFAULT 1 stays in place as a safety net so legacy INSERT paths that don't
  yet pass `school_id` still write to Parrott. Day 3 will remove the DEFAULT
  once routes explicitly carry `req.schoolId`.
- Drizzle schema files NOT yet updated to declare `school_id` — deliberately
  deferred to Day 3 when the route-by-route scoping work happens, so we don't
  pay the cost twice. The DB is the source of truth in the meantime.
- Tenancy panel now shows: per-school row counts (5 columns × 10 tables),
  total per row, and a green "✓ All records assigned to a school (0 orphans)"
  / red "✗ N orphan rows" data-integrity check.
- Tables NOT scoped (deliberately): `districts`, `schools`, `custom_roles`
  (cross-school presets), `district_integrations` (district-level),
  `school_settings` (singleton, becomes per-school in Day 4),
  `bell_schedule_periods` (child of `bell_schedules`, scoped via parent),
  `user_sessions`, `check_in_with_options` (legacy).

**Day 3 (in progress)** — silo-per-school request scoping.

Wave 1 (foundation):
- `req.schoolId`, `req.homeSchoolId`, `req.isSchoolSwitched` resolved on every
  request (`artifacts/api-server/src/app.ts`).
- `lib/scope.ts` exports `requireSchool(req, res)` — handler helper that
  returns the active school id or writes 401.
- 13 Drizzle schema files updated with `schoolId: integer().notNull().default(1)`
  so route code can reference the column without raw SQL.
- New routes (`artifacts/api-server/src/routes/tenancy.ts`):
  - `GET  /api/tenancy/schools` — pickable schools (SuperUser sees all,
    everyone else sees their own home school).
  - `POST /api/tenancy/switch-school { schoolId }` — SuperUser-only; persists
    `session.activeSchoolId`. `schoolId: null` clears the override.
  - `POST /api/tenancy/schools` — SuperUser-only create-school flow used by
    the Tenancy panel to prove silo isolation against an empty school.
- `/api/auth/me` and `/api/auth/login` now return
  `{ schoolId, homeSchoolId, isSchoolSwitched }`.

Wave 2 (route scoping). Each route below filters reads by `req.schoolId` and
stamps `school_id` on every INSERT:
- `students`, `hall-passes` (all CRUD), `tardies`, `support-notes`,
  `accommodation-logs` (GET + POST + bulk),
- `pbis` (list, leaderboard, POST, bulk, home-stats, needs-attention with
  student/staff denominators all scoped via `staff.school_id` join until the
  config tables migrate to per-school in Day 4),
- `pullouts` (list, by-student, report, POST, **all 6 PATCH actions** —
  `verify`, `reject`, `arrived`, `returned`, `closed`, `review` — now match
  `id AND school_id`),
- `locations` (GET, POST),
- `interventions` (GET + POST),
- `reports/teachers` (filters by `staff.school_id`).

Top bar (`artifacts/client/src/components/SchoolSwitcher.tsx`):
- Shows the active school as a 🏫 pill. SuperUsers click to open a switcher
  popover. When switched away from the home school, an amber "⚠ Acting as X"
  badge plus an "Exit switch" button appear so SuperUsers never get stuck.
- On a successful switch the page hard-reloads — every list refetches scoped
  data. Cheaper than threading a query-key through every `useState` list.

Tenancy panel (`TenancyPanel.tsx`) now includes a "Create new school" form
(SuperUser-only) that POSTs `/api/tenancy/schools`, refetches the status, and
instructs the SuperUser to switch into the new (empty) school to verify silo
isolation. Server validates name/code uniqueness within the district until the
composite unique index lands in Day 4.

Routes intentionally NOT scoped yet (config singletons → per-school in Day 4):
`bell-schedules`, `pbis-reasons` (lists), `school-settings`, `kiosk-activations`.

The DB-level `DEFAULT 1` on `school_id` stays until every INSERT path
(including kiosk + admin tools) is explicit; planned for end of Day 3 / start
of Day 4. `class_sections` and `section_roster` still lack `school_id` — also
Day 4.

Multi-day plan tracked in `.local/session_plan.md`.

## Multi-tenancy — Day 4 (April 2026)

D4 makes per-school configuration *truly* per-school instead of singleton.

**Schema (Wave A1).**
- `school_settings.school_id INTEGER NOT NULL DEFAULT 1` + unique index
  `school_settings_school_id_unique` — guarantees one row per school.
- `schools.timezone TEXT NOT NULL DEFAULT 'America/New_York'`.
- Drizzle schemas updated: `schoolSettings.ts`, `schools.ts`, plus
  `schoolId` columns added to `pbisGoals`, `pbisMilestones` (table-wide
  unique on `points` removed in favor of per-school dup-check),
  `kioskActivations`, `teacherDestinationAllowlist`,
  `locationAllowedDestinations` (DB columns existed since D2 — Drizzle
  was missing them).

**Routes (Wave A2).**
- `requireSchool(req, res)` helper at `src/lib/scope.ts` returns
  `req.schoolId` or writes 401.
- Lazy "ensure settings row" pattern in `routes/schoolSettings.ts` —
  GET reads-or-creates by `req.schoolId`, PUT updates by both `id` AND
  `school_id` (defensive). Concurrent inserts are absorbed by the
  unique index + retry-read.
- Scoped CRUD routes: `bellSchedules.ts`, `teacherAllowlist.ts`,
  `listsAdmin.ts` (pbis-reasons), `pbisGoals.ts`, `pbisMilestones.ts`,
  `kiosk.ts` (activations list / activate / deactivate),
  `locationAllowedDestinations.ts`.
- **Acceptance criterion fix at `routes/pbis.ts:583`** — the PBIS
  thresholds query now filters by `staff.schoolId`. Changing
  `pbisQuietTeacherDays` in Parrott no longer affects Powell.
- `routes/studentHallPassLimits.ts`: `getEffectiveDailyLimit` and
  `findDailyLimitConflict` now take `schoolId`. Callers in
  `hallPasses.ts` (uses `req.schoolId`) and `kiosk.ts` (uses
  `act.schoolId` from the kiosk activation) pass it through.
- `kiosk.ts /kiosk/activate` is unauthenticated, so it derives
  school from the verified staff record (not `req.schoolId`) and
  stamps `kiosk_activations.school_id` on insert. Origin-room lookup
  is also filtered to the staff's school.

**Post-review hardening (Wave A2.1).**
After the first architect pass, several non-obvious cross-school readers
were closed:
- `routes/issAttendance.ts /iss-attendance/today-periods` now scopes the
  bell-schedule lookup by `req.schoolId` (an ISS dean was previously
  seeing the first active default schedule globally).
- `routes/pbis.ts` cold-period logic scopes the `bellSchedules` query
  by `staff.schoolId`.
- `routes/kiosk.ts /kiosk/hall-passes` resolves origin/destination by
  `(name, act.schoolId)` and checks the allowlist by
  `(schoolId, origin, dest)` — names like "Library" can repeat across
  schools, so name-only lookup was a leak.
- `routes/locations.ts /wire-classrooms-mesh` now requires
  `req.schoolId`, reads classrooms + existing pairs filtered by school,
  and **stamps `school_id` on inserted mesh pairs** (previously inserts
  silently fell through to `DEFAULT 1`).
- `routes/locations.ts` PATCH/DELETE `/locations/:id` now match by
  `(id, schoolId)` so an admin can't mutate another school's row by id.
- DB constraint `pbis_milestones_school_points_unique UNIQUE
  (school_id, points)` replaces the old table-wide
  `pbis_milestones_points_key` — concurrency-safe per-school dup check.

**Tenancy panel (Wave A3).**
- `routes/tenancy.ts` `COUNT_TABLES` extended with `school_settings`,
  `bell_schedules`, `pbis_reasons`, `pbis_milestones`. SuperUsers see
  "1 settings row per school visited" once each school's UI loads.

## Multi-tenancy — Day 5 (April 2026)

D5 closes the cross-school *data* leaks that D4's settings-focused
work didn't cover. Acceptance: an admin or coordinator in school A
cannot read or mutate school B's ISS attendance, PBIS entries,
milestone-email log, or hall-pass limits even with a known row id.

**Drizzle schemas — exposed schoolId on four more tables.** All four
DB tables already had `school_id` from D2 backfill; the ORM was just
unaware:
- `studentHallPassLimits`, `issAttendanceDay`, `issRoster`,
  `pbisMilestoneEmails`.

**Routes.**
- `routes/issAttendance.ts`:
  - `GET /iss-attendance` filters by `req.schoolId` (was day-only).
  - `PUT /iss-attendance/:id` matches by `(id, schoolId)`.
  - `upsertIssAttendance` helper now requires `schoolId` and stamps
    it on insert. Both callers updated: `issRoster` manual add uses
    `req.schoolId`; `pullouts` arrival uses `existing.schoolId` from
    the parent pullout row.
- `routes/pbis.ts`:
  - `PATCH /pbis/:id` and `POST /pbis/:id/void` load + update by
    `(id, staff.schoolId)`.
  - `/pbis/needs-attention` top-heavy `monthEntries` query AND'd on
    `staff.schoolId` (analytics no longer mix schools).
- `routes/pbisMilestones.ts` `/pbis-milestone-emails` filters by
  `staff.schoolId`.
- `routes/studentHallPassLimits.ts`:
  - `countPassesToday(studentId, schoolId)` — caller passes school;
    counts only today's passes at that school.
  - `findDailyLimitConflict` threads schoolId through.
  - `GET /student-hall-pass-limits` filters by `req.schoolId`.
  - `POST /student-hall-pass-limits` stamps `schoolId`; the
    "deactivate prior active row" sweep is also scoped per-school
    so two schools can hold their own active row for the same
    student id.
  - `DELETE /student-hall-pass-limits/:id` matches by
    `(id, schoolId)`.

**Background helper — milestone email pipeline.**
`lib/pbisMilestones.ts` `processMilestonesForStudent(id, schoolId)`
and `processMilestonesForStudents(ids, schoolId)` now take school
explicitly. The helper:
- reads only THIS school's milestones (otherwise points awarded in
  Powell would be checked against Parrott's thresholds),
- reads only THIS school's prior PBIS entries when summing total
  points,
- reads/inserts the email-log row with `school_id` stamped.
Both call sites in `routes/pbis.ts` (single + bulk award) pass
`staff.schoolId`.

**DB unique indexes — relaxed to be school-scoped.** Three indexes
that previously enforced "one row per student id" globally are now
"one row per (student id, school id)":
- `iss_attendance_day_student_day_idx` →
  `(student_id, day, school_id)`. Conflict target on the
  `upsertIssAttendance` insert was updated to match; the manual→pullout
  enrichment update also includes `schoolId` in its WHERE.
- `pbis_milestone_emails_student_pts_unique` →
  `(student_id, milestone_points, school_id)`. Without this, school A
  claiming/sending a student's milestone email silently blocked
  school B from sending its own. All 4 status-update WHEREs in
  `lib/pbisMilestones.ts` (skip-no-roster, skip-no-email, sent, error)
  now include `schoolId`.
- `student_hall_pass_limits_student_active` partial index →
  `(student_id, school_id) WHERE active = true`.
  `getActiveStudentLimit(studentId, schoolId)` was previously
  unscoped (school A's effective limit could be school B's row);
  now school-scoped end-to-end.

**Pullouts → ISS roster.** `routes/pullouts.ts` `/pullouts/:id/arrived`
now stamps `existing.schoolId` on the auto-inserted `iss_roster` row
(was relying on DB DEFAULT 1, mis-tenanting non-Parrott arrivals).

**D5 follow-up (Apr 23 2026).** Closed the deferred display-only
`schoolSettings...limit(1)` readers and the unscoped intervention
oracle:

- `routes/pullouts.ts` `hasRecentIntervention(studentId, schoolId)`
  now AND-filters by school. Both callers (preflight GET uses
  `req.schoolId`; POST uses `staff.schoolId`) updated. Same
  enumeration-oracle pattern that D5 closed on hall-pass limits.
- `lib/pulloutEmail.ts` (3 functions: `sendPulloutArrivalEmail`,
  `sendPulloutReturnEmail`, `sendPulloutDispatchEmail`) — each loads
  the parent pullout first, then uses `p.schoolId` to scope both the
  student lookup and the schoolSettings fetch. Branding/from-name
  now matches the school the pullout belongs to, not whichever
  school sorts first.
- `lib/pbisMilestones.ts` settings read (line 109) — now scoped by
  `schoolId` (already a parameter on `processMilestonesForStudent`).
- `routes/email.ts` `getFromName(schoolId)` — now takes the
  caller's `req.schoolId`.
- `routes/parentEmail.ts` POST `/parent-email/send` — student lookup
  and settings fetch both AND-filter on `staff.schoolId`. The
  audit-log insert into `support_notes` now also stamps
  `schoolId: staff.schoolId` (was relying on DB DEFAULT 1, which
  mis-tenanted every non-Parrott parent-email log). Closes the
  same student-id enumeration oracle pattern on this surface.
- `lib/pulloutEmail.ts` `sendPulloutDispatchEmail` recipient query —
  was selecting all admins/deans/MTSS/ISS staff district-wide;
  now AND-filters `staffTable.schoolId = p.schoolId` so a school A
  pullout's student id, reason, and teacher name are only emailed
  to school A's dispatchers.

**D5 follow-up — daily digest per-school (Apr 23 2026).**
`lib/dailyDigest.ts` was district-wide: a single email mixed every
school's pullouts and went to every dispatcher across the district.
Now refactored to per-school:

- `buildDailyDigest(forDay, schoolId)` — schoolId required; pullouts
  query and unreviewed-closed backlog query both AND-filter by school.
- `sendDailyDigestEmailForSchool(forDay, schoolId)` — sends one
  digest for one school. Recipients are active admin/dean/MTSS
  staff in THAT school. Branding (school name, from-name) comes
  from THAT school's `school_settings` row. Returns
  `DailyDigestResult` with `schoolId` stamped.
- `sendDailyDigestEmail(forDay)` — cron entry point. Loops over
  every row in `schools` and calls the per-school sender. Returns
  `DailyDigestResult[]`. Per-school errors don't kill the loop.
- `index.ts` cron caller — iterates the result array and logs one
  line per school with its `schoolId`, status, recipient count, and
  any error.
- `routes/digest.ts` admin endpoints — `/digest/today` preview and
  `/digest/send-now` both now use the calling admin's
  `staff.schoolId`, so an admin can only preview or fire their own
  school's digest.

Today only school 1 has active dispatchers, so cron will fire once
for school 1 and skip schools 2/3/4/5/36 with "No digest recipients
configured" — exactly the right behavior, and adding a dispatcher
to any other school turns its digest on automatically.

**Verification.** SQL spot-checks confirmed:
- Two schools can each hold an active hall-pass limit, an ISS
  attendance day row, and a milestone-email row for the same
  student id (cross-school dups now permitted).
- Same-school dups still rejected with
  `duplicate key value violates unique constraint
  "student_hall_pass_limits_student_active"
  Key (student_id, school_id)=(D5VERIFY2, 1) already exists`.
- API restarts clean and serves requests.

**Tenant audit follow-up — kiosk hall passes (Apr 23 2026).**
After D5, a broader audit found four cross-school holes in
`routes/kiosk.ts` (the unattended hallway kiosk flow):

- The hall-pass INSERT in `/kiosk/hall-passes` was not stamping
  `school_id`, so every pass issued by a kiosk bound to school 2-36
  was silently being written with the column default of 1
  (mis-tenant write, identical pattern to the parent-email support-
  notes bug fixed earlier). Now stamps `schoolId: act.schoolId` from
  the kiosk activation row.
- The "student already has an active pass" duplicate-check query was
  district-wide. Two schools could legitimately have the same
  student id, so a kiosk at school B would 409 on a student whose
  only open pass lived at school A. Now AND-filtered on
  `act.schoolId`.
- The "I'm back" return-tap query (`/kiosk/hall-passes/return`)
  filtered by `studentId + status='active' + originRoom`. Room labels
  like "Room 102" repeat across schools, so a kiosk at school B
  Room 102 could end school A's open pass. Now AND-filtered on
  `act.schoolId`.
- Both student-name lookups (issuance + return) were keyed on
  `studentId` only, leaking first names across schools — same
  enumeration-oracle pattern. Now AND-filtered on `act.schoolId`.

False positives that were verified safe and left alone:
`accommodationLogs.ts:307` and `locations.ts:217` already stamp
`schoolId` via the spread inside `toInsert.push({...})`;
`kiosk.ts:255` is authenticated by `tokenHash` (not by url id);
`pbisGoals.ts:134` UPDATE-by-id is preceded by a school-scoped
existence check on the same row; `lib/pulloutEmail.ts` "load
pullout by id" calls are internal helpers invoked from already-
scoped routes.

**Tenant audit follow-up — polarity pairs (Apr 23 2026).**
Architect review of the kiosk fixes flagged that
`findPolarityConflict(studentId)` in `routes/polarityPairs.ts` was
still globally scoped — it ran the keep-apart check across every
school's `polarity_pairs` and `hall_passes` rows. With the kiosk
issuance flow now correctly tenant-scoped, this helper became the
last cross-school oracle in the kiosk path: a kiosk at school B
could be told "cannot issue pass: STUDENT X is currently out on
a pass to BATHROOM" purely because some unrelated student id at
school A was paired and out.

Closed it the same way as the rest of D5:

- Exposed `school_id` on `polarityPairsTable` (Drizzle schema; the
  column was already in the DB from the D2 backfill, default 1).
- `findPolarityConflict(studentId, schoolId)` now requires the
  caller to pass `schoolId` and AND-filters every internal query
  (`polarity_pairs`, `hall_passes`, partner-name lookup on
  `students`).
- Updated both call sites: `routes/hallPasses.ts` POST passes
  `schoolId` from `requireSchool(req)`, and the kiosk
  `/kiosk/hall-passes` route passes `act.schoolId` from the
  activation row.
- Scoped the polarity-pairs CRUD too: `GET /polarity-pairs` filters
  pairs and the hydration `students` fetch by school; `POST` stamps
  `schoolId`, validates both student ids exist *at this school*
  (was a global oracle), and dedupes per-school; `DELETE /:id`
  matches by `(id, school_id)`.

**Verification.** SQL spot-check confirmed: a polarity pair inserted
with `school_id=2` is invisible to a `school_id=1` lookup
(0 rows) and visible to a `school_id=2` lookup (1 row). API
restarts clean and serves requests.

**Legacy data.** No remediation needed — all 7,732 historical
`hall_passes` rows and the 1 existing `polarity_pairs` row are
already `school_id=1` (the only active school today), and there
are zero `kiosk_activations` historically, so no kiosk has yet
written a mis-tenanted row.

**Tenant audit follow-up — record_edits, admin_notifications,
hall-pass report (Apr 23 2026).** Architect's third pass found three
more cross-school exposures outside the kiosk surface:

- `GET /api/record-edits` returned the entire global edit log with
  no auth boundary at all, and the matching writer paths in
  `routes/pbis.ts` (`logEdit`) and `routes/hallPasses.ts`
  (PATCH-end edit batch) were not stamping `school_id` on insert.
- `GET /api/admin/notifications` and the matching resolve POST
  showed every kiosk default-room-missing alert across the
  district to any school's admin, and the writer at
  `routes/kiosk.ts` `/kiosk/activations` was not stamping
  `school_id` on insert.
- `GET /api/reports/hall-passes` (Admin/ESE-only daily summary)
  ran a date-only query against `hall_passes` and a
  `studentId`-only `IN (...)` against `students` for name
  hydration, so the admin/ESE report at one school silently
  aggregated every school's passes and merged student names.

Closed all three with the same pattern as the rest of D5:

- Drizzle schemas now expose `school_id` on `recordEditsTable` and
  `adminNotificationsTable` (DB columns were already there from
  D2 backfill, default 1).
- Every INSERT into `record_edits` (`pbis.ts logEdit` — now takes
  `schoolId` parameter and passes it from the route's
  `requireSchool(req)` value at every call site, including void;
  `hallPasses.ts` PATCH edit-batch — stamps `schoolId`) and
  `admin_notifications` (`kiosk.ts` `/kiosk/activations` —
  stamps `staff.schoolId`) now sets `school_id` explicitly.
- `GET /api/record-edits` now requires a signed-in session AND
  AND-filters by `requireSchool(req)`. Both query paths
  (with-recordType-and-id and bare list) are scoped.
- `GET /api/admin/notifications` and POST `/admin/notifications/
  :id/resolve` now AND-filter by `requireSchool(req)`.
- `GET /api/reports/hall-passes` now requires `requireSchool(req)`
  and AND-filters `hall_passes.schoolId` on the day-of query.

**Verification.** SQL spot-check: rows inserted into
`record_edits` and `admin_notifications` with `school_id=2` are
invisible to a `school_id=1` lookup (0 rows) and visible to a
`school_id=2` lookup (1 row). API restarts clean.

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

## Multi-tenancy — DEFAULT 1 safety net dropped (Apr 23 2026)

The DB-level `school_id INTEGER NOT NULL DEFAULT 1` safety net introduced
during D2 backfill is now removed across all 33 tenant-scoped tables. From
this point on, any INSERT path that forgets to stamp `schoolId` fails fast
with a NOT NULL constraint violation instead of silently mis-tenanting
rows to D. S. Parrott (`school_id = 1`) — exactly the failure mode that
masked the kiosk hall_passes / kiosk_activations / parent-email
support_notes / iss_roster bugs we hunted down through D5.

**What changed.**
- Audited every `.insert()` in `artifacts/api-server/src` (52 call sites
  across 33 scoped tables). All route paths already stamp `schoolId`
  correctly (4 architect-validated false positives where `schoolId` is
  spread/array-mapped onto rows: `accommodationLogs.ts:307`,
  `locations.ts:217` mesh insert, `hallPasses.ts:273` `record_edits`,
  `accommodationsAdmin.ts:421`).
- Real gaps were 9 inserts in `artifacts/api-server/src/seed.ts` (the
  boot-time `seedIfEmpty` flow). Added `const SEED_SCHOOL_ID = 1` and
  stamped it on every insert: `staff`, `students`, `classSections`,
  `sectionRoster`, `schoolAccommodations`, `studentAccommodations`,
  `locations` (via `.map((l) => ({ schoolId: SEED_SCHOOL_ID, ...l }))`),
  `locationAllowedDestinations`, `staffDefaults`.
- Dropped `DEFAULT 1` from `school_id` on all 33 tables in a single
  transaction. Verified `information_schema.columns` shows 0 rows with
  a `school_id` default remaining.
- Removed `.notNull().default(1)` → `.notNull()` from all 32 Drizzle
  schema files in `lib/db/src/schema/*.ts` (33 occurrences;
  `pbisMilestones.ts` had two columns) so a future `db:push` cannot
  silently re-apply the defaults. Restored the unrelated
  `pbisReasons.defaultPoints.default(1)` that was bystander-stripped by
  the sed (legitimate non-tenancy default; DB column already has it).

**Smoke test.**
- `INSERT INTO students (student_id, first_name, last_name, grade) VALUES
  (...)` without `school_id` → `ERROR: null value in column "school_id"
  ... violates not-null constraint`. Correct.
- `INSERT INTO students (school_id, ...) VALUES (2, ...)` → success, row
  visible at `school_id = 2`. Correct.

**Tables NOT in scope** (no `school_id`, intentional): `districts`,
`schools`, `custom_roles`, `district_integrations`, `user_sessions`,
`check_in_with_options`, `bell_schedule_periods` (scoped via parent
`bell_schedules.school_id`).

## Multi-tenancy — Pasco County added as 2nd district (Apr 23 2026)

Stood up the second district to actually exercise the silo machinery
end-to-end. Until now Hernando was the only district, so the
silo-per-district + silo-per-school plumbing had never been stressed
against a real second tenant.

**District added.**
- `Pasco County School District` — `id = 37`, `slug = "pasco"`,
  `state_district_code = "51"`, `timezone = America/New_York`.
- 96 schools loaded from the Florida DOE roster (codes ranging from
  `0021` Rodney B. Cox Elementary through `7023` Pasco Virtual
  Instruction Program), all stamped `district_id = 37`, `is_primary
  = false`. Names title-cased from the source spreadsheet (preserving
  `K-8`, `Jr.`, `Dr.`, `O'`, `eSchool`).

**Hernando left untouched.** Still 6 schools at `district_id = 1`
(Parrott=1, Springstead=2, NCT=3, Weeki=4, Powell=5, Test Middle=36).

**Silo smoke test (Apr 23).**
- Inserted a student against a Pasco school_id (`Pasco High School`,
  state code `0031`). Insert succeeded; row's `school_id` resolved to a
  Pasco school via FK join, `district_id = 37`. Rolled back.
- Confirmed: zero rows in `students` where `school_id = 1` (Parrott)
  also belong to a Pasco school. Silo boundary holds.

**What this exposes (intentionally).** Any code path that still assumes
`district_id = 1` will now show wrong-district behavior the first time a
SuperUser switches into a Pasco school. The cross-school sweeps from
D3–D5 only enforced *school* scoping, not *district* scoping. Latent
bugs to expect: any admin/list endpoint that joins through `schools`
without filtering on the actor's `districtId`, any place a SuperUser's
school-switch UI lists *all* schools across districts (it should list
only their district's schools unless they're the one true cross-district
SuperUser).

**Pasco silo is currently empty.** No staff, students, sections, or
settings. SuperUser can switch into any Pasco school via the Tenancy
panel to validate that empty-silo views render cleanly and to start
populating data if needed.

### District-scoping sweep — closing the latent holes (D6, Apr 23 2026)

The cross-school sweeps (D3-D5) only enforced *school* scoping. With
Pasco landed, several SuperUser surfaces were still treating "SuperUser"
as "every school in the database" instead of "every school in the
actor's district". Closed in this batch:

- **`artifacts/api-server/src/lib/scope.ts`** — added two helpers used
  by every district-scoped surface: `getDistrictIdForSchool(schoolId)`
  resolves the actor's district via a single-row lookup on
  `schools.district_id`; `getSchoolIdsForDistrict(districtId)`
  materializes the (small) school-id list for `inArray` filtering.
  Staff has no `district_id` column — district is always derived
  through their `school_id`.

- **`artifacts/api-server/src/routes/tenancy.ts`** —
  `GET /api/tenancy/schools` now district-filters at the SQL level so
  the SuperUser switcher only lists schools in the actor's district.
  `POST /api/tenancy/switch-school` rejects cross-district switches
  with 403 ("Cannot switch into a school in another district") so a
  Hernando SuperUser can't resolve `req.schoolId` to a Pasco school
  for the rest of the session.

- **`artifacts/api-server/src/routes/adminStaff.ts`** — four SuperUser
  surfaces tightened: `GET /admin/staff` (list), `PATCH /admin/staff/:id`
  (target lookup + update WHERE), `POST /admin/staff` (validates the
  target school is in the actor's district), and
  `POST /admin/staff/:id/password`. SuperUser still has district-wide
  reach (the original design intent per old comments), just no longer
  cross-district reach.

- **`artifacts/client/src/components/TenancyPanel.tsx`** — the panel
  was hard-coded to `districts[0]` and would have hidden Pasco from
  the UI entirely. Now iterates every district and renders the
  per-district sections (header, "create school" form, schools table)
  once each. The per-school row-count grid is also filtered to only
  schools that have at least one row — otherwise it would explode to
  100+ columns the moment Pasco was loaded.

- **`artifacts/api-server/src/lib/dailyDigest.ts`** —
  `sendDailyDigestEmail` cron used to iterate every row in `schools`
  and return a "skipped" result for each one with no recipients.
  After Pasco loaded, that meant 96 wasted iterations per weekday
  cron run. Now SQL-pre-filters to schools that have at least one
  active admin/dean/MTSS-coordinator staff and iterates only those.

**Three additional holes caught by post-build review** (same batch):

- **`GET /api/tenancy/status`** was returning every district, every
  school, and per-school row counts unfiltered. That's tenant-metadata
  exposure (not row-level data, but a Hernando SuperUser shouldn't see
  Pasco's name, school list, or counts). Now derives `actorDistrictId`
  and filters districts/schools to that district. Per-table count SQL
  adds `WHERE school_id IN (<district school ids>) OR school_id IS
  NULL`. Orphan rows stay in scope as a system-integrity signal —
  every district admin should see them flagged. Numeric school ids
  come from a trusted DB query, not user input, so the `sql.raw`
  interpolation is safe.

- **`POST /api/tenancy/schools`** accepted any `districtId` in the
  request body and created the school there. A Hernando SuperUser
  could mint a school inside the Pasco silo by submitting
  `{ districtId: 37, ... }`. Now rejects with 403 if `body.districtId`
  doesn't match the actor's home district.

- **`app.ts` request middleware** was honoring
  `staff.activeSchoolOverride` without checking same-district. If a
  pre-D6 cross-district override existed in the DB, it kept resolving
  `req.schoolId` to the wrong-district school until next login.
  Defense-in-depth fix: when an override is present AND the user is
  a SuperUser, look up both the override school's `district_id` and
  the home school's `district_id`, only honor the override if they
  match. Falls back to home school otherwise. Extra DB hops only run
  when an override is actually set (most requests skip them entirely).

**Cleanup:** the `eq(staffTable.id, -1)` no-match fallback used in
`adminStaff.ts` for empty-district-school-list cases was replaced
with `sql\`false\`` for clarity.

**Future escape hatch.** If we ever need a true cross-district
SuperUser (e.g. for Replit-side support), the right shape is a
separate flag — `isCrossDistrictSuperUser` or similar — checked on
top of the existing `isSuperUser`. Deferred until there's a real
caller for it; today every SuperUser belongs to exactly one district
via their home school.

**D6 follow-up #1 — custom-roles district scope.** The
`custom_roles` table is the SuperUser-defined role-preset catalog
(e.g. "Behavior Tech" = `capHallPasses + capHallPassesViewAll +
capPbisAward`). It was previously instance-global, which meant a
Hernando SuperUser editing the catalog also rewrote what Pasco saw,
and the global `UNIQUE(key)` constraint blocked Pasco from creating
a "behavior_tech" preset that already existed in Hernando.

Schema change: added `district_id INTEGER NOT NULL REFERENCES
districts(id) ON DELETE CASCADE` and replaced the global
`UNIQUE(key)` with a composite `UNIQUE(district_id, key)`. Table
was empty so no backfill was required. Drizzle schema updated to
match (`uniqueIndex("custom_roles_district_key_uq")`). The migration
was applied directly because `drizzle-kit push --force` was blocked
on an unrelated interactive prompt (an existing `districts_slug_unique`
constraint that was added earlier but not yet pushed); the next
time someone runs push it'll prompt for that pre-existing drift, not
this change.

Route change (`routes/customRoles.ts`): all four endpoints
(`GET/POST/PATCH/DELETE /api/custom-roles`) now resolve the actor's
district via `getDistrictIdForSchool(actor.schoolId)` through a new
`actorDistrictOr403` helper (returns 403 if the staff row's school
can't be mapped to a district — never silently falls back to "all
districts"). GET filters by `district_id`. POST writes the actor's
`district_id` into the new row (request body `district_id` is
ignored — the client never specifies it). PATCH and DELETE add
`AND district_id = <actor's>` to the WHERE clause; PATCH 404s on
cross-district to avoid id-enumeration leaks, DELETE silently
no-ops to preserve idempotent-delete semantics.

Client (`StaffRolesMatrix.tsx`) needed no changes — the response
shape is unchanged; it just sees a shorter list scoped to the
viewer's district.

**D6 follow-up #2 — TenancyPanel per-district form state.**
The "Create new school" form previously held a single set of refs
(`newName`, `newShort`, `newCode`, `creating`, `createError`,
`createOk`) shared across every rendered district section. With one
district that was fine; once Pasco landed and the panel rendered two
forms, two visible bugs appeared: typing in Hernando's input mirrored
into Pasco's, and submitting against one district painted the
success/error banner under both.

Replaced with per-`districtId` state: `drafts: Record<number,
{name, short, code}>` (populated lazily through a `getDraft` /
`updateDraft` / `clearDraft` trio so an empty district just reads
the shared `emptyDraft`), `creatingDistrictId: number | null`, and
`createMessage: { districtId, kind: "ok" | "err", text } | null`.
The JSX render loop derives `draft`, `isCreating`, and `myMessage`
per district before rendering inputs/button/banner. Submit handler
clears only the affected district's draft on success.

Single-valued `creatingDistrictId` means double-clicking Create in
two districts simultaneously will visually overwrite the "Creating…"
indicator on the first form, but both POSTs still complete
independently and the last response wins the banner. Acceptable
trade-off — onboarding two districts in the same second isn't a real
workflow. Architect review PASSED with no blockers.

**D6 follow-up #3 — school-switcher consistency.** With cross-tenancy
holes closed, an audit turned up a separate class of bug: about half
the routes that touch school-scoped tables were reading
`staff.schoolId` (always the home school) instead of `req.schoolId`
(the active school after middleware resolution). For non-SuperUsers
those are always equal, so nothing was visibly wrong. For SuperUsers
who'd switched into another same-district school, the switcher was
silently ignored — clicking "give a PBIS award" while viewing Pasco
Sunlake from a Hernando SuperUser session still created the entry
under their Hernando home school.

Replaced `staff.schoolId` → `req.schoolId!` in the route handlers of
`pullouts.ts` (5 sites: list / create / by-student / report /
recent-intervention check), `pbis.ts` (~19 sites across leaderboard,
awards, void, home-stats, needs-attention, settings, students, staff,
schedule), `pbisMilestones.ts` (1 site: milestone email log),
`parentEmail.ts` (3 sites: student lookup, school settings, audit
note), and `digest.ts` (2 sites: preview / send-now). The `!`
non-null assertion is safe because every changed call site is
already inside a `requireStaffMW` / `requireAdmin` handler, and the
middleware in `app.ts` guarantees `req.schoolId` is set whenever a
staff session is loaded.

Intentionally NOT changed:

- `kiosk.ts` activation routes — they're unauthenticated (no
  session, no `req.schoolId`); a kiosk's school is intrinsically the
  activating staff member's home school.
- `auth.ts /me` — already returns both `activeSchoolId` and
  `homeSchoolId` so the UI can render the switcher correctly.
- `tenancy.ts` and `app.ts` — those compute the actor's HOME
  district to decide what's in scope; that resolution is intrinsically
  about home, not active.

Architect review PASSED. The verdict noted that because the D6
middleware fix already guarantees `req.schoolId` is same-district
as `staff.schoolId`, swapping one for the other can't introduce a
cross-tenancy leak even theoretically — this change is purely a UX
correctness pass on top of an already-secure foundation.

**Silo migration: complete.** D1–D5 covered the schema columns,
route filtering, UI scoping, SuperUser permissions, and cross-school
sweeps. D6 closed the latent holes that surfaced once Pasco landed
as the second district (8 server endpoints, schema for
`custom_roles`, the request middleware override-school district
check, the TenancyPanel iteration + per-district form state, and
this final school-switcher consistency pass). The system is now
silo-per-district with no documented follow-ups remaining. Two
deferred items, only build them when a real caller appears: a
test harness for the api-server (the architect suggested regression
coverage for tenancy routes; no test framework exists yet — would
be the natural cap once a real caller appears for these tests).

---

## Multi-school dev seed (2026-04-23, late session)

The dev DB is now seeded with realistic multi-school data so the
contracted AWS engineer (who is sizing the AWS backend wiring + CIO
review documentation, not taking over the project) can evaluate the
end-to-end flow.

**Totals:** 396 staff, 9,750 students, 2,730 class sections, 68,250
roster rows, 98 master accommodations (14 per school), 8,112 student
accommodation assignments, 105 locations, 7 bell schedules with 49
periods, 7 school_settings rows.

**Per school:**

| id  | school                              | teachers | students | sections | admin (besides SuperUsers) |
|-----|-------------------------------------|---------:|---------:|---------:|----------------------------|
| 1   | D. S. Parrott Middle School         | 35       | 875      | 245      | Chris Clifford (also Super) |
| 2   | F. W. Springstead High School       | 80       | 2,000    | 560      | Brandon Wright (also Super) |
| 3   | Nature Coast Technical High School  | 60       | 1,500    | 420      | Brad Merschbach            |
| 4   | Weeki Wachee High School            | 65       | 1,625    | 455      | Ed LaRose                  |
| 5   | Powell Middle School                | 55       | 1,375    | 385      | Alex Rastatter             |
| 36  | Test Middle School                  | 35       | 875      | 245      | Luke Skywalker             |
| 220 | Cypress Creek High School (Pasco)   | 60       | 1,500    | 420      | (none — SuperUser only)    |

**Email convention.** All seeded staff use `@hcsb.k12.fl.us`.
Chris and Brandon were renamed from `@school.local` to
`chris.clifford@hcsb.k12.fl.us` and `brandon.wright@hcsb.k12.fl.us`
(IDs 83 and 84 preserved, passwords unchanged: `@Leopards` and
`@GoEagles`). All other generated staff (teachers + 4 named admins)
share the temporary password `PulseDemo!` (bcrypt cost 10) — they
should rotate via Profile on first login.

**Schedule.** Every school has the same 7-period bell schedule,
07:30–14:00, ~47 min periods with 5 min passing and a 35 min lunch
between P5 (ends 11:45) and P6 (starts 12:20). Each teacher has 1
planning period; planning periods are evenly distributed across the
7 periods so each non-planning period has roughly equal teaching
capacity. Students are round-robin assigned so each non-planning
section holds ~25 students.

**Accommodations rule.** 25 % of students are accommodated. Each
accommodated student is assigned EITHER an IEP base OR a 504 base
(never both), drawing 2–4 items from the 7 IEP / 4 504 master
strategies. There is then a 30 % chance to add 1–2 ELL items on top,
capped at 4 total. The "Strategy" category is intentionally not used
at the per-student level (it stays as a school-level master list
only).

**Globally-unique field workarounds.** Three columns still have a
global unique constraint that pre-dates the silo migration; the
seed prefixes values to avoid cross-school collisions, and these
prefixes are the canonical convention until those columns are
relaxed to per-school uniqueness:

- `students.student_id` — prefixed `S{schoolId}-{n}`, e.g. `S1-2000`,
  `S220-2000`.
- `locations.name` — prefixed with the school short name, e.g.
  `Parrott Room 101`, `CCHS Library`. (The schema comment on
  `locations.name` flags this as a known item.)
- `staff.email` — generated emails embed a global teacher sequence
  number (`sarah.rivera117@hcsb.k12.fl.us`) so two schools that
  happen to pick the same first/last pair never collide.

**Schema fix during seeding.** The DB had a stale global partial
unique index `bell_schedules_one_default_idx` from before the silo
migration that allowed only ONE `is_default = true` row in the
entire table — it would have blocked any second school from having
a default bell schedule and was not declared in `bellSchedules.ts`.
Dev was patched in place with:

```sql
DROP INDEX IF EXISTS bell_schedules_one_default_idx;
CREATE UNIQUE INDEX bell_schedules_school_default_idx
  ON bell_schedules (school_id) WHERE is_default = true;
```

The matching `uniqueIndex` declaration is now in
`lib/db/src/schema/bellSchedules.ts` so future `db push` runs do not
re-add the global index.

**⚠ Prod still has the old index** — it was created by the earlier
`db push` runs that built the prod tables, and `drizzle-kit push`
cannot be relied on to drop a legacy index that is no longer
declared. Before the next prod deploy uses bell schedules at all,
run the same two statements above against the prod DB (psql via the
deployed Postgres connection string). Verify after with
`SELECT indexname FROM pg_indexes WHERE tablename='bell_schedules';`
— only `bell_schedules_pkey`, `bell_schedules_school_id_idx`, and
`bell_schedules_school_default_idx` should remain.

**How the seed was applied.** Ad-hoc Node.js script in the code
sandbox (no committed file) using the workspace's `pg` install at
`node_modules/.pnpm/pg@8.20.0/...` and `bcryptjs@3.0.3`. Connection
string `postgresql://postgres:password@helium/heliumdb?sslmode=disable`
(env shows `PGPASSWORD=password`, not `postgres`). The same script
can be re-run safely — it wipes everything except `staff` IDs 83/84
and the static config tables (`schools`, `districts`, `custom_roles`,
`pbis_reasons`, `pullout_reasons`, `intervention_types`,
`polarity_pairs`, `trusted_adult_interventions`,
`district_integrations`) before re-inserting.

## MTSS Plans v1 (2026-04-24)

First slice of the MTSS Intervention Plan system. The Invisible Student
Finder and Teacher Roster page (both spec'd, on hold) will read from
this table.

**Schema.** `lib/db/src/schema/studentMtssPlans.ts` →
`student_mtss_plans` table (id, schoolId, studentId text, title, goals,
tier default 2, pointRangeMin/Max, notes, openedAt/By, closedAt/By,
created/updated). Indexes on `school_id` and `(school_id, student_id)`.
No FK constraint on student_id (matches codebase convention — JS-side
joins, AND-school filter).

**Goals format.** The `goals` column is a single text field, but the
client and server treat it as a **newline-delimited list of 1–5 goals**
(cap 800 chars per goal). `splitGoals` / `joinGoals` in
`MtssPlansAdmin.tsx` and `normalizeGoals` in `routes/mtssPlans.ts` keep
the two sides in sync — both trim, drop empty lines, slice to 5, and
clamp each line. The modal renders 1–5 numbered slots with "+ Add
another goal" (gated at 5) and a per-row remove button; removing the
last row resets to one empty input. The list view renders an `<ol>`
clamped to 3 visible lines. Legacy single-line plans parse cleanly as
a single goal — no migration needed.

**DDL on boot, not via drizzle-kit.** `drizzle-kit push` refuses to
apply this table non-interactively because rename detection confuses it
with legacy `user_sessions` / `check_in_with_options`. Instead, the
table is created idempotently at boot by `ensureMtssPlansSchema()` in
`seed.ts`, which is called from `seedMtssPlansIfEmpty()`. Mirrors the
"always-run schema fix" pattern already used for the bell_schedules
index. Fresh prod deploys self-heal — no manual SQL needed.

**Routes.** `artifacts/api-server/src/routes/mtssPlans.ts`:
- `GET /api/mtss-plans?status=active|closed|all&studentId=...`
- `POST /api/mtss-plans`
- `PATCH /api/mtss-plans/:id` — pass `{closed: true}` to close,
  `{closed: false}` to reopen
- `DELETE /api/mtss-plans/:id`

**Authz — "core team" gate on BOTH read and write.** Allowed:
SuperUser, Admin, BehaviorSpecialist, MtssCoordinator, PbisCoordinator.
Plain teachers get 403. Read is gated the same as write because plans
contain protected intervention notes; a broader read-only view for
classroom teachers can be added later if needed. Mirror flag on the
client is `canManageMtssPlans` in App.tsx — keep both in sync.

**Seed.** `seedMtssPlansIfEmpty()` is idempotent per-school: skips any
school that already has at least one plan. For each empty school it
seeds 20% of the roster with a placeholder Tier-2 plan, attributed to
"System Seed" so coordinators can tell them from real plans. Runs at
boot AFTER `seedIfEmpty()`. Verified: 1,950 plans across 7 dev schools
(175/400/300/325/275/175/300).

**UI.** `artifacts/client/src/components/MtssPlansAdmin.tsx`. Reachable
from two places (no sidebar entry — hub-tile only, like
`schoolStoreManage`):
- BS hub tile "MTSS Plans" (teal)
- MTSS Coordinator hub tile "MTSS Plans" (teal, first tile)

Single-screen list with status filter (active/closed/all), free-text
search across student name/ID/title, +New Plan button, per-row
edit/close/reopen/delete. Modal allows multiple active plans per
student (soft warning, not blocked).

**Open follow-ups (not blocking).**
- Concurrent boot seeding could double-seed if scaled horizontally.
  Single-instance deploy today, so not addressed.
- Sub-level cut points for the FAST PM pills (1.1/1.2/1.3, 2.1/2.2)
  still pending from user — only affects the Teacher Roster pill label,
  not anything in this slice.

## Where we paused (end of session, 2026-04-23)

Migration is done, app is published, but production is unusable
until the prod database is seeded. Picking up tomorrow needs all of
the following context.

**What's deployed.** The publish flow ran twice tonight — both
succeeded. The production environment is live at the user's
`.replit.app` URL (the user can find it in the Deployments pane;
not recorded here on purpose). The build copies code only, not data;
the production database is a brand-new, empty Postgres with all
tables created by `db push` but zero rows in `staff`, `schools`,
`districts`, etc. Logging into the live site fails not because of a
bug but because there is literally nothing to log into. The user
hit this and was confused — explanation in chat history.

## Production seed wired into boot (2026-04-24)

**`artifacts/api-server/src/seed.ts` was rewritten** so the same
multi-school dataset that lives in dev gets produced automatically
on the first prod boot. The two boot-time hooks are unchanged in
shape (`seedTenancy()` + `seedIfEmpty()` from `index.ts` →
`Promise.all`) but their bodies now do:

- `seedTenancy()`: idempotent. Inserts Hernando + Pasco districts
  and all 7 schools (Parrott, Springstead, Nature Coast, Weeki
  Wachee, Powell, Test Middle, Cypress Creek). Safe to re-run.
- `seedIfEmpty()`: marker-guarded on `school_accommodations`. Only
  runs when that table is empty (so dev — which already has 98
  rows — is unaffected). When it does run it:
  1. Drops the legacy `bell_schedules_one_default_idx` and creates
     the per-school `bell_schedules_school_default_idx`. This is the
     same DDL fix dev got patched with manually — baking it into the
     seed makes prod self-correcting.
  2. Wipes every per-school table (in dependency order, including
     bell schedules, school settings, hall pass limits, pullouts,
     ISS, interventions).
  3. For each of the 7 schools, generates: 55 teachers + optional
     SuperUser + optional named admin, 1390 students, 7 sections per
     teacher (one is planning), full roster, 14 master accommodations
     (IEP/504/ELL only — Strategy was excluded), per-student
     accommodation assignments (25% accommodated, IEP-OR-504 base of
     2-4, 30% chance to add 1-2 ELL on top, capped at 4), 15
     locations (school-prefixed names so they're globally unique),
     a 7-period bell schedule (7:30am-2:00pm with lunch between P5
     and P6), and a `school_settings` row.
  4. Resets the `students` and `staff` sequences.

Logins it produces in prod (same as dev):
- `chris.clifford@hcsb.k12.fl.us` / `@Leopards` (SuperUser, Parrott)
- `brandon.wright@hcsb.k12.fl.us` / `@GoEagles` (SuperUser, Springstead)
- `brad.merschbach@hcsb.k12.fl.us` / `PulseDemo!` (Admin, Nature Coast)
- `ed.larose@hcsb.k12.fl.us` / `PulseDemo!` (Admin, Weeki Wachee)
- `alex.rastatter@hcsb.k12.fl.us` / `PulseDemo!` (Admin, Powell)
- `luke.skywalker@hcsb.k12.fl.us` / `PulseDemo!` (Admin, Test Middle)
- All 385 generated teachers: `<first>.<last><N>@hcsb.k12.fl.us` /
  `PulseDemo!` (N is a global counter so emails are unique)

**Prod IDs will differ from dev.** Dev has school IDs 1-5, 36, 220
(historical accidents). Prod will assign 1-7 in `SCHOOL_SPECS`
order. The UI never exposes school IDs to principals so this is
cosmetic, but is worth knowing if you debug by ID in prod.

**Re-seeding prod.** The marker is "is `school_accommodations`
empty?" — so to force a reseed in prod, run
`TRUNCATE school_accommodations` against the prod DB (read-only
query tool can't do this; you'd need direct psql access via the
deployment's connection string). On the next app restart the seed
fires again. Don't truncate while principals are mid-session.

**Dev DB state, end of session.** Two SuperUser accounts, both with
known passwords (set this session, in chat history; both should be
rotated by the user via the Profile page on next login):

| id | email                          | display_name    | school_id | is_admin | is_super_user | password   |
|----|--------------------------------|-----------------|-----------|----------|---------------|------------|
| 83 | chris.clifford@school.local    | Chris Clifford  | 1 (Parrott)     | t  | **t** | `@Leopards` |
| 84 | brandon.wright@school.local    | Brandon Wright  | 2 (Springstead) | t  | **t** | `@GoEagles` |

Bcrypt cost 10 (matches `auth.ts` and `change-password.ts`); reset
via direct UPDATE using bcryptjs from
`node_modules/.pnpm/bcryptjs@3.0.3/...` (the workspace package is
`bcryptjs`, not `bcrypt` — `import('bcrypt')` from the code
sandbox throws ERR_MODULE_NOT_FOUND).

**Two open decisions waiting on the user.** Do not act on these
without confirmation — both were explicitly raised at end of
session and the user replied "let's rest":

1. **Drop Brandon's `is_super_user` flag.** The user's stated mental
   model is "Brandon will be the *admin* on Springstead, I'll be the
   sole Hernando SuperUser." Brandon currently still has
   `is_super_user = true` (carried over from before this session;
   only his school_id, is_admin, password, and active_school_override
   were touched). If the user confirms, run
   `UPDATE staff SET is_super_user = false WHERE id = 84;` That
   leaves him as a school-scoped admin at Springstead.
2. **Seed production.** Prod has none of: districts (Hernando=1,
   Pasco=37), Hernando schools (Parrott=1, Springstead=2, NCT=3,
   Weeki=4, Powell=5, Test Middle=36), or staff. Decide with the
   user: (a) mirror dev exactly (same emails, same school IDs,
   same passwords — fastest, but `@school.local` emails are obvious
   placeholders); (b) seed with real `@hernandoschools.org`-style
   emails and a fresh starter password; (c) seed Hernando only and
   defer Pasco's 96 schools until ready to onboard them with real
   data. The user has not chosen. Pasco's school list isn't in dev
   either — D6 set up the *district* row but no schools were ever
   imported, so seeding Pasco for prod still requires their actual
   school roster (CSV / SIS export / Florida DOE list).

**Next session, start by asking:**

1. "Do you want me to drop Brandon's SuperUser flag so he's the
   Springstead admin only and you're the sole Hernando SuperUser?"
2. "How do you want me to seed production — same setup as dev, or
   do you want to use real district email domains and start with a
   fresh password? And do you have Pasco's school list yet, or
   should we seed Hernando only for now?"

Then act on the answers and the production deploy is actually
useful. Until then, the live URL exists but no one can log in.
require setting up vitest + supertest + a test database strategy),
and an `isCrossDistrictSuperUser` flag for a Replit-side support
persona that needs to move between districts.

## Teacher Roster v1 (2026-04-24)

**What shipped.** A new "Teacher Roster" page that lists each teacher's
students with their FAST PM1/PM2/PM3 scores rendered as colored
sub-level pills, a bucket icon showing how many points away the
student is from the next achievement level, and a Bottom Quartile (BQ)
flag based on the student's prior-year final scale score.

**Schema.** New `student_fast_scores` table (`lib/db/src/schema/
studentFastScores.ts`):

- `(id, schoolId, studentId text, subject 'ela'|'math', pm1, pm2, pm3,
  priorYearScore, priorYearBq, timestamps)`
- `UNIQUE(schoolId, studentId, subject)` — CSV import (deferred) will
  upsert on this key.
- Boot-time `ensureFastScoresSchema()` self-creates the table with
  `CREATE TABLE IF NOT EXISTS` (same workaround as MTSS plans — drizzle
  push is non-interactive and gets confused by legacy renames).
- Re-exported from `lib/db/src/schema/index.ts`.

**Cut-score chart + helpers.** `artifacts/api-server/src/lib/
fastCutScores.ts` encodes:

- ELA Table 6 grades 3-10 (full L1/L2 sub-bands + L3/L4/L5).
- Math Table 8 grades 3-8 only. Algebra 1 / Geometry are deliberately
  NOT in v1 — students taking those courses just won't have a Math
  chart, and the bucket icon is suppressed.
- `placeOnChart(score, subject, grade)` → `{level, subLevel}`.
- `placePm3(score, subject, currentGrade)` → uses the **prior-grade**
  chart (so PM3 represents end-of-prior-year mastery). Falls back to
  current grade for 3rd graders (no prior).
- `bucketTarget(subject, currentGrade, level)` → next-level min on the
  current-grade chart, or `null` for L5 / grade 3 / no-chart subjects.
- `bucketColor(gap)` → green ≤ 0, orange 1-5, red > 5.
- `bucketFor(pm3, subject, grade)` → one-shot `{targetScore, gap, color}`
  used by the API.

**Placeholder seed.** `seedFastScoresIfEmpty()` in `seed.ts`:

- Per student per subject, picks a "true level" with a middle-skewed
  weighted distribution (20% L1 / 35% L2 / 25% L3 / 15% L4 / 5% L5),
  then generates PM1/PM2/PM3 with mild positive drift to mimic
  learning gains. Prior-year score is generated on the prior-grade
  chart at the same level. BQ flag probability is 85% at L1, 45% at
  L2, 5% otherwise (yields ~25% BQ overall).
- Idempotent per school (same skip-if-non-empty pattern as MTSS plans).
- Math rows skipped for grades 9-10 (no chart).
- First boot seeded ~9,600 rows across 7 schools.

**API.** `routes/teacherRoster.ts`:

- `GET /api/teacher-roster?teacherId=&period=` — returns enriched
  rows with placement + bucket computed server-side.
  - No `teacherId` → caller's own roster.
  - `teacherId` ≠ caller → core-team gate (admin / superuser / ESE /
    behavior specialist / MTSS coordinator). Mirrors the
    schedule.ts `?all=1` gate.
  - Optional `period` filter; response always includes
    `availablePeriods` so the client can render the period chip row
    even when the current filter is empty.
- `GET /api/teacher-roster/teachers` — picker source. Plain teachers
  get a single-entry list (themselves); core-team members get every
  staff in their school who teaches at least one section.
- Mounted in `routes/index.ts` after `mtssPlansRouter`.

**Client.** `artifacts/client/src/components/TeacherRosterPage.tsx`:

- Mirrors the MtssPlansAdmin pattern (component file under `components/`,
  authFetch, local state, no global store).
- Teacher picker (core team only) + period chip row + legend +
  summary line + table (Student | Grade | ELA | Math | BQ).
- Each subject cell renders 3 PM pills (PM1/PM2/PM3) with the
  sub-level shown on the pill, color-coded by level (red/orange/yellow/
  green/blue), plus a circular bucket icon (green ✓ at-or-above target,
  otherwise the gap value in orange or red).
- Hover tooltips on every pill explain "PM• Level x.y • Scale score N".
- BQ column shows red `BQ ELA` / `BQ Math` chips (only when the
  prior-year flag is set).
- Wired into App.tsx in three places: sidebar nav (visible to everyone),
  BS hub tile, MTSS hub tile. `activeSection: "teacherRoster"`.

**Scope rules (the four rules the user confirmed at the start of the
session).**

1. Seed placeholder FAST scores now; CSV import in Settings is a
   deliberate follow-on (deferred).
2. Teachers see their own roster; core team (Admin / SuperUser / ESE /
   BS / MTSS) can pick any teacher.
3. BQ is the Bottom Quartile based on prior-year final scale score
   (not a current-year computation).
4. For 3rd graders and for Algebra 1 / Geometry students, the bucket
   icon is hidden and only the level pill renders. (3rd graders have
   no prior-grade chart; Algebra/Geometry have no chart at all.)

**Deferred follow-on: CSV import.** Settings → "FAST Scores" with a
file picker that upserts `student_fast_scores` on
`(schoolId, studentId, subject)`. CSV columns expected to be at least
`student_id, subject, pm1, pm2, pm3, prior_year_score`. Not built yet.

---

## Per-school feature toggles (two-tier model)

Six top-level features have per-school on/off switches behind a
two-tier model: a SuperUser-level "allowed" flag (the billing /
availability gate) and an admin-level "enabled" flag (the school's
day-to-day on/off). A feature is **effective** when both are ON.

**Schema (`school_settings`).** Twelve booleans, all
`NOT NULL DEFAULT TRUE` so existing schools keep current behavior:

- `feature_family_comm` / `super_feature_family_comm`
- `feature_pbis` / `super_feature_pbis`
- `feature_school_store` / `super_feature_school_store`
- `feature_accommodations` / `super_feature_accommodations`
- `feature_log_intervention` / `super_feature_log_intervention`
- `feature_request_pullout` / `super_feature_request_pullout`

Added at boot via `ensureSchoolSettingsFeatureFlagsSchema()` in
`seed.ts` using `ALTER TABLE … ADD COLUMN IF NOT EXISTS … DEFAULT TRUE`,
wired into the existing `seedFastScoresIfEmpty` boot chain. Idempotent —
safe on every restart, and back-fills existing rows to TRUE.

**API (`routes/schoolSettings.ts`).**

- `FEATURE_KEYS` central list keeps GET, PUT, and the derived map in
  sync.
- GET `/api/school-settings` returns the row plus
  `effectiveFeatures: { FamilyComm, Pbis, SchoolStore, Accommodations,
  LogIntervention, RequestPullout }` where each value is
  `super_* && feature_*`.
- PUT `/api/school-settings` accepts `featureX` (admin or SuperUser)
  and `superFeatureX` (SuperUser only). Returns 403 if a non-SuperUser
  tries to flip a `super_*` flag, or if an admin tries to enable a
  `feature_*` whose `super_*` counterpart is currently false (and not
  also being flipped on in the same payload). Server-side teeth behind
  the locked-checkbox UX.

**Client.**

- `schoolSettings` state (App.tsx) carries all 12 fields; load + save
  round-trip them. Defaults to true so the first paint matches the
  server for every existing school.
- New `effectiveFeatures` computed near `baseNavSections` and used to:
  - filter the six gated sidebar entries (`student`,
    `pbis`, `schoolStore`, `accommodations`, `logIntervention`,
    `requestPullout`); Hall Passes / Tardy Pass / Teacher Roster are
    never gated.
  - hide the `schoolStoreManage` tile in the PBIS, BS, and MTSS hubs
    when SchoolStore is off. (The PBIS Hub previously had a separate
    `pbisStore` placeholder tile; that was retired in favor of pointing
    all three hubs at the same `schoolStoreManage` view, since the
    rewards catalog is school-wide rather than PBIS-only.)
  - hide the `logIntervention` tile in the BS hub when LogIntervention
    is off.
- New "School Features" tile in `SettingsHub` (admin + SuperUser),
  `SettingsTileId = "schoolFeatures"`. Panel renders one row per
  feature: admin sees a single checkbox (locked + greyed when
  `super_* = false`, with a "Disabled by your district SuperUser"
  tooltip); SuperUser sees both Allowed and Enabled checkboxes.
  Subtitle on the tile shows `<live>/6 live` at a glance.

**Out of scope (intentional).** Verify Pullouts has **no** dependency
on Request Pullouts here. The user explicitly kept them separate: a
school could turn off teacher-driven pullout requests while still
verifying pullouts created by other paths. If we ever want to gate
Verify Pullouts too, add a 7th `feature_verify_pullout` /
`super_feature_verify_pullout` pair and another `effectiveFeatures`
entry — do not piggy-back on `RequestPullout`.

### Cross-school SuperUser admin (shipped May 3, 2026)

**Expanded catalog.** The 6 original feature pairs were extended to 18.
Twelve new pairs added in `school_settings` (defaults TRUE; idempotent
ALTER at boot in `ensureSchoolSettingsFeatureFlagsSchema`):
HallPasses, TardyPass, MtssPlans, BehaviorSpecialist, IssDashboard,
Displays, BellSchedule, EarlyWarning, Academics, DataImports, Houses,
ParentPortal. The same names appear in `FEATURE_KEYS` in
`routes/schoolSettings.ts` and the client `effectiveFeatures` map in
`App.tsx`. Adding a new feature = add a column + add the key to
`FEATURE_KEYS` + add it to the client map.

**Tier presets.** New `tier_presets` table (`id`, `name`,
`description`, `is_built_in`, `feature_keys` JSONB). Three built-in
presets seeded at boot in `ensureTierPresetsSchema`:

- Basic — HallPasses, TardyPass, FamilyComm, Pbis
- Pro — Basic + SchoolStore, Accommodations, MTSS Plans, ISS
  Dashboard, Displays, Houses, BellSchedule, ParentPortal,
  LogIntervention, RequestPullout
- Enterprise — every feature

Built-in rows are flagged read-only for name/description; SuperUsers
can still rebalance their feature_keys array. `school_settings.tier_preset_id`
is an advisory pointer to the last-applied preset (cleared whenever
any flag is hand-toggled, since the school no longer matches exactly).

**SuperUser routes.** SuperUser-only, mounted in `routes/index.ts`:

- `routes/schoolPlans.ts` — `GET /api/superuser/school-plans` returns
  every school × every flag in one payload; `PATCH /:schoolId` sets
  one or more `super_feature_*` columns; `POST /:schoolId/apply-preset`
  bulk-sets every super flag from the preset's `featureKeys`.
- `routes/tierPresets.ts` — full CRUD on tier presets. Built-ins
  protected from delete + name/description edit.

**SchoolPlansAdminPage.** New SuperUser-only settings tile
(`SettingsTileId = "school-plans"`) renders a sticky-header table:
rows = schools, cols = features. Each cell shows a check toggle. Per
row a "Apply preset" dropdown bulk-sets every super flag from a
chosen preset. Cell colors: green = available + admin enabled (live),
yellow = available but admin turned off, gray = not in plan. Tab-2
of the page is the preset editor (built-in pills + new-preset form).
Flipping super off propagates instantly because the same column the
admin's `effectiveFeatures` map reads from is what the SuperUser
just wrote.

---

## HeartBEAT Snapshot — Parent Portal v1 (shipped Apr 24, 2026)

Parents log into a separate portal to see their student's HeartBEAT
data (PBIS, hall passes, tardies, accommodations, staff notes). Admin
sends invites from Settings → Parent Access; parent clicks the email
link, sets a password, sees their kid.

**Decisions made (don't re-ask):**
1. Parents only in v1. Students later via ClassLink (deferred).
2. Email + self-set password. Invite link is the bootstrap.
3. Linking is admin-driven: admin uploads parent emails on the student
   roster (or types them inline in Parent Access), parent accepts the
   invite — that creates the `parents` row and the `parent_students`
   link. **Never written back to `students` table.**
4. Per-row email override + "+ Add another email" button supports
   mom/dad/grandma — each adult gets their own invite for the same
   student; all of them land on the same Snapshot when accepted.
5. Sibling switcher lives in the dashboard header (reads `parent_students`).
6. Section visibility is gated by `school_heartbeat_settings`.

**DB tables (migration: `pnpm db:push --force` already run):**
- `parents` — id, email, passwordHash, displayName, schoolId
- `parent_students` — M:N (parentId, studentId)
- `parent_invites` — id, schoolId, studentId, email, token, status
  (pending/accepted/expired/revoked), sentAt, expiresAt, acceptedAt,
  acceptedParentId, resendCount, sentByStaffId
- `school_heartbeat_settings` — per-school visibility flags for each
  Snapshot section
- `parent_heartbeat_prefs` — per-parent saved toggles (used later by
  HeartBEAT Report PDF)

**Backend routes:**
- `artifacts/api-server/src/routes/parentAuth.ts` — login, me, logout,
  accept-invite, change-password, request-password-reset. Session key
  is `req.session.parentId` (separate from staff `staffId`). Bearer
  token variant for iframe stored in sessionStorage `pulseed.parentToken`.
- `artifacts/api-server/src/routes/parentInvites.ts` — admin endpoints:
  - `GET /api/admin/parent-invites` — one row per student, with **all**
    invites for that student (latest-first) so multi-parent shows up.
  - `POST /api/admin/parent-invites/send` — bulk send to every eligible
    student (uses `students.parent_email`).
  - `POST /api/admin/parent-invites/send-one` `{studentId, email}` —
    single send with email override; powers the per-row form and the
    "+ Add another email" button.
  - `POST /api/admin/parent-invites/:id/resend` and `/revoke`.
- `artifacts/api-server/src/routes/parentSnapshot.ts` —
  `GET /api/parent/snapshot?studentId=…` returns identity, PBIS (with
  sparkline + week stats), hall passes, tardies, accommodations, staff
  notes. Each section is gated by `school_heartbeat_settings`.
- `artifacts/api-server/src/lib/parentInviteEmail.ts` — Resend wrapper
  with branded subject/body using school name + signature.

**Frontend:**
- `artifacts/client/src/parent/` — standalone parent app:
  - `ParentApp.tsx` — path-based router (login / accept-invite /
    forgot / reset / dashboard). No staff sidebar.
  - `api.ts` — `parentFetch()` + redirect-on-401.
  - `ParentLogin.tsx`, `AcceptInvite.tsx`, `Dashboard.tsx`
    (real-data port of the Snapshot mockup, sibling switcher in header).
- `artifacts/client/src/main.tsx` — `path.includes("/parent")` →
  `ParentApp` (else `App` for staff, `/kiosk` → `Kiosk`).
- `artifacts/client/src/components/ParentAccess.tsx` — the admin tile
  (Settings → 👪 Parent Access). Per-student card: name + grade,
  status pill, list of invites with Resend/Revoke per email, inline
  "Send invite" form (pre-fills with Skyward parent_email if no
  invite yet), "+ Add another email" for multi-parent.
- `artifacts/client/src/components/SettingsHub.tsx` — added
  `"parent-access"` to `SettingsTileId`.

**Tailwind wiring (important):** parent components use Tailwind
utilities; staff app does NOT. Resolved with a top-of-file import in
`artifacts/client/src/index.css`:
```css
@import "tailwindcss/theme.css";
@import "tailwindcss/utilities.css";
```
**Preflight is intentionally NOT imported** — that would clobber the
staff app's existing custom CSS. Verified parent login + staff app both
render correctly.

**Deferred (revisit later):**
1. ClassLink SSO for students.
2. ~~School-level "available sections" admin toggle UI~~ — DONE Apr 26.
3. ~~Per-parent toggle UI for what's in their HeartBEAT Report~~ —
   DONE Apr 26 (see "Parent Portal Sections — per-parent toggle UI"
   block below).
4. ~~PDF export of the HeartBEAT Report~~ — DONE Apr 26 (see
   "HeartBEAT PDF export" block below).
5. ~~Optional weekly emailed PDF~~ — DONE Apr 26 (see "HeartBEAT
   weekly email" block below).

**Mockup files (do not delete — referenced when iterating):**
- `artifacts/mockup-sandbox/src/components/mockups/heartbeat/Snapshot.tsx`
- `artifacts/mockup-sandbox/src/components/mockups/heartbeat/ReportToggle.tsx`

**Pending reminders (surface at the gated moment, don't act early):**
- *After item #7 in this list ships:* ask the user about adding view
  features for the uploaded data (browse/filter/inspect what's been
  imported). Captured Apr 26, 2026. Do NOT bring this up before #7 is
  closed — the user explicitly gated it. Once #7 is marked done, prompt
  the user with: "You wanted to revisit view features for uploaded data
  after #7 — ready to scope that now?"
- *Search-box → combobox sweep (captured Apr 30, 2026, NOT part of any
  active build):* the user wants a dedicated pass to convert every plain
  search/filter input across the app into a typeahead combobox (input
  + dropdown of matching options, keyboard-navigable, click-to-select).
  Surface this when the user finishes their current build OR explicitly
  asks "what was that combobox thing I asked you to remind me about?"
  Don't act until the user opens the door — they explicitly said it is
  not part of the current build.

## Displays: HeartBEAT toggle (shipped Apr 30, 2026)

The school-wide HeartBEAT screen at `/signage/heartbeat`
(`artifacts/client/src/signage/HeartbeatSignage.tsx` — red/green mood
slider, live activity ticker for passes/tardies/PBIS/etc., already
school-scoped via `?schoolId=N`) is now exposed as a third toggle
inside the Signage Displays playlist editor, mirroring the existing
"Show PBIS Houses slide each loop" and "Show Active Hall Passes slide
each loop" controls.

- Schema: new `display_playlists.show_heartbeat` boolean column
  (`NOT NULL DEFAULT false`) added to
  `lib/db/src/schema/displayPlaylists.ts`.
- Server (`artifacts/api-server/src/routes/displays.ts`): the field
  is read in the playlists list SELECT, accepted in PATCH (same shape
  as the other two booleans), and surfaced on the public playlist
  endpoint. The public endpoint also now returns `playlist.schoolId`
  so the cycler can build the per-school iframe URL — that field was
  already on the row, just not previously exposed.
- Client editor (`Displays.tsx` PlaylistEditor): third checkbox
  appended after "Show Active Hall Passes" with label "Show Today's
  Heartbeat slide each loop". Patches via the same `patchPlaylist`
  helper.
- Client cycler (`DisplayShow.tsx`): new `Slide` variant
  `{ kind: "heartbeat"; schoolId }` injected after the house and
  passes slides. Renders as a sandboxed iframe at
  `/signage/heartbeat?schoolId=N`; advances on the playlist's default
  duration (floored to 15s so visitors have time to read at least one
  row). The heartbeat page polls `/api/pulse/*` for itself, so we do
  not fetch heartbeat data server-side for the playlist response.
- Auth model is unchanged: same `cap_manage_displays` capability for
  the editor; no auth on the public cycler path.

## Parked: Bathroom Queue (kiosk station)

User wants a kiosk-style "bathroom queue" tied to the existing kiosk
system. While a pass is active, the green countdown screen also accepts
keyboard input — pressing spacebar pops a small field for a student ID,
which adds them to a queue shown on the side. When the current pass
ends, the next queued student is auto-promoted to "Up Next" and they
press spacebar to start their own pass.

**Status (Apr 24, 2026):** Idea captured, parked. User wants to keep
working on HeartBEAT first.

**Decisions already made (don't re-ask):**
1. Kiosk is the pass issuer — no teacher step. Walk up → queue →
   spacebar → pass starts.
2. One shared queue per kiosk (no boys/girls split).
3. Auto-skip "Up Next" after 60 seconds with no spacebar; promote next.
4. Queue resets at the end of each period. **No new passes can be
   created during the last 10 minutes of any period.**
5. Must preserve the existing big green countdown screen — the queue
   lives alongside it, not in place of it.

**Still open (ask when un-parking):**
- Where the queue panel lives visually on the green screen (right
  rail? bottom strip?).
- Whether teachers/admins see the queue from their dashboards too.
- What "end of period" means when the school's bell schedule isn't
  fully wired (does it use existing bell schedule, or a per-kiosk
  timer?).

---

## 2026-04-26 — Phase 3: rosters + behavior importers (architect Pass)

Extended the importer beyond assessments. Same `KIND_CONFIGS` registry
pattern, two new kinds:

- **rosters** writes to `students`. Insert uses `onConflictDoNothing` on
  `(school_id, student_id)` so re-uploading a roster file is idempotent;
  the diff between `validRows` and `committedRows` surfaces as
  `skippedRows` in the response (warnings, not errors).
- **behavior** writes to `support_notes`. Pure INSERT (no de-dup —
  every row is a distinct event). Defaults `note_type='concern'`,
  `staff_name='CSV Import'`, `created_at=now()` when not mapped.

Both kinds are **school-scope only** for now (no district variant).
Rollback uses `KIND_CONFIGS[kind].rollback(tx, importJobId, schoolId)` —
the dispatcher in DELETE rollback now routes through the registry, with
the legacy assessments branch retained for the district-scope case.

Schema additive: `students.import_job_id` and
`support_notes.import_job_id` (both nullable integer) added via psql
ALTER + mirrored in `lib/db/src/schema/{students,supportNotes}.ts`. No
FK — same convention as `assessments.import_job_id`.

Frontend (`DataImports.tsx`):
- `Kind` widened to `"assessments" | "rosters" | "behavior"`.
- `KIND_DEFS` metadata table drives the radio selector + targets dict.
- `effectiveScope` clamps to "school" for kinds without district
  support; the scope toggle hides for those kinds.
- `kind` is now a useEffect dep for `loadJobs` / `loadTemplates` so
  switching kinds refreshes the History list and template dropdown.

Backend `validateTemplateMapping(mapping, kind)` is now kind-aware:
assessments preserves the legacy `VALID_TARGETS` set; rosters/behavior
look up `KIND_CONFIGS[kind].validTargets`. This unblocks saving
templates for the new kinds.

Architect Pass on second review. Attendance importer **deferred** — no
`daily_attendance` table exists; needs schema discussion before
proceeding. Next: eduClimber-style Insights module.

### Future direction — attendance via Skyward + ClassLink (2026-04-26)

User signaled intent to eventually pull attendance from **Skyward** (the
SIS) and **ClassLink** (identity / OneRoster rostering provider). This
informs the deferred attendance importer design:

- Don't ship attendance as "CSV only." Build a source-adapter layer
  where CSV is one adapter; Skyward (REST or SFTP nightly drop,
  contract-dependent) is another; ClassLink OneRoster is another (best
  for roster + enrollment sync, less for live attendance).
- All adapters should feed into the same `import_jobs` pipeline so
  preview, commit, rollback, and audit work uniformly regardless of
  source.
- ClassLink overlap with Replit Auth / Clerk: ClassLink also does SSO,
  so when we wire it up we'll need to decide whether ClassLink replaces
  or supplements the current sign-in path.

Schema decision to revisit when we start: per-day vs per-period
attendance, the code dictionary (P / A / T / E / U / ISS / OSS), and
excused-reason free-text vs enum.

### Whole-child radar on Insights profile (2026-04-26)

Added a five-axis radar to the top of `StudentProfile.tsx` mirroring the
existing pillar grid (Academics, Behavior, Attendance, Supports,
Family). Each axis is scored 0–100 server-side in `insights.ts` so the
formulas live in one place and can be iterated without rebuilding the
client. The response now carries `radar.axes[]` with `{ key, label,
score, rationale, hasData, isResourceAxis? }`.

Heuristics (intentionally directional, not definitive):
- **Academics** — uses `fastCutScores` placement. PM3 prefers prior-grade
  chart via `placePm3` (so e.g. 9th-grade math can be placed off the
  8th-grade chart). PM2/PM1 require a current-grade chart. L1..L5 maps
  to 20/40/70/85/95; averaged across subjects.
- **Behavior** — 75 base, +PBIS+ (cap 25), −PBIS− (cap 50), −support
  notes×8 (cap 60).
- **Attendance** — 100 base, −5/tardy, −15/ISS day, − over-grade-avg
  hall-pass excess (cap 25).
- **Supports** — explicitly a *scaffolding meter*, not a wellness
  signal. 30 base + 20 (any accommodation) + 25 (any active MTSS plan)
  + 15 (intervention in last 30d) + 10 (any trusted adult). Marked
  `isResourceAxis: true`; client renders an asterisk + footnote.
- **Family** — 30 (parent email) + 20 (parent phone) + 50 (linked
  parent account).

Client (`WholeChildRadar` in `StudentProfile.tsx`) uses recharts
`RadarChart` inside a 280px-tall `ResponsiveContainer`, paired with a
sidebar listing each axis score + rationale. No-data axes are plotted
as `null` (not a synthetic 50) and labeled `(no data)` so the polygon
honestly drops at that vertex. Polygon stroke color is the lowest
non-resource axis score (green ≥75, amber ≥50, red <50) so the chart
"reads" at a glance.

Architect PASS after one revision (fixed: trusted-adult missing from
supports rationale, no-data plotting as 50 misled viewers, academics
gate dropped valid PM3-only placements).

## MUST DO before full deploy

These are open user-flagged items that should be resolved (or
explicitly deferred) before the production deploy. Track them here so
they cannot slip through as we move forward on other work.

1. **Confirm raw-export shape for FAST / iReady / SCI** — the generic
   Assessments importer expects "long" format (one row per (student,
   test, date)). Need to verify with the school's actual vendor
   exports whether their data lands long (works as-is), or wide (one
   row per student with columns like `pm1_score`, `pm2_score`). If
   wide, either add a wide-format adapter or document a one-shot
   reshape recipe so admins aren't stuck. Pinged user; awaiting their
   sample header rows. Do NOT close out before getting that answer.

## Parent Portal Sections — admin toggle UI (April 26, 2026)

Closed item #2 from the HeartBEAT "Deferred (revisit later)" list.
Earlier this session, T13 wired the parent snapshot endpoint to read
`school_heartbeat_settings.show_*` flags from the DB, but admins still
had no UI to flip them — defaults baked at row creation were the only
source of truth in practice.

This change adds the admin surface:

- **Server**: `artifacts/api-server/src/routes/heartbeatSettings.ts`
  - `GET /api/heartbeat-settings` — returns the row for `req.schoolId`,
    lazily inserting one with schema defaults if missing.
  - `PUT /api/heartbeat-settings` — accepts any subset of the 12
    boolean section keys; admin or SuperUser only (`isAdmin ||
    isSuperUser`, both gated through `staffTable.active`).
  - Validates that every supplied value is a boolean before any write
    is committed; whitelist of keys is centralized in `SECTION_KEYS`.
- **Client**: `HeartbeatSectionsAdmin.tsx` — one row per section with
  an inline switch, label, plain-language description, and a
  "Sensitive" tag on the four off-by-default sections (Interventions,
  Staff Notes, ISS, MTSS). Optimistic UI rollback on PUT failure;
  error banner appears at top of card on the rolled-back attempt.
- **Settings tile**: registered under the **Family & Signage** group
  with id `parent-portal-sections`, gated `isAdmin || isSuperUser` so
  the tile is invisible to staff who can't edit it. Branch in App.tsx
  re-checks the same gate before rendering, mirroring how `tenancy`
  and `data-imports` defend their tiles.

Behavioral contract (kept consistent with the parent-portal reader at
`parentSnapshot.ts`): a school OFF flag wins. A parent can never
override a school OFF to ON via `parent_heartbeat_prefs`; their value
is ignored at read time. So this admin panel is the school-level
ceiling — parents only ever sit at or below it.

Open follow-ups still on the deferred list:
1. ClassLink SSO for students.
3. Per-parent toggle UI (analogue of this panel for parents).
4. PDF export of the HeartBEAT Report.
5. Optional weekly emailed PDF (Resend already wired).

## Parent Portal Sections — per-parent toggle UI (April 26, 2026)

Closed item #3 from the HeartBEAT "Deferred (revisit later)" list.
Item #2 (school-level admin toggle) gave admins a knob to turn whole
sections off across the school. This change gives each PARENT a knob
to hide individual sections from THEIR view of THEIR child's snapshot
— without ever being able to reveal a section the school has hidden.

**Server**: `artifacts/api-server/src/routes/parentHeartbeatPrefs.ts`
- `GET /api/parent/heartbeat-prefs?studentId=N` — returns one row per
  section with `{ key, schoolEnabled, parentPref }`, plus
  `weeklyEmailAllowed` (school-side flag), `weeklyEmailEnabled`
  (parent's choice), and `dateRangeDefault`. parentPref is `null` when
  the parent hasn't expressed a preference (= inherit school default).
- `PUT /api/parent/heartbeat-prefs` — body
  `{ studentId, prefs?: { showFoo: boolean | null, … },
     weeklyEmailEnabled?, dateRangeDefault? }`. Validates each section
  value is `boolean | null`; whitelists keys via `SECTION_KEYS`;
  `dateRangeDefault` constrained to `'semester' | 'month' | 'all'`.
  Upsert is concurrency-safe — falls back to a re-read if a parallel
  insert from another tab wins the unique-pair index.
- Both routes resolve `req.parentId` via the same session-or-Bearer
  middleware used by `parentSnapshot.ts`, then enforce that the parent
  is actually linked to `studentId` via `parentStudentsTable`.
- Parent prefs are NOT re-clipped to the school ceiling on write —
  storing a parent's "show this if you ever turn it back on" intent
  across an admin re-enable is friendlier than silently dropping it.
  The ceiling is enforced at READ time in `parentSnapshot.ts` instead.

**Reader update**: `parentSnapshot.ts` now joins
`parent_heartbeat_prefs` for the (parentId, studentId) pair in
parallel with the school settings row. The new `gate()` helper
implements the contract: section visible iff
`schoolEnabled AND parentPref !== false`. School OFF wins
unconditionally; parent's only power is to HIDE.

**Client**: `artifacts/client/src/parent/Preferences.tsx` — full-page
panel that lists all 11 sections. Each row shows an eye icon, the
human label, a one-line description, optional `Sensitive` badge for
the four off-by-default sections, an inline `Switch`, and conditional
status badges (`Hidden by school` when the school has it off, `You hid
this` when the parent has it off). Switch is disabled for
school-disabled rows. Toggling a row sends an optimistic PUT and rolls
back on failure with an inline error banner. Below the section list,
a Weekly Email card flips `weekly_email_enabled` (also disabled if the
school has weekly email off entirely).

**Wiring**: `Dashboard.tsx` adds a `view` state and renders
`<Preferences />` when set to `prefs`. New "What I see" header button
flips view. Returning from Preferences bumps a separate
`snapshotNonce` state which is included in the snapshot effect's
deps, forcing a fresh `/api/parent/snapshot` call so the dashboard
reflects new visibility immediately. (A naive `setActiveStudentId(id
=> id)` doesn't work — React bails out when the next state equals
the previous.)

**Behavioral contract recap (kept across server + reader + UI):**
- School OFF, parent any → hidden.
- School ON, parent null (no row, or row with null) → shown.
- School ON, parent true → shown.
- School ON, parent false → hidden.
- Toggling a hidden-by-parent row back ON sets it to `null` (revert
  to inherit), not `true`. This means a later admin toggle change
  won't "lock in" the parent's old preference.

## HeartBEAT PDF export (April 26, 2026)

Closed item #4 from the HeartBEAT "Deferred (revisit later)" list.
Parents can now download a paper-friendly PDF copy of their student's
snapshot — useful for IEP meetings, sharing with the other guardian,
or attaching to outside provider records.

**Server**:
- `artifacts/api-server/src/lib/parentSnapshot.ts` — extracted
  `buildParentSnapshot(parentId, studentId)` from the JSON route. This
  is the single source of truth for the snapshot data shape AND the
  visibility contract (school OFF wins; parent can only HIDE). Returns
  a `SnapshotResult` discriminated union — `{ ok: true, data }` or
  `{ ok: false, status, error }` — so both routes handle 403/404
  identically.
- `artifacts/api-server/src/routes/parentSnapshot.ts` — refactored
  down to ~40 lines; just resolves the parent id (cookie or Bearer)
  and delegates to the helper.
- `artifacts/api-server/src/lib/parentSnapshotPdf.ts` — pdfkit-based
  renderer. Returns `Promise<Buffer>` (not a stream) so the route can
  set `Content-Length` upfront. Sections are rendered in the same
  order as the on-screen Dashboard (Recognition → Attendance/Hall
  passes → Accommodations → FAST → MTSS → Interventions → Staff
  notes) so a parent can match the printout to what they see in the
  app row-for-row. Honors `snapshot.sectionsAvailable` — sections
  hidden by school OR by parent prefs are omitted entirely (never
  rendered as empty placeholders). Footer on every page shows page
  numbers + a confidentiality notice with the parent's name.
- `artifacts/api-server/src/routes/parentSnapshotPdf.ts` — `GET
  /api/parent/snapshot.pdf?studentId=N`. Same auth pattern as the
  JSON snapshot route. Sets `Content-Type: application/pdf`,
  `Content-Disposition: attachment; filename="HeartBEAT-{first}-
  {last}.pdf"` (filename sanitized to `[A-Za-z0-9._-]`), and
  `Cache-Control: private, no-store` so the per-parent confidential
  document never lands in a shared proxy cache. Best-effort lookup
  of the school name for the header strip — failure is swallowed
  (header just renders "PulseEDU" instead).

**Client** (`artifacts/client/src/parent/Dashboard.tsx`):
- "Download PDF" button next to "What I see" / "Sign out". Disabled
  while a download is in flight or before the snapshot has loaded
  (so parents can't request a PDF for a student they haven't even
  seen the on-screen version of yet).
- Uses `parentFetch` + blob + invisible `<a download>` so the
  Authorization header (Bearer fallback for expired cookie sessions)
  is attached. Object URL is revoked on the next tick to avoid memory
  growth across many downloads. Errors render in a small red banner
  at the top of the dashboard, distinct from snapshot-load errors.
- `parseFilenameFromCD()` lifts the server-suggested filename out of
  the `Content-Disposition` header so the file lands as
  `HeartBEAT-Mia-Rodriguez.pdf` instead of `download.pdf`.

**Build / packaging notes**:
- Added `pdfkit` (runtime) + `@types/pdfkit` (dev) + `@swc/helpers`
  to `artifacts/api-server`. The last one is needed because pdfkit
  pulls in `fontkit`, which has a bundled CJS dep on
  `@swc/helpers/cjs/_define_property.cjs`. esbuild externalizes
  `@swc/*` (correct — it's CJS-only and contains numeric-property
  edge cases bundlers mangle), and pnpm only exposes hoisted
  packages that are direct deps. Adding `@swc/helpers` as a direct
  dep gives node a resolvable path at runtime. If a future package
  upgrade still fails with `Cannot find module '@swc/helpers/...'`
  the same pattern applies — add it as a direct dep, don't try to
  un-externalize it in `build.mjs`.

**Why pdfkit (not puppeteer / @react-pdf):**
- No headless chromium download (would have added ~300MB to the
  image and slowed cold starts).
- No React in the api-server (keeps the runtime + bundle tight; the
  React → CSS → print pipeline is overkill for a 1-page report).
- Deterministic vector output — the same snapshot always produces
  byte-identical PDFs, useful when we eventually attach these to
  emails for #5 (won't trigger spam filters that hate
  every-message-different attachments).

## HeartBEAT weekly email (April 26, 2026)

Closed item #5 from the HeartBEAT "Deferred (revisit later)" list.

**Goal**: Each Friday afternoon, every parent who opted in (per
student) gets a HeartBEAT PDF emailed to them. Reuses the same
shared snapshot builder (`lib/parentSnapshot.ts`) and the pdfkit
renderer (`lib/parentSnapshotPdf.ts`) the on-demand "Download PDF"
button uses, so the mailed report is byte-identical to what the
parent sees on the dashboard.

**New helper — `artifacts/api-server/src/lib/weeklyHeartbeatEmail.ts`**:
- `sendWeeklyHeartbeatEmails(now: Date): Promise<WeeklyEmailResult[]>`
- One join query pulls every eligible (parent, student) tuple:
  - `parent_heartbeat_prefs.weekly_email_enabled = true`
  - `parents.active = true` AND `parents.password_hash IS NOT NULL`
    (so we never email parents who never accepted the invite)
  - `parent_heartbeat_prefs.last_weekly_email_at IS NULL` OR older
    than `DEDUP_WINDOW_DAYS` (6 days). 6, not 7, absorbs a half-day
    clock drift if the cron fires slightly early.
- Per-school `school_heartbeat_settings.allow_weekly_email = false`
  is honored at send time (not in the candidate query) so a single
  school flipping it off doesn't require a query rewrite. Cached in
  a Map so we don't re-query per parent.
- School name + `school_settings.from_name` for the From header are
  cached the same way.
- Resend client is initialized once. If init throws (no API key
  configured), every row gets a `failed` result with the init
  error — the cron log explains why everything was skipped, instead
  of silently aborting.
- Per row: `buildParentSnapshot()` → `renderSnapshotPdf()` → Resend
  `client.emails.send({ ..., attachments: [{ filename, content }] })`.
  Filename is `HeartBEAT-{First}-{Last}-{YYYY-MM-DD}.pdf`,
  sanitized the same way the on-demand PDF route does it.
- Email body is a small text + HTML pair with a plain-English
  unsubscribe instruction ("sign in and turn off Weekly email under
  What I see"). v1 keeps it simple — no per-parent unsubscribe
  token. If we want one-click unsubscribe later, generate a signed
  token in this helper and mount a public `GET /api/parent/unsub?t=…`
  route that flips `weekly_email_enabled = false`.
- `lastWeeklyEmailAt` is stamped to `now` ONLY on a successful send.
  A failed send leaves it untouched so the next cron run retries.
  The stamp update is wrapped in its own try/catch — a stamp failure
  logs loudly but does not abort the whole cron run.
- 200ms `SEND_THROTTLE_MS` between Resend calls (Resend free tier is
  2/sec, standard 10/sec — 5/sec is safe for both). Throttle runs
  after every Resend call regardless of outcome so a 5xx storm
  doesn't retry-storm the provider.

**Schema change — `parent_heartbeat_prefs.last_weekly_email_at`**:
- New nullable `timestamp with time zone` column. Added via direct
  `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (drizzle-kit push hung on
  an unrelated `districts_slug_unique` interactive prompt — the
  column add itself is non-destructive so the SQL path was safe).
  Schema in `lib/db/src/schema/parents.ts` is the source of truth
  going forward.

**Cron wiring — `artifacts/api-server/src/index.ts`**:
- Mirrors the existing daily-digest pattern. Default expression
  `0 16 * * 5` (Friday 16:00 school local time — after the day's
  events have been logged, before the weekend so families have time
  to read it). Default timezone `America/New_York`. Both
  override-able via `WEEKLY_HEARTBEAT_CRON` and
  `WEEKLY_HEARTBEAT_TZ`. Skipped entirely when `NODE_ENV === "test"`,
  same as the daily digest.
- Logs a structured summary (`{ total, sent, failed, skipped }`) at
  INFO and emits a per-row WARN for each failure with parentId,
  studentId, email, and errorMsg. No PII beyond what's already in
  the DB.

**Verification**:
- `Weekly HeartBEAT email scheduled` line appears in api-server logs
  at boot alongside `Daily digest scheduled`.
- Candidate-query smoke test (synthetic insert → run query →
  verify pickup → set `last_weekly_email_at = now() - 2 days` →
  verify NOT picked up → cleanup): all four assertions pass.
- Dev DB has zero parent accounts with accepted invites, so the
  cron will fire on Friday and log `total:0` until parents actually
  subscribe — no risk of accidental sends in dev.

**Why no admin "Send now" button (yet)**:
- Manual send requires per-school plumbing (admin UI, scope check)
  and risks accidentally double-mailing a school's parents during
  testing. The cron-only design is safer for v1. If/when ops needs
  a manual trigger, add a superuser-gated `POST /api/admin/weekly-heartbeat/run`
  that takes an optional `schoolId` filter and respects the same
  `last_weekly_email_at` dedup window.

## iReady AP1/2/3 + SCI Benchmark 1/2/3 — placeholder seed + profile display (Apr 26, 2026)

**What shipped (one bundled change set):**
1. **Watchlist Spider pill** — added an optional `onOpenSpider` prop to
   `InsightsWatchlist`. When wired (it is, from `App.tsx`), each row in
   the watchlist table renders a small "🕸️ Spider" pill next to the
   student's name that opens the whole-child radar / StudentProfile.
   The whole row is also clickable, so the pill uses
   `e.stopPropagation()` to avoid double-fire and to be future-safe if
   the row click target ever changes. Mirrors the same pill on
   `TeacherRosterPage` for visual consistency. Visibility check happens
   server-side on the profile fetch — no client-side gate needed because
   the row is already navigable.
2. **iReady AP1/AP2/AP3 + SCI Benchmark 1/2/3 demo seed** —
   `seedIreadyAndSciIfEmpty()` in `seed.ts`, called from `index.ts`
   boot after `seedFastScoresIfEmpty()`. Both land in the long-format
   `assessments` table (same target as the generic CSV importer) so the
   dashboard treats them identically to uploaded data and rollback
   (DELETE WHERE import_job_id = X) works as a no-op cleanup. Coverage:
   * iReady Reading + Math AP1/AP2/AP3 — grades K-8 only (HS doesn't
     use iReady in either Hernando or Pasco).
   * SCI Benchmark 1/2/3 (percent-correct, FL achievement bands) —
     grades 6-12 (district science benchmark; ES doesn't run it).
   Per-school × per-source skip-if-non-empty guards make re-runs a
   noop. **Each (school, source) seed runs inside a single
   `db.transaction(...)` so a mid-run crash rolls back fully and the
   next boot re-attempts from scratch — no permanently-wedged partial
   datasets.** The synthetic `import_jobs` row is committed in the
   same txn with `committedAt = now()` and a `mapping` marker
   `{_seed: "true", _source: "iReady"|"District SCI"}` so the
   History UI / support can distinguish seed-generated from real CSV
   uploads.
3. **Backend aggregation** — `routes/insights.ts` adds two new
   structured fields to `pillars.academics`:
   * `ireadyScores: Array<{subject, ap1, ap2, ap3, ap1Level, ap2Level,
     ap3Level}>` — only emits a subject if at least one AP is populated,
     so HS students with no iReady get an empty array and the UI hides
     the block cleanly.
   * `sciScores: {b1, b2, b3, b1Level, b2Level, b3Level} | null` —
     null when the student has no SCI Benchmark data (e.g. K-5).
   Both computed in-memory from the existing `assessments` query (no
   extra SQL round-trip). The `assessments` query is already ordered
   `desc by administeredAt`, so `.find()` returns the most recent row
   in the unlikely event of duplicates — though the unique index on
   `(school_id, student_id, assessment_name, administered_at)` plus
   the importer's `onConflictDoUpdate` make duplicates impossible.
4. **Frontend display** — `StudentProfile.tsx` Academics card now
   renders three parallel tables: FAST PM (existing), iReady AP (new),
   SCI Benchmark (new). All three follow the same shape: subject row +
   three columns of period scores + a latest-level summary column. SCI
   row shows "Latest Level" via fallback chain `b3Level → b2Level →
   b1Level → "—"`. Defensive `?? []` / `?? null` defaults on the new
   fields so a stale-cache version-skew race (old API response in
   memory while the new bundle expects the new shape) can't crash the
   page on the first HMR cycle.

**Boot verification:** seeded 18,750 iReady rows across 3 K-8/middle
schools (3,125 students × 6 names = Reading × 3 + Math × 3) and 29,250
SCI Benchmark rows across all 7 schools (9,750 students × 3
benchmarks). Sample data inspection confirms scores fall in plausible
per-grade bands, level labels match the band the score falls into, and
AP1 → AP2 → AP3 shows mild positive drift (consistent with year-over-
year learning gains). On second boot the per-source guards correctly
skipped — no log lines, near-zero work.

**Note on K-5 students:** the dev DB currently only has students in
grades 6-12 (per `seed.ts` line 819 — high school seeder uses 6 + 0..6).
The K-8 grade gate in the iReady seed is already in place for when
K-5 students exist; today only grade 6/7/8 students get iReady rows
and 6-12 students get SCI rows. No code change needed — the gate is
forward-compatible.

**Files touched:**
- `artifacts/client/src/components/InsightsWatchlist.tsx` (Spider pill)
- `artifacts/client/src/App.tsx` (wire `onOpenSpider`)
- `artifacts/api-server/src/seed.ts` (new `seedIreadyAndSciIfEmpty`)
- `artifacts/api-server/src/index.ts` (boot wiring)
- `artifacts/api-server/src/routes/insights.ts` (structured aggregation)
- `artifacts/client/src/components/StudentProfile.tsx` (UI tables + type)

## eduCLIMBER Ledger — Phase Queue (committed Apr 26, 2026)

User explicitly asked for ALL seven of the following items, in any
order I prefer. Working through them lowest-effort-first so we ship
visible wins quickly. Mark each one DONE inline as it ships; **do
NOT drop any of these without an explicit user OK**.

1. **Engagement dashboard** — attendance + hall-pass + tardy + ISS
   patterns aggregated across school/grade/teacher/time. Uses data
   already in the DB (`hallPassEvents`, `issAttendanceDay`,
   `tardyEvents`/equivalent). No new importer needed. STATUS: **DONE
   (Apr 26, 2026)**.

   Shipped:
   - Backend `GET /api/insights/engagement` in `routes/insights.ts`
     (~line 1411). Auth: `loadStaff` + `isCoreTeam` + `requireSchool`.
     Filters: `?window=7d|30d|60d|90d` + `?grade=K|0..12`. Aggregates
     hall passes, tardies, ISS days, pullouts → 5 KPIs (incl.
     `hallPassMinutesLost` capped at 8h per pass for safety), dense
     per-day trend series, top-N student/destination/period tables
     with batched name lookup.
   - Grade param parses defensively: K → 0, numeric strings → int
     (validated 0–12), anything else → no filter (the students.grade
     column is integer; passing the raw "K" string crashed Drizzle).
   - Empty-cohort fast-path returns zeros instead of `inArray([])`.
   - Frontend `EngagementDashboard.tsx`: KPI strip + 3 recharts
     AreaCharts + 5 top-N tables, eduCLIMBER-clean style matching
     `InsightsWatchlist`. Student names are buttons calling
     `onOpenProfile` so users can drill into the StudentProfile.
   - `InsightsHub.tsx` engagement tile graduated from "Phase 4"
     placeholder to "Today" with `targetSection: "engagementDashboard"`.
   - `App.tsx` adds `engagementDashboard` section gated by
     `canAccessMtssHub`, sets `studentProfileReturnTo` so profile
     back-button returns here.
   - `seedEngagementEventsIfEmpty()` in `seed.ts` populates ~520 hall
     passes / ~270 tardies / ~40 ISS days / ~110 pullouts per school
     spread over the last 60 days (school-days only, Pareto-distributed
     across students for realistic top-N tables). Skip-guard is
     strictly "table empty for this school" — non-zero thresholds
     caused deterministic re-seed crashes against the
     `(student_id, day, school_id)` ISS unique index. Wired into
     `index.ts` boot sequence after `seedHousesIfEmpty`.

   Known pre-existing surface-wide issue (NOT introduced here):
   backend `isCoreTeam` includes PBIS Coordinator; frontend
   `canAccessMtssHub` does not. Affects all of `/api/insights/*`,
   not just this endpoint. Out of scope for this item; revisit when
   we re-evaluate the Insights Hub gating model.
2. **Behavior dashboard** — tile-based PBIS+/PBIS−/incident analytics
   across grade/teacher/time, eduCLIMBER-style. STATUS: **DONE
   (Apr 26, 2026)**.

   Shipped:
   - Backend `GET /api/insights/behavior` in `routes/insights.ts`
     (~line 1746). Same auth as engagement: `loadStaff` +
     `isCoreTeam` + `requireSchool`. Same `?window` and `?grade`
     params with the same defensive K → 0, 0–12 int validation. All
     queries scoped by `schoolId`; entries filtered by
     `isNull(voidedAt)` so voided awards never poison KPIs.
   - Single `pbis_entries` query feeds every aggregation (no separate
     "incidents" table — negative-polarity entries serve that role).
     Polarity branching is explicit: only `polarity === "negative"`
     counts as negative, anything else is treated as positive so a
     stray polarity value can't silently disappear from totals.
   - KPIs: positives, negatives, net points (positive − negative),
     pos:neg ratio (`null` when no negatives, UI renders as "—"),
     distinct students recognized, distinct students with negatives.
   - Trends: per-day positives + per-day negatives, both via the
     same `denseSeries(fromDateOnly..toDateOnly)` so dates align by
     index for the overlay chart.
   - Top-N (10): recognized students, concerning students, positive
     reasons, negative reasons, recognizing staff (positives/staff),
     issuing staff (negatives/staff). One batched student-name
     lookup powers both student tables.
   - Empty-cohort fast-path returns a fully zeroed payload instead
     of an `inArray([])` crash, mirroring the engagement fix.
   - Frontend `BehaviorDashboard.tsx`: 6-tile KPI strip with
     green/red left borders for positive/negative, single overlaid
     recharts AreaChart (positives green / negatives red with
     legend), 6 top-N tables in a responsive grid. Student names
     are buttons calling `onOpenProfile` for drill-in. Same window
     / grade filters as engagement for visual symmetry.
   - `App.tsx`: behavior tile graduated from "Phase 4" placeholder
     to "Today" with `targetSection: "behaviorDashboard"` and a
     PBIS-accurate subtitle. New render block gated by
     `canAccessMtssHub` sets `studentProfileReturnTo:
     "behaviorDashboard"` so the profile back-button returns here.
   - `seed.ts` adds `seedPbisCatalogIfEmpty` (14 reasons/school —
     8 positive + 6 negative) and `seedPbisEntriesIfEmpty`
     (~1050 entries/school over 60 days, school-days only,
     80%pos/20%neg, Pareto students). Both use strict empty-table
     skip-guards (the engagement-seed lesson). Wired into
     `index.ts` boot sequence after the engagement seeders.
   - Architect review: PASS. No HIGH/CRITICAL issues. Tenant
     scoping, voided handling, polarity branching, empty-cohort
     payload, and seed contracts all explicitly verified.

   Known pre-existing surface-wide issue (NOT introduced here):
   `App.tsx` has narrow union types for `activeSection` and
   `studentProfileReturnTo` that don't include the new dashboard
   keys. Engagement triggers the same +2 TS errors (37 → 39 with
   behavior added — perfectly symmetric); both surfaces work at
   runtime. Tried widening `studentProfileReturnTo` but it
   cascaded into `setActiveSection`. Park as broader App.tsx union
   debt; revisit holistically when we touch the navigation model.
3. **Academics dashboard** — multi-cohort FAST/iReady/SCI breakdowns
   with filters (school × grade × subgroup). Uses the data we just
   seeded plus existing FAST PM. STATUS: **DONE (Apr 26, 2026)**.

   Shipped:
   - Backend `GET /api/insights/academics` in `routes/insights.ts`
     (~line 2036). Same auth as engagement/behavior: `loadStaff` +
     `isCoreTeam` + `requireSchool` (403 otherwise). **Intentionally
     drops the `?window=` param** — academic data lives at fixed
     PM1/PM2/PM3 + AP1/AP2/AP3 dates, so a windowed daily trend
     would just be three spikes. Keeps the same defensive
     `?grade=K|0..12` parsing for visual symmetry.
   - Empty-cohort fast-path returns a fully-zeroed payload before any
     `inArray()` call (mirrors engagement/behavior).
   - 6 KPIs from `student_fast_scores`: studentsAssessed (distinct
     students with any PM), elaPm3Average + mathPm3Average (cohort
     means rounded to 1 dp, `null` if nothing seen),
     `atOrAboveLevel3Pct` (% of PM3 placements landing L3/L4/L5 via
     `placePm3()`), `bottomQuartilePct` (% students flagged
     `priorYearBq`), `growersPct` (% with PM3 > PM1 in any subject).
   - Progression series: cohort-average score at PM1 → PM2 → PM3,
     two parallel arrays (ELA + Math), null entries dropped so a
     subject without data renders as a gap not a zero.
   - Placement distribution: 5×2 matrix of PM3 placement counts (L1
     through L5 × ELA/Math), driving the stacked-bar chart.
   - 4 top-N (10) lists: top growers ELA, top growers Math (PM3 −
     PM1 delta), L1 ELA students, L1 Math students (lowest PM3 in
     L1 placement only — the "biggest gap to close" cohort).
   - Sources panel: row counts for FAST / iReady / District SCI to
     hint at vendor coverage and seeded volume. iReady + SCI counts
     come from two short cohort-scoped raw-SQL `COUNT(*)` queries
     (parameterized via Drizzle's `sql` template, no injection).
   - FAST placement uses per-student current grade from
     `students.grade` and passes it to `placePm3()`, which internally
     applies the FAST worked-example "PM3 → prior-grade chart" rule.
     Architect explicitly verified this.
   - Frontend `AcademicsDashboard.tsx`: 6-tile KPI strip with subject
     and outcome accent colors (blue=ELA, orange=Math, green=success
     metrics, red=BQ risk), recharts LineChart for PM progression
     (two lines), recharts BarChart for placement distribution
     (grouped bars), 4 top-N tables in a responsive grid. Student
     names are buttons calling `onOpenProfile` for drill-in.
   - `App.tsx`: academics tile graduated from "Phase 4" to "Today"
     with `targetSection: "academicsDashboard"` and a FAST-accurate
     subtitle. New render block gated by `canAccessMtssHub` sets
     `studentProfileReturnTo: "academicsDashboard"` so the profile
     back-button returns here.
   - Widened `studentProfileReturnTo` union to include the three
     dashboard return targets (was previously narrow → engagement,
     behavior, and academics all assigned out-of-union literals).
     This clears the +6 TS errors that the prior two dashboards +
     this one would have introduced. `setActiveSection` did NOT
     cascade as feared — that union was already wider.
   - Architect review: PASS. Tenant scoping, raw-SQL parameterization,
     auth parity, defensive grade parsing, empty-cohort handling, and
     FAST placement correctness all explicitly verified. No
     HIGH/CRITICAL issues.

   Known pre-existing surface-wide debt (NOT introduced here): 28 TS
   strict-mode errors in `src/seed.ts` (lines 1300+) — implicit-any
   on transaction callbacks and array methods. Untouched by this
   change. The api-server still builds and runs correctly via
   esbuild; tsc-strict is informational only at this point.
4. **SEB/SEL dashboard** — surface social-emotional/behavioral signals
   already in the DB (support notes, MTSS plans, accommodations,
   trusted-adult data, parent-engagement signals). STATUS: **DONE
   (Apr 26, 2026)**.

   Shipped:
   - Backend `GET /api/insights/sebsel` in `routes/insights.ts`
     (~line 2387). Same auth as the prior three dashboards:
     `loadStaff` + `isCoreTeam` + `requireSchool` (403 otherwise).
     Same defensive `?grade=K|0..12` parsing. **Intentionally drops
     the `?window=` param** — most SEB/SEL signals are stateful
     (active plans, accommodations, IEP/504/ELL flags), so a
     windowed daily trend would be misleading. The one windowed
     signal — recent negative PBIS — is hard-coded to a fixed 30-day
     "active concern" window and surfaced in the page footer.
   - Empty-cohort fast-path returns a fully-zeroed payload before
     any `inArray()` call (mirrors the prior three dashboards).
   - 6 KPIs: `activeMtssPlans` (open `student_mtss_plans` for cohort),
     `selFlaggedPlans` (active plans whose title bucket is "Behavior"
     or "SEL" via case-insensitive substring matching against the
     seeded titles in `seed.ts` ~line 373), `iepStudents`
     (`students.ese=true`), `students504` (`students.is504=true`),
     `ellStudents` (`students.ell=true`), and `multiRiskStudents`
     (count of students with ≥2 of {plan, BQ, ≥3 negatives in last
     30d, IEP-or-504}).
   - Plan-area mix: 5-bucket categorization of every active plan
     (Behavior / SEL / Academic / Attendance / Other) by title
     regex. Returned in stable `PLAN_AREA_ORDER` so the UI doesn't
     resort.
   - Risk-overlap histogram: count of students by number of risk
     flags (1 / 2 / 3 / 4). flagCount=0 is intentionally excluded
     from the response — would dwarf every other bar.
   - 4 top-N (15) lists:
     - **Highest need** — sorted by flag count desc, name asc
       tiebreak. Each entry carries the full `flags[]` so the UI
       can render risk chips inline.
     - **At risk without a plan** — students with BQ or
       ≥3 recent negatives AND no active MTSS plan ("missed kids");
       sorted by (negatives desc, BQ desc, name asc).
     - **SEL plan roster** — students with active SEL- or Behavior-
       bucketed plans (deduped per student via `Map.has()` guard so
       a student with two SEL plans appears once); sorted by name.
     - **Most accommodated** — heaviest support footprint, sorted by
       active accommodation count desc.
   - Sources panel: counts of active plans, active accommodations,
     last-30d negative PBIS rows, and FAST BQ flags consumed.
   - Frontend `SebSelDashboard.tsx`: 6-tile KPI strip with a fresh
     palette to distinguish from the prior three dashboards (purple
     for plan-related KPIs, blue for IEP/504/ELL demographic flags,
     red for the multi-risk concentration KPI). Recharts horizontal
     `BarChart` for plan-area mix with per-bar `Cell` colors and
     right-aligned value labels; recharts vertical `BarChart` for
     risk overlap with per-bar `Cell` colors (yellow→red gradient as
     flag count grows) and top-aligned labels. 4 top-N tables in a
     responsive grid, with `FlagChip` rendering each student's risk
     flags inline on the highest-need rows and a small grade chip on
     every student name. Two distinct empty states: `allEmpty` (no
     students in cohort) vs `noSignal` (cohort exists but no flags
     fire).
   - `App.tsx`: SEB tile graduated from "Phase 4" to "Today" with
     `targetSection: "sebSelDashboard"` and a sharper subtitle.
     `SebSelDashboard` imported next to `AcademicsDashboard`. New
     render block gated by `canAccessMtssHub` mirrors the academics
     block and sets `studentProfileReturnTo: "sebSelDashboard"` so
     the profile back-button returns here. Widened the
     `studentProfileReturnTo` union to include `"sebSelDashboard"`
     (clean +1 entry — that union was already widened to hold the
     three dashboard targets in item #3).
   - Architect review: PASS. Tenant scoping (every query AND-filters
     on `schoolId` AND `inArray(studentId, cohort)`), defensive grade
     parsing, empty-cohort handling, multi-risk threshold (>=2),
     plan-bucket title matching against the seeded titles, dedupe
     via `Map.has()`, active-only accommodations filter, and viz
     parity with the sibling dashboards all explicitly verified. No
     HIGH/CRITICAL issues.

   Data NOT used in v1 (deferred until those tables actually get
   seeded/populated): `support_notes`, `intervention_entries`,
   `student_trusted_adults`, `parent_students`. The dashboard works
   off the data the seed actually produces today (~278 MTSS plans,
   accommodations, IEP/504/ELL flags, ~1050 PBIS entries from item
   #2's seeder, and FAST BQ from item #3). Adding the deferred data
   sources later is purely additive — KPIs and top-N lists can grow
   without breaking the envelope shape.

   **Retroactive update (Apr 26, 2026 — same day, after item #5
   shipped):** the SEB/SEL dashboard's IEP / 504 / ELL KPIs were
   silently zero on Apr 26 morning because `students.ese`,
   `students.is_504`, and `students.ell` were `false` for all 9750
   seeded students (the columns existed but no seeder populated
   them). Item #5's `seedStudentDemographicsIfEmpty` (see item #5
   below) now backfills those flags with realistic FL-school
   proportions on every demo school, so this dashboard's IEP / 504
   / ELL tiles now light up: ELL ~14%, IEP ~16%, 504 ~4%. **No
   code changes were needed in the SEB/SEL dashboard itself** — the
   queries were always correct, they just had nothing to count.
5. **Equity dashboard** — disaggregate every existing pillar by
   demographic subgroup (ELL, IEP, 504, Female, Male) with **risk
   ratio** as the headline metric for district-level conversations.
   STATUS: **DONE (Apr 26, 2026)**.

   Shipped:
   - **Demographic seeder** `seedStudentDemographicsIfEmpty` in
     `artifacts/api-server/src/seed.ts` (~line 1536). Wired into
     `seedIfEmpty()` boot path AFTER the FAST + PBIS seeders so
     correlation lookups have data. **Two-stage idempotency
     check** (architect-hardened):
       * Stage 1: skip school if any student already has `ell=true`,
         `ese=true`, `is_504=true`, or non-NULL `gender`.
       * Stage 2: skip school if `school_accommodations` is empty
         for that school — that table is populated exclusively by
         `seedIfEmpty()` on the demo schools, so any real SIS-
         imported school (which has no `school_accommodations`
         rows) skips even on a fresh boot. Without Stage 2 a real
         SIS roster with all-false demographic booleans + NULL
         gender (a valid "no demographics imported yet" state)
         would get overwritten by demo correlations.
     Stage 2 logs each skip at INFO so the boot log is auditable.
     On the current 7 demo schools, Stage 1 fires (silently
     skips) — verified post-restart that all 9750 students retain
     the originally seeded demographics.
   - **Demo correlation patterns** — deliberately mild so the
     dataset shows realistic 1.3x–1.7x risk ratios without
     looking obviously synthetic. **These are intentional, NOT
     bugs** — documented in seeder comments and called out in the
     dashboard footer:
       * **ELL**: base 12% + 8 pts if BQ in any subject + 6 pts if
         recent-30d negs ≥ 3.
       * **ESE (IEP)**: base 14% + 12 pts if recent-30d negs ≥ 5
         + 5 pts if BQ.
       * **504**: base 4% + 3 pts if math-specific BQ.
       * **Gender**: M ~49.5% / F ~49.5% / NULL ~1% (no risk
         correlation — gender disparities are noise on demo data
         by design, so when real data shows real gender disparities
         it isn't drowned out).
     Verified post-seed: ELL 14.2%, ESE 15.6%, 504 3.9%, gender
     ~49.7 / 49.4 / 1.0%.
   - **Backend** `GET /api/insights/equity` in
     `routes/insights.ts` (~line 2810). Same auth pattern as the
     prior 4 dashboards (`requireSchool` + `loadStaff` +
     `isCoreTeam` → 403) and same defensive `?grade=K|0..12`
     parsing. Empty-cohort fast-path returns a fully-zeroed
     envelope before any `inArray()` call.
   - **5 subgroups × 5 metrics** matrix:
       * Subgroups: ELL, IEP (ese), 504, Female, Male.
       * Metrics: % on active MTSS plan, avg negative PBIS / student
         (last 30d), pos:neg PBIS ratio, % flagged BQ (any subject),
         avg out-of-class events / student (passes + tardies, 30d).
   - **Risk ratio** = `inGroupValue / outGroupValue`. In-group vs
     out-group (NOT vs school avg) for cleaner ratio math. Safety
     fallbacks: denom 0 → null, both 0 → 1.0. Pos:neg ratio
     returns null when in-group neg=0 (no sentinel value).
   - **Direction-of-concern** semantics: each metric carries a
     `worseDirection: "higher" | "lower"` so the UI colors red /
     green correctly (avg negs being higher in a subgroup is BAD;
     pos:neg ratio being higher is GOOD).
   - **High-disparity flag threshold**: ratio ≥ 1.30 OR ≤ 0.77
     (i.e., ≥30% gap in either direction), AND in-group size ≥ 10
     (`MIN_GROUP_SIZE` constant, prevents small-n noise from
     producing false alarms).
   - **PBIS query excludes voided rows** (`isNull(voidedAt)`) to
     match the rest of the codebase's behavior semantics —
     architect caught this gap in review and it's now fixed.
   - **Frontend** `EquityDashboard.tsx`: 6-tile KPI strip with
     teal accents for the 3 demographic counts, **rose accent +
     extra-large value font** on the max-risk-ratio tile so it
     reads as the visual headline, amber accent on the high-
     disparity flag count. Disparity flags top-12 panel with HUGE
     ratio numbers + sample-size chips, sorted by `|log(ratio)|`
     desc. Per-subgroup snapshot grid (5 cards, one per subgroup)
     for drill-down after the headline grabs attention.
     **Demo-data disclaimer footer** explicitly tells district
     staff the seeded correlations are illustrative.
   - **Two distinct empty states**: cohort empty ("Select a grade
     to load equity insights") vs cohort exists but no
     demographics imported ("No demographic data yet — import a
     SIS roster with ELL/ESE/504/gender fields").
   - `App.tsx`: equity tile graduated from "Phase 4" to "Today"
     with `targetSection: "equityDashboard"`. `EquityDashboard`
     imported next to `SebSelDashboard`. New render block gated
     by `canAccessMtssHub` mirrors the SEB/SEL block and sets
     `studentProfileReturnTo: "equityDashboard"` (union widened
     by 1 entry — that union was already widened to hold the
     prior 4 dashboard targets).
   - **UI nit fix in same session**: bumped `gradeChipStyle` left
     margin from 6→10px, added a 1px slate border, bumped font
     weight to 600. Previously the chip "G8" could visually run
     into the trailing letters of a student's name (e.g.
     "...lker G8" → "lkerG8"). Affects all 4 places the chip
     renders in `SebSelDashboard.tsx`.
   - Architect review: PASS after 2 fixes. Architect initially
     flagged: (1) seeder Stage 2 missing — fixed via
     `school_accommodations` marker check; (2) PBIS query missing
     `voidedAt IS NULL` — fixed. Tenant scoping, risk-ratio edge
     handling, MIN_GROUP_SIZE guard, direction-of-concern
     semantics, and demo-correlation transparency all explicitly
     verified.

   **Item #5 follow-on: Race + Ethnicity (Apr 26, 2026)** — user
   requested race-based equity disaggregation. Shipped:
   - Schema: `students.race` (text) + `students.ethnicity` (text)
     in `lib/db/src/schema/students.ts`. Race uses 7 buckets
     (white | hispanic | black | asian | multi | native | pacific)
     for K-12 SIS display compatibility (Skyward / Focus expose a
     single race column that can include Hispanic). Ethnicity is
     a separate Hispanic-origin Y/N flag (`hispanic` |
     `non_hispanic`) per OMB Directive 15. Columns added via
     direct ALTER TABLE because `db:push` interactively prompted
     about an unrelated `districts_slug_unique` constraint
     addition; the additive column change has zero data risk.
   - **Race seeder** `seedStudentRaceIfEmpty` in
     `artifacts/api-server/src/seed.ts` (~line 1726). Same
     two-stage idempotency contract as the demographics seeder:
     Stage 1 = "any student in this school already has race OR
     ethnicity set"; Stage 2 = "school_accommodations non-empty"
     (demo marker, protects real SIS-imported schools). Wired
     LAST in the boot path in `artifacts/api-server/src/index.ts`
     (after `seedStudentDemographicsIfEmpty`), so PBIS + FAST
     correlations are already populated.
   - **Per-district base weights** (out of 1000 to keep the
     cumulative-pick draw clean):
       * **Hernando**: white 670 / hispanic 200 / black 60 /
         multi 40 / asian 20 / native 5 / pacific 5.
       * **Pasco**: white 700 / hispanic 170 / black 50 / multi
         40 / asian 30 / native 5 / pacific 5.
     District is detected via `districtSlug` regex (`/pasco/i`)
     so a future district added to the demo seed picks up the
     Hernando defaults until weights are added.
   - **Mild correlations** (deliberately small, mirror documented
     K-12 disparities so the demo dataset shows realistic
     race-disparity ratios; **all are seed artifacts, not real
     district data** — dashboard footer carries the disclaimer):
       * Recent-30d negs ≥ 5 → +30/1000 white→black shift
         (mirrors documented discipline disparity).
       * BQ + recent-30d negs ≥ 3 → +30/1000 white→hispanic
         shift (mirrors language-acquisition academic gap;
         intentionally overlaps with the ELL bumps in the
         demographics seeder so the same students often carry
         both flags — that's what real district data looks like).
       * BQ → -5/1000 asian under-representation in BQ cohorts
         (mirrors documented K-12 academic gap, OPPOSITE
         direction).
     Multi / Native / Pacific stay tiny (<5%); the Equity
     dashboard's `MIN_GROUP_SIZE = 10` guard naturally suppresses
     them when the cohort is too small to make meaningful
     disparity claims.
   - **Ethnicity** correlated with race: race=hispanic →
     ethnicity=hispanic 95% of the time (the 5% non-hispanic
     captures real-world federal Q1 variance); other races →
     ethnicity=hispanic 2% of the time (small share of
     non-Hispanic-race students still claim Hispanic origin).
   - **Equity endpoint extension** (`routes/insights.ts` ~line
     2840): `studentRows` SELECT widened with `race + ethnicity`,
     7 race membership sets + 1 Hispanic-ethnicity set built in
     a single pass over students, `SubgroupKey` union widened to
     13 entries, `SUBGROUPS` array extended (5 demographic + 7
     race + 1 ethnicity = 13 subgroups). Both the empty-cohort
     fast-path AND the populated `totals` response now include
     `raceMix` (per-bucket count + pct) and
     `ethnicityHispanicCount/Pct + ethnicityUnknownCount/Pct`.
   - **Frontend** (`EquityDashboard.tsx`): `SubgroupKey` union
     widened to 13 entries, `SUBGROUP_COLORS` palette extended
     with 8 new chip definitions (cool/neutral race family
     visually distinct from the warm demographic-flag family;
     dark-amber chip for the Hispanic ethnicity entry). The
     `EquityResponse.totals` interface gained `raceMix` and the
     ethnicity counts so the existing snapshot grid + flags
     table render the new subgroups automatically — no other UI
     wiring needed because the components iterate
     `subgroupSnapshots` and look up colors by key.
   - **Verified post-restart**: 7 demo schools all have race +
     ethnicity populated (8500 students). Hernando schools 1, 2,
     3, 4, 5, 36: ~67% white / ~22% hispanic. Pasco school 220:
     ~70% white / ~16% hispanic. Per-bucket counts within ±0.5pp
     of the configured weights. Roster-only schools (no
     `school_accommodations` marker) correctly skipped — verified
     by zero race-set count for schools 182-219, 221-277, 391.

6. **Early Warning composite** — single 0-100 risk score per student
   rolling up four pillars (academics + behavior + engagement +
   supports). STATUS: SHIPPED.
   - Endpoint: `GET /api/insights/early-warning?grade=...` in
     `artifacts/api-server/src/routes/insights.ts` — auth gated by
     `requireSchool` + `isCoreTeam` (same model as Equity).
   - Pillars (each 0-25, sum = 0-100):
     - **Academics** — distinct FAST `priorYearBq` subjects: 0→0,
       1→14, 2+→25.
     - **Behavior** — negative PBIS in last 30d (excludes voided):
       0→0, 1-2→8, 3-5→15, 6-9→20, 10+→25.
     - **Engagement** — weighted disruption: tardy=1, hall pass=1,
       pullout=2, ISS day=5 (a full day out of class is a much heavier
       signal than a single tardy). Weighted total: 0-2→0, 3-5→8,
       6-12→15, 13-25→20, 26+→25.
     - **Supports** — active MTSS plan tier (max across all open plans):
       no plan→0, T1→5, T2→14, T3→25. Counts *as* risk because being
       on a Tier-3 plan means the team has already identified intensive
       need — the inverse case is captured by the
       `unsupportedHighRisk` flag (composite ≥ 60 with no active plan).
   - Risk bands: 0-19 Low · 20-39 Watch · 40-59 Moderate · 60-79
     High · 80-100 Critical.
   - Response: totals (cohortStudents, avgScore, maxScore, per-band
     counts/pcts, highOrCritical, unsupportedHighRiskCount), top-25
     risk leaderboard with pillar breakdown + signal counts, sources
     counts (FAST BQ, neg PBIS 30d, hall passes 30d, tardies 30d,
     pullouts 30d, ISS days 30d, active plans). Empty-cohort fast
     path returns the same envelope shape with all zeros.
   - Frontend: `artifacts/client/src/components/EarlyWarningDashboard.tsx`
     mirroring EquityDashboard structure — grade filter, KPI strip
     (cohort / avg / max / High+Critical / unsupported), 5-color risk
     band distribution bar with legend, top-25 leaderboard with
     pillar-color chips and click-through to studentProfile.
   - Insights tile (`earlyWarning` in `artifacts/client/src/App.tsx`)
     promoted from Phase 4 → Today, wired to new
     `earlyWarningDashboard` activeSection, `studentProfileReturnTo`
     union extended.
   - Sanity check on school 1: 875 students, 497 with at least one BQ
     subject (max 2), 175 active MTSS plans, 193 hall pass rows /
     120 tardy rows / 57 pullout rows / 15 ISS-day rows in 30d
     window — composite scoring will exercise all four pillars.
7. **Attendance importer schema decision** — needs user input on
   per-day vs per-period attendance, the code dictionary
   (P/A/T/E/U/ISS/OSS), and excused-reason free-text vs enum.
   Currently blocked on user. Will ping user for the decision once
   items 1–4 are done so they have context for what data shapes we're
   working with. STATUS: blocked on user (will surface at the right
   moment).

**Why this order:** Engagement, Behavior, and Academics dashboards
each work with data already in the DB and produce immediately useful
visualizations. SEB/SEL aggregates support-side data we already
collect. Equity and Early Warning are roll-ups that depend on the
first four producing per-student metrics. Attendance schema decision
is parked until last because it needs the user and doesn't block the
other six.

**Reminder still active**: after item #7 from the *HeartBEAT*
Deferred list ships (separate list — search "*After item #7 in this
list ships*" earlier in this file), ask the user about adding view
features for the uploaded data. That reminder is unrelated to this
phase queue.

---

## Save-for-later: eduCLIMBER "Students 3D" feature

User dropped in a screenshot of eduCLIMBER's **Students 3D** view on
Apr 26, 2026 with the directive "Save for later." Not on the Phase
Queue yet — capturing here so we don't lose the reference when the
user is ready to prioritize it.

Reference image: `attached_assets/image_1777213040627.png`

What it is (from the screenshot):
- A whole-school visualization where every student is rendered as a
  small circular portrait, grouped into vertical "stacks" by an
  attribute (the screenshot shows grouping by Ethnicity — White 67%
  / 284, Hispanic-Latino 13.7% / 58, Black 8.7% / 37, Two+ Races
  6.4% / 27, Asian 4% / 17, American Indian 0.2% / …).
- Top of screen: School Year, Schools, Grades multi-selects with
  filter chips ("Incident", "Attendance: 93%-100%") shown applied
  with X-to-remove pills.
- Left rail "Group" panel: School / Grade / Gender / Ethnicity /
  Meal Status / Disability / Incident / Attendance buckets — pick
  one to be the X-axis of the stacks.
- Left rail "Filter" panel: Assessment / Attendance / Disability /
  Ethnicity (and more below the fold) — these narrow the population
  and feed the chip strip at top.
- Hover/click a portrait → a card appears with the student's name,
  school, grade, headshot, and the active metrics ("2.00 : Incident",
  "98.90 : Attendance: …").

Why it's compelling for our app:
- Makes the abstract numbers feel like real kids — every dot is a
  face, hard to ignore an outlier subgroup when you can see them.
- Doubles as an equity lens (it's literally the disproportionality
  view from item #5) **and** a roster explorer (drill-in to the
  individual profile we already have).
- Builds naturally on the watchlist + dashboards we just shipped —
  the metrics on the hover card are exactly the engagement /
  behavior / academics KPIs.

Not-trivial considerations to think about before we commit:
- Photo plumbing: we don't currently store student headshots. Would
  need a photo upload pipeline + object storage + a fallback initials
  avatar. That's a meaningful side-quest before this can look like
  the screenshot. (Could ship a v0 with monogram avatars first.)
- Performance: rendering hundreds-to-thousands of DOM portraits with
  hover interactions needs canvas/SVG virtualization, not naive
  React divs.
- Privacy: a wall of student faces visible to anyone with the right
  role is a meaningful escalation of what "core team" sees today.
  Worth a quick policy check with the user before designing.

Status: **idea parked** — surface to the user when they ask "what's
next after the eduCLIMBER ledger" or when item #5 (Equity dashboard)
comes up, since this could *be* the equity dashboard's hero view.

---

## Program Effectiveness Sankey — mockup built (Apr 26, 2026)

Status: **mockup live in mockup-sandbox + on the canvas**, not yet
graduated to the main client.

- File: `artifacts/mockup-sandbox/src/components/mockups/pulse-screens/ProgramEffectivenessSankey.tsx`
- Preview: `/__mockup/preview/pulse-screens/ProgramEffectivenessSankey`
- Canvas shape id: `pulse-program-effectiveness-sankey` (1280x800 at x=12720, y=-540)
- Renders recharts `<Sankey>` with custom node + link render functions:
  4 left nodes (PM1) → 4 right nodes (PM3), bands `at-or-above`,
  `below`, `well-below`, `na`. Ribbons are colored by the **end** band
  (matches the screenshot's read direction).
- Filters (visual + interactive against a deterministic synthetic
  matrix): subject toggle (ELA / Math), grade dropdown (All / K–10),
  PM-window dropdown (PM1→PM3 / PM1→PM2 / PM2→PM3).
- Lessons learned for any future recharts Sankey work in this repo:
  1. ResponsiveContainer **must** sit inside a parent with an explicit
     pixel `height` — `min-h` alone collapses to 0 and the chart goes
     blank silently.
  2. Recharts hands `sourceY/targetY` to the link renderer
     **pre-centered** for the link thickness; do not add `linkWidth/2`
     again or the ribbon detaches from the node bar.
  3. The Sankey tooltip's active item lives at `payload[0].payload`,
     not `payload[0].payload.payload`. Both link and node hovers use
     the same shape — branch on whether `fromBand`/`toBand` exist.

Original "save for later" notes from the inspiration screenshot are
preserved below.

---

## Save-for-later: eduCLIMBER "Program Effectiveness" Sankey

User dropped in a second screenshot on Apr 26, 2026 with the same
"Save for later" directive. Capturing alongside the Students 3D idea
above.

Reference image: `attached_assets/image_1777213106692.png`

What it is (from the screenshot):
- A Sankey / flow diagram titled **Program Effectiveness** showing
  cohort movement across two assessment windows (Beginning → End).
  Three benchmark bands on each side, color-coded:
  - **At or Above Benchmark** (green)
  - **Below Benchmark** (yellow / amber)
  - **Well Below Benchmark** (red / pink)
- Ribbon thickness represents the number of students moving from a
  Beginning band to an End band. Diagonal cross-flows visualize
  movement (kids who were Below at BOY but At-or-Above at EOY → green
  ribbon flowing up, etc.).
- Top-left controls: **Beginning** + **End** window pickers, a
  **Default Performance Band** selector (so a school can swap in
  iReady vs FAST vs district-defined cuts), Search button.
- An **NA** sliver on the far right — students with no End-of-window
  score (moved out, untested, etc.). Honest about missing data.

Why it's compelling for our app:
- This is the headline "did our intervention work?" visual that
  eduCLIMBER demos lead with. Single picture answers "are kids
  moving up the bands or sliding down?" across an entire grade or
  intervention cohort.
- Pairs naturally with item #3 (Academics dashboard) and item #6
  (Early Warning composite) — same FAST PM data, different lens.
- Could also be filtered to a specific intervention's roster to
  show that intervention's effectiveness specifically.

Not-trivial considerations:
- Sankey rendering: recharts doesn't have a great built-in Sankey;
  options are `recharts/Sankey` (basic), `@nivo/sankey` (nicer, new
  dep), or D3 directly. Nivo is the easiest path if we add it.
- Cut-score handling: we already have `placePm3` / `placeOnChart`
  in `lib/fastCutScores.js` — those are the band classifiers we'd
  feed in for both BOY and EOY snapshots.
- "Default Performance Band" picker implies multiple cut-score
  systems coexisting per school. We have FAST today; iReady would
  be a separate import (blocks on more data infra).
- Window pairing: needs the user to define what counts as "BOY"
  and "EOY" per school — could default to first/last assessment in
  the school year and let the user override.

Status: **idea parked** — surface this together with the Students
3D idea when item #3 (Academics dashboard) lands, since both are
academics-flavored views and we'll have the cut-score plumbing
warm at that point.

---

## Save-for-later: eduCLIMBER "Risk Ratio Calculation" (disproportionality)

Third "Save for later" screenshot from the user on Apr 26, 2026.
Same parking-lot capture pattern as the two above.

Reference image: `attached_assets/image_1777213147558.png`

What it is (from the screenshot):
- A **Risk Ratio Calculation** view, **By Ethnicity**, with an
  "Edit Calculation" button top-right (so the educator can swap
  the cohort axis — by Ethnicity / Gender / Disability / Meal
  Status / etc., presumably).
- Top half: a tile grid, one tile per ethnicity bucket (No Value
  Assigned, American Indian, Asian, Black or African American,
  Chinese, Filipino, Guamanian, Hawaiian, Hispanic, Japanese,
  Laotian, Native Hawaiian or Other Pacific Islander, Other
  Pacific Islander, Refused to Identify, Samoan, Two or More Races,
  Vietnamese, White). Each tile shows:
  - The risk ratio in big type ("1.5 to 1", "0.4 to 1", etc.)
  - The numerator/denominator below ("240 / 725 Students" — i.e.,
    240 of this group's 725 students were "in the incident set"
    being measured).
- Bottom half: horizontal bar chart of the same ratios sorted by
  the bucket label, with x-axis 0 → 3.25.
- Right rail: a legend explaining what the ratios *mean* — 1.0 =
  Equal Risk, 1.25 = 25% higher, 1.5 = 50% higher, 2.0 = 2x, 2.5
  = 2.5x, 3.0 = 3x. This is the gold-standard interpretation
  scaffolding educators need; without it the numbers are
  meaningless to a non-statistician.

Why it's compelling for our app:
- This is **literally** the calculation behind item #5 (Equity
  dashboard). The "incident set" is a swap-in slot — could be
  ODRs, ISS days, suspensions, special-ed referrals, intervention
  assignments, etc. The same widget answers a dozen "is this
  proportionate?" questions just by changing the metric.
- Pairs naturally with the Students 3D idea above — Students 3D
  is the *people* view of disproportionality, this is the *math*
  view. They reinforce each other.
- The legend on the right is itself a teachable artifact; that's
  the kind of "explain the metric inline" UX that earns trust
  with skeptical principals.

Not-trivial considerations:
- Risk ratio formula = (% of group in the set) / (% of all-other
  groups in the set). Easy to compute server-side once we have
  the demographic columns + the metric in question.
- Demographics: we currently store basic student demographics but
  the breakdown granularity in this screenshot (Chinese / Filipino
  / Guamanian / Hawaiian as separate buckets, not just "Asian /
  Pacific Islander") implies a richer code list than we have today.
  Either we accept the broader buckets we have, or we add finer
  fields to the SIS importer.
- Small-N suppression: a "3.0 to 1" tile based on "2 / 3 Students"
  (Samoan in the screenshot) is statistical noise dressed up as
  a finding. We must add a min-N suppression rule and a clear
  "insufficient sample" badge instead of letting the chart shout.
- Privacy: same concern as Students 3D — surfacing demographic
  breakdowns to anyone with a role triggers policy. Worth the same
  conversation with the user.

Status: **idea parked** — this is the natural hero view for item
#5 (Equity dashboard). When we get to item #5, propose this widget
as the centerpiece, with the Students 3D view as the
"see the actual kids" complement.

---

## Save-for-later: eduCLIMBER "Program Evaluation" multi-panel

Fourth "Save for later" screenshot from the user on Apr 26, 2026.

Reference image: `attached_assets/image_1777213180593.png`

What it is (from the screenshot):
- A **Program Evaluation** page with a top filter strip (Assessment
  picker = FAST, Subtest = aReading, Window = 3, Year = 2020-2021,
  Schools multi-select, Grades multi-select, Filters button, Search
  button) and **three stacked panels**, each a stacked-bar +
  overlay-line combo card. All three answer "how is this assessment
  trending" but at different aggregation levels:
  1. **FAST - aReading** (top): three bars total — Fall / Winter /
     Spring — with green (At/Above Benchmark) stacked on red
     (Below Benchmark) and a teal **Avg Score** line overlaid on a
     secondary right-side y-axis. The line trends up across the
     year while the bar shifts from mostly-red to mostly-green —
     classic "the kids are growing" picture.
  2. **FAST - aReading by School** (middle): one stacked bar per
     school per window (so Fall/Winter/Spring × ~7 schools = ~21
     bars), with the same overlay line per school for Avg Score.
     Lets a district admin spot which schools are pulling the
     district up vs lagging.
  3. **FAST - aReading by Grade** (bottom): one bar per grade per
     window, with **multiple** overlay lines this time — Avg Score
     plus two comparison/baseline lines (Aug '19 25%ile, Aug '19
     Net'l Mean). Adds normative context so a school can see how
     they sit vs prior cohorts and national benchmarks.
- Top-right per-panel: Performance dropdown (probably swaps the
  metric — Performance / Growth / Percentile etc.) plus pin /
  expand / kebab icons. Implies cards are reorderable / pinnable
  per user.

Why it's compelling for our app:
- Highest information density of the four saved screenshots —
  one page answers "are kids growing on the assessment" at three
  cuts simultaneously without making the user re-filter.
- Drops directly onto item #3 (Academics dashboard). The data is
  exactly what `studentFastScoresTable` already holds; cut-score
  classification uses our existing `placePm3` / `placeOnChart`.
- The "comparison lines" pattern (national mean, prior-year
  percentile) is the differentiator vs a plain stacked bar. Earns
  trust by showing context, not just a number in isolation.

Not-trivial considerations:
- We already have the FAST PM data and the cut-score plumbing;
  the work is mostly the chart composition (recharts ComposedChart
  with overlaid Bar + Line). Nivo not required for this one.
- Comparison baselines: we'd need to either ingest national norms
  (FAST publishes them) or compute prior-year cohort means from
  our own historical data once we have multiple school years
  loaded. Stage 1 could ship with just the school's own historical
  trend line; baselines come later.
- Window labeling: "Fall / Winter / Spring" assumes a 3-window
  testing schedule. Schools that test more often (4-6 windows)
  need a different label convention. Make the window count a
  per-school setting.
- Pinning / reordering panels is nice-to-have but not v0.

Status: **idea parked** — this is the most direct mapping to
the queued items: pull onto the table when we start item #3
(Academics dashboard) since it could be the dashboard's main
canvas. Pairs with the Sankey idea (same data, complementary
lens).

---

## Save-for-later: eduCLIMBER "Early Warning" dashboard

Fifth "Save for later" screenshot from the user on Apr 26, 2026.

Reference image: `attached_assets/image_1777213241589.png`

What it is (from the screenshot):
- A **\*Early Warning** dashboard (asterisk in the title implies
  "saved view") with an Edit button top-right and **five tile
  cards** laid out in a responsive grid:
  1. **School Year** filter card (top-left): a multi-select with
     `2020-2021` chip currently selected.
  2. **Students** card: a donut/pie chart of the entire student
     population split by risk band — green = **Low Risk** (the
     dominant slice), yellow = **Some Risk** (medium slice), red
     = **High Risk** (small slice). Legend below the chart.
  3. **By Gender** card: one row per gender bucket (Not Specified
     / F / M) with a horizontal stacked bar showing the share in
     each risk band, plus the raw N to the right (e.g., "1320
     Students" for F).
  4. **By Ethnicity** card: same horizontal-stacked-bar pattern,
     one row per ethnicity bucket. Same color coding so the user
     can scan vertically — any row with a meaningful red segment
     is a disproportionality flag worth investigating.
  5. **By Grade** card: same pattern, 1st through 10th grade,
     with N on the right. Quickly answers "which grade is
     producing the most at-risk kids."
  6. (Partially visible at the bottom-left) **By School** card —
     same pattern, one row per school in the district.
- Color encoding is consistent across every card: green / yellow /
  red = Low / Some / High Risk. That's the magic — once you learn
  it on the donut, every other card is instantly readable.

Why it's compelling for our app:
- This **is** the visual hero for item #6 (Early Warning
  composite). The composite score puts every kid in one of the
  three risk bands; this dashboard is the natural way to slice
  that population.
- Doubles as an equity lens (item #5) for free — the By Ethnicity
  card surfaces disproportionality in the risk score itself,
  which is a more honest lens than just "look at our incidents."
- Five tiles, one filter, zero clicks needed to read — exactly
  the right density for a principal who has 30 seconds before
  the next meeting.

Not-trivial considerations:
- Composite definition: we don't have an Early Warning composite
  yet (item #6 in the queue). The composite needs a defined
  formula — typically academics + behavior + attendance + supports
  rolled up to a 0-100 score with cut points for the three bands.
  This dashboard is the *consumer* of that composite; we have to
  build the composite first.
- Multi-axis breakdown plumbing: each card is the same query
  (population × risk band × dimension). Build one server endpoint
  that takes the dimension as a param (`?by=gender|ethnicity|grade|school`)
  and the cards become a thin wrapper around the same component.
- Edit button: implies user-saved dashboard configurations.
  Stage-2 polish, not v0.
- Same equity / privacy / small-N concerns as the Risk Ratio idea.
  Need an "insufficient sample" treatment for tiny ethnicity
  buckets so a 4-student row doesn't dominate the visual.

Status: **idea parked** — this is the natural hero view for
item #6 (Early Warning composite) **once item #6 is built**.
Sequence is: build the composite scoring engine first, then this
dashboard becomes a thin consumer of it. If we ever need to
prove the composite is working, building this view at the same
time is the fastest way to make the math visible.

---

## Save-for-later: eduCLIMBER "Tier 2 Student Referral Form" (printable)

Sixth "Save for later" screenshot from the user on Apr 26, 2026.
**Different category** from the previous five — this one is a
*printable document generated from the data*, not a dashboard. The
others answer "what's happening across the school"; this one is
the artifact a teacher hands to the MTSS team to start a Tier 2
referral conversation.

Reference image: `attached_assets/image_1777213280099.png`

What it is (from the screenshot — page 1 of 2):
- Printable PDF-style report with the school's branding/logo at
  the top-left and the school's address block top-right (district
  name, street, city/state/zip).
- Title: **Tier 2 Student Referral Form**.
- **Student Information** section (teal header band): name,
  school, grade, plus a free-text **Student Strengths** paragraph
  ("Westin is a fun, energetic 3rd grader …"). Strengths-first
  framing is deliberate and important — sets a respectful tone
  before listing concerns.
- **Staff Information** section: "Individual completing form" +
  "Role in District". Audit trail for who initiated the referral.
- **Areas of Concern** section: checkbox row (Reading / Math /
  Social-Emotional / Other) with "Reading" checked.
- **Reading** detail section (one section per concern checked):
  - Subtitle "FAST - FAST - aReading"
  - Most-recent score in big type ("465")
  - Risk-band ribbon (red-yellow-green gradient) with an X marker
    placed in the red zone and a "High Risk" caption above it.
  - Multi-line trend chart spanning Aug → May with overlays:
    score (yellow line), grade_average (teal), 17-18 25%ile,
    17-18 50%ile, Aug '19 25%ile, Aug additional baseline. Same
    norm-comparison pattern as the Program Evaluation idea above.
- Page footer: form name + "1/2" page indicator (so there's a
  second page — likely additional concern sections + interventions
  already attempted + signature/date block).

Why it's compelling for our app:
- **High-leverage workflow piece.** Schools live in
  printed/PDF'd referral forms; MTSS team meetings open with
  exactly this artifact. Generating it from data we already have
  saves teachers a 30-minute manual data-pull every time they
  refer a kid.
- Consumes data we already collect: student demographics,
  FAST PM scores + cut-band placement, intervention history.
  Strengths/concerns are the only free-text bits — those become
  form fields the teacher fills inline.
- Pairs with our existing `mtssPlans` workflow — the referral
  form is the *front door*; the MTSS plan is what comes out the
  *back door* once the team accepts the referral.

Not-trivial considerations:
- PDF generation pipeline: we don't have one yet. Options:
  - Server-side: `puppeteer` / `playwright` rendering a printable
    HTML route (heavy dep, but pixel-perfect).
  - Browser-side: print-stylesheet `@media print` on a dedicated
    React route + `window.print()` (lightweight, "good enough"
    for v0; harder to email/archive).
  - Library: `@react-pdf/renderer` (declarative, mid-weight,
    cleanest typography).
  My instinct: ship v0 as a print-styled route, then upgrade to
  `@react-pdf/renderer` if the user wants attached PDFs in
  emails or stored in object storage.
- Form lifecycle: this isn't just a print job — it's a *record*.
  Need a `tier2_referrals` table that stores the filled-out form,
  who created it, when, what the concerns + strengths text were,
  and a state machine (Draft → Submitted → Reviewed → Plan
  Created / Declined). The print layout is just one rendering of
  the underlying record.
- Demographics & audit: the form shows the school address +
  district code — pull from the existing school-branding /
  school-settings tables we already maintain.
- Multi-concern pages: each checked Area of Concern adds a
  detail section (with the relevant assessment/behavior data).
  Reading uses FAST aReading; Math would use FAST aMath; SEL
  would use whatever screener we add (BIMAS / SAEBRS — which is
  itself a data-import side-quest); "Other" is a free-text
  textarea.
- Permission: who can *create* a referral (any teacher) vs who
  can *act on* one (MTSS team only). Maps cleanly to existing
  role plumbing.

Status: **idea parked** — this is a workflow artifact, not a
dashboard, so it doesn't fit any single ledger item perfectly.
Best opportunistic moment to surface it is **alongside item #4
(SEB/SEL dashboard)** since SEB referrals are one of the most
common Tier 2 paths, and we'll be touching support-side data
plumbing anyway. Or as its own follow-up item once the user has
seen the dashboards and asks "great, now how do we *act* on
this data?"

---

## Save-for-later: eduCLIMBER "Student Profile" single-pane

Seventh "Save for later" screenshot from the user on Apr 26, 2026.
**Important context:** we already *have* a Student Profile in our
app (`artifacts/client/src/components/StudentProfile.tsx`), so
this screenshot is best read as "what theirs has that ours
doesn't yet" — a gap-list, not a from-scratch build.

Reference image: `attached_assets/image_1777213380077.png`

What it is (from the screenshot):
- Top header strip: product logo + breadcrumb scope tabs
  (District / School / Grade) and the usual icon row top-right
  (calendar, mail, notifications, app-switcher, account).
- Left icon rail (vertical) with ~12 entry points: add, favorite,
  building (school), person (current — Profile), **3D**, photos,
  briefcase, calendar, target, flag, list, cloud-upload,
  settings. Implies the profile is one entry in a deep
  per-student tool palette.
- **Top KPI strip** — 7 colored tiles spanning the page:
  - 78% Full Day Rate (blue)
  - 98.9% SIS Reported Rate (purple)
  - 24 Forms (teal)
  - 27 Comments (pink)
  - 4 Tags (blue)
  - 2 Observations (orange)
  - 4 Thresholds (purple)
  Pure scannability — every important count for this kid in one
  glance.
- **Three-column body** below the KPIs:
  - **Left column — Student Information**: Demographics tab with
    profile photo, DOB, Gender, Ethnicity chip, School chip,
    Grade chip, plus Student Data / Attachments (2) / Assigned
    Staff (2) counters at the bottom.
  - **Middle column top — Incidents**: small list with one row
    per incident type and a count (Anecdotal 3, School
    Psychologist Visit 2, Health Office Visit 1, Outside Agency
    Contact 2, Minor 1). Plus button to add.
  - **Middle column bottom — Interventions**: card-per-plan list.
    Each card shows intervention name, subject + year, **status
    pill** (red "Not on Track" or green "On Track"), and ROI math
    (Plan ROI 0.75 / Goal ROI 1.25 / Latest Score 11.00). This is
    the slope-of-improvement vs goal-line math we currently do
    inside the MTSS plan detail — surfacing it on the profile
    card itself is the upgrade.
  - **Right column — Latest Assessment Scores** (the dominant
    real estate, ~50% of width): tabbed panel (All / Literacy /
    Mathematics / SEB / Specials) with one *sub-card per
    assessment* inside each tab:
    - Literacy: DnA Benchmarks (Pre 73 / Post 97), FastBridge
      aReading (Fall 123 / Winter 170), Reading Level (Beg C /
      Mid D / End G), iReady Overall Reading (Fall 569 / Winter
      630)
    - Mathematics: DnA Benchmarks (Fall 216.6 / Winter 232),
      FastBridge aMath (Pre 73 / Post 97)
    - Social-Emotional/Behavior: My SAEBRS (Term 2 MP:1
      87.660 / MP:2 78.630 / MP:3 81.960 / MP:4 81.430)
    - Combined Performance: Student Engagement (Pre Strength /
      Inst Average), Parent Engagement (Pre No / Inst Need),
      Home WiFi/Internet (Pre No / Inst Modem), Participation
      (Q3 50 / Q4 80) — *this is the engagement screening data
      we already collect in our SchoolStartScreener!*
- **Color encoding** is the same color language used elsewhere
  in the product: each data-point chip is red / yellow / green
  based on cut-band placement, so a parent or new teacher can
  read the whole profile without knowing what "232" means on the
  DnA aMath assessment.

What ours already has (so we don't double-build):
- Student Information card with photo, demographics, school/grade
  chips. ✓
- Interventions list (via `mtssPlans`) with status. ✓ (but the
  "Plan ROI / Goal ROI / Latest Score" surfacing is *not* on the
  profile card — it's buried in the plan detail.)
- Some assessment data (FAST PM scores). ✓ (but rendered as a
  table, not as the per-assessment colored-chip sub-cards.)
- Engagement screener data (the "Combined Performance" cluster
  in their bottom-right is essentially our SchoolStart screener
  results). ✓

What we'd add to match this pane (gap-list, ranked):
1. **Top KPI strip.** 5-7 tiles aggregating the most-clicked
   counts for this kid (Full Day Rate, Forms, Comments, Tags,
   Thresholds met). High signal for low effort — a few SQL
   counts wrapped in a colored card.
2. **Plan ROI on the profile card.** Move the "Plan ROI / Goal
   ROI / Latest Score" math from the plan detail onto the
   intervention summary card. We already compute it.
3. **Per-assessment colored-chip sub-cards** for the assessments
   panel. This is the biggest visual upgrade — replaces the
   current table view with scannable card-per-assessment chips.
   Re-uses existing FAST cut-band placement; needs a generic
   "ChipCard" component.
4. **Tabbed assessment categories** (All / Literacy / Math / SEB
   / Specials) so the panel can hold many years of data without
   becoming a wall.
5. **Comments / Tags / Forms counters** — implies we'd need
   tables for each of those workflows. Out of scope for v0;
   list as future once we add the Forms feature.
6. **3D view entry point on the left rail** — that's the
   Students 3D portrait grid idea we already saved (Save-for-later
   #1). Worth noting that *eduCLIMBER itself* puts a 3D entry
   point in the per-student rail, not just the cohort overview.

Why it's compelling for our app:
- Closes the "I have to click into 5 tabs to see what's
  happening with this kid" complaint that every MTSS tool gets.
- Re-uses data we already collect. The work is mostly visual
  composition — colored-chip cards and a top KPI strip — not
  new data plumbing.
- The user already values our existing profile (it's wired up
  as the `studentProfileReturnTo` target across multiple
  dashboards), so this is upgrading the most-trafficked page in
  the app.

Not-trivial considerations:
- Don't rebuild — *upgrade*. Specifically protect the existing
  return-to-profile navigation flows that depend on the current
  component shape and the `studentProfileReturnTo` setting in
  App.tsx. Any rework needs to leave those entry points stable.
- Top KPI strip needs cut-thoughtful counts. We don't currently
  track Forms/Tags/Comments — for v0 the strip should only show
  KPIs we can compute today (Full Day Rate, Engagement Score,
  Plan-on-Track Count, Open Thresholds). Skip Forms/Comments
  until we add those features rather than showing fake zeros.
- Tab discipline: the "All" tab implies showing every assessment
  card at once. Easy to make this a wall — limit to most-recent
  N years per assessment + a "show older" affordance.
- Assessment chip placement requires every assessment to have a
  defined cut-band schema. We have that for FAST PM via
  `placePm3` / `placeOnChart`; we'd need similar for any
  additional assessments before they get colored chips (or fall
  back to neutral chips for unscored data).

Status: **idea parked** — this is the *most product-leverage*
of the seven saved ideas because it upgrades the page the user
already cares most about. No single ledger item triggers it;
best surfaced as a **standalone "Student Profile v2" follow-up
item** once items #3 (Academics) and #4 (SEB/SEL) ship, since
those will produce the per-assessment colored-chip components
this profile would re-use.

---

## Save-for-later: eduCLIMBER "Incident Charting" small-multiples

Eighth "Save for later" screenshot from the user on Apr 26, 2026.
**Important context:** we already shipped **item #2 (Behavior
dashboard)** which has KPI strip + dense trends + top-N lists.
This screenshot is a *forensic / small-multiples* lens on the
same incident data — different shape, complementary purpose, not
a replacement for the dashboard we already built.

Reference image: `attached_assets/image_1777213403180.png`

What it is (from the screenshot):
- Title: **Incident Charting** with a back arrow (so this is a
  drill-through reachable from the top-level Behavior page).
- **Severity filter chip** at the top: "Minor" (with an X to
  remove). Implies the same view exists for Major incidents.
- **Tab strip**: "Big Five" (selected) / "Range Charts". The
  Big Five tab is the canonical forensic view; Range Charts is
  presumably a configurable date-range comparison.
- Header: a single **"What"** sub-heading suggesting other
  category tabs (Where / When / Who) might exist as horizontal
  slices, but in this Big Five layout they're rolled into one
  scroll.
- **8-card grid of small-multiple bar charts**, each filtered
  to the selected year (2020-2021) with a year picker per card:
  - Row 1: **By Primary Incident Type** (one tall bar — "Minor"
    only because of the filter), **By Primary Incident Code**
    (~14 codes ranked by count), **By Response** (~10 response
    types ranked by count).
  - Row 2: **By Month** (Jul-Jun school-year axis), **By
    Weekday** (Mon-Sun), **By Hour** (8AM-3PM).
  - Row 3: **By Location** (~13 location categories ranked),
    **By School** (~17 schools ranked).
- Every card has the same chrome: title left, **pin / expand /
  kebab** icons right, year picker below the chrome, single
  legend chip ("● 2020-2021") under the bar. Pin = save to a
  custom dashboard. Expand = full-screen the chart.
- All bars use the same blue. The story is "compare counts within
  a single dimension" — the lack of color encoding is
  intentional, it keeps the eye on the *shape* of each
  distribution.

Why it's compelling for our app:
- **Forensic complement to item #2.** Our behavior dashboard
  answers "how are we doing this term?"; this view answers "what
  patterns hide in the data?" — when do incidents cluster, where
  do they happen, which response is being over-used. PBIS
  coordinators live in this view between team meetings.
- The hardest one to skip is **By Hour** + **By Weekday** + **By
  Location** in combination. Those three bars together
  immediately surface the "we have a problem at the cafeteria
  on Wednesday afternoons" pattern that no KPI strip can show.
- 8 cards, one filter chip, no clicks to read — same density
  philosophy as the Early Warning dashboard.

What ours already has (so we don't double-build):
- The underlying `pbisEntries` data with type, reason, response,
  timestamp, location, school. ✓ (every dimension this view
  needs we already collect.)
- The window/grade auth + voided_at filter + empty-cohort
  fast-path scaffolding from `GET /api/insights/behavior`. ✓
- The school-days-only seeding so the day-of-week / hour
  distributions look realistic. ✓ (Important: we already seeded
  on school days only, so a By Weekday chart wouldn't have fake
  weekend spikes.)

What we'd add to match this view (gap-list, ranked):
1. **"By Hour" and "By Weekday" extractions** on the existing
   incident endpoint. Cheap — a single grouped count per
   dimension.
2. **"By Location"** — we have location strings on entries
   already; needs a normalized location categorical column or a
   server-side bucketization step.
3. **Severity filter chip** (Minor / Major). We have a severity
   field already; just need a filter param.
4. **Small-multiples component**. A reusable
   `<DistributionBarCard title dimension data />` — every card
   on this page is the same component with a different
   dimension. Ship once, use 8 times.
5. **Pin-to-dashboard** affordance. Stretch — implies user-saved
   dashboard configurations (same Stage-2 polish flag as the
   Early Warning Edit button). Skip for v0.

Not-trivial considerations:
- This view tempts you to add 8 separate endpoints. Don't —
  build one endpoint that takes `?by=type|code|response|month|weekday|hour|location|school`
  and returns `{ buckets: [{label, count}] }`. The frontend
  fans out 8 calls in parallel. Same parameterized pattern we
  already use in the engagement and behavior endpoints.
- Hour-of-day extraction depends on every incident having a
  recorded *time* (not just a date). We need to verify our
  seed data has plausible time-of-day stamps; if it's noon-only,
  the By Hour chart looks fake.
- Severity filter has to be plumbed into every dimension query —
  pass through the `?severity=minor|major|all` param.
- "Range Charts" tab is a separate idea and not a priority.

Status: **idea parked** — this is the natural **drill-through
from the existing Behavior dashboard** (item #2, already
shipped). Best surfaced as a "Behavior Dashboard v2 — Forensic
view" follow-up after the Academics dashboard ships, so the
small-multiples component we'd build can be reused on the
Academics page (e.g., score-distribution histograms by school /
grade / window). Eight saved ideas in the parking lot now.

---

## Save-for-later: eduCLIMBER "CICO Point Sheet" Tier 2 monitor

Ninth "Save for later" screenshot from the user on Apr 26, 2026.
**Important context:** this is a *specific Tier 2 intervention*,
not a dashboard category. CICO ("Check-In / Check-Out") is one
of the most widely-used evidence-based Tier 2 behavior
interventions in K-12 — a student carries a daily point sheet
that teachers rate at the end of every period across a small set
of expectations (Be Safe / Be Respectful / Be Responsible / etc.),
and the kid checks in with a coach in the morning and out in the
afternoon. This screen is the **per-student progress monitor**
that the coach uses to decide if the intervention is working.

Reference image: `attached_assets/image_1777213461995.png`

What it is (from the screenshot):
- Title: **Behavior (Point Sheet): CICO (Dec 31st, 19 to Feb
  13th, 20)** with a dropdown caret on the title (likely lets
  the coach swap between this kid's *other* active point sheets,
  if they have multiple).
- Pin icon top-right (same pin-to-dashboard pattern as the other
  eduCLIMBER charts).
- Filter row: **Date Range** picker + **Quick Ranges** dropdown
  (Last 7 days, This week, Last month, etc.).
- **Tab strip**: Summary (selected) / Goal / By Period / By
  Expectation. Summary is the at-a-glance; the other tabs drill
  into a single dimension.
- **Summary card (top-left, ~50% width)**: huge centered KPI
  block:
  - "Overall Percentage Earned" → **84.63%**
  - "Goal 80%" (the threshold for "intervention is working")
  - "Average Score 3.385294" (mean per-rating score on what
    looks like a 1-4 scale)
  This single number is what the MTSS team meeting will open
  on. Above goal = continue / fade. Below goal = intensify or
  switch.
- **By Day of Week card (top-right)**: 5 horizontal blue bars
  (Mon-Fri) with x-axis "Percentage Earned Toward Goal" 0-100.
  Surfaces day-pattern issues — e.g., Monday is dragging at 65%
  while Tue/Thu hit 95%+.
- **By Expectation card (bottom-left)**: 5 horizontal bars, one
  per expectation on this kid's specific point sheet (Keep Hands
  to Self / Raises hand to speak / Respectful / Responsible /
  Safe). Diagnoses *which* expectation needs explicit teaching
  vs which is already mastered.
- **By Period card (bottom-right)**: 8 horizontal bars, one per
  period in the school day (Morning Meeting / Writing / Math /
  Science / Lunch/Recess / Specials / Reading / Social Studies).
  Diagnoses *when* during the day the kid struggles — the most
  actionable single chart on the page (Math at 60% vs everything
  else at 85%+ → Math teacher needs the strategy conversation).
- All four charts use the same blue. Goal line is implicit (the
  80% number) — could be a vertical reference line on each bar
  chart for added visual punch.

Why it's compelling for our app:
- **Plugs directly into our existing MTSS system.** We already
  have `mtssPlans` for Tier 2/3 intervention tracking. CICO
  becomes a *typed* MTSS plan (`type: 'cico'`) with structured
  daily score capture instead of free-text progress notes.
- Daily point-sheet capture is the only common workflow no part
  of our app touches yet — the gap between "we identified a kid
  needs help" (Early Warning / Behavior dashboard / referral
  form) and "we know if the help is working" (this view).
- Same data also feeds **fidelity tracking** ("did the teacher
  actually fill out the point sheet today?") which is its own
  Tier-2-team meeting question.

Not-trivial considerations:
- **New data plumbing required.** Need at least:
  - `cicoPointSheets` (template per kid: list of expectations,
    list of periods, scoring scale 1-N, goal %, start/end dates)
  - `cicoPointSheetEntries` (one per period per day per kid:
    score 1-N or absent, optional teacher comment, who entered)
  This is the only saved idea that requires schema work
  meaningful enough to call out before starting.
- **Daily entry UX.** This view is the *consumer*; the *producer*
  is a teacher quickly tapping period scores during the day. A
  teacher-facing entry screen (probably mobile-friendly, one
  card per kid on their roster, three taps to score and save)
  is the harder build than this dashboard.
- **Goal-line reference**: add a vertical 80% line on each bar
  chart. Tiny visual, big readability win — the eye should
  immediately see which bars cleared goal and which didn't.
- **Multi-sheet picker** (the dropdown in the title) — a kid
  can have CICO for behavior *and* a separate point sheet for
  academic engagement. Title acts as a switcher between active
  point sheets for the same student.
- **Fade-out math.** CICO best practice fades the kid off the
  intervention after 4 consecutive weeks above goal. The system
  should surface a "ready to fade" badge automatically, not
  require the coach to count weeks manually.

Status: **idea parked** — this is a **substantial**
intervention-tracking feature, not just a chart. The dashboard
in the screenshot is the easy half; the daily-entry workflow
and the data model are the real work. Best surfaced as its own
follow-up item *after* item #4 (SEB/SEL dashboard) ships, since
the SEB dashboard will identify the kids who *need* CICO and
this becomes the natural "now what?" workflow that follows.
Pairs with the Tier 2 Referral Form idea (Save-for-later #6) —
together they are the full Tier 2 lifecycle. Nine saved ideas
in the parking lot now.

---

## Jen Merschbach District User created (Apr 26, 2026)

User asked for a District User account for jen.merschbach@hcsb.k12.fl.us
(Hernando County School District, password "PulseDemo!"). Created staff
row id=480, displayName "Jen Merschbach", schoolId 1 (D. S. Parrott
Middle School — cosmetic home; District Admins have access to every
school in their district), `is_district_admin=true`, all other flags
default. Verified bcrypt hash via `bcrypt.compare()` round-trip
(correct password verifies, wrong password rejects).

**Why no `is_admin=true` too**: scope.ts line 30's combined gate is
`isSuperUser || isDistrictAdmin || isAdmin`, so District Admin alone
already grants school-admin operations across the district. Only set
`is_admin` if you want a *district admin* who is also restricted to
acting as a *school admin* in some other context — not the case here.

**bcryptjs import gotcha** (recurring in the code execution sandbox):
`import("bcryptjs")` fails with ERR_MODULE_NOT_FOUND because the sandbox
runs from the workspace root and bcryptjs is hoisted under pnpm's
.pnpm node_modules. Use the full path:
`await import("/home/runner/workspace/node_modules/.pnpm/node_modules/bcryptjs/index.js")`.

---

## Equity dashboard — drag-and-drop subgroup tile reorder (Apr 26, 2026)

User wanted to reorder the bottom subgroup-snapshot tiles on the Equity
dashboard and have the order **persist across devices** (so a District
Admin who logs in on a laptop at home and a tablet at school sees the
same arrangement). Scope: Equity dashboard only — other dashboards keep
their default order.

**Storage model — generic per-user UI prefs.** Added `staff.ui_prefs`
jsonb column (default `'{}'`, NOT NULL). Each future per-user pref owns
its own top-level key in the bag. Today's only key:
`equitySubgroupOrder` → array of SubgroupKey strings. Schema change
applied via direct `ALTER TABLE staff ADD COLUMN IF NOT EXISTS ui_prefs
jsonb NOT NULL DEFAULT '{}'::jsonb` (db:push hangs on an unrelated
districts_slug_unique prompt — direct SQL is the workaround for
additive schema changes; pattern documented earlier in this doc).

**Endpoints** (`artifacts/api-server/src/routes/uiPrefs.ts`, mounted
under `/api`):
- `GET /api/me/ui-prefs/equity-subgroup-order` → `{ order: SubgroupKey[] | null }`
- `PUT /api/me/ui-prefs/equity-subgroup-order` body `{ order: ... }`

Both gated by `req.staffId` + a fresh `staff.active` check (matches
heartbeatSettings active-gate pattern — a live session can outlive a
deactivation, so re-check on every read/write). Validation rejects
non-arrays, unknown SubgroupKeys, duplicates, and oversized arrays.
Corrupted stored values surface as `order: null` on read so the client
falls back to the server's natural order rather than 500ing.

**Frontend** (`artifacts/client/src/components/EquityDashboard.tsx`):
Replaced the static `SubgroupSnapshotGrid` with `ReorderableSubgroupGrid`.
- On mount: fetches saved order, applies it via `applySavedOrder()`
  (unknown subgroups land at the end so a newly-added SubgroupKey shows
  up without forcing a re-save; saved entries with no matching snapshot
  are silently dropped).
- HTML5 drag-and-drop on each tile with a custom MIME
  (`application/x-equity-subgroup`) so we don't pick up stray text drags.
  Visual cues: dragged tile drops to opacity 0.4, drop target gets a
  dashed indigo outline.
- Save is debounced 400ms via `setTimeout`/`clearTimeout`, plus a
  cleanup-effect flush on unmount so a quick "drag then navigate"
  doesn't lose the choice.
- savedOrderRef holds the order across grade-filter refetches so the
  user's arrangement survives changing the grade dropdown.

**Known v1 limitations (intentional, deferred):**
- Mobile/touch: HTML5 dnd doesn't fire touchstart-style drag events on
  mobile. Touch-drag would need a polyfill or react-dnd-touch-backend.
- Keyboard a11y: no arrow-key reorder fallback. If we add this, the
  cleanest path is a "keyboard mode" toggle that turns each tile into
  an arrow-keyed list item.
- RMW clobber: if a second pref key lands in `ui_prefs` later and two
  tabs write different keys at the same time, last-write-wins on the
  whole bag. With one key today this is moot; switch to `jsonb_set`
  partial update when adding the second key.

**Architect: PASS.** No CRITICAL/HIGH findings. Three LOW findings:
empty-array rejection (no API reset; UI never sends empty so moot),
RMW clobber (documented above), and the active-gate (addressed —
loadPrefsIfActive checks `staff.active` on every call).

────────────────────────────────────────────────────────────────────────
SESSION NOTE — Early Warning: collapsible "How to use" help panel
────────────────────────────────────────────────────────────────────────
Why: Staff opening Early Warning for the first time had no in-app
explanation of what the 0-100 score means, how the four pillars are
calculated, what the bands signal, or how to act on the leaderboard.
External docs are not where teachers look — they need it on the page.

What shipped:
- New `HowToUsePanel` component in
  `artifacts/client/src/components/EarlyWarningDashboard.tsx`,
  rendered immediately under the dashboard header (above KPI strip).
- Click-to-toggle button (defaults closed). Uses `aria-expanded` +
  `aria-controls` for screen readers; chevron rotates 90° on open.
- Open state intentionally NOT persisted — staff who close it almost
  always want it closed on next visit. Per-user persistence would just
  cost a `ui_prefs` round-trip for a one-time read.
- Sections: "What this dashboard is", "How the score is calculated"
  (per-pillar 0-25 budget + 30d window + Aca/Beh/Eng/Sup chips),
  "What the risk bands mean" (5 BandRow chips reusing BAND_COLORS so
  help text and live data line up), "How to use it day-to-day"
  (start-at-top, High+Critical headline, Unsupported high-risk pill,
  grade filter, click-row-to-profile, pillar legend),
  "A few caveats" (triage not diagnosis, 30d recency, footer source
  counts).
- Three small helper components added to keep the section markup
  consistent: `HowToSection` (subhead wrapper), `PillarSwatch`
  (inline pillar chip — same colour/abbrev as PillarBar so the user
  can pattern-match later), `BandRow` (band chip + range + meaning).

Caveats considered:
- React.CSSProperties / React.ReactNode used without an explicit
  React import — same pattern as App.tsx and EquityDashboard.tsx.
  TS `react-jsx` mode + @types/react makes the namespace global.
- HMR confirmed clean update (`/src/components/EarlyWarningDashboard.tsx`
  hot updated, no console errors).
- Pre-existing TS errors in App.tsx are NOT introduced by this change
  (verified by file path — none match EarlyWarningDashboard.tsx).
- No backend changes. No schema changes. No new routes.

Follow-ups (not done, not needed):
- Could add the same pattern to other insights dashboards (Equity,
  Behavior, Academics, Engagement). Not requested; only Early Warning
  was raised.

================================================================
SESSION NOTE — How-to-use panel rolled out to all 5 sibling
insights dashboards  (2026-04-26, follow-up to EWS panel)
================================================================

Goal: Take the click-to-expand "How to use" panel that shipped on
Early Warning and put the same pattern on every other insights
dashboard so staff get in-page orientation everywhere — Academics,
Behavior, Engagement, Equity, SEB/SEL.

What changed:
- New shared component `artifacts/client/src/components/HowToUseHelp.tsx`
  exporting `HowToUseHelp` (the collapsible shell), `HowToSection`
  (subhead wrapper), and `howtoListStyle`. Accepts `title` and any
  React children. Open state is local, NOT persisted (matches EWS
  decision — staff who close it want it closed next visit too).
- `EarlyWarningDashboard.tsx` refactored to consume the shared shell.
  Its old inline `HowToUsePanel` is now a thin wrapper returning
  `<HowToUseHelp title="How to use Early Warning">…</HowToUseHelp>`.
  Local duplicate `HowToSection` and `howtoListStyle` deleted.
  EWS-specific helpers `PillarSwatch` and `BandRow` stayed local.
- Each of the 5 sibling dashboards got an import of the shared
  helpers + a `<HowToUseHelp>` block placed right after the header
  flex div, before the loading conditional. Sections per panel:
  "What this dashboard is", "What the KPIs mean", "How to read the
  charts/lists", "How to use it day-to-day", "A few caveats".

Numeric accuracy (architect already burned us once on EWS — verified
each claim against insights.ts):
- Academics: PM3 average is the average raw FAST scale score, NOT
  an average level (1-5). Backend sums `r.pm3` (raw column) at
  insights.ts:2189-2190. Help text says "average FAST scale score …
  scale-score → level cutoff is grade- and subject-specific." Architect
  missed this; we caught it during verification.
- Equity: 1.30 risk-ratio threshold confirmed at insights.ts:3224
  (`RATIO_HIGH = 1.3`).
- SEB/SEL: multi-risk requires ≥ 2 of 4 flags (insights.ts:2664).
  The 4 flags: active plan, prior-year FAST BQ
  (`priorYearBq=true` at line 2611), ≥ 3 negative PBIS in last 30d
  (line 2599 `if (n >= 3) recentNegatives.add(sid)`), and IEP/504.
  Help text now spells out the ≥ 3 threshold and the prior-year BQ
  qualifier explicitly.
- Behavior: 4:1 positive:negative ratio cited as the standard PBIS
  Tier-1-healthy benchmark (Cook/Sprick literature). EWS does NOT
  use this ratio — its Behavior pillar is a count of negatives, and
  its Supports pillar is plan-tier-based. Architect flagged a "5:1
  vs 4:1 inconsistency" but that was a confidently-wrong claim:
  there is no 5:1 anywhere in the codebase.

Architect findings rejected (verified false):
- "EWS panel placement is in Body" — false; `<HowToUsePanel />` sits
  before the loading conditional at EarlyWarningDashboard.tsx:202,
  identical to siblings.
- "EWS uses 'What to watch out for' heading" — false; EWS used
  "A few caveats" (matches the new sibling panels).

Caveats considered:
- HMR confirmed clean update for all six files (workflow logs show
  `hmr update` lines for each, no errors).
- Pre-existing TS errors in App.tsx are not introduced by this
  change (verified — no errors mention any HowTo* or *Dashboard.tsx
  file).
- No backend changes. No schema changes. No new routes.
- Visual screenshot blocked by login (auth required); HMR + tsc
  signal trusted instead.

Files touched:
- artifacts/client/src/components/HowToUseHelp.tsx (NEW)
- artifacts/client/src/components/EarlyWarningDashboard.tsx (refactor)
- artifacts/client/src/components/AcademicsDashboard.tsx
- artifacts/client/src/components/BehaviorDashboard.tsx
- artifacts/client/src/components/EngagementDashboard.tsx
- artifacts/client/src/components/EquityDashboard.tsx
- artifacts/client/src/components/SebSelDashboard.tsx

## Phase 4 Final · Attendance dashboard — Weather + Recent events (2026-04-26)

Three improvements to the existing Attendance dashboard. All scoped to
`/api/insights/attendance` and `AttendanceDashboard.tsx`:

1. **Weather module** — for attendance-correlation insight ("did rain
   knock attendance down?"). Real Open-Meteo data (no API key needed).
2. **Recent events table** — PBIS-style log of the 25 most-recent
   absence/tardy entries at the bottom of the dashboard, newest first,
   with clickable student names.
3. **"Recent (7d)" pill** — relabeled the existing 7-day window button
   from "7d" to "Recent (7d)" so the meaning is obvious at a glance.

### Data layer
- Added `latitude`, `longitude` (doublePrecision, nullable) to
  `lib/db/src/schema/schools.ts`. Backfilled the 7 demo Hernando County
  schools with Brooksville FL coords (28.5544, -82.3885).
- New `lib/db/src/schema/weatherDay.ts` — one row per (school, day) with
  `tempHighF`, `tempLowF`, `precipInches`, `weatherCode` (WMO), `summary`
  (short label). Unique idx on (schoolId, day).

### Backend
- New `artifacts/api-server/src/lib/weatherFetcher.ts` — wraps
  Open-Meteo `/v1/forecast` with `past_days=62`. 8s AbortController
  timeout, returns `[]` on any failure (no key required, no fallback
  synthetic data — empty array → "no data" UI state). Includes
  `summarizeWeatherCode()` for WMO → short label mapping.
- `artifacts/api-server/src/seed.ts` — added per-school weather seed
  block (~line 1405) gated by `wxExisting <= ENGAGEMENT_SEED_THRESHOLD`
  (=0). Idempotent via `.onConflictDoNothing()` on the unique idx.
  Network failure logs a warning and continues (does not block seed).
  Added `weatherDayTable` to the truncate list.
- `artifacts/api-server/src/routes/insights.ts` — augmented the
  attendance route response with two new arrays:
  - `weather: WeatherDay[]` — window-scoped, school-wide (no cohort
    narrowing — weather is the same for everyone), sorted ascending.
  - `recentAbsences: RecentAbsenceRow[]` — last 25 absence/tardy
    entries in the window for the cohort, newest first, with student
    name resolved (reuses the existing `nameById` map and only
    queries Postgres for missing IDs).
  Both are also returned as `[]` in the `emptyResponse()` path so the
  client never has to defend against `undefined`.

### Client
- `artifacts/client/src/components/AttendanceDashboard.tsx`:
  - Imported `ComposedChart`, `Bar`, `Line` from recharts.
  - Added `WeatherDay` and `RecentAbsenceRow` types to
    `AttendanceResponse`.
  - Renamed the "7d" pill label to **"Recent (7d)"**.
  - New `WeatherCard` — composed chart with precip bars (left axis,
    inches) + high-temp line (right axis, °F) + dashed attendance-rate
    line (rescaled into the temp axis for visual comparison; tooltip
    resolves the real % from row payload). Below the chart: avg high,
    total rainfall, count of wet days (≥0.1"). Empty state prints a
    friendly message instead of an empty card.
  - New `RecentAbsencesTable` — Date / Student (clickable, opens
    profile) / Status pill (color-coded excused/unexcused/tardy) /
    Periods ("All day" or "Periods 1, 3, 5"). Lives in its own row
    below the top-N tables.
  - Two new HowToSection blocks: "Weather vs attendance" and
    "Recent events".

### Validation
- DB sanity: 6 schools have 63 weather rows each (real data: 83.7°F
  highs, "Cloudy" labels, etc.). Hit endpoint as super-user (Chris
  Clifford / @Leopards) and confirmed: 31 weather rows + 25 recent
  absences over 30d window for school 1 (cohort 875 students,
  ADA 96.02%).
- Architect code review passed — no blocking issues. Verified no
  cross-school leakage, FK safety, idempotency, tooltip-math
  correctness, and query performance for the cohort `inArray`.
- Pre-existing TS errors in App.tsx (HubKey narrowing) and seed.ts
  (any inference) are NOT regressions — none touch the new code paths.

Files touched:
- lib/db/src/schema/schools.ts (added lat/lon)
- lib/db/src/schema/weatherDay.ts (NEW)
- lib/db/src/schema/index.ts (barrel export)
- artifacts/api-server/src/lib/weatherFetcher.ts (NEW)
- artifacts/api-server/src/seed.ts (weather seed block + truncate)
- artifacts/api-server/src/routes/insights.ts (route augmentation)
- artifacts/client/src/components/AttendanceDashboard.tsx (UI)

## Watch List graduations — system Watch List card-grid + new "My Watch List" (Apr 26, 2026)

**Two parallel graduations from the mockup-sandbox canvas to the live app:**

### A. System Watch List → card-grid view

**`artifacts/client/src/components/InsightsWatchlist.tsx`** rewritten:
the existing table view is replaced by a card grid (severity stripe,
avatar, signal chips capped at 5+overflow, mini pillar grid for
Acad/Beh/Att/MTSS), KPI tile strip, saved-view pill row, and a
"More filters" collapsible. **All existing filter / sort / preset /
quick-lookup logic is preserved**, and the same `/api/insights/watchlist`
data drives both. `onOpenStudent` + `onOpenSpider` props are unchanged
so the StudentProfile drill-in keeps working from `App.tsx` with no
caller-side changes. Title relabeled "Watch List" (was "Watchlist").
Mockup elements deferred to follow-ups: trend microcopy and "new this
week" badges (current API doesn't expose deltas).

### B. New "My Watch List" — teacher-personal hand-curated list

**Schema** — `lib/db/src/schema/teacherWatchlistEntries.ts` defines
`teacher_watchlist_entries` (id serial PK, staff_id int → staff.id,
school_id int, student_id text → students.student_id, group_key text,
note text, followup_text text null, followup_due date null,
added_at timestamp, last_touch_by/what/at). UNIQUE(staff_id, student_id)
so a kid is on the list at most once per teacher. Exported from the
schema barrel. Created via direct `CREATE TABLE` because drizzle-kit
push-force was blocked on an unrelated interactive rename prompt for
orphan tables (`user_sessions`, `check_in_with_options`); raw create on
a brand-new table is safe (no data loss risk).

**Backend** — `artifacts/api-server/src/routes/myWatchlist.ts` exposes
five endpoints (mounted via `routes/index.ts` as `myWatchlistRouter`,
**relative paths under the `/api` mount** — that's the convention here,
absolute paths like `/api/...` get double-prefixed and 404):
* `GET    /insights/my-watchlist` — list caller's entries with
  hydrated student name/grade. **Re-applies visibility scope at
  hydration time** (roster ∪ trusted-adult, with core-team bypass) so
  if a teacher loses access to a student after bookmarking them, that
  entry's PII is filtered out of the response. Stale entries stay in
  the DB (a future "view archive" affordance benefits from that) but
  aren't surfaced.
* `POST   /insights/my-watchlist` — add `{studentId, groupKey, note?,
  followupText?, followupDue?}`. Server validates studentId is in the
  caller's visibility scope before insert.
* `PATCH  /insights/my-watchlist/:id` — edit `note` / `groupKey` /
  `followupText` / `followupDue`. Non-owner → 404 (don't leak
  existence).
* `POST   /insights/my-watchlist/:id/touch` — log a touch
  `{what}` ("Touched base" / "Called home" / "Pulled aside" or
  free-form ≤80 chars). Server stamps `lastTouchBy` from session +
  `lastTouchAt = now()`.
* `DELETE /insights/my-watchlist/:id` — hard delete (it's a personal
  bookmark; soft delete adds no value).

Auth pattern mirrors `insights.ts`: inline `loadStaff` helper +
`req.staffId` from the cookie/Bearer middleware in `app.ts`. Visibility
helper `visibleStudentIds(staff, schoolId)` is the canonical
roster ∪ trusted-adult check, with a `full: true` shortcut for core
team (SuperUser / Admin / BehaviorSpecialist / MtssCoordinator /
PbisCoordinator).

**Frontend** — `artifacts/client/src/components/MyWatchList.tsx`
renders four hardcoded built-in groups (reading, behavior, family,
shine) as sticky-note cards with quick-action buttons that fire the
touch endpoint, an add+edit modal with student picker (reuses the
same student directory as the system Watch List), follow-up reminder
display, and a stale-touch nudge (>14 days). Custom groups deferred
to a follow-up.

**App.tsx wiring** — added `MyWatchList` import; `"myWatchList"` to
the activeSection union AND the narrower `studentProfileReturnTo`
union (back-target tracking); included in `NAV_GROUP_OWNERSHIP.insights`
so the Insights nav group force-expands for it; sidebar item "My Watch
List" rendered under the Insights group right beneath "Watch List";
render block alongside `insightsWatchlist` that pins the back-target
to `"myWatchList"` on student drill-in.

**Files:**
- lib/db/src/schema/teacherWatchlistEntries.ts (NEW)
- lib/db/src/schema/index.ts (barrel export)
- artifacts/api-server/src/routes/myWatchlist.ts (NEW — 5 endpoints)
- artifacts/api-server/src/routes/index.ts (mounted myWatchlistRouter)
- artifacts/client/src/components/InsightsWatchlist.tsx (table → card grid)
- artifacts/client/src/components/MyWatchList.tsx (NEW)
- artifacts/client/src/App.tsx (import + activeSection union ×2 +
  NAV_GROUP_OWNERSHIP + sidebar item + render block)

### C. Core team can seed entries on a teacher's behalf (Apr 26, 2026 follow-up)

Plain teachers' "My Watch List" was originally entirely self-curated.
Added a flow so admins / MTSS coordinators / behavior specialists /
PBIS coordinators / SuperUsers can drop a student onto a specific
teacher's list (e.g. after a student is referred to MTSS).

Schema: added nullable `added_by_staff_id integer` to
`teacher_watchlist_entries` (drizzle push prompt blocks the column
add — applied via direct `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
since adding a nullable column is a no-op for existing rows). Null =
self-added (the row's owner did it themselves). Non-null = a core
team member seeded the entry on the teacher's behalf.

Backend (`myWatchlist.ts`):
- POST now accepts optional `targetStaffId`. If set and != caller's
  id, requires core-team role (else 403); requires target staff to be
  active at the same active school (else 404); validates visibility
  against the **target** teacher's roster, not the caller's, so
  admins can't seed kids the teacher won't be able to open.
- Sets `addedByStaffId = caller.id` only when on-behalf-of, else null
  (keeps self-add rows visually clean).
- New `GET /insights/my-watchlist/staff-directory` (core team only)
  returns `[{id, displayName}]` to power the picker. Defined before
  any future `:id` GET to avoid route-shadowing.
- Fixed a latent unique-violation handler — Drizzle wraps pg errors
  in `DrizzleQueryError`, so the old substring check on `err.message`
  never matched. Now also checks `err.cause.code === '23505'` and
  `err.cause.constraint === 'teacher_watchlist_staff_student_uniq'`.
  Without this, dup adds returned 500 instead of 409.
- Replaced `staffDisplayName` helper that was reading nonexistent
  `firstName`/`lastName` columns; staff table only has `display_name`.
- GET hydrates `addedBy: { id, displayName } | null` per entry.

Frontend (`MyWatchList.tsx`):
- `Entry` gained `addedBy: { id, displayName } | null`.
- New `currentUser` prop carries auth flags + id (App.tsx passes
  `authUser`).
- Staff-directory fetched only when `isCoreTeamUser(currentUser)` is
  true — avoids 403s for plain teachers.
- `EntryModal` got `staffDirectory`, `allowTargetPicker`,
  `currentUserId`. In add mode for core team, renders a "Add to
  whose watch list?" select defaulting to "My list (default)".
  Edit mode never re-targets (would silently move a row).
- POST body conditionally adds `targetStaffId` only when picker
  selected non-self; "" → omit so server defaults to caller.
- `NoteCard` renders an amber pill "Added by X" only when
  `entry.addedBy` is set.

App.tsx: passes `currentUser={authUser}` to `<MyWatchList>`.

Smoke-tested: staff-directory 200; on-behalf-of POST 201 with
`addedByStaffId` stamped; non-roster student for target → 404;
duplicate → 409 with existing entry returned; self-add path
unchanged with `addedBy: null`.

## My Watch List polish — banner, ack, custom groups + InsightsWatchlist trends (Apr 27, 2026)

Five-item polish push on the Watch List surfaces.

### Schema
- `teacher_watchlist_entries.acknowledged_at timestamp` (nullable).
- New `teacher_watchlist_groups` table: `(id serial pk, staff_id int,
  school_id int, key text, label text, emoji text, created_at)` with
  `UNIQUE (staff_id, key)`. Lets a teacher define their own group
  tabs (e.g. "Math intervention" 🧮) on top of the four built-ins
  (reading / behavior / family / shine).
- Both applied via direct `ALTER TABLE … ADD COLUMN IF NOT EXISTS` /
  `CREATE TABLE IF NOT EXISTS` since `drizzle push` is still blocked
  on a prior interactive prompt; `lib/db` schema files + barrel
  updated to match.

### Backend (`artifacts/api-server/src/routes/myWatchlist.ts`)
- `POST /api/insights/my-watchlist/:id/acknowledge` — only the row's
  owner can ack, and only when `addedByStaffId` is set (self-added
  → 400). Idempotent (re-ack returns the same timestamp). 404 for
  wrong owner so we don't leak existence to other teachers.
- `GET /api/insights/my-watchlist` now hydrates `acknowledgedAt` per
  entry and orders unacked-seeded first
  (`addedByStaffId IS NOT NULL AND acknowledged_at IS NULL`), then by
  `addedAt desc`. Client honors the same order inside each group so
  the pinning works whichever group tab is open.
- `GET /api/insights/my-watchlist/groups` — caller's custom groups
  (no role gate; plain teachers see their own).
- `POST …/groups` — body `{ label, emoji? }`. Server normalizes
  `label → key` (`lowercase`, alphanumeric + `-`, max 40). Rejects
  built-in keys + duplicates → 409 (uses the same
  `DrizzleQueryError → cause.code === '23505'` unwrap pattern as the
  entries table).
- `DELETE …/groups/:id` — only the owner; 409 if any entry still
  references the group's key (we don't auto-orphan).
- POST/PATCH `/my-watchlist` accepts a key only if it's a built-in
  OR one of the caller's custom group keys; else 400. Validation is
  per-caller, so a custom group only widens the keyspace for its
  owner.
- On a successful on-behalf-of POST, `lib/myWatchlistSeedEmail.ts`
  fires a Resend email via `getUncachableResendClient()`. Subject:
  "[PulseEDU] {seeder displayName} added a student to your Watch
  List", body links to the My Watch List section. Wrapped in
  try/catch with one log line on failure — never blocks or reverses
  the create.

### Frontend — MyWatchList (`artifacts/client/src/components/MyWatchList.tsx`)
- `Entry.acknowledgedAt: string | null` added; `CustomGroup` interface
  + `customGroups` state + `reloadGroups()` + `mergedGroups` memo
  (built-ins first, custom alpha-sorted after with a slate palette
  + user's emoji).
- `pendingSeeded` banner pinned at the top:
  *"💡 N student(s) were added to your watch list by [names]. Scroll
  down to review."* Dismiss button = `scrollIntoView` on the first
  pending row's ref; ack state itself is the source of truth so the
  banner clears naturally as items get acknowledged.
- Inside each group, sort puts pending-seeded rows first, then
  `addedAt desc`.
- `NoteCard` "Added by X" pill renders amber + inline "Acknowledge"
  button when unacked → `POST /:id/acknowledge` then local row
  update. Once acked, the pill renders muted gray
  *"Added by X · Acknowledged"* with no button.
- `EntryModal` accepts `groups`, `customGroups`, `onGroupsChanged`.
  New "Manage groups" inline panel (add `label + emoji`, delete with
  409 surfaced inline). Edit mode never re-targets the row owner —
  only add mode shows the "Add to whose watch list?" picker for core
  team.

### Frontend — InsightsWatchlist (`artifacts/client/src/components/InsightsWatchlist.tsx`)
- `Row` extended with `previousBehaviorCount`, `previousIssDayCount`,
  `isNewThisWindow`. Server-side, `/api/insights/watchlist` computes
  `prevFrom`/`prevTo` (same length, immediately before current
  window) and runs three additional grouped queries (PBIS notes,
  support notes, ISS days) keyed by student. `isNewThisWindow` =
  current window has any high/watch flag AND prev window had zero
  behavior + zero ISS.
- `WatchCard` renders a small amber "✨ New this period" badge in
  the header next to the Spider button when `isNewThisWindow`.
- `PillarCell` gained an optional `trend` prop. The Beh cell passes
  `behaviorTrend(row)` which returns `{ arrow, delta }` when current
  != previous; renders a tiny *"↑ N from prior"* / *"↓ N from prior"*
  line under the pillar label and folds the same string into the
  cell's `title` tooltip. Other pillars omit `trend` and look
  unchanged.

### Smoke
- Acknowledge endpoint: wrong owner → 404, self-added → 400, owner
  happy path flips `acknowledgedAt` and is idempotent. Verified via
  a seeded `(staff 83, addedBy 1)` row.
- Custom groups: create works, dup key returns 409, `DELETE`
  blocked-when-in-use returns 409 (handled inline in the modal).
- `/api/insights/watchlist`: confirmed `isNewThisWindow: true` +
  populated `previousBehaviorCount` on the seeded BQ_ELA student.
- Self-add path is unchanged — `addedBy: null` rows never hit the
  ack code path or render the amber pill.

### Post-review hardening (same day)
Code review surfaced three real issues — fixed inline:
1. **Email path could still 500 the create** — the group-label and
   student-name lookups were `await`ed *before* the `void` send, so a
   DB blip there would surface as a 500 on a row that was already
   inserted. Wrapped the entire block (lookups + send) in a
   self-contained `void (async () => { try { … } catch { warn } })()`
   IIFE. Now the response always ships immediately and email failures
   are logged once with no request-path side effect.
2. **PATCH skipped the group-key allow-list** — the entries POST
   validates against built-ins + caller's custom keys, but PATCH only
   normalized the slug. Added the same `isAllowedGroupKey` check to
   PATCH so a stale or hand-typed key can't land in the row and never
   render in any tab.
3. **Custom groups weren't school-scoped + delete had a TOCTOU
   window** — `isAllowedGroupKey` and `GET /groups` filtered on
   `staffId` only, so a staff member who switched active schools
   could see/use the other school's groups. Both now also filter by
   `schoolId = activeSchoolId(staff)`. Group `DELETE` now runs
   inside `db.transaction` with `SELECT … FOR UPDATE` on the group
   row so the count-then-delete window is bounded by the
   transaction; not perfectly race-proof against a concurrent entry
   insert (no FK between entries.group_key and groups.key) but the
   window shrinks dramatically.

## Displays / digital signage (Apr 28, 2026)

Built per-school playlists that drive lobby/cafeteria TVs. Capability gate
mirrors PBIS: core team (SuperUser, Admin, MTSS, BS, Dean) gets it for free,
plus any teacher granted `cap_manage_displays` from Staff & Roles → Manage
Displays. Schema: `display_playlists` (one per named playlist) +
`display_playlist_items` (PNG/MP4/WAV/PDF asset rows; `kind` derived from MIME
on upload). Reused the existing object-storage presigned-PUT flow for uploads.
Public route `/display/:id` is short-circuited at the very top of `App.tsx`
(before the auth redirect) so a smart TV opens the URL with no login. The
public API surface is two narrowly-scoped endpoints: `GET /api/displays/public/playlists/:id`
returns metadata + enabled items + (when `show_pbis_house_page` is on) the
house standings & recent shoutouts; `GET /api/displays/public/media/:itemId`
streams the asset only after verifying the itemId exists in the items table.
Cycler rules: PNG → image for `durationSeconds`; MP4 → video, advance on
`onEnded`; WAV → autoplay audio over a colored card, advance on `onEnded`;
PDF → render each page with `pdfjs-dist`, advance per page using
`durationSeconds`. Editor lives at School Admin → Displays with name, default
duration, PBIS toggle, per-item duration override + enable + up/down reorder
+ delete, and an embedded preview iframe of the public URL. Loop reloads
playlist meta every 60s to pick up edits. v1 deliberately omits scheduling,
overlays/transitions, and share-tokens.

### v2 (Apr 29, 2026): schedule + active hall passes

Added 5 columns to `display_playlists`: `schedule_enabled`,
`schedule_start_time` / `schedule_end_time` (HH:MM text, validated server-side),
`schedule_days_of_week` (CSV "0,1,...,6"; empty = every day; canonicalized on
PATCH), and `show_active_hall_passes`. Editor adds a Schedule fieldset (toggle
+ two `<input type="time">` + 7 day chips) and a "Show active hall passes"
checkbox right next to the existing PBIS toggle. Cycler evaluates the schedule
on every minute boundary (1-minute tick state) and renders a centered "Off-air"
card outside the window — overnight wrap is supported (`endMin <= startMin`).
Schedule semantics fail open: missing start/end = always on (a dark TV is worse
than an over-eager one). When `show_active_hall_passes` is on, a passes slide
is injected into the loop alongside the PBIS slide; it shows up to 12 cards
with `firstName + lastInitial`, origin → destination, and elapsed minutes
(red border + ⚠ when overdue). New `GET /api/displays/public/passes/:schoolId`
returns the same sanitized payload standalone (no auth, 10 s cache); the
short-circuit in `App.tsx` matches `/display/passes/(\d+)` BEFORE the existing
`/display/(\d+)` route so a numeric playlist id can't shadow the keyword.
`HallPassDisplay` (also exported from `DisplayShow.tsx`) is the standalone
full-bleed page — polls every 15 s, ticks every 60 s for live elapsed time.

## Accommodations Class Log redesign (Apr 29, 2026)

Reworked the Accommodations area: dropped the "By Student" tab and rebuilt
"Class Log" around a per-student-click flow with explicit Provided/Refused
buttons, plus date + period selectors. Class View and Reports unchanged.

### Server
- `POST /api/accommodation-logs/bulk-per-student` — accepts
  `{ period:int, date?:"YYYY-MM-DD", entries:[{studentId,
  accommodationId, status:'provided'|'refused'}] }`. Composes the chosen
  date as UTC midnight for `created_at`, validates section ownership for
  the requesting teacher, validates roster + plan entitlement per entry,
  and reuses the existing `accommodation_logs` partial-unique index
  (status='provided' rows only) for duplicate-per-day protection.
  Returns counts: `inserted, skippedNotRostered, skippedNotEntitled,
  skippedDuplicate, skippedUnknownAcc`.
- `GET /api/bell-schedules/active` — any signed-in staff member can
  fetch the school's default bell schedule's periods so the client can
  highlight "current period" in dropdowns.

### Client
- Removed the "By Student" tab button and its `accView === "student"`
  render branch entirely.
- Class Log now:
  - Loads the active bell schedule on mount and computes the
    "currently in session" period by matching local clock to
    `startTime`/`endTime` windows.
  - Auto-fills the period dropdown the first time a teacher opens
    Class Log on a date where their roster contains today's current
    period; manual changes stick (`autoPeriodApplied` flag).
  - Adds `<input type="date">` defaulting to today, `max=today` (no
    future-dating). Any past date is allowed.
  - Roster column on the left lists every student in the chosen
    period whose plan contains an IEP/504/ELL accommodation
    (Strategy excluded). Click a row to expand THAT student's
    tracked accommodations with mutually-exclusive Provided / Refused
    toggle buttons (click again to clear).
  - Skipping a student is implicit absence — no separate absent flow.
  - Submit button posts only touched (sid, accId, status) entries to
    the new bulk-per-student endpoint with the chosen date + period.

### Smoke
- `GET /api/bell-schedules/active` returns Parrott's "Regular Day"
  (7 periods).
- Real positive POST as `sarah.patel1@hcsb.k12.fl.us` (period 1 teacher
  for section 456): `{inserted:2, skipped*:0, sectionId:456}`. Repeat
  POST: `{inserted:0, skippedDuplicate:1}` confirming the partial
  unique index still guards.

### Files touched
- `artifacts/api-server/src/routes/accommodationLogs.ts` (new endpoint)
- `artifacts/api-server/src/routes/bellSchedules.ts` (new `/active`)
- `artifacts/client/src/App.tsx`
  - state cleanup: removed `dailyAbsent*`, `dailySelectedAccs`,
    `dailyApplyPulse`; added `dailyDate`, `dailyEntries`,
    `dailyExpandedSid`, `bellPeriods`, `bellPeriodsLoaded`,
    `autoPeriodApplied`.
  - `submitDailyLog` rewritten to call `/bulk-per-student`.
  - new bell-schedule fetch effect, `currentBellPeriod` helper, and
    auto-period-select effect.
  - Class Log render branch entirely replaced; "By Student" tab and
    branch removed.

### Architect review hardenings (post-build)
First architect pass found three high-severity issues; all were fixed:
1. **Tenant isolation**: added `eq(*.schoolId, schoolId)` to the section,
   accommodation, student-assignment, and target-staff lookups in
   `bulk-per-student` so cross-school IDs cannot satisfy validation.
2. **Elevated delegation**: introduced an explicit `actingAsStaffId` body
   field. Server pulls the principal from `requireStaff` and only honors
   delegation when the principal has admin/super/ESE/MTSS/behavior
   roles AND the target staff is in the same school. Client now sends
   `actingAsStaffId` only when an elevated user has chosen another
   teacher (no longer overloads the iframe-fallback `staffId`).
3. **Date hardening**: malformed format → 400 (no silent fallback to
   today), calendar-invalid (e.g. `2026-02-31`) → 400 via roundtrip
   check, future dates → 400 server-side (UI's `max=today` is now a
   defense-in-depth signal, not the only guard).

Re-smoked: malformed/invalid/future dates all return 400; admin
delegating to teacher in same school returns `inserted:1`; non-elevated
user trying to delegate returns `403`; default-today path still works.

### Pre-existing TS errors NOT regressed
`pbis.ts` 892/896, `studentHallPassLimits.ts` 305, `tardies.ts` 85,
`seed.ts` 809/824/933/2375/2397/2455 (api-server) and the App.tsx HubKey
narrowing list (lines 2676–17724) all pre-date this change.

### Bug fix: empty-roster regression
The `schoolAccommodations` state powering `accCategoryByName` was loaded
by a `useEffect(..., [])` mount-only fetch. On a fresh page load that
fetch raced ahead of authentication, hit `/api/school-accommodations`
without a bearer token, fell through the silent `r.ok ? r.json() : []`
branch, and never re-fired. Result: every accommodation name failed the
`accCategoryByName.get(name)` lookup in `trackedAccsForStudent`, the
`!cat || !trackedCats.has(cat)` guard rejected them all, and the
roster filter `row.accs.length > 0` emptied the entire Class Log even
though `/api/students` was returning fully-populated `accommodations`
arrays. Fix: gated the effect on `authUser?.id` and re-added it to the
dep list so it refetches once auth is established.

### Bug fix: "Sign-in required" on submit
`submitDailyLog` was using raw `fetch(...)` instead of `authFetch(...)`,
so the bearer token wasn't attached and the server-side `requireStaff`
middleware (which prefers the JWT for the principal identity) returned
401 `{"error":"Sign-in required"}` even after a successful login.
Fix: swapped to `authFetch`. Same pattern as every other authenticated
mutation in the file.

## Tier-aware Intervention Logging (Tier 2 / Tier 3)

The legacy "+ Log Intervention" CTA, which dropped every user into the
free-form `CheckInOutModal` (raw `tardies` POST), has been replaced with
a tier-aware launcher that routes a teacher to the correct daily/weekly
log based on the student's active MTSS plan. The CheckInOutModal lives
on as a "Quick Check-in" secondary link inside the launcher so the
legacy quick-tally path still works.

### Roles touched

- New role flag: `staff.is_school_psychologist`. Surfaced in the Staff
  Roles matrix as a "School Psych" column. Treated as Core Team for the
  intervention surfaces (alongside SuperUser / DistrictAdmin / Admin /
  BS / MTSS) — see `lib/coreTeam.ts` (server) and the inline
  `isCoreTeam` predicate in `App.tsx` where the launcher is rendered.

### DB schema

Tables (all in `lib/db/src/schema/`):

- `tier2_intervention_entries` — one row per teacher per student per
  date. `sub_type` is `'cico' | 'group'`, optional
  `trusted_adult_intervention_id` FK to the new tier-tagged
  `intervention_types` rows.
- `tier3_goals` — versioned (effective_from, never UPDATEd). Slot 1..5
  per student. Edits create a new row; readers should always pick the
  latest `effective_from <= today` per slot.
- `tier3_weekly_records` — one row per (student, teacher, Monday).
  Columns: `mon..fri` 1..5 score, per-day comment, weekly comment,
  `pride_mon..pride_fri` (0..2 nullable), `goal_version_ids` json
  (snapshot of which goal versions this record was scored against).
- `tier3_strategy_categories` + `tier3_strategies` —
  school-scoped CRUD; drives the "Interventions Used This Week"
  checklist.
- `tier3_strategy_usage` — `(weekly_record_id, strategy_id, day, used)`.
- `student_mtss_plans` extensions: `intervention_sub_type`,
  `assigned_teacher_ids` (csv), `track_school_wide_expectations` bool.
- `intervention_types.tier` — `'2' | '3' | null`. Tier 2 form filters
  the Trusted Adult selector to `tier='2'`. Trusted Adult admin now
  shows a tier dropdown on add + per-row inline select.
- `school_settings` extensions:
  `school_wide_expectation_acronym`, `school_wide_expectation_letters`
  (json `[{letter, word}]`).

Schema was applied via `executeSql` (drizzle-kit push was blocked by
interactive prompts). If pushing later, ensure `db:push --force` is
used and matches the columns above.

### Server endpoints

All under `artifacts/api-server/src/routes/`:

- `tier2.ts` — POST/GET/PATCH/DELETE `/api/tier2-entries`. Teachers see
  and edit only their own; Core Team sees school-wide.
- `tier3.ts` — POST/GET/PATCH/DELETE `/api/tier3-records` +
  `/api/tier3-goals`. Goal edits insert a new versioned row, never
  UPDATE; reads return the latest version per slot. Strategy usage is
  upserted alongside the weekly record.
- `tier3Strategies.ts` — `/api/tier3-strategies` and
  `/api/tier3-strategy-categories`. Core Team writes only.
- `interventionsBell.ts` — `/api/interventions/owed-today` returns the
  bell payload (`{visible, totalOwed, rows[]}`). Hidden for Core Team
  (`visible:false`). Tier 2 rows skip weekends; Tier 3 rows respect
  Mon..Fri day-of-week.
- `interventionsBell.ts` also exposes
  `/api/interventions/completion-report` for the Intervention Reports
  page — Core Team only. Returns
  `{schoolDayDates[5], rows[].teachers[]={teacherStaffId, teacherName,
  completed, expected, scoreAvg}}`.
- `schoolSettings.ts` PUT extended to validate
  `schoolWideExpectationAcronym` (≤16 chars) and
  `schoolWideExpectationLetters` (json array of `{letter, word}`).
- `listsAdmin.ts` POST/PATCH for `intervention_types` now accept
  `tier` ('2'|'3'|null).
- `emailPreview.ts` — `GET /api/admin/email-preview/<type>` renders
  each dormant template against canned sample data. SuperUser only.

### Client surfaces

All under `artifacts/client/src/components/`:

- `LogInterventionLauncher.tsx` — student picker. On pick, fetches the
  active plan and routes to `Tier2DailyForm` or `Tier3WeeklyForm`.
  Exposes `onOpenQuickCheckin` so the launcher can drop down to the
  legacy CheckInOutModal.
- `Tier2DailyForm.tsx` — date picker, sub-type radios (locked for
  teachers when the plan dictates, free for Core Team), Trusted Adult
  selector filtered to `tier='2'`, notes, submit.
- `Tier3WeeklyForm.tsx` — Mon..Fri score buttons (1..5 with frozen
  percent legend: 5=80%+, 4=60–80%, 3=40–60%, 2=20–40%, 1=<20%),
  dynamic 1..5 goal rows, per-day + weekly comments, optional
  PRIDE/school-wide-expectation 0/1/2 buttons (gated on
  `track_school_wide_expectations`), and a category-grouped
  "Interventions Used This Week" checklist with five Mon..Fri
  checkboxes per row. Goals are read-only for teachers; Core Team has
  an inline "Edit goals" affordance that POSTs new versioned rows.
- `InterventionsBell.tsx` — global header bell. Hidden for Core Team
  and when `totalOwed === 0`. Polls `/api/interventions/owed-today`
  every 60s + on `refreshKey` bump (each save bumps the key).
- `InterventionsTodayPage.tsx` — `activeSection === "interventionsToday"`
  page. Groups rows by tier with one-click "Log now" buttons that hand
  off to the launcher with `initialStudentId` + `initialMode` set.
- `InterventionReportsPage.tsx` — `activeSection ===
  "interventionReports"`. Two-pane: roster left with tier badges and
  completion pill, detail drawer right with per-teacher completion
  grid, per-goal averages, overall + PRIDE averages, strategy usage
  frequency, recent comments. Visible only to `canManageMtssPlans`
  (Admin / BS / MTSS / Psych). Wired into the BS hub and MTSS hub as a
  new "Intervention Reports" tile.
- `SchoolWideExpectationsPanel.tsx` (Settings → School Identity tile,
  id `school-wide-expectations`) — acronym + letter→word list.
- `Tier3StrategiesAdmin.tsx` (Settings → Feature Configuration tile,
  id `intervention-strategies`) — Core Team CRUD over categories and
  strategies.
- `TrustedAdultInterventionsAdmin.tsx` — got a Tier dropdown on add
  and a per-row inline select; persists to the `tier` column.

### Email reminder infrastructure (dormant)

- `lib/emails/interventionReminders.ts` — three templates
  (`tier2-morning`, `tier3-weekly-load`, `core-team-friday`) plus
  `maybeSend(...)` which is gated on the env flag
  `EMAIL_REMINDERS_ENABLED` (default `false`). Sender is
  `RESEND_FROM_ADDRESS` which is intended to land on a verified
  `@hcsb.k12.fl.us` address — domain not yet verified, so the cron is
  off by default.
- `lib/scheduler.ts` — node-cron registrations:
  - `0 7 * * 1-5` America/New_York → Tier 2 morning digest
  - `0 7 * * 1`   America/New_York → Tier 3 weekly load digest
  - `0 14 * * 5`  America/New_York → Core Team Friday summary
  Wired into `index.ts` `startListening`. Logs
  `intervention reminder scheduler registered  enabled: false  tz: ...`
  on boot. To enable: set `EMAIL_REMINDERS_ENABLED=true` and
  `RESEND_FROM_ADDRESS=...@hcsb.k12.fl.us` after sender verification.
- Inspection: `/api/admin/email-preview/<type>` (SuperUser only)
  renders each template against canned sample data.

### Known caveats

- App.tsx still has pre-existing TS errors (sections in `HubKey` /
  `MtssHubKey` that aren't in the `activeSection` union, an `AuthUser`
  vs `AuthUserLite` mismatch on `SignageLauncherView`, several
  `'s' is possibly 'undefined'` reduces, etc.). None of them were
  introduced by this work; the build still ships.
- Scheduler is registered but **dormant** — cron jobs are no-ops until
  the env flag is flipped. The Resend integration itself is already
  installed.

### Architect-driven fixes

After the first pass, an architect review surfaced three issues that
were addressed:

1. **Plain teachers couldn't read `/api/mtss-plans`** so the launcher
   always fell through to Tier 2 even for Tier 3 students. Added
   `GET /api/mtss-plans/probe/:studentId` — open to any signed-in
   staff in the same school, returns only
   `{tier, interventionSubType, trackSchoolWideExpectations}` (no
   notes / goal text). LogInterventionLauncher / Tier2DailyForm /
   Tier3WeeklyForm now use the probe endpoint.
2. **TZ rollover**: `interventionsBell.ts` formatted "today" as
   `toISOString().slice(0,10)` (UTC), so a teacher submitting at
   ~8 PM EST would see tomorrow's row. Replaced with a
   `toLocaleDateString("en-CA", { timeZone: "America/New_York" })`
   helper plus a `todayDowLocal()` helper for the Tier 3 day-of-week
   calculation.
3. **Bell refresh wiring**: confirmed `interventionRefreshKey` is
   already lifted to `App.tsx` and bumped via the launcher's
   `onLogged`, then passed to both `<InterventionsBell>` and
   `<InterventionsTodayPage>` — no fix needed; architect's first read
   was a false alarm.

Deferred to follow-ups:

- The `/api/interventions/owed-today` payload still issues several
  sequential queries (allPlans → studentRows → tier2Entries →
  tier3Records). Acceptable at current scale; consolidate into one
  CTE if it becomes a bottleneck.
- Other server routes (`mtssPlans.ts`, `listsAdmin.ts`,
  `schoolSettings.ts`) still re-implement Core Team gates rather
  than using `lib/coreTeam.ts`. Pre-existing pattern; not regressed.

### Unified intervention history (Apr 30 2026)

Replaced the ad-hoc "Recent interventions" table on the Log
Intervention page with a single canonical surface that merges every
intervention source into one row shape:

- Server: `artifacts/api-server/src/routes/interventionHistory.ts`
  exposes two endpoints. Both return rows of shape
  `{source, sourceId, studentId, staffId, staffName, occurredAt, date,
  tier, typeLabel, detail}` merged from `tier2_intervention_entries`,
  `tier3_weekly_records`, legacy `intervention_entries`, and
  check-in/check-out rows in `tardies`. Source-of-truth tier labels
  come from joined `intervention_types`. Tardies have no `staff_id`
  so we fuzzy-match `createdBy`/`teacherName` to `staff.display_name`
  when populating `staffId`/`staffName`.
  - `GET /api/students/:studentId/intervention-history` — all entries
    for one student (school-scoped). Powers the per-student panel on
    StudentProfile.
  - `GET /api/interventions/my-history?from&to&studentId&tier&staffId`
    — caller's own entries by default. `staffId` override is
    Core-Team-only (`isCoreTeam` from `lib/coreTeam.ts`). Counts
    object (`{t2, t3, legacy, quick}`) is computed **before** the
    optional `tier` filter so the summary stays honest when the user
    narrows the table.
- Client:
  - `artifacts/client/src/components/MyInterventionsPage.tsx` — new
    page wired to `activeSection === "myInterventions"`. Date presets
    All / Today / 7d / 15d / 30d / Custom, datalist-based student
    combobox, tier filter, summary counts row, results table with
    coloured tier badges. Print uses a hidden print-only block
    rendered into the DOM right before `window.print()`; if the
    visible result is "long" (>25 rows) the user gets a Print Range
    picker first to optionally narrow the printout to a date range.
  - Nav: added "My Interventions" entry below "Log Intervention" in
    `allBaseNavSections`, gated by the same `LogIntervention` feature
    flag.
  - StudentProfile: new "Intervention history" Card under the pillars
    grid that fetches the per-student endpoint and renders rows with
    tier badges. The small 5-item "Recent interventions" list inside
    the Supports pillar stays as a quick glance; the new panel is the
    full record.
  - Log Intervention page: legacy in-page "Recent interventions" IIFE
    table removed and replaced with a violet call-out card linking to
    My Interventions ("View My Interventions →").

Follow-up done Apr 30: HeartBEAT signage screen at `/signage/heartbeat`
is now wireable into a Signage Displays playlist as a per-loop slide
(see "Displays: HeartBEAT toggle (shipped Apr 30, 2026)" earlier in
this file). It is rendered as a sandboxed iframe rather than a
first-class playlist *item* type — the editor toggle lives in the
playlist meta (alongside the PBIS-houses and active-hall-passes
toggles), not in the items list. Promoting it to a first-class item
type with per-instance duration is still on the wishlist.

### Teacher Roster: ESE / 504 / ELL chips (Apr 30 2026)

Added a "Programs" column to the Teacher Roster page so teachers can
see whole-child program flags at a glance without opening each student
profile.

- Server: `GET /api/teacher-roster` now includes `ese`, `is504`, and
  `ell` booleans on every student row, sourced directly from the
  `students` table (populated by the SIS / roster importer).
- Client: `TeacherRosterPage.tsx` renders three small pastel chips
  (ESE / 504 / ELL) per row. Hidden when none apply ("—"). New
  visibility toggle "Programs" alongside the existing PM/LG/BQ/Eye
  toggles, persisted in `localStorage` under
  `teacherRoster.visibility.v3` (`v2` keys upgrade cleanly via `??`
  fallbacks). Legend includes a sample of each chip. Summary line is
  unchanged in shape but now also reports ESE / 504 / ELL counts to
  callers via `summary.ese / summary.five04 / summary.ell` (display
  text not surfaced yet — chip column itself is the primary signal).
- Column position: Programs sits between Student/Spider and Grade so
  it reads as student-context, not academic data.
- Hover popover: hovering (or clicking to pin) the Programs cell of
  any student with active accommodations opens a category-grouped
  popover listing the accommodation names. Categories use the same
  color palette as the Accommodations Class View
  (IEP/504/ELL/Strategy). Server now joins `student_accommodations`
  → `school_accommodations` and returns `accommodations: { name,
  category }[]` per row. When a student has accommodations but none
  of the three program flags, a soft "Acc" pill is shown so there's
  still a hover target.

### MTSS BIP: Auto-track schedule + exclude/extra-interventionist (Apr 30 2026)

Refactor to how interventionist assignments work on every Tier 2 / Tier 3
plan in `student_mtss_plans`. Replaces the static `assigned_teacher_ids`
CSV as the *source of truth* for who owes interventions.

- New columns on `student_mtss_plans` (added via `ALTER TABLE`; reflected
  in `lib/db/src/schema/studentMtssPlans.ts`):
  - `auto_assign_schedule_teachers BOOLEAN NOT NULL DEFAULT TRUE` —
    when true (the new default), the student's *current* class
    schedule (joined via `section_roster` → `class_sections`,
    excluding planning periods) is the authoritative list of who
    owes the daily/weekly entry. Mid-year roster changes flow
    through automatically.
  - `excluded_teacher_ids TEXT NOT NULL DEFAULT ''` — CSV of staff
    ids the team has excused from this particular plan (e.g. art /
    PE teacher who can't realistically check-in/check-out). Only
    consulted when `auto_assign_schedule_teachers = true`.
  - `additional_interventionist_ids TEXT NOT NULL DEFAULT ''` — CSV
    of staff ids ADDED on top (counselor, behavior specialist,
    school psych, social worker, trusted adult — anyone who isn't
    one of the student's classroom teachers but is still on the
    plan).
- Legacy `assigned_teacher_ids` is kept and continues to be populated
  on insert / patch by clients that haven't been updated, but server
  consumers prefer the *effective list* whenever a plan has
  `auto_assign_schedule_teachers = true`.
- New shared helper `artifacts/api-server/src/lib/effectiveTeachers.ts`
  exports `parseCsvIds`, `loadScheduleTeacherIdsForStudents` (batched
  by school + student), `effectiveTeacherIdsForPlan`, and
  `loadScheduleSectionsForStudent`. Both `routes/mtssPlans.ts` and
  `routes/interventionsBell.ts` import from here so the
  auto/exclude/extra logic lives in exactly one place.
- `routes/mtssPlans.ts`:
  - `GET /mtss-plans` (list) now includes `effectiveTeacherIds`
    (number[]) and `effectiveTeachers: { staffId, displayName,
    source: "schedule" | "additional" }[]` per row. The three new
    raw fields are also returned so the modal can seed itself.
  - New `GET /mtss-plans/teacher-options?studentId=…` returns
    `scheduleTeachers: { staffId, displayName, period, courseName }[]`
    plus `staffOptions: { id, displayName }[]` (active staff in the
    same school) and `scheduleStaffIds`. The Plan modal uses this
    to render the live schedule list and to power the
    "Additional interventionists" picker.
  - `POST /mtss-plans` and `PATCH /mtss-plans/:id` accept
    `autoAssignScheduleTeachers`, `excludedTeacherIds`,
    `additionalInterventionistIds` (arrays or CSVs are normalized
    via `normalizeStaffIdCsv`). When `auto = true` the legacy
    `assignedTeacherIds` is recomputed server-side as schedule ∪
    additional − excluded; when `auto = false` clients still write
    `assignedTeacherIds` explicitly.
- `routes/interventionsBell.ts`:
  - `GET /interventions/owed-today` now filters by the effective
    teacher list per plan instead of the static CSV.
  - `GET /interventions/completion-report` builds the expected
    "who-owes-what-this-week" set from the effective list, *but*
    UNIONs in any past teacher who actually logged a Tier 2 entry
    or Tier 3 weekly record for the plan during the report window.
    This means a teacher who left mid-year (or was just removed
    from the schedule) still shows up correctly for any week where
    they did the work.
- Backfill (run once via `executeSql`): every active plan was
  flipped to `auto = true`. `additional_interventionist_ids` was
  seeded with the set of ids in the OLD `assigned_teacher_ids` that
  weren't in the student's current schedule (preserves counselors /
  past-schedule contributors). For the existing 2,923 active plans
  the diff was zero — the old assigned ids were already a subset of
  the live schedule — so no plan lost any interventionist.
- Client `MtssPlansAdmin.tsx` PlanModal: new "Include all teachers
  on this student's schedule" checkbox (default ON). When ON, the
  schedule is rendered as a list with a per-row Exclude / Include
  toggle (excluded teachers strike-through). Below it is a
  type-to-search "Additional interventionists" multi-pick that
  reuses `staffOptions` from the new `teacher-options` endpoint.
  The modal fetches `teacher-options` whenever the picked student
  changes; closed plans seed the modal from the persisted CSVs.

### Demo backfill: 60 days of intervention data at School 2 (Apr 30 2026)

To make the upcoming Reports page demo-able, ~60 days of synthetic
Tier 2 daily entries and ~8 weeks of Tier 3 weekly records were
inserted at School 2 via the canonical helper SQL at
`scripts/sql/seed_mtss_demo_data.sql` (idempotent — re-running is a
no-op thanks to `WHERE NOT EXISTS` guards).

- For every active T2 plan: each weekday × each effective teacher
  gets a `tier2_intervention_entries` row with a 90% completion
  probability (`random() < 0.9`). Result: 135,728 rows; ~90%
  completion as displayed in the existing completion-report.
- For every active T3 plan: each Monday × each effective teacher
  gets a `tier3_weekly_records` row with mon..fri scores drawn
  from `[5,5,4,5,4,5,3,5,4,5]` (mean 4.5 / 5 = exactly 90%) and
  `submitted_at` set to that week's Friday. Result: 4,905 rows;
  measured mean 4.50.

### Subtype-aware completion keying (Apr 30 2026 follow-up)

Architect re-review caught two latent same-subtype-collision bugs.
Both fixed:

- `interventionsBell.ts` `GET /interventions/completion-report`:
  the per-plan `t2Counts` map is now keyed by
  `${studentId}::${teacherId}::${subType ?? ""}` (and the parallel
  `t3ByKey` map by `…::tier3`). Without the discriminator, two T2
  plans for the same student and same teacher with different
  subtypes would inflate each other's "X of 5" completion display.
- `interventionsBell.ts` `GET /interventions/owed-today`: the
  `submitted` query now also selects `subType`, and `doneIds` is
  keyed by `${studentId}::${subType ?? ""}`. Without it, a teacher
  who logged a CICO entry for a student would clear that same
  student's separate check-and-connect owed row for the day.
- Manual-mode authoring: `MtssPlansAdmin.tsx` PlanModal now seeds
  the picker from `assignedTeacherIds` when
  `autoAssignScheduleTeachers === false` (so editing a manual plan
  shows the actual team), and submit spreads
  `assignedTeacherIds: additionalIds` whenever the toggle is OFF
  (so the picker IS the authoritative manual list). The picker
  label and helper text also switch from "Additional
  interventionists" to "Assigned interventionists" in manual mode.
- Effective-teacher resolution in the SQL exactly mirrors the
  server helper: schedule ∪ additional − excluded for auto plans;
  legacy assigned for manual plans.

### MTSS Reports page (Apr 30 2026)

New richer Reports page lives at the existing
`activeSection === "interventionReports"` slot but renders a new
component, `MtssReportsPage.tsx`, instead of the legacy weekly
grid. (The legacy weekly grid is still reachable from
`activeSection === "interventionReportsLegacy"` if a future link
needs it.)

- Server: new `artifacts/api-server/src/routes/mtssReports.ts`
  exposes one endpoint:
  `GET /api/mtss-reports/summary?range=7|30|60|90|sinceOpened&planId=&tier=&subType=&grade=&teacherStaffId=`.
  Auth uses the same Core Team gate as the rest of the MTSS admin
  surface (admin / BS / MTSS coord / PBIS coord / SuperUser).
  Response shape returns: `weeklyTrend`, `perTeacher`,
  `perSubject` (joined to current schedule for course names),
  `dayOfWeek` (Mon-Fri completion %), `t3GoalTrend`, plus summary
  tiles and a `planMeta` payload in per-plan mode. All counts
  respect the per-plan effective-teacher list (schedule ∪ extras
  − excluded) and treat each plan's expected work as starting at
  `openedAt` and ending at `closedAt` if set.
- Client: `MtssReportsPage` ships in two modes:
  1. Standalone — entered via the existing Reports nav item;
     filters are tier / subtype / grade / teacher.
  2. Per-plan — entered via a new "Report" button on every row
     of `MtssPlansAdmin`. App.tsx tracks the picked plan in
     `mtssReportsPlanId` / `mtssReportsPlanTitle` state and the
     Reports section conditionally renders the per-plan view,
     which unlocks the "Since plan opened" date preset and shows
     plan metadata up top.
  Charts use the already-installed `recharts`. Includes a
  Print-to-PDF button backed by a `@media print` stylesheet that
  hides the back button and filters so the PDF is
  presentation-ready.

## Tier 2 weekly cadence (May 2 2026)

Tier 2 documentation switched from DAILY to WEEKLY. One entry per
(student, teacher) per Mon-Fri week is the obligation; the bell, the
completion-report and the Reports page all use this denominator.

**Server changes:**
- `artifacts/api-server/src/routes/tier2.ts` — POST validates that
  non-Core-Team teachers can only log a weekday date in the last 14
  calendar days (this week + last week) and never in the future.
  Core Team is exempt so they can repair history.
- `artifacts/api-server/src/routes/interventionsBell.ts`:
  - `owed-today` Tier 2: queries entries across the current Mon-Fri
    week (not just today) and shows owed if no entry exists for the
    (student, subType) pair anywhere in the week. Weekend skip
    removed — the bell stays visible Sat/Sun.
  - `completion-report` Tier 2: `expected = 1`, `completed = 1` if
    any entry exists in the report week (formerly `expected = 5` and
    `completed = count of distinct dates`).
  - Unused `isWeekend` helper deleted.
- `artifacts/api-server/src/routes/mtssReports.ts` — every Tier 2
  loop (weeklyTrend, perTeacher, perSubject) iterates over
  `schoolWeeks` (de-duped Mondays in range) instead of `schoolDays`,
  with one obligation per (week, plan, teacher). The `dayOfWeek`
  panel was repurposed: instead of "% completion per Mon-Fri" it now
  shows the DISTRIBUTION of which weekday teachers actually log
  their weekly check-in on (% of total weekly entries falling on
  each day). Plan inclusion now uses week-overlap (openedAt ≤
  Friday and closedAt ≥ Monday) instead of day-by-day.

**Client changes:**
- `Tier2DailyForm.tsx` (filename kept for stability):
  - Title is "Tier 2 — Weekly check-in for {studentName}".
  - Date input now constrained `min = mondayOfThisWeek - 7 days`,
    `max = today`. Notes placeholder asks about discussion topic
    and curriculum/program (e.g. WhyTry, Zones of Regulation).
  - Submit button label is "Save weekly check-in".
- `InterventionsTodayPage.tsx` — page title "My Interventions This
  Week", section heading "Tier 2 — weekly check-in · week of
  {weekStartDate}", per-row label "Tier 2 weekly".
- `InterventionsBell.tsx` — bell title/aria changed from
  "to log today" → "to log this week".
- `LogInterventionLauncher.tsx` — comment updated.
- `MtssReportsPage.tsx` — day-of-week chart heading rewritten to
  "Weekly check-in: which day teachers log on (Tier 2)" so the
  chart's new meaning is clear.

**Demo data re-seed (Apr 26 → May 2 2026):**
All 667,240 daily Tier 2 entries were deleted. A new SQL seed (run
in code_execution) inserted ONE entry per (active T2 plan ×
effective teacher × Monday in last 60 days) at ~90% completion,
with a deterministic random weekday placement and weekly notes. All
7 schools with active T2 plans (1, 2, 3, 4, 5, 36, 220) now have
weekly demo data. Total: 121,839 entries, perfectly uniform Mon-Fri
distribution at school 2 (5074/4914/5140/5161/5032).
