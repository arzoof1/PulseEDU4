---
name: FAST level pill single-source
description: Rendering the same FAST achievement-level pill across Roster + Insights drill-downs without drift.
---

# FAST level pill single-source

The roster-style FAST pill (level-colored, click-to-flip sub-level↔scale
score) is shared between the Teacher Roster and the Insights drill-downs.

**Rule:** the level palette (`LEVEL_BG`/`LEVEL_FG`) and the per-PM placement
conventions live in ONE place each — the palette in
`components/FastScorePill.tsx` (imported by the roster, not re-declared),
and the placements in `placePmSet()` (`fastCutScores.ts`: prior & current
PM3 → `placePm3`; PM1/PM2 → `placeOnChart`). Trajectory band classification
derives from the SAME `placePmSet` result it uses for the pills.

**Why:** colors and placement math previously had a roster copy and a
drawer copy; any tweak to one silently diverged the surfaces. The product
invariant is "the drill-down pill must match the roster pill exactly."

**How to apply:** never add a second local copy of the level palette or a
parallel placeOnChart/placePm3 call for a new FAST-pill surface — import
the palette and call `placePmSet`. The drawer's `levels` field carries the
placements; both shared-`BandStudentsDrawer` callers (AcademicsTrajectory +
AcademicsDashboard) must ALSO set `showScoreToggle` — it's easy to wire one
and forget the other, leaving one drill-down without the global toggle.
