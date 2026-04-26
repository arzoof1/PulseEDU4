// Shared cohort-narrowing filter helpers for the 5 insights dashboards
// (Academics, Behavior, Engagement, Equity, SEB/SEL).
//
// Every insights route accepts the same optional filters in addition
// to its own params (e.g. grade). They let an admin scope from
// school-wide → one teacher → one period → one demographic slice
// without each route re-implementing the parsing or SQL.
//
// Query params (all optional):
//   teacher_id  numeric staff id; restricts to students rostered to
//               sections taught by this teacher (planning sections
//               excluded)
//   period      integer; further narrows to one period of the
//               teacher's schedule (ignored when teacher_id is absent)
//   ese         "1" | "true" → only ESE students
//   is_504      "1" | "true" → only 504 students
//   tier        "2" | "3"   → only students with an active MTSS plan
//               at tier ≥ N
//   bq_ela      "1" | "true" → only students flagged priorYearBq in ELA
//   bq_math     "1" | "true" → same for Math
//
// Composition: filters AND together (all must pass) EXCEPT bq_ela
// and bq_math, which compose as OR within the BQ family (a student
// flagged BQ in either subject passes when both are checked).

import type { Request } from "express";
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  classSectionsTable,
  sectionRosterTable,
  studentsTable,
  studentMtssPlansTable,
  studentFastScoresTable,
} from "@workspace/db";

export type InsightsFilters = {
  teacherId: number | null;
  period: number | null;
  ese: boolean;
  is504: boolean;
  tier: number | null;
  bqEla: boolean;
  bqMath: boolean;
};

function parseBool(v: unknown): boolean {
  return v === "1" || v === "true" || v === true;
}

export function parseInsightsFilters(req: Request): InsightsFilters {
  const teacherIdRaw = req.query.teacher_id;
  const periodRaw = req.query.period;
  const tierRaw = req.query.tier;
  const teacherId =
    typeof teacherIdRaw === "string" ? Number.parseInt(teacherIdRaw, 10) : NaN;
  const period =
    typeof periodRaw === "string" ? Number.parseInt(periodRaw, 10) : NaN;
  const tier =
    typeof tierRaw === "string" ? Number.parseInt(tierRaw, 10) : NaN;
  return {
    teacherId: Number.isInteger(teacherId) && teacherId > 0 ? teacherId : null,
    period: Number.isInteger(period) && period > 0 ? period : null,
    ese: parseBool(req.query.ese),
    is504: parseBool(req.query.is_504),
    tier: tier === 2 || tier === 3 ? tier : null,
    bqEla: parseBool(req.query.bq_ela),
    bqMath: parseBool(req.query.bq_math),
  };
}

export function hasAnyInsightsFilter(f: InsightsFilters): boolean {
  return (
    f.teacherId != null ||
    f.ese ||
    f.is504 ||
    f.tier != null ||
    f.bqEla ||
    f.bqMath
  );
}

// Narrows a base cohort (already filtered by grade by the caller) to
// the subset that satisfies the optional filters. Returns a Set of
// student business IDs. The caller should re-filter their own row
// arrays against this set.
//
// Short-circuits when allowed becomes empty. Each filter only runs
// when its corresponding flag is set.
export async function applyInsightsFilters(
  schoolId: number,
  baseStudentIds: string[],
  f: InsightsFilters,
): Promise<Set<string>> {
  let allowed = new Set(baseStudentIds);
  if (allowed.size === 0) return allowed;

  // Teacher / period — class_sections ⨝ section_roster.
  // Planning sections excluded (teacher_roster does the same).
  if (f.teacherId != null) {
    const sections = await db
      .select({ id: classSectionsTable.id })
      .from(classSectionsTable)
      .where(
        and(
          eq(classSectionsTable.schoolId, schoolId),
          eq(classSectionsTable.teacherStaffId, f.teacherId),
          eq(classSectionsTable.isPlanning, false),
          f.period != null
            ? eq(classSectionsTable.period, f.period)
            : sql`true`,
        ),
      );
    if (sections.length === 0) return new Set();
    const sectionIds = sections.map((s) => s.id);
    const roster = await db
      .select({ studentId: sectionRosterTable.studentId })
      .from(sectionRosterTable)
      .where(inArray(sectionRosterTable.sectionId, sectionIds));
    const teacherIds = new Set(roster.map((r) => r.studentId));
    allowed = new Set([...allowed].filter((id) => teacherIds.has(id)));
    if (allowed.size === 0) return allowed;
  }

  // ESE / 504 — students table booleans.
  if (f.ese || f.is504) {
    const ids = [...allowed];
    const flagRows = await db
      .select({
        studentId: studentsTable.studentId,
        ese: studentsTable.ese,
        is504: studentsTable.is504,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          inArray(studentsTable.studentId, ids),
        ),
      );
    const ok = new Set(
      flagRows
        .filter((r) => (!f.ese || r.ese) && (!f.is504 || r.is504))
        .map((r) => r.studentId),
    );
    allowed = new Set([...allowed].filter((id) => ok.has(id)));
    if (allowed.size === 0) return allowed;
  }

  // Tier 2/3 — has any active MTSS plan at tier ≥ N.
  if (f.tier != null) {
    const ids = [...allowed];
    const planRows = await db
      .selectDistinct({ studentId: studentMtssPlansTable.studentId })
      .from(studentMtssPlansTable)
      .where(
        and(
          eq(studentMtssPlansTable.schoolId, schoolId),
          inArray(studentMtssPlansTable.studentId, ids),
          isNull(studentMtssPlansTable.closedAt),
          gte(studentMtssPlansTable.tier, f.tier),
        ),
      );
    const ok = new Set(planRows.map((r) => r.studentId));
    allowed = new Set([...allowed].filter((id) => ok.has(id)));
    if (allowed.size === 0) return allowed;
  }

  // BQ ELA / BQ Math — student_fast_scores.priorYearBq=true with
  // matching subject. OR-composed within the BQ family.
  if (f.bqEla || f.bqMath) {
    const subjects: string[] = [];
    if (f.bqEla) subjects.push("ela");
    if (f.bqMath) subjects.push("math");
    const ids = [...allowed];
    const bqRows = await db
      .selectDistinct({ studentId: studentFastScoresTable.studentId })
      .from(studentFastScoresTable)
      .where(
        and(
          eq(studentFastScoresTable.schoolId, schoolId),
          inArray(studentFastScoresTable.studentId, ids),
          eq(studentFastScoresTable.priorYearBq, true),
          inArray(studentFastScoresTable.subject, subjects),
        ),
      );
    const ok = new Set(bqRows.map((r) => r.studentId));
    allowed = new Set([...allowed].filter((id) => ok.has(id)));
  }

  return allowed;
}

// Narrows a "studentIds | null" cohort (the engagement/behavior/equity/
// sebsel pattern, where null means "full school, no narrowing") by the
// cross-cutting filters. Convenience wrapper around applyInsightsFilters
// that handles the null-base case by fetching the school's student set
// when needed.
//
// Returns:
//   ids   — narrowed list (possibly empty), OR null if neither
//           grade-based narrowing nor cross-cutting filters were applied
//   empty — true when the filters narrowed to zero students; the caller
//           should return its empty-cohort fast-path response
export async function narrowCohort(
  schoolId: number,
  baseIds: string[] | null,
  f: InsightsFilters,
): Promise<{ ids: string[] | null; empty: boolean }> {
  if (!hasAnyInsightsFilter(f)) {
    return { ids: baseIds, empty: false };
  }
  let base: string[];
  if (baseIds !== null) {
    base = baseIds;
  } else {
    const all = await db
      .select({ studentId: studentsTable.studentId })
      .from(studentsTable)
      .where(eq(studentsTable.schoolId, schoolId));
    base = all.map((r) => r.studentId);
  }
  if (base.length === 0) return { ids: [], empty: true };
  const allowed = await applyInsightsFilters(schoolId, base, f);
  const ids = [...allowed];
  return { ids, empty: ids.length === 0 };
}

// Resolves the periods this teacher actually teaches, for populating
// the period chip row in the filter bar. School-scoped, planning
// excluded, sorted ascending. Returns an empty array if the teacher
// teaches nothing in this school.
export async function getTeacherPeriods(
  schoolId: number,
  teacherStaffId: number,
): Promise<number[]> {
  const rows = await db
    .selectDistinct({ period: classSectionsTable.period })
    .from(classSectionsTable)
    .where(
      and(
        eq(classSectionsTable.schoolId, schoolId),
        eq(classSectionsTable.teacherStaffId, teacherStaffId),
        eq(classSectionsTable.isPlanning, false),
      ),
    );
  return rows.map((r) => r.period).sort((a, b) => a - b);
}
