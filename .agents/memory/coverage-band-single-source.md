---
name: Instructional Coverage band single-source
description: The effectiveness-band ladder for the Instructional Coverage Report is one shared function across the row and per-teacher drawer.
---

# Instructional Coverage effectiveness band

`computeCoverageBand(deliveries, masteryPct)` + `COVERAGE_BAND_META` (module-level in `InstructionalCoverageDashboard.tsx`) are the SINGLE source of truth for the flag pill. The schoolwide row feeds it the aggregate (totalDeliveries + rolled-up mastery); the drawer feeds it one teacher's own numbers. Same function, two grains.

**The ladder (order matters):**
1. `deliveries === 0` → `critical` — pure COVERAGE gap ("not taught"), not a method verdict.
2. `masteryPct === null` → `nosignal` — taught but no FAST data; can't judge effectiveness.
3. `masteryPct < 50` → `reteach` — taught but not landing, at ANY delivery count.
4. `masteryPct >= 70 && deliveries >= 2` → `effective`.
5. else → `building`.

**Why:** Previously two divergent functions (row `bandOf` needed ≥3 deliveries for Effective + called 1-delivery-low-mastery "critical"; drawer `teacherBand` needed ≥2 + called it "reteach"), so the same student/benchmark got different labels on the row vs in the drawer. Null mastery was also silently folded into building/critical, hiding "no evidence yet" behind "trending". A coach reasonably expected the two surfaces to agree.

**How to apply:**
- The null check MUST stay ABOVE the `< 50` comparison — JS coerces `null < 50` to `0 < 50 = true`, which would mislabel no-signal teachers as re-teach.
- Any new band value must be wired at ALL enumerations: the `bandCounts` record, the legend chip map array, the "What the bands mean" HowTo legend, the drawer bottom legend, and it inherits sort `rank` from the shared meta.
- Never reintroduce a second per-surface band function; extend the shared one.
