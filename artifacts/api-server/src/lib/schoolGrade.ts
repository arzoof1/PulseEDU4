// School Grade scoring model — Florida school-grade component framework.
//
// A Florida school grade is the sum of up to 11 components (fewer for
// middle schools), each worth up to 100 points. The percentage of total
// possible points earned maps to a letter (A–F) via a school-type band.
// PulseEDU's calculator is an ESTIMATE / planning tool — it mirrors the
// district's spreadsheet, not the official FLDOE computation.
//
// Phase 1 implements MIDDLE SCHOOL only (9 components). The band tables
// for every school type are stored now so adding elementary / high /
// combination later is a lookup change, not a schema change.

export type SchoolGradeType =
  | "elementary"
  | "middle"
  | "high"
  | "combination";

// A school grade component. `auto` components are computed from FAST data
// by the engine; `manual` components are admin-entered at PM1/PM2 and
// uploaded at PM3 (Phase 2).
export interface SchoolGradeComponentDef {
  key: string;
  label: string;
  shortLabel: string;
  // 'fast' = computed by the engine from student_fast_scores.
  // 'manual' = admin-entered (Science, Social Studies, Acceleration).
  source: "fast" | "manual";
  // Subject the component draws from (for FAST components), used by the
  // engine + the % tested indicator.
  subject?: "ela" | "math";
  // 'achievement' | 'lg' | 'lg_l25' — the metric family (FAST only).
  metric?: "achievement" | "lg" | "lg_l25";
}

// Middle-school components, in district-spreadsheet order.
export const MIDDLE_SCHOOL_COMPONENTS: readonly SchoolGradeComponentDef[] = [
  {
    key: "ela_ach",
    label: "ELA Achievement",
    shortLabel: "ELA Ach",
    source: "fast",
    subject: "ela",
    metric: "achievement",
  },
  {
    key: "math_ach",
    label: "Math Achievement",
    shortLabel: "Math Ach",
    source: "fast",
    subject: "math",
    metric: "achievement",
  },
  {
    key: "sci_ach",
    label: "Science Achievement (Gr 8)",
    shortLabel: "Sci Ach",
    source: "manual",
  },
  {
    key: "ss_ach",
    label: "Social Studies Achievement (Civics, Gr 7)",
    shortLabel: "Civics Ach",
    source: "manual",
  },
  {
    key: "ela_lg",
    label: "ELA Learning Gains",
    shortLabel: "ELA LG",
    source: "fast",
    subject: "ela",
    metric: "lg",
  },
  {
    key: "math_lg",
    label: "Math Learning Gains",
    shortLabel: "Math LG",
    source: "fast",
    subject: "math",
    metric: "lg",
  },
  {
    key: "ela_lg_l25",
    label: "ELA Learning Gains — Lowest 25%",
    shortLabel: "ELA LG L25%",
    source: "fast",
    subject: "ela",
    metric: "lg_l25",
  },
  {
    key: "math_lg_l25",
    label: "Math Learning Gains — Lowest 25%",
    shortLabel: "Math LG L25%",
    source: "fast",
    subject: "math",
    metric: "lg_l25",
  },
  {
    key: "accel",
    label: "Middle School Acceleration",
    shortLabel: "Acceleration",
    source: "manual",
  },
] as const;

// Component key → manual-input column on school_grade_manual_inputs.
export const MANUAL_COMPONENT_COLUMN: Record<
  string,
  "science" | "socialStudies" | "acceleration"
> = {
  sci_ach: "science",
  ss_ach: "socialStudies",
  accel: "acceleration",
};

export function componentsFor(
  type: SchoolGradeType,
): readonly SchoolGradeComponentDef[] {
  // Phase 1: only middle school is implemented. Other types fall back to
  // the middle-school component list so the UI still renders; their real
  // component sets land in Phase 3.
  switch (type) {
    case "middle":
    default:
      return MIDDLE_SCHOOL_COMPONENTS;
  }
}

// Letter-grade bands by school type. Each entry is the INCLUSIVE minimum
// percent for that letter. Source: FLDOE school-grade percentage bands.
// Middle school confirmed with user (A 64+, B 57-63, C 44-56, D 34-43,
// F 0-33). The other types use the published FLDOE bands and are here so
// Phase 3 is a lookup, not a migration.
interface GradeBand {
  letter: "A" | "B" | "C" | "D" | "F";
  min: number; // inclusive minimum percent
}

export const GRADE_BANDS: Record<SchoolGradeType, readonly GradeBand[]> = {
  middle: [
    { letter: "A", min: 64 },
    { letter: "B", min: 57 },
    { letter: "C", min: 44 },
    { letter: "D", min: 34 },
    { letter: "F", min: 0 },
  ],
  elementary: [
    { letter: "A", min: 62 },
    { letter: "B", min: 54 },
    { letter: "C", min: 41 },
    { letter: "D", min: 32 },
    { letter: "F", min: 0 },
  ],
  high: [
    { letter: "A", min: 62 },
    { letter: "B", min: 54 },
    { letter: "C", min: 41 },
    { letter: "D", min: 32 },
    { letter: "F", min: 0 },
  ],
  combination: [
    { letter: "A", min: 62 },
    { letter: "B", min: 54 },
    { letter: "C", min: 41 },
    { letter: "D", min: 32 },
    { letter: "F", min: 0 },
  ],
};

export function letterForPercent(
  type: SchoolGradeType,
  percent: number,
): "A" | "B" | "C" | "D" | "F" {
  const bands = GRADE_BANDS[type];
  for (const b of bands) {
    if (percent >= b.min) return b.letter;
  }
  return "F";
}

// Sum the present components and map to a percent + letter. Missing
// (null) components are EXCLUDED from both numerator and denominator —
// this matches FLDOE (a school is graded on the components it has data
// for) and lets a partial PM1/PM2 estimate render before the manual
// pieces are entered.
export interface GradeTotal {
  totalPoints: number;
  totalPossible: number;
  presentCount: number;
  totalCount: number;
  percent: number;
  letter: "A" | "B" | "C" | "D" | "F";
}

export function computeGradeTotal(
  type: SchoolGradeType,
  values: Record<string, number | null>,
): GradeTotal {
  const comps = componentsFor(type);
  let totalPoints = 0;
  let presentCount = 0;
  for (const c of comps) {
    const v = values[c.key];
    if (v != null && Number.isFinite(v)) {
      totalPoints += v;
      presentCount += 1;
    }
  }
  const totalPossible = presentCount * 100;
  const percent =
    totalPossible > 0 ? Math.round((totalPoints / totalPossible) * 100) : 0;
  return {
    totalPoints,
    totalPossible,
    presentCount,
    totalCount: comps.length,
    percent,
    letter: letterForPercent(type, percent),
  };
}

export const PARTICIPATION_THRESHOLD = 95; // % tested warning floor
