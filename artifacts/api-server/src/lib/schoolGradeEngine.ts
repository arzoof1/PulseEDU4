// School Grade engine — computes the six FAST-derived components
// (ELA/Math Achievement, ELA/Math Learning Gains, ELA/Math LG Lowest-25%)
// from student_fast_scores for a given (school, year, window).
//
// Phase 1 is an ESTIMATE: it scores whatever students currently sit in
// the roster (no Survey 2/3 matched cohort yet — that's Phase 2). At
// PM1/PM2 the learning-gain components are PROJECTIONS (see
// learningGains.ts → projectLearningGain); at PM3 they use the strict
// PM3-to-PM3 rule (decideLearningGain), identical to the Teacher Roster.
//
// Placement conventions (mirror the roster / fastCutScores):
//   - Achievement: place the window score on the student's CURRENT-grade
//     chart; proficient = level ≥ 3.
//   - Learning Gains prior evidence: the most-recent prior-year PM3 from
//     the FL importer's historical rows (loadFastHistory), placed on the
//     test-administration grade chart via placeOnChart(pm3, subject,
//     grade-1). This is the SAME source the Teacher Roster uses for its
//     green-check (buildSubjectBlock → priorPm3); we deliberately do NOT
//     use student_fast_scores.priorYearScore here so the two surfaces
//     never disagree on a student's learning gain.
//   - Learning Gains @ PM3: current = placePm3(pm3) (prior-grade chart by
//     FAST convention) vs prior historical PM3 → decideLearningGain.
//   - Learning Gains @ PM1/PM2: current = window score on current-grade
//     chart vs prior historical PM3 → projectLearningGain (estimate).

import { db, studentsTable, studentFastScoresTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  placeOnChart,
  placePm3,
  hasChart,
  type Subject,
} from "./fastCutScores.js";
import { decideLearningGain, projectLearningGain } from "./learningGains.js";
import { loadFastHistory, type FastHistoryMap } from "./fastHistory.js";

// Middle-school tested grades for ELA / Math.
const MS_GRADES = [6, 7, 8];

export type PmWindow = "pm1" | "pm2" | "pm3";

export interface FastComponentResult {
  value: number | null; // 0..100 points, null when no data
  status: "computed" | "projected" | "pending";
  numerator: number | null;
  denominator: number | null;
  note?: string;
}

export interface SubjectParticipation {
  tested: number;
  eligible: number;
  testedPct: number;
}

export interface FastEngineResult {
  components: {
    ela_ach: FastComponentResult;
    math_ach: FastComponentResult;
    ela_lg: FastComponentResult;
    math_lg: FastComponentResult;
    ela_lg_l25: FastComponentResult;
    math_lg_l25: FastComponentResult;
  };
  participation: { ela: SubjectParticipation; math: SubjectParticipation };
}

interface StudentRow {
  studentId: string;
  grade: number;
}

interface ScoreRow {
  pm1: number | null;
  pm2: number | null;
  pm3: number | null;
  priorYearScore: number | null;
  priorYearBq: boolean;
}

function windowScore(s: ScoreRow, w: PmWindow): number | null {
  return w === "pm1" ? s.pm1 : w === "pm2" ? s.pm2 : s.pm3;
}

// Achievement: % of tested students at level 3+ on their current-grade
// chart. Denominator = students with a window score that places on a
// chart.
function achievement(
  students: StudentRow[],
  scores: Map<string, ScoreRow>,
  subject: Subject,
  w: PmWindow,
): FastComponentResult {
  let tested = 0;
  let proficient = 0;
  for (const st of students) {
    const sc = scores.get(st.studentId);
    if (!sc) continue;
    const raw = windowScore(sc, w);
    if (raw == null) continue;
    const placement = placeOnChart(raw, subject, st.grade);
    if (!placement) continue;
    tested += 1;
    if (placement.level >= 3) proficient += 1;
  }
  if (tested === 0) {
    return { value: null, status: "pending", numerator: 0, denominator: 0 };
  }
  return {
    value: Math.round((proficient / tested) * 100),
    status: "computed",
    numerator: proficient,
    denominator: tested,
  };
}

// Learning gains for a subject + window. `bottomQuartileOnly` restricts
// the cohort to prior-year Bottom-Quartile students (the Lowest-25%
// component).
function learningGains(
  students: StudentRow[],
  scores: Map<string, ScoreRow>,
  history: FastHistoryMap,
  subject: Subject,
  w: PmWindow,
  bottomQuartileOnly: boolean,
): FastComponentResult {
  let eligible = 0;
  let gains = 0;
  for (const st of students) {
    const sc = scores.get(st.studentId);
    if (!sc) continue;
    if (bottomQuartileOnly && !sc.priorYearBq) continue;
    const raw = windowScore(sc, w);
    if (raw == null) continue;

    // Prior-year evidence = most-recent historical PM3 (FL importer),
    // placed on the test-administration grade chart (current grade − 1).
    // Identical to the Teacher Roster's priorPm3 resolution so the two
    // surfaces can never disagree. No historical PM3 → cannot decide.
    const priorPm3 = history.get(st.studentId)?.get(subject)?.[0];
    if (!priorPm3) continue;
    const priorGrade = st.grade - 1;
    const canPlacePrior =
      priorGrade >= 1 &&
      (subject === "ela" || subject === "math") &&
      hasChart(subject, priorGrade);
    const priorPlacement = canPlacePrior
      ? placeOnChart(priorPm3.pm3, subject, priorGrade)
      : null;

    let gain: boolean | null;
    if (w === "pm3") {
      const currentPlacement = placePm3(raw, subject, st.grade);
      gain = decideLearningGain({
        priorLevel: priorPlacement?.level ?? null,
        currentLevel: currentPlacement?.level ?? null,
        priorScore: priorPm3.pm3,
        currentScore: raw,
        priorSubLevel: priorPlacement?.subLevel ?? null,
        currentSubLevel: currentPlacement?.subLevel ?? null,
      });
    } else {
      const currentPlacement = placeOnChart(raw, subject, st.grade);
      gain = projectLearningGain({
        priorLevel: priorPlacement?.level ?? null,
        currentLevel: currentPlacement?.level ?? null,
        priorSubLevel: priorPlacement?.subLevel ?? null,
        currentSubLevel: currentPlacement?.subLevel ?? null,
      });
    }
    if (gain == null) continue; // not enough data — excluded
    eligible += 1;
    if (gain) gains += 1;
  }
  if (eligible === 0) {
    return { value: null, status: "pending", numerator: 0, denominator: 0 };
  }
  return {
    value: Math.round((gains / eligible) * 100),
    status: w === "pm3" ? "computed" : "projected",
    numerator: gains,
    denominator: eligible,
  };
}

function participation(
  students: StudentRow[],
  scores: Map<string, ScoreRow>,
  w: PmWindow,
): SubjectParticipation {
  const eligible = students.length;
  let tested = 0;
  for (const st of students) {
    const sc = scores.get(st.studentId);
    if (sc && windowScore(sc, w) != null) tested += 1;
  }
  return {
    tested,
    eligible,
    testedPct: eligible > 0 ? Math.round((tested / eligible) * 100) : 0,
  };
}

export async function computeFastComponents(
  schoolId: number,
  schoolYear: string,
  w: PmWindow,
): Promise<FastEngineResult> {
  // Active roster for tested grades. There is no withdrawn flag on
  // students; the roster IS the active set (school-scoped).
  const students = (await db
    .select({
      studentId: studentsTable.studentId,
      grade: studentsTable.grade,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        inArray(studentsTable.grade, MS_GRADES),
      ),
    )) as StudentRow[];

  const ids = students.map((s) => s.studentId);

  const buildScoreMap = async (subject: Subject) => {
    const map = new Map<string, ScoreRow>();
    if (ids.length === 0) return map;
    const rows = await db
      .select({
        studentId: studentFastScoresTable.studentId,
        pm1: studentFastScoresTable.pm1,
        pm2: studentFastScoresTable.pm2,
        pm3: studentFastScoresTable.pm3,
        priorYearScore: studentFastScoresTable.priorYearScore,
        priorYearBq: studentFastScoresTable.priorYearBq,
      })
      .from(studentFastScoresTable)
      .where(
        and(
          eq(studentFastScoresTable.schoolId, schoolId),
          eq(studentFastScoresTable.schoolYear, schoolYear),
          eq(studentFastScoresTable.subject, subject),
          eq(studentFastScoresTable.isHistorical, false),
          inArray(studentFastScoresTable.studentId, ids),
        ),
      );
    for (const r of rows) {
      map.set(r.studentId, {
        pm1: r.pm1,
        pm2: r.pm2,
        pm3: r.pm3,
        priorYearScore: r.priorYearScore,
        priorYearBq: r.priorYearBq,
      });
    }
    return map;
  };

  const elaScores = await buildScoreMap("ela");
  const mathScores = await buildScoreMap("math");

  // Prior-year PM3 evidence for learning gains — same source as the
  // Teacher Roster (FL importer historical rows), school-scoped.
  const history = await loadFastHistory({
    schoolId,
    studentIds: ids,
    subjects: ["ela", "math"],
    currentSchoolYear: schoolYear,
  });

  return {
    components: {
      ela_ach: achievement(students, elaScores, "ela", w),
      math_ach: achievement(students, mathScores, "math", w),
      ela_lg: learningGains(students, elaScores, history, "ela", w, false),
      math_lg: learningGains(students, mathScores, history, "math", w, false),
      ela_lg_l25: learningGains(students, elaScores, history, "ela", w, true),
      math_lg_l25: learningGains(students, mathScores, history, "math", w, true),
    },
    participation: {
      ela: participation(students, elaScores, w),
      math: participation(students, mathScores, w),
    },
  };
}
