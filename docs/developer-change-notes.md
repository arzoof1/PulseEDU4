# PulseEDU — Developer Change Notes

A running, numbered log of changes made in this session, to be compiled into a
PDF for the developer. Most-recent detail lives inline under each item.

---

## Change #1 — Sidebar: allow closing a nav group that contains the active page

**Area:** `artifacts/client/src/App.tsx` — `NavGroup` component.

**Symptom (reported):** Clicking a left-sidebar group such as **Special Programs**
opens its dropdown and navigates into it, but clicking **Special Programs again
does not close the dropdown**.

**Root cause:** The group's open state was computed as
`open = isMobile || containsActive || userOpen === true`. Because `containsActive`
(the group holds the currently-active page) was OR'd in, the group was force-opened
whenever you were on a page inside it. Clicking the header set `userOpen = false`,
but `containsActive` kept overriding it, so it could never collapse.

**Fix:**
1. Resolution changed to `open = isMobile || (userOpen === null ? containsActive : userOpen)`
   so an explicit user preference — open **or** closed — wins over `containsActive`.
   Re-clicking the header now collapses the group even while it holds the active page.
2. Added a `useRef` + `useEffect` that clears the manual collapse (resets `userOpen`
   to `null` and removes the localStorage key) **only** on the `containsActive`
   false→true transition. So navigating *into* a group from elsewhere re-opens it by
   default, while an explicit collapse still sticks while you stay on the same page.

**Mobile unchanged:** `isMobile` still force-opens every group (matches the CSS that
disables the toggle on the mobile horizontal strip).

**Known minor caveat (non-blocking):** if you fully reload the browser while sitting
on a page inside a group you had manually collapsed, that group can remain collapsed
on load (the false→true reset doesn't fire on a fresh mount). Clicking it opens it.

**Verification:** `pnpm --filter @workspace/client run typecheck` passes; code review passed.

---

## Change #2 — Data Export: never emit the state FLEID, use the district Local SIS ID

**Area:** Settings → Data Management → **Export data**.
- Server: `artifacts/api-server/src/routes/dataImports.ts` — `GET /api/data-imports/export`.
- Client: `artifacts/client/src/components/DataExportPanel.tsx`.

**Requirement (reported):** Every download from the Export data panel must reference
the **Local SIS ID**, never the state **FLEID**. Scope is strictly the exported file
contents — **no change to any data upload/import behavior**.

**Background:** In the DB, `students.student_id` is the canonical **FLEID** (e.g.
`FL000008101387`, unique, the internal foreign key). `students.local_sis_id` is the
friendlier district display number (nullable, not guaranteed unique). An audit of
*every* CSV/Excel/PDF download in the app found this Export panel was the **only**
surface still emitting the FLEID — all other reports/exports (Teacher Roster,
Insights, Eligibility, PBIS reports, HeartBEAT PDFs, Data Chats, registry exporter)
already use the Local SIS ID.

**Fix (export payload only):**
1. **Server** — after the per-kind rows are built (all 5 kinds put the student id in
   column 0), one central step translates the FLEID → Local SIS ID via a school-scoped
   `students` lookup and relabels the header from `student_id` to `local_sis_id`.
   A student with no Local SIS ID on file exports a **blank** id cell. The `REQUIRED`
   column set (always re-injected during column projection) was updated to key on
   `local_sis_id`. Applies to all 5 datasets: rosters, behavior, FAST scores,
   FAST prior-year, assessments.
2. **Client** — `EXPORT_CONFIG` column lists + required lists renamed `student_id` →
   `local_sis_id` for all 5 kinds, and the panel help text now states students are
   identified by the district Local SIS ID and the FLEID is never exported.

**Explicitly NOT changed:** the importer / upload wizard and its `student_id`
matching logic are untouched (per the requirement). Note this means a file downloaded
from this panel is no longer a drop-in re-upload for the id column (the importer still
matches on the FLEID); every other column is unchanged.

**Verification:** `pnpm --filter @workspace/api-server run typecheck` and
`pnpm --filter @workspace/client run typecheck` both pass; API server restarted clean.
Confirmed live: an authenticated download of the roster export now returns the
header `local_sis_id` with district IDs (e.g. `S2-2394`) and no `FL…` values.

---

## Change #3 — Data Export download failed with "Sign-in required" (auth on download)

**Area:** Settings → Data Management → **Export data** → *Download CSV*.
- Client: `artifacts/client/src/components/DataExportPanel.tsx`.

**Symptom (reported):** Clicking *Download CSV* returned a page reading
`{"error":"Sign-in required"}` (and, in the Replit preview, the "Open a new tab
to test authentication and file uploads" banner) instead of downloading a file.

**Root cause:** The download was triggered by a plain `<a href="/api/data-imports/export?…">`
browser navigation. This app authenticates with a **Bearer token held in JS**
(via `authFetch`), **not** a cookie — so a raw navigation reaches the endpoint
with no `Authorization` header and the server correctly rejects it as
unauthenticated. This is especially visible inside the preview iframe.

**Fix (client only):** `handleDownload` now fetches the export through `authFetch`
(which attaches the Bearer token), reads the response as a **blob**, and saves it
via an object URL — so the download carries the signed-in identity. The saved
filename is taken from the server's `Content-Disposition` header (falling back to
`pulseedu-<kind>-<date>.csv`). Added a *Preparing…* disabled state and an inline
error message if the export fails. No server or endpoint change.

**Verification:** `pnpm --filter @workspace/client run typecheck` passes; the
authenticated export was confirmed returning CSV directly from the running server.

---

## Change #4 — Teacher Roster (and other) headers had "no words" after the sticky-header work

**Area:** Teacher Roster column headers — and the same style of table on
MTSS Plans Admin, Staff Directory, and Safety Plans Admin.
- Styling: `artifacts/client/src/index.css` (`.sticky-scroll` block).

**Symptom (reported):** After yesterday's sticky-header changes, the Teacher
Roster header row showed **no visible column labels** — the words ("Student",
"Programs", "Grade", "ELA", "Math", etc.) were effectively invisible.

**Root cause:** The labels were never removed — they were made invisible by a
color collision. These headers (`.pulse-table`) render their *text* with a
gradient that is "clipped to the shape of the letters," which uses the header
cell's own **background** to paint the letters. Yesterday's sticky rule added
`background: var(--surface-2)` directly onto each header cell (`.sticky-scroll
thead th`) so pinned headers wouldn't be see-through. That fill **overwrote the
gradient the letters depend on**, so the text rendered in the light fill color
and disappeared. Plain tables (e.g. the Eligibility Hub, `.table`) don't use the
gradient-text technique, which is why the bug only showed on the gradient
(`pulse-table`) rosters.

**Fix (CSS only):** Pin the whole `<thead>` as one sticky block and put the
opaque fill on the `<thead>` (an *ancestor* of the cells) instead of on each
header cell. The header cells keep their gradient-text background untouched, so
the labels paint normally *on top of* the solid header fill — and the header
still stays pinned while rows scroll under it. This one change fixes all four
affected tables at once (the old `.sticky-scroll--group` special case is now
covered by the base rule). No component/markup changes.

**Verification:** CSS-only change, hot-reloaded by the client dev server; header
labels render normally while the header stays pinned on scroll.

---

## Change #5 — Teacher Roster: "PM3 history" book-icon drawer

**Area:** Teacher Roster rows.
- Server: `artifacts/api-server/src/routes/studentLookup.ts` — `GET /api/student-lookup/:studentId/fast-history`.
- Client: new `artifacts/client/src/components/FastHistoryModal.tsx`; wired into
  `artifacts/client/src/components/TeacherRosterPage.tsx`.

**Requirement (reported):** Add a 📖 book icon on each Teacher Roster row that
opens a drawer showing the student's **historical FAST PM3** (prior years, ELA +
Math PM3), a dividing line, then the **current year's full PM1 / PM2 / PM3**.
This lives only on the Teacher Roster — the Student Profile page is unchanged
(it stays the place for per-standard review). Teachers need access.

**FLEID handling (confirmed):** The FLEID (`students.student_id`) is **never
shown on screen** and is **never returned** by the endpoint — the response echoes
only the district **Local SIS ID** plus grade / school-year / scores. Per the
established app pattern (spider chart, data-chat, safety-plan actions all do the
same), the FLEID is used only as the internal handle passed in the request URL;
it is not rendered anywhere in the drawer.

**Server change:** The `fast-history` endpoint previously returned **403** unless
the caller was Core Team / admin (or held the `capViewFastHistory` cap). That
role/cap gate was **removed** so any staff member can call it. Access is still
bounded by the **same `getVisibleStudentIds` visibility check** already used by
the rest of this router: a classroom teacher only sees their own roster (+ their
trusted-adult set), while admins / Core Team / counselors get the school-wide
set. (Access is therefore slightly broader than the old cap-gated model — any
staff who can already see the roster row can open the drawer.) The pre-existing
visibility responses are unchanged: an out-of-scope student returns **403**, a
non-existent one **404**.

**Client change:** New `FastHistoryModal` fetches the endpoint via `authFetch`
and renders two blocks separated by a divider — **Historical · PM3 by year**
(one row per prior year with ELA PM3 + Math PM3) and **Current year · PM1 → PM2
→ PM3** (ELA + Math). Score cells reuse the shared `FastScorePill` (defaults to
showing the scale score, click a pill or use the header toggle to flip to the
achievement level). The header shows only the Local SIS ID and grade.

**Data cleanup (applied):** While building this, I found **school 1** was the
only school carrying stray `26-27` FAST rows (642 rows, PM1 only, no PM2/PM3).
Because the app derives the "current year" as the newest non-historical year,
school 1 resolved to `26-27`, so its current-year block showed only a sparse PM1
while the complete `25-26` year fell into the historical section. These rows did
not come from the seed (guarded, always writes full PM1/PM2/PM3) or the Parrott
reseed (writes `25-26`, admin-triggered only) — they were leftover manual-import
data. Per the decision made during this session, the stray non-historical
`26-27` rows (and their 25,680 orphaned item-response rows) were **deleted**, so
school 1 now resolves to `25-26` with full data, matching every other school.
This affected the whole app (roster / insights), not just this drawer.

**Verification:** `pnpm --filter @workspace/client run typecheck` and
`pnpm --filter @workspace/api-server run typecheck` both pass; API server
restarted clean and client hot-reloaded the roster.

---

## Change #6 — Watch List: "Needs attention" gate + school-configurable thresholds

**Area:** Insights Watch List (system-driven, was overwhelming teachers with 100+
students) plus School Settings.
- DB: `lib/db/src/schema/schoolSettings.ts` — 4 new int cols
  (`watchlistAbsenceThreshold`=10, `watchlistBehaviorThreshold`=3,
  `watchlistTardyThreshold`=5, `watchlistIssThreshold`=1); matching
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` boot migration in
  `artifacts/api-server/src/seed.ts`.
- Server: `artifacts/api-server/src/routes/insights.ts`
  (`GET /api/insights/watchlist`), `artifacts/api-server/src/routes/schoolSettings.ts`
  (PUT).
- Client: `artifacts/client/src/components/InsightsWatchlist.tsx`,
  `artifacts/client/src/App.tsx`, `artifacts/client/src/components/SettingsHub.tsx`.

**Requirement (reported):** Two enhancements. (#1) Default the Watch List to a
"needs attention" gate showing only students who trip ≥1 risk trigger, with a
"show full roster" escape hatch. (#5) Make the count-based thresholds
school-configurable via a new "Watch List Thresholds" tile in School Settings
(gated `canManageSettings`), stored in `school_settings`, saved via
`PUT /api/school-settings`.

**Server change:** `GET /api/insights/watchlist` now parses `scope=all|attention`
(default `attention`; any unrecognized value falls back to the gated view) and
loads the 4 thresholds from `school_settings` (schema-default fallback when the
row doesn't exist yet). Each row gains an `absences` field (official days absent
from `loadAttendanceMetrics` → latest Eligibility Hub upload; **null when no
upload — never fabricated to 0**) and a server-computed `needsAttention` boolean.
`needsAttention` = Tier≥2 **OR** FAST bottom-quartile ELA/Math (always-on boolean
triggers) **OR** any count-based trigger meeting its threshold (behavior, ISS,
tardy, absences). New flag codes `ABSENCES` (high) and `TARDY_TREND` (watch) join
the existing set; behavior/ISS flags now compare against the configured
thresholds instead of hardcoded constants. The response computes `totalInScope`
(all rows matching the explicit filters) and `attentionCount`, then returns only
the needs-attention subset unless `scope=all`. `scope`, `thresholds`,
`totalInScope`, `attentionCount` are added to the JSON.

**PUT /school-settings:** The 4 new fields are added to the destructure and to the
shared `intRange` validation block (absence 1–180, behavior/tardy/iss 1–100). No
extra role gate — any settings-manager (the gate on the Settings page itself) may
tune them, matching the sibling PBIS-threshold knobs.

**Client change:** `InsightsWatchlist` adds `scope` to `Filters`/`EMPTY_FILTERS`
(default `"attention"`), sends it in the query string, and renders a segmented
"Needs attention | Full roster" toggle (with live counts) plus a "Show full
roster (N)" escape-hatch link when the gate is hiding students. `Row` gains
`absences` + `needsAttention`; the card signal-chip list gains an "Absences N"
chip. A new "Watch List Thresholds" settings tile (School Settings →
behavior-pbis group, 👀) renders 4 numeric inputs mirroring the PBIS-thresholds
tile and saves through the existing `saveSchoolSettings`. The 4 fields were added
to all 4 exhaustive `App.tsx` schoolSettings mapper spots (type, defaults, load
reducer, save reducer) and the `SettingsTileId` union in `SettingsHub.tsx`.

**FLEID handling:** No FLEID exposure — the endpoint continues to key rows on the
internal handle and surface only `localSisId`; the new `absences` field is a plain
integer count.

**Verification:** `pnpm run typecheck:libs`,
`pnpm --filter @workspace/client run typecheck`, and
`pnpm --filter @workspace/api-server run typecheck` all pass. Dev DB columns
applied via direct SQL (drizzle-kit push is broken on this drizzle version — the
app relies on the seed.ts boot migration by design). API server restarted clean;
`GET /api/insights/watchlist` returns 200 on health and 401 unauthenticated as
expected.
