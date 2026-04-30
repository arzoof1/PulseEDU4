// Effective teacher resolution for MTSS plans.
//
// Source of truth for "who is responsible for logging on this plan":
//
//   if plan.autoAssignScheduleTeachers (default true):
//      effective = (live schedule teachers ∪ additionalInterventionistIds)
//                  − excludedTeacherIds
//   else (legacy manual mode):
//      effective = parseCsv(assignedTeacherIds)
//
// Past teachers' previously-logged Tier 2 / Tier 3 entries are NOT
// deleted when the schedule changes — those rows live in their own
// tables joined on (studentId, teacherStaffId), so the historical
// record is preserved automatically. Reports that need to surface
// past contributors should UNION the effective list with whoever has
// logged entries in the date range under inspection.
import {
  db,
  classSectionsTable,
  sectionRosterTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

export interface EffectiveTeacherPlanShape {
  autoAssignScheduleTeachers: boolean;
  assignedTeacherIds: string;
  excludedTeacherIds: string;
  additionalInterventionistIds: string;
}

export function parseCsvIds(csv: string): number[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}

// Batch-load every (studentId → schedule teacher staffIds[]) for the
// given school. Returns a Map keyed by SIS student_id (text).
// Excludes planning-period sections.
export async function loadScheduleTeacherIdsForStudents(
  schoolId: number,
  studentIds: string[],
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (studentIds.length === 0) return out;
  const rows = await db
    .selectDistinct({
      studentId: sectionRosterTable.studentId,
      teacherStaffId: classSectionsTable.teacherStaffId,
    })
    .from(sectionRosterTable)
    .innerJoin(
      classSectionsTable,
      eq(classSectionsTable.id, sectionRosterTable.sectionId),
    )
    .where(
      and(
        eq(sectionRosterTable.schoolId, schoolId),
        eq(classSectionsTable.isPlanning, false),
        inArray(sectionRosterTable.studentId, studentIds),
      ),
    );
  for (const r of rows) {
    const arr = out.get(r.studentId);
    if (arr) arr.push(r.teacherStaffId);
    else out.set(r.studentId, [r.teacherStaffId]);
  }
  return out;
}

// Resolve the effective teacher staffId list for one plan, given the
// (already-loaded) schedule teacher list for that plan's student.
export function effectiveTeacherIdsForPlan(
  plan: EffectiveTeacherPlanShape,
  scheduleTeacherIds: number[],
): number[] {
  if (!plan.autoAssignScheduleTeachers) {
    return parseCsvIds(plan.assignedTeacherIds);
  }
  const excluded = new Set(parseCsvIds(plan.excludedTeacherIds));
  const additional = parseCsvIds(plan.additionalInterventionistIds);
  const merged = new Set<number>();
  for (const t of scheduleTeacherIds) if (!excluded.has(t)) merged.add(t);
  for (const t of additional) if (!excluded.has(t)) merged.add(t);
  return Array.from(merged).sort((a, b) => a - b);
}

// Schedule details for the modal: every section the student is rostered
// into (period, course, teacher), excluding planning periods.
export interface ScheduleTeacherSection {
  staffId: number;
  period: number;
  courseName: string;
}

export async function loadScheduleSectionsForStudent(
  schoolId: number,
  studentId: string,
): Promise<ScheduleTeacherSection[]> {
  const rows = await db
    .select({
      teacherStaffId: classSectionsTable.teacherStaffId,
      period: classSectionsTable.period,
      courseName: classSectionsTable.courseName,
    })
    .from(sectionRosterTable)
    .innerJoin(
      classSectionsTable,
      eq(classSectionsTable.id, sectionRosterTable.sectionId),
    )
    .where(
      and(
        eq(sectionRosterTable.schoolId, schoolId),
        eq(sectionRosterTable.studentId, studentId),
        eq(classSectionsTable.isPlanning, false),
      ),
    );
  return rows
    .map((r) => ({
      staffId: r.teacherStaffId,
      period: r.period,
      courseName: r.courseName,
    }))
    .sort((a, b) => a.period - b.period);
}
