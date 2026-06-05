// Learning-gain decision logic, shared by the Teacher Roster and the
// School Grade Calculator so both speak the exact same definition of a
// "gain." Previously this lived as an inline IIFE inside teacherRoster.ts;
// it was extracted here when the School Grade Calculator needed identical
// rules. Keep this as the single source of truth — do not re-implement.
//
// Two flavours:
//   - decideLearningGain  → the STRICT, official FLDOE-style rule used at
//     PM3 (and on the roster). Requires real PM3-to-PM3 evidence.
//   - projectLearningGain → a LENIENT PM1/PM2 PROJECTION ("are they on
//     pace?"). There is no current-year endpoint yet at PM1/PM2, so we
//     compare the current window placement against last year's final
//     placement and treat "maintaining proficiency / holding sub-tier" as
//     on-track. This is an ESTIMATE only and is always labelled as such in
//     the UI — never present it as an actual learning gain.

import type { SubLevel } from "./fastCutScores";

// STRICT rule (per district guidance, confirmed May 2026):
//   - Moved up a performance level → MET
//   - Stayed at L5 → MET (top of scale; growth not measurable)
//   - Stayed at L3 or L4 → MET only when this year's score is at least
//     last year's + 1 (some scale-score growth, not flat).
//   - Stayed at L1 or L2 → MET only when this year's sub-tier is HIGHER
//     than last year's sub-tier.
//   - Dropped a level → NOT MET.
// Returns null when there isn't enough data to decide (excluded from the
// learning-gains denominator).
export function decideLearningGain(params: {
  priorLevel: number | null;
  currentLevel: number | null;
  priorScore: number | null;
  currentScore: number | null;
  priorSubLevel: SubLevel | null;
  currentSubLevel: SubLevel | null;
}): boolean | null {
  const {
    priorLevel,
    currentLevel,
    priorScore,
    currentScore,
    priorSubLevel,
    currentSubLevel,
  } = params;
  if (priorLevel == null || currentLevel == null) return null;
  if (currentLevel > priorLevel) return true;
  if (currentLevel === priorLevel) {
    if (currentLevel === 5) return true;
    if (currentLevel === 3 || currentLevel === 4) {
      if (priorScore == null || currentScore == null) return null;
      return currentScore >= priorScore + 1;
    }
    if (currentLevel === 1 || currentLevel === 2) {
      // Sub-tier order within L1/L2: "1.1" < "1.2" < "1.3" (and "2.1" <
      // "2.2"). Lexicographic compare is safe — all sub-tier strings share
      // the same "<digit>.<digit>" shape and length.
      if (priorSubLevel == null || currentSubLevel == null) return null;
      return currentSubLevel > priorSubLevel;
    }
  }
  return false;
}

// LENIENT PM1/PM2 projection. Scale scores across different grade charts
// are not directly comparable, so this rule uses LEVEL and SUB-TIER only —
// never the "+1 scale point" maintenance test from the strict rule.
//   - Moved up a level → on pace
//   - Dropped a level → off pace
//   - Same level, L3+ → on pace (already proficient; holding is good)
//   - Same level, L1/L2 → on pace only if sub-tier held or improved
// Returns null when there isn't enough data to project.
export function projectLearningGain(params: {
  priorLevel: number | null;
  currentLevel: number | null;
  priorSubLevel: SubLevel | null;
  currentSubLevel: SubLevel | null;
}): boolean | null {
  const { priorLevel, currentLevel, priorSubLevel, currentSubLevel } = params;
  if (priorLevel == null || currentLevel == null) return null;
  if (currentLevel > priorLevel) return true;
  if (currentLevel < priorLevel) return false;
  if (currentLevel >= 3) return true;
  if (priorSubLevel == null || currentSubLevel == null) return null;
  return currentSubLevel >= priorSubLevel;
}
