// FAST score coverage telemetry.
//
// Admin-gated. Returns per-(subject, grade) coverage so a new tenant
// admin can see at a glance: "FAST scores missing for grades X, Y, Z"
// before opening the Teacher Roster (which silently renders blank
// pills when scores aren't loaded). Backs the Settings → FAST
// Coverage tile.
//
// Computes, for each (subject, grade) the school has students at:
//   - studentsTotal        — count of active students at that grade
//   - withPm1 / withPm2 / withPm3 — students with that PM score loaded
//   - withPriorYear        — students with the prior-year scale score
//   - hasChart             — whether fastCutScores.ts has a chart for
//                            this (subject, grade). When false the row
//                            is informational only — loading scores
//                            won't unblock the bucket render.
//
// "Missing" is defined as `studentsTotal > 0 && hasChart &&
// withPm3 === 0`. PM3 drives the LG bucket, so a school can ship a
// roster without PM1/PM2 but PM3 is the canonical blocker.
import { Router, type IRouter } from "express";
import {
  db,
  staffTable,
  studentsTable,
  studentFastScoresTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { hasChart, SUBJECT_KEYS, type Subject } from "../lib/fastCutScores.js";

const router: IRouter = Router();

interface CoverageRow {
  subject: Subject;
  grade: number;
  studentsTotal: number;
  withPm1: number;
  withPm2: number;
  withPm3: number;
  withPriorYear: number;
  hasChart: boolean;
}

router.get("/insights/fast-coverage", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  // Admin-only — telemetry tile is a Settings page surface.
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  const [staff] = await db
    .select({
      isAdmin: staffTable.isAdmin,
      isDistrictAdmin: staffTable.isDistrictAdmin,
      isSuperUser: staffTable.isSuperUser,
    })
    .from(staffTable)
    .where(eq(staffTable.id, staffId))
    .limit(1);
  if (
    !staff ||
    !(staff.isAdmin || staff.isDistrictAdmin || staff.isSuperUser)
  ) {
    res.status(403).json({ error: "Admin only" });
    return;
  }

  // 1) Students per grade (only grades > 0 — kindergarten is grade 0
  // and has no FAST chart, so it would always render "missing"
  // noise. Surface those separately if a tenant asks for it.)
  const studentsByGrade = await db
    .select({
      grade: studentsTable.grade,
      count: sql<number>`count(*)::int`,
    })
    .from(studentsTable)
    .where(eq(studentsTable.schoolId, schoolId))
    .groupBy(studentsTable.grade);

  // 2) Score coverage per (subject, grade). Join students → scores so
  // the count reflects only currently-rostered students; orphaned
  // score rows for transferred-out students don't inflate coverage.
  const scoresByGradeSubject = await db
    .select({
      grade: studentsTable.grade,
      subject: studentFastScoresTable.subject,
      withPm1: sql<number>`count(*) filter (where ${studentFastScoresTable.pm1} is not null)::int`,
      withPm2: sql<number>`count(*) filter (where ${studentFastScoresTable.pm2} is not null)::int`,
      withPm3: sql<number>`count(*) filter (where ${studentFastScoresTable.pm3} is not null)::int`,
      withPriorYear: sql<number>`count(*) filter (where ${studentFastScoresTable.priorYearScore} is not null)::int`,
    })
    .from(studentFastScoresTable)
    .innerJoin(
      studentsTable,
      and(
        eq(studentsTable.schoolId, studentFastScoresTable.schoolId),
        eq(studentsTable.studentId, studentFastScoresTable.studentId),
      ),
    )
    .where(eq(studentFastScoresTable.schoolId, schoolId))
    .groupBy(studentsTable.grade, studentFastScoresTable.subject);

  // 3) Build the cross-product (every grade present × every known
  // subject) and merge counts in. Missing intersections become
  // zeros, which is exactly what the tile needs to show.
  const rows: CoverageRow[] = [];
  for (const g of studentsByGrade) {
    const grade = g.grade;
    if (grade <= 0) continue; // skip K and pre-K — no FAST charts
    for (const subject of SUBJECT_KEYS) {
      const score = scoresByGradeSubject.find(
        (s) => s.grade === grade && s.subject === subject,
      );
      rows.push({
        subject,
        grade,
        studentsTotal: g.count,
        withPm1: score?.withPm1 ?? 0,
        withPm2: score?.withPm2 ?? 0,
        withPm3: score?.withPm3 ?? 0,
        withPriorYear: score?.withPriorYear ?? 0,
        hasChart: hasChart(subject, grade),
      });
    }
  }

  rows.sort(
    (a, b) =>
      a.subject.localeCompare(b.subject) || a.grade - b.grade,
  );
  res.json({ rows });
});

export default router;
