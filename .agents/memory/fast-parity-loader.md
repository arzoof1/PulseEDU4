---
name: FAST parity single-source loader
description: One loader (loadStudentFastParity) is the single source for the roster-style FAST view on the Student Snapshot and the Family HeartBEAT PDF.
---

# Single-student FAST parity loader

`lib/fastParity.ts` `loadStudentFastParity({schoolId, studentId, grade})` is the
one place that builds the Teacher-Roster-style FAST view (achievement-level
placements, points-to-next sub-level, points-to-proficiency, strict PM3-to-PM3
learning-gain check) for a single student. It composes the SAME roster helpers:
`placePmSet` + `bucketFor` + `proficiencyGap` (`fastCutScores.ts`) and
`computeRowLearningGain` (`lib/learningGains.ts`, which reads `loadFastHistory`).

Consumers: the Student Snapshot endpoint (`routes/exports.ts`) and the Family
HeartBEAT (`lib/parentSnapshot.ts` → `parentSnapshotPdf.ts`). It always returns
BOTH subjects (ela, math) null-filled; the PDF filters to rows with any non-null
score to keep its "No FAST results yet" empty state.

**Why:** the user requires the same student to show identical FAST numbers on
the Teacher Roster, Insights drill-downs, Student Snapshot, and HeartBEAT.
Duplicating the placement/points/LG math per surface is exactly how they drift.

**How to apply:**
- Any NEW single-student FAST surface goes through `loadStudentFastParity`, not a
  fresh `student_fast_scores` query. Do not re-derive levels/points/LG inline.
- "Current year" is resolved from DATA (`resolveCurrentFastYear` = MAX
  non-historical `school_year`), NOT the wall clock — a frozen demo dataset
  drifts past the July school-year boundary. (This is what fixed the old
  `parentSnapshot.ts` wall-clock `schoolYearLabelFor` query.)
- The learning-gain check must come from `computeRowLearningGain`
  (`loadFastHistory` historical PM3), never `student_fast_scores.priorYearScore`
  — same rule as the School Grade calculator.
- Server can't import the client `FastScorePill` palette, so the PDF redefines
  the L1-L5 color map locally; keep it in sync (L1 red / L2 orange / L3 green /
  L4 blue / L5 purple). The PDF LG check is a drawn vector stroke — WinAnsi
  built-in fonts can't render a ✓ glyph.
