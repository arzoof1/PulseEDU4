# PulseEDU Developer Migration Report

## Multi-Grade Bell Schedule Architecture

**Status:** Complete — deployed to development workspace, all typechecks and tests passing (43/43)
**Date:** August 7, 2026
**Scope:** Support multiple simultaneous grade-level bell schedules (variants) under a single Day Type, with all runtime period resolution done per-student.

---

## 1. Executive Summary

Previously, one `bell_schedules` row held a single flat list of periods (`bell_schedule_periods`) that applied to every student in the school. Middle schools running staggered lunches (e.g. Grades 6/7/8 eating at different times, with shifted afternoon periods) could not be modeled.

This migration introduces a **Day Type → Variant** architecture:

- A `bell_schedules` row is now a **Day Type** (e.g. "Regular Day", "Early Release").
- Each Day Type contains one or more **variants** — complete, independent timelines (e.g. "Grade 6 Schedule").
- Variants are composed of **typed blocks**: `period`, `lunch`, `passing`, `advisory`, `homeroom`, `custom`.
- Grades are mapped to variants via an **assignment table** (extensible `kind` column; currently `grade`).
- All "what period is it right now for this student?" logic resolves through one central resolver.

**Resolution rule (never guess):** explicit grade assignment → default variant → explicit *not configured* failure.

---

## 2. Database Schema Changes

### 2.1 New tables (schema source: `lib/db/src/schema/bellScheduleVariants.ts`)

#### `bell_schedule_variants`
One row per timeline inside a Day Type.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| schedule_id | integer FK → bell_schedules.id | cascade delete |
| name | text | e.g. "Grade 6 Schedule" |
| is_default | boolean | exactly one default per schedule; undeletable |
| sort_order | integer | display ordering |
| created_at / updated_at | timestamps | |

#### `bell_variant_blocks`
Typed timeline blocks belonging to a variant.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| variant_id | integer FK → bell_schedule_variants.id | cascade delete |
| block_type | text | one of `period`, `lunch`, `passing`, `advisory`, `homeroom`, `custom` (exported `BELL_BLOCK_TYPES`) |
| period_number | integer nullable | only for `period` blocks |
| name | text | display label |
| start_time / end_time | text "HH:MM" | validated end > start, no overlaps within a variant |
| included_in_on_time_streak | boolean | only `period` blocks may be true |
| sort_order | integer | |

#### `bell_variant_assignments`
Maps a population to a variant.

| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| schedule_id | integer FK → bell_schedules.id | |
| variant_id | integer FK → bell_schedule_variants.id | |
| kind | text | currently `"grade"`; column is extensible (e.g. future `"team"`, `"track"`) |
| value | text | grade stored as text (students.grade integer is stringified at resolution) |

Duplicate (schedule, kind, value) is rejected (409 at the API; DB-level uniqueness).

### 2.2 Unchanged / legacy tables

- `bell_schedules` — unchanged shape; now semantically a "Day Type".
- `bell_schedule_periods` — **retained but dormant at runtime.** It is a legacy mirror kept for the flat-period editor. No runtime resolution reads it anymore.

### 2.3 Migration / backfill

Schema is created by the idempotent boot helper `ensureBellScheduleVariantsSchema()` in `artifacts/api-server/src/seed.ts` (wired into boot in `index.ts`). Note: this project does **not** use drizzle-kit push; all schema changes go through `ensure*Schema()` boot helpers.

Backfill behavior (idempotent, runs once):
- Every existing schedule receives a single **"Default Schedule"** variant (`is_default = true`).
- Its legacy periods are copied in as typed blocks, with name-based type detection (a period named "Lunch" becomes a `lunch` block, "Advisory" → `advisory`, etc.).
- Verified in dev: 7 schedules backfilled → 7 variants, 49 blocks.

---

## 3. Central Resolver (new)

**File:** `artifacts/api-server/src/lib/scheduleResolver.ts` — the **only** sanctioned way to answer schedule questions at runtime.

Key exports:
- `loadDayTypeContext(schoolId)` — loads the active default Day Type + variants + blocks + grade assignments. Status is `"ok"`, `"no_day_type"`, or `"no_default"` (variants exist but none flagged default — treated as not configured; we never guess).
- `variantForGrade(ctx, grade)` — explicit assignment → default variant → `null`.
- `blockContextAt(blocks, minutesOfDay)` — `[start, end)` boundary semantics; on overlap, the later-starting block wins.
- `contextForVariant(ctx, variant, now)` / `getScheduleContextForStudent(...)` — current block/period for a variant or a specific student.
- `loadVariantPeriodWindows`, `hmToMin`, `minutesOfDayInTz` — helpers (all time math is school-timezone aware).

---

## 4. Code Adjusted to Use the Resolver

All of the following were rewired from "single flat schedule" to per-student/per-grade resolution:

| Area | File | Change |
|---|---|---|
| On-time attendance engine | `lib/onTimeAttendance.ts` | Rewritten on the resolver. Pure `computeWindow()`; per-grade windows. Explicit `passing` blocks are **bridges** (on-time window stays open across them to the next instructional period); `lunch`/`advisory` blocks keep the window **closed** while running, and their end opens the next period's window. Post-bell grace applies only to instructional periods. |
| Period-key idempotency | `lib/onTimeAttendance.ts` | Default variant keeps the legacy key `s<schedId>:p<n>:<day>` (backward compatible with existing scan records); non-default variants use `s<schedId>:v<variantId>:p<n>:<day>`. Do not collapse these. |
| Kiosk scanning | `routes/kiosk.ts` | Per-student grade window re-check on every scan (rejects `not_their_window`), per-grade roll-call periods, per-grade welcome message period. |
| Hall pass queue | `routes/hallPassQueue.ts` | Current period key via resolver (default variant, school tz). |
| Student Finder | `routes/studentFinder.ts` | Per-grade current period + the student's own variant timeline. |
| Lost instruction / tardies | `lib/lostInstruction.ts` | Added `loadGradePeriodWindows(schoolId)` → memoized `windowsForGrade(grade)`. Legacy `loadDefaultPeriodWindows` now reads the default variant. |
| Tardy consumers | `routes/tardies.ts`, `lib/studentMetrics.ts`, `lib/parentSnapshot.ts` | Grade-aware lost-minute math (grades fetched in bulk once). |
| PBIS cold periods | `routes/pbis.ts` | Resolver default variant + school-tz bucketing (was server-local time — bug fixed as part of this migration). |
| Hall pass research | `routes/hallPassResearch.ts` | **Deliberately left** on default-variant windows — it only uses average period-length estimates. |

---

## 5. API Changes

**File:** `artifacts/api-server/src/routes/bellSchedules.ts`

- `GET /bell-schedules/active` — serves the resolver's default variant; accepts optional `?grade=`. Legacy `periods` response shape is **preserved**; new `blocks` and `variant` fields added. Existing consumers (SpotlightPanel, PbisPointsHub, App.tsx) verified unaffected.
- `GET /bell-schedules` — schedule list now includes variants, blocks, and grade assignments.
- New variant CRUD (school-scoped, admin-gated, transactional):
  - `POST /bell-schedules/:id/variants`
  - `PUT /bell-schedules/:id/variants/:variantId`
  - `DELETE /bell-schedules/:id/variants/:variantId`
- Validation enforced server-side: valid block types, HH:MM format, end > start, unique period numbers, no overlapping blocks, duplicate grade assignment → 409, the default variant cannot be deleted or un-defaulted.

### Legacy editor compatibility (critical rule)

Legacy schedule `POST`/`PUT` (flat period list) mirrors its periods into the default variant **only while the schedule has at most one variant**. Once grade-specific variants exist, the variant editor is authoritative and legacy saves must never touch variant data (a promoted grade variant may be the default; an unguarded mirror would destroy it). This guard lives in `syncDefaultVariantFromPeriods`.

---

## 6. Client Changes

**File:** `artifacts/client/src/components/BellScheduleSection.tsx`

- New `VariantsSection` + `VariantEditor` inside the existing ScheduleEditor (shown for saved schedules): variant list with grade chips and default badge, typed block editor, comma-separated grade assignment input, wired to the new CRUD endpoints, list refresh from responses.
- Admin path: **Settings → School Bell Schedule → edit a schedule → "Grade schedules (variants)"**.

---

## 7. Testing & Verification

- `artifacts/api-server/src/__tests__/multiGradeSchedule.test.ts` — 18 tests covering: the 3-grade staggered-lunch spec scenario, `[start, end)` boundary inclusivity, simultaneous per-grade answers at the same wall-clock minute, lunch exclusion from on-time credit, passing-block bridging, variant-scoped period keys, default fallback, and explicit failure for unconfigured schools / missing default variant.
- Full suite: **43/43 passing**. Typecheck (`tsc -b`) clean in both api-server and client.
- Independent architect code review completed; all three findings fixed and re-tested:
  1. Legacy editor could overwrite a promoted grade variant → mirror now restricted to ≤1-variant schedules.
  2. Explicit passing blocks closed the on-time window → passing blocks now bridge to the next instructional period.
  3. Variants-without-default returned an ambiguous "ok" → explicit `no_default` status.

---

## 8. Deployment Notes

- **No manual SQL required.** `ensureBellScheduleVariantsSchema()` runs automatically at api-server boot and is idempotent (safe on every restart, including production publish).
- The live production host runs a **separate database**; the backfill will execute there on its first boot after this code is published.
- Zero-configuration rollout: schools with no variants configured behave exactly as before (single default variant mirrors the legacy schedule).

## 9. Invariants for Future Development

1. Never read `bell_schedule_periods` for runtime period resolution — always go through `scheduleResolver`.
2. Never guess a student's schedule: grade assignment → default variant → explicit not-configured.
3. Preserve the dual period-key format (legacy for default variant, variant-scoped otherwise).
4. Any new pass/attendance/period feature must be grade-aware from day one (call `variantForGrade` / `windowsForGrade`).
5. The legacy flat-period mirror must never fire on multi-variant schedules.
