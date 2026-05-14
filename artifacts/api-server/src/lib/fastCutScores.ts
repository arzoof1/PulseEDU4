// FAST cut-score tables and placement helpers.
//
// Source: FL DOE FAST scale-score "Learning Gains" tables.
//   - ELA   → Table 6 (grades 3–10)
//   - Math  → Table 8 (grades 3–8 + Algebra 1 + Geometry)
//
// Algebra 1 and Geometry EOC are intentionally NOT included in the
// chart yet — per spec, the Teacher Roster hides the bucket icon for
// those students (and we don't have FAST EOC scores in seed data).
//
// Conventions:
//   - Each grade has Levels 1–5.
//   - Level 1 has sub-bands Low / Middle / High.
//   - Level 2 has sub-bands Low / High.
//   - Levels 3–5 are whole bands (no sub-divisions).
//
// Placement rules (per the worked example):
//   - PM1 / PM2 placement: use the student's CURRENT-grade chart.
//   - PM3 placement:       use the PRIOR-grade chart (it represents
//                          end-of-prior-year mastery).
//   - 3rd grade has no prior-grade chart, so we fall back to G3 for
//     PM3 placement and the bucket icon is HIDDEN.
//   - Algebra 1 / Geometry: not in this table; bucket also HIDDEN.
//
// Bucket target:
//   - Always computed against the student's CURRENT-grade chart.
//   - Target = the MIN of the NEXT SUB-BAND on the climb path:
//       Low1 → Mid1 → High1 → Low2 → High2 → L3 → L4 → L5.
//     Sub-bands give smaller, more achievable increments than whole
//     levels.
//   - Gap   = target − pm3Score.
//   - Color reflects the student's CURRENT level (per FAST palette):
//       L1 red, L2 orange, L3 green, L4 blue, L5 purple.

export type SubLevel =
  | "1.1" // Level 1 Low
  | "1.2" // Level 1 Middle
  | "1.3" // Level 1 High
  | "2.1" // Level 2 Low
  | "2.2" // Level 2 High
  | "3"
  | "4"
  | "5";

export interface Placement {
  level: 1 | 2 | 3 | 4 | 5;
  subLevel: SubLevel;
}

export type BucketColor = "red" | "orange" | "green" | "blue" | "purple";

export interface BucketInfo {
  // The min score on the current-grade chart that lands the student in
  // the next SUB-BAND on the climb path. null when no next stop exists
  // (already at L5) or no chart is available.
  targetScore: number | null;
  // pm3 - target. Negative = at/above next stop. null when target null.
  gap: number | null;
  // Color of the student's CURRENT level (per FAST palette), not the
  // gap size. null when no placement.
  color: BucketColor | null;
  // The student's current sub-level (e.g. "1.2", "2.2", "3"). null when
  // no placement.
  currentSubLevel: SubLevel | null;
  // Human-readable label of the next stop on the path (e.g. "Mid 1",
  // "High 2", "Level 3"). null when already at L5 / no chart.
  nextStopLabel: string | null;
}

// Per-grade chart. We only need the Level 3/4/5 mins and the L1/L2 sub
// boundaries for placement; the full ranges are encoded as printed for
// readability and so we can validate scores.
type Range = readonly [min: number, max: number];

interface FastChart {
  L1Low: Range;
  L1Mid: Range;
  L1High: Range;
  L2Low: Range;
  L2High: Range;
  L3: Range;
  L4: Range;
  L5: Range;
}

// ---- ELA Table 6 ----
const ELA: Record<number, FastChart> = {
  3: {
    L1Low: [140, 155],
    L1Mid: [156, 170],
    L1High: [171, 185],
    L2Low: [186, 193],
    L2High: [194, 200],
    L3: [201, 212],
    L4: [213, 224],
    L5: [225, 260],
  },
  4: {
    L1Low: [154, 168],
    L1Mid: [169, 183],
    L1High: [184, 198],
    L2Low: [199, 205],
    L2High: [206, 212],
    L3: [213, 223],
    L4: [224, 236],
    L5: [237, 270],
  },
  5: {
    L1Low: [160, 175],
    L1Mid: [176, 190],
    L1High: [191, 205],
    L2Low: [206, 213],
    L2High: [214, 221],
    L3: [222, 231],
    L4: [232, 245],
    L5: [246, 279],
  },
  6: {
    L1Low: [161, 176],
    L1Mid: [177, 192],
    L1High: [193, 208],
    L2Low: [209, 216],
    L2High: [217, 224],
    L3: [225, 236],
    L4: [237, 249],
    L5: [250, 284],
  },
  7: {
    L1Low: [165, 181],
    L1Mid: [182, 198],
    L1High: [199, 214],
    L2Low: [215, 223],
    L2High: [224, 231],
    L3: [232, 241],
    L4: [242, 256],
    L5: [257, 292],
  },
  8: {
    L1Low: [169, 185],
    L1Mid: [186, 202],
    L1High: [203, 219],
    L2Low: [220, 228],
    L2High: [229, 237],
    L3: [238, 250],
    L4: [251, 261],
    L5: [262, 300],
  },
  9: {
    // L1Low ends at 190 (not 191) — adjacent-grade pattern + DOE Table 6.
    // Earlier rev had a transcription overlap at 191 that always pulled
    // a 191 into L1Low ahead of L1Mid.
    L1Low: [174, 190],
    L1Mid: [191, 207],
    L1High: [208, 223],
    L2Low: [224, 232],
    L2High: [233, 241],
    L3: [242, 253],
    L4: [254, 266],
    L5: [267, 303],
  },
  10: {
    L1Low: [179, 195],
    L1Mid: [196, 212],
    L1High: [213, 229],
    L2Low: [230, 238],
    L2High: [239, 246],
    L3: [247, 257],
    L4: [258, 270],
    L5: [271, 308],
  },
};

// ---- Math Table 8 (FAST Math, grades 3–8 only) ----
const MATH: Record<number, FastChart> = {
  3: {
    L1Low: [140, 154],
    L1Mid: [155, 168],
    L1High: [169, 182],
    L2Low: [183, 190],
    L2High: [191, 197],
    L3: [198, 208],
    L4: [209, 224],
    L5: [225, 260],
  },
  4: {
    L1Low: [155, 169],
    L1Mid: [170, 184],
    L1High: [185, 199],
    L2Low: [200, 205],
    L2High: [206, 210],
    L3: [211, 220],
    L4: [221, 237],
    L5: [238, 273],
  },
  5: {
    L1Low: [158, 174],
    L1Mid: [175, 190],
    L1High: [191, 206],
    L2Low: [207, 214],
    L2High: [215, 221],
    L3: [222, 233],
    L4: [234, 245],
    L5: [246, 285],
  },
  6: {
    L1Low: [168, 182],
    L1Mid: [183, 197],
    L1High: [198, 212],
    L2Low: [213, 220],
    L2High: [221, 228],
    L3: [229, 238],
    L4: [239, 253],
    L5: [254, 287],
  },
  7: {
    L1Low: [175, 190],
    L1Mid: [191, 206],
    L1High: [207, 222],
    L2Low: [223, 228],
    L2High: [229, 234],
    L3: [235, 246],
    L4: [247, 257],
    L5: [258, 288],
  },
  8: {
    L1Low: [183, 197],
    L1Mid: [198, 212],
    L1High: [213, 226],
    L2Low: [227, 235],
    L2High: [236, 243],
    L3: [244, 253],
    L4: [254, 262],
    L5: [263, 291],
  },
};

export type Subject = "ela" | "math";

function chartFor(subject: Subject, grade: number): FastChart | null {
  const table = subject === "ela" ? ELA : MATH;
  return table[grade] ?? null;
}

// Public: does this (subject, grade) have a chart at all?
export function hasChart(subject: Subject, grade: number): boolean {
  return chartFor(subject, grade) !== null;
}

// Place a raw scale score on a given chart. Returns null if no chart
// exists or if the score falls outside all bands (defensive — FAST
// scores should always land somewhere).
export function placeOnChart(
  score: number,
  subject: Subject,
  chartGrade: number,
): Placement | null {
  const c = chartFor(subject, chartGrade);
  if (!c) return null;

  const inRange = (s: number, r: Range) => s >= r[0] && s <= r[1];

  if (inRange(score, c.L1Low)) return { level: 1, subLevel: "1.1" };
  if (inRange(score, c.L1Mid)) return { level: 1, subLevel: "1.2" };
  if (inRange(score, c.L1High)) return { level: 1, subLevel: "1.3" };
  if (inRange(score, c.L2Low)) return { level: 2, subLevel: "2.1" };
  if (inRange(score, c.L2High)) return { level: 2, subLevel: "2.2" };
  if (inRange(score, c.L3)) return { level: 3, subLevel: "3" };
  if (inRange(score, c.L4)) return { level: 4, subLevel: "4" };
  if (inRange(score, c.L5)) return { level: 5, subLevel: "5" };

  // Outside all bands. Approximate by clamp:
  if (score < c.L1Low[0]) return { level: 1, subLevel: "1.1" };
  return { level: 5, subLevel: "5" };
}

// Place a PM3 score using the PRIOR-grade chart (per the worked
// example). 3rd graders have no prior chart — caller should still
// expect a placement (we fall back to G3) but suppress the bucket icon.
export function placePm3(
  score: number,
  subject: Subject,
  currentGrade: number,
): Placement | null {
  const priorGrade = currentGrade - 1;
  const c = chartFor(subject, priorGrade);
  if (c) return placeOnChart(score, subject, priorGrade);
  // Fallback for 3rd grade (and any out-of-range grade): use current.
  return placeOnChart(score, subject, currentGrade);
}

// The climb path: each sub-band's next stop. Used to compute the
// bucket target one INCREMENT at a time rather than jumping a whole
// integer level.
const NEXT_STOP: Record<SubLevel, SubLevel | null> = {
  "1.1": "1.2",
  "1.2": "1.3",
  "1.3": "2.1",
  "2.1": "2.2",
  "2.2": "3",
  "3": "4",
  "4": "5",
  "5": null,
};

const SUB_LEVEL_LABEL: Record<SubLevel, string> = {
  "1.1": "Low 1",
  "1.2": "Mid 1",
  "1.3": "High 1",
  "2.1": "Low 2",
  "2.2": "High 2",
  "3": "Level 3",
  "4": "Level 4",
  "5": "Level 5",
};

// Min score for a given sub-band on a chart.
function subLevelMin(c: FastChart, sub: SubLevel): number | null {
  switch (sub) {
    case "1.1":
      return c.L1Low[0];
    case "1.2":
      return c.L1Mid[0];
    case "1.3":
      return c.L1High[0];
    case "2.1":
      return c.L2Low[0];
    case "2.2":
      return c.L2High[0];
    case "3":
      return c.L3[0];
    case "4":
      return c.L4[0];
    case "5":
      return c.L5[0];
  }
}

// Compute the bucket target on the CURRENT-grade chart given the PM3
// placement sub-level. Returns null when:
//   - no current-grade chart exists (Algebra/Geometry, etc.)
//   - the student is already at L5 (no next stop)
//   - currentGrade === 3 (per spec: hide bucket for grade 3)
export function bucketTarget(
  subject: Subject,
  currentGrade: number,
  placedSubLevel: SubLevel,
): { score: number; nextStop: SubLevel } | null {
  if (currentGrade === 3) return null;
  const c = chartFor(subject, currentGrade);
  if (!c) return null;
  const next = NEXT_STOP[placedSubLevel];
  if (next === null) return null;
  const score = subLevelMin(c, next);
  if (score === null) return null;
  return { score, nextStop: next };
}

const LEVEL_COLOR: Record<1 | 2 | 3 | 4 | 5, BucketColor> = {
  1: "red",
  2: "orange",
  3: "green",
  4: "blue",
  5: "purple",
};

// One-shot bucket computation for a PM3 score.
export function bucketFor(
  pm3Score: number,
  subject: Subject,
  currentGrade: number,
): BucketInfo {
  const placement = placePm3(pm3Score, subject, currentGrade);
  if (!placement) {
    return {
      targetScore: null,
      gap: null,
      color: null,
      currentSubLevel: null,
      nextStopLabel: null,
    };
  }
  const target = bucketTarget(subject, currentGrade, placement.subLevel);
  if (target === null) {
    return {
      targetScore: null,
      gap: null,
      color: LEVEL_COLOR[placement.level],
      currentSubLevel: placement.subLevel,
      nextStopLabel: null,
    };
  }
  return {
    targetScore: target.score,
    gap: target.score - pm3Score,
    color: LEVEL_COLOR[placement.level],
    currentSubLevel: placement.subLevel,
    nextStopLabel: SUB_LEVEL_LABEL[target.nextStop],
  };
}
