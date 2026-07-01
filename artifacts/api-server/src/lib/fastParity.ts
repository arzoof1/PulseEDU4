// Shared single-student FAST parity loader. Produces the exact same
// per-subject FAST view the Teacher Roster / Insights drill-downs render —
// achievement-level placements (pills), points-to-next-level,
// points-to-proficiency, and the strict PM3-to-PM3 learning-gain check — so
// the Student Snapshot and the Family HeartBEAT PDF show numbers identical to
// every other surface.
//
// All computation flows through the same helpers the roster uses:
//   - placePmSet   → PM1/PM2/PM3 (+prior) achievement-level placements
//   - bucketFor    → points-to-next sub-level (PM3-only, matching the roster)
//   - proficiencyGap → points-to-Level-3 (PM3-only)
//   - computeRowLearningGain → learning-gain green-check (loadFastHistory PM3)
//
// "Current year" is resolved from the DATA (resolveCurrentFastYear), never the
// wall clock — a frozen demo dataset drifts past the July school-year boundary.

import { and, eq } from "drizzle-orm";
import { db, studentFastScoresTable } from "@workspace/db";
import {
  placePmSet,
  bucketFor,
  proficiencyGap,
  withGap,
  type PmPlacementSetWithGap,
  type Subject,
} from "./fastCutScores.js";
import { computeRowLearningGain } from "./learningGains.js";
import {
  loadFastHistory,
  pickHistory,
  resolveCurrentFastYear,
} from "./fastHistory.js";

export interface FastParityRow {
  subject: "ela" | "math";
  pm1: number | null;
  pm2: number | null;
  pm3: number | null;
  priorYearScore: number | null;
  priorYearBq: boolean;
  // Achievement-level placements for prior/PM1/PM2/PM3 (single-sourced via
  // placePmSet), each enriched with the per-window "+N → next stop" caption
  // (withGap) so the Student Snapshot renders the exact same per-pill caption
  // the Teacher Roster does. Drives the level pills; null members render
  // neutral.
  levels: PmPlacementSetWithGap;
  // Strict PM3-to-PM3 learning-gain flag (null = not enough evidence).
  learningGain: boolean | null;
  // PM3-only, matching the Teacher Roster / drill-down metric columns.
  ptsToNextLevel: number | null;
  ptsToProficient: number | null;
}

const EMPTY_LEVELS: PmPlacementSetWithGap = {
  priorYearScore: null,
  pm1: null,
  pm2: null,
  pm3: null,
};

// Load current-year FAST parity rows for one student. Always returns both
// subjects (ela, math) in stable order — a subject with no data comes back
// null-filled so callers that always render both (Student Snapshot) can, while
// callers that want an empty state (parent PDF) can filter out the null rows.
export async function loadStudentFastParity(args: {
  schoolId: number;
  studentId: string;
  grade: number | string | null;
}): Promise<FastParityRow[]> {
  const { schoolId, studentId } = args;
  const grade =
    args.grade != null && Number.isInteger(Number(args.grade))
      ? Number(args.grade)
      : null;

  const currentSchoolYear = await resolveCurrentFastYear(schoolId);

  const rows = await db
    .select({
      subject: studentFastScoresTable.subject,
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
        eq(studentFastScoresTable.studentId, studentId),
        eq(studentFastScoresTable.schoolYear, currentSchoolYear),
        eq(studentFastScoresTable.isHistorical, false),
      ),
    );

  const historyMap = await loadFastHistory({
    schoolId,
    studentIds: [studentId],
    subjects: ["ela", "math"],
  });

  const subjects: Array<"ela" | "math"> = ["ela", "math"];
  return subjects.map((subject) => {
    const r = rows.find((row) => row.subject === subject);
    const pm1 = r?.pm1 ?? null;
    const pm2 = r?.pm2 ?? null;
    const pm3 = r?.pm3 ?? null;
    const priorYearScore = r?.priorYearScore ?? null;

    const levels: PmPlacementSetWithGap =
      grade != null
        ? (() => {
            const base = placePmSet(subject as Subject, grade, {
              priorYearScore,
              pm1,
              pm2,
              pm3,
            });
            // Enrich each window with its "+N → next stop" caption using the
            // same shared helper the Teacher Roster uses (current-grade chart),
            // so the Snapshot's per-pill captions match the Roster exactly.
            return {
              priorYearScore: withGap(
                base.priorYearScore,
                priorYearScore,
                subject as Subject,
                grade,
              ),
              pm1: withGap(base.pm1, pm1, subject as Subject, grade),
              pm2: withGap(base.pm2, pm2, subject as Subject, grade),
              pm3: withGap(base.pm3, pm3, subject as Subject, grade),
            };
          })()
        : EMPTY_LEVELS;

    const learningGain = computeRowLearningGain({
      subject: subject as Subject,
      grade,
      currentLevels: levels,
      currentPm3: pm3,
      history: pickHistory(historyMap, studentId, subject),
    });

    const ptsToNextLevel =
      pm3 != null && grade != null
        ? bucketFor(pm3, subject as Subject, grade).gap
        : null;
    const ptsToProficient =
      grade != null ? proficiencyGap(pm3, subject as Subject, grade) : null;

    return {
      subject,
      pm1,
      pm2,
      pm3,
      priorYearScore,
      priorYearBq: r?.priorYearBq ?? false,
      levels,
      learningGain,
      ptsToNextLevel,
      ptsToProficient,
    };
  });
}
