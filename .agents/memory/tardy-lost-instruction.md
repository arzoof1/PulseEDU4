---
name: Tardy lost-instruction metrics
description: How staff + parent tardy/lost-instruction YTD totals are computed and kept in parity.
---

# Tardy "lost instruction" metrics

Two surfaces show school-year-to-date tardy totals: the staff Hall Passes
"Tardy / Check-In History" tab (school-wide) and the parent HeartBEAT
attendance section + its PDF (per-child).

## Lost-instruction math
- Lives in `artifacts/api-server/src/lib/lostInstruction.ts`.
- Per tardy: `lostMinutes = (createdAt-in-school-tz minutes-of-day) − (scheduled
  period start)`, clamped to `[0, period length]` with a 90-min fallback cap
  when the period has no usable end time.
- Period start comes from the school's DEFAULT **and** ACTIVE bell schedule,
  matched on period number (`periodNumberFromText` accepts "3"/"03"/"P3").
- Returns `null` (not computable) when the period isn't on the default
  schedule or no default+active schedule exists — callers surface that
  honestly ("not counted — no bell time"), never as 0.
- Timezone: pass the per-school tz via `getSchoolTimezone(schoolId)`
  (`schoolYear.ts`), NOT the bare `DEFAULT_SCHOOL_TZ`. `createdAt` is a UTC
  ISO string; minutes-of-day is derived with `Intl.DateTimeFormat`.

## Parity invariant
**Why:** the staff total (computed client-side from the enriched `/api/tardies`
rows) and the parent total (computed server-side in `parentSnapshot.ts`) must
agree on the window.
**How to apply:** both use an **Aug 1 cutover** (matches parent
`schoolYearBounds`). The client helper `schoolYearBoundsIso()` in `App.tsx`
returns `{start, end}` with an **exclusive** upper bound (next Aug 1) so
future-dated rows don't leak in — keep the upper bound; don't revert to a
start-only filter.

## Gotcha
`GET /api/tardies` is plain `res.json` (NOT in api-spec/OpenAPI). Adding a
field is backward-compatible but requires editing the local `Tardy` interface
in `App.tsx` by hand. Seed tardies use evening timestamps, so they all clamp
to the period length — that's expected, not a bug.
