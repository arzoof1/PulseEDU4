import {
  db,
  schoolSettingsTable,
  eligibilityAbsencesTable,
  eligibilityParentNotesTable,
  eligibilityActivitiesTable,
  eligibilityActivityMembersTable,
  studentsTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";

// =============================================================================
// Eligibility Hub — shared computation helpers.
//
// The counting model is intentionally centralized here so the at-risk report,
// the roster views, and the notification cron all agree on who is eligible.
//
//   countedAbsences = max(0, uploadedAbsenceTotal − min(approvedNotes, cap))
//                     + (tardyRatio > 0 ? floor(daysTardy / tardyRatio) : 0)
//
//   status:
//     ineligible  countedAbsences >= threshold
//     warning     threshold − warningWindowDays <= countedAbsences < threshold
//     ok          otherwise
//
// Everything is keyed by the CURRENT semester label (school-configurable).
// =============================================================================

export type EligibilityStatus = "ok" | "warning" | "ineligible";

export interface EligibilitySettings {
  threshold: number;
  warningWindowDays: number;
  tardyToAbsenceRatio: number;
  parentNoteCap: number;
  districtAdNotify: boolean;
  semesterLabel: string;
  semesterStart: string | null;
  semesterEnd: string | null;
}

const DEFAULT_SEMESTER_LABEL = "Spring 2026";

export async function loadEligibilitySettings(
  schoolId: number,
): Promise<EligibilitySettings> {
  const [s] = await db
    .select()
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId))
    .limit(1);
  const semesterLabel =
    s?.eligibilitySemesterLabel && s.eligibilitySemesterLabel.trim() !== ""
      ? s.eligibilitySemesterLabel
      : DEFAULT_SEMESTER_LABEL;
  return {
    threshold: s?.eligibilityIneligibilityThreshold ?? 10,
    warningWindowDays: s?.eligibilityWarningWindowDays ?? 4,
    tardyToAbsenceRatio: s?.eligibilityTardyToAbsenceRatio ?? 0,
    parentNoteCap: s?.eligibilityParentNoteCap ?? 5,
    districtAdNotify: Boolean(s?.eligibilityDistrictAdNotify),
    semesterLabel,
    semesterStart: s?.eligibilitySemesterStart ?? null,
    semesterEnd: s?.eligibilitySemesterEnd ?? null,
  };
}

export function computeCountedAbsences(
  absenceTotal: number,
  daysTardy: number,
  approvedNotes: number,
  settings: Pick<
    EligibilitySettings,
    "tardyToAbsenceRatio" | "parentNoteCap"
  >,
): number {
  const excused = Math.min(approvedNotes, settings.parentNoteCap);
  const base = Math.max(0, absenceTotal - excused);
  const tardySpill =
    settings.tardyToAbsenceRatio > 0
      ? Math.floor(daysTardy / settings.tardyToAbsenceRatio)
      : 0;
  return base + tardySpill;
}

export function statusFor(
  countedAbsences: number,
  settings: Pick<EligibilitySettings, "threshold" | "warningWindowDays">,
): EligibilityStatus {
  if (countedAbsences >= settings.threshold) return "ineligible";
  if (countedAbsences >= settings.threshold - settings.warningWindowDays) {
    return "warning";
  }
  return "ok";
}

export interface StudentEligibilityRow {
  studentId: string;
  localSisId: string | null;
  firstName: string;
  lastName: string;
  grade: number;
  parentName: string | null;
  parentEmail: string | null;
  absenceTotal: number;
  daysTardy: number;
  approvedNotes: number;
  countedAbsences: number;
  notesLeft: number;
  status: EligibilityStatus;
}

// Build a per-student eligibility snapshot for a set of student IDs (FLEIDs)
// within one school + semester. Returns a map keyed by studentId.
export async function buildEligibilityMap(
  schoolId: number,
  semesterLabel: string,
  studentIds: string[],
  settings: EligibilitySettings,
): Promise<Map<string, StudentEligibilityRow>> {
  const out = new Map<string, StudentEligibilityRow>();
  if (studentIds.length === 0) return out;

  const uniqueIds = Array.from(new Set(studentIds));

  const students = await db
    .select({
      studentId: studentsTable.studentId,
      localSisId: studentsTable.localSisId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
      parentName: studentsTable.parentName,
      parentEmail: studentsTable.parentEmail,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        inArray(studentsTable.studentId, uniqueIds),
      ),
    );

  const absences = await db
    .select()
    .from(eligibilityAbsencesTable)
    .where(
      and(
        eq(eligibilityAbsencesTable.schoolId, schoolId),
        eq(eligibilityAbsencesTable.semesterLabel, semesterLabel),
        inArray(eligibilityAbsencesTable.studentId, uniqueIds),
      ),
    );
  const absenceByStudent = new Map(absences.map((a) => [a.studentId, a]));

  const noteRows = await db
    .select({
      studentId: eligibilityParentNotesTable.studentId,
      c: sql<number>`count(*)::int`,
    })
    .from(eligibilityParentNotesTable)
    .where(
      and(
        eq(eligibilityParentNotesTable.schoolId, schoolId),
        eq(eligibilityParentNotesTable.semesterLabel, semesterLabel),
        inArray(eligibilityParentNotesTable.studentId, uniqueIds),
      ),
    )
    .groupBy(eligibilityParentNotesTable.studentId);
  const notesByStudent = new Map(noteRows.map((n) => [n.studentId, n.c]));

  for (const s of students) {
    const a = absenceByStudent.get(s.studentId);
    const absenceTotal = a?.absenceTotal ?? 0;
    const daysTardy = a?.daysTardy ?? 0;
    const approvedNotes = notesByStudent.get(s.studentId) ?? 0;
    const countedAbsences = computeCountedAbsences(
      absenceTotal,
      daysTardy,
      approvedNotes,
      settings,
    );
    out.set(s.studentId, {
      studentId: s.studentId,
      localSisId: s.localSisId,
      firstName: s.firstName,
      lastName: s.lastName,
      grade: s.grade,
      parentName: s.parentName,
      parentEmail: s.parentEmail,
      absenceTotal,
      daysTardy,
      approvedNotes,
      countedAbsences,
      notesLeft: Math.max(0, settings.parentNoteCap - approvedNotes),
      status: statusFor(countedAbsences, settings),
    });
  }
  return out;
}

// All active members across all active activities for a school, with the
// activity name attached. Used by the at-risk report + notification cron.
export interface MemberWithActivity {
  memberId: number;
  activityId: number;
  activityName: string;
  studentId: string;
  jerseyNumber: string | null;
}

export async function loadActiveMembers(
  schoolId: number,
): Promise<MemberWithActivity[]> {
  const rows = await db
    .select({
      memberId: eligibilityActivityMembersTable.id,
      activityId: eligibilityActivityMembersTable.activityId,
      activityName: eligibilityActivitiesTable.name,
      studentId: eligibilityActivityMembersTable.studentId,
      jerseyNumber: eligibilityActivityMembersTable.jerseyNumber,
    })
    .from(eligibilityActivityMembersTable)
    .innerJoin(
      eligibilityActivitiesTable,
      eq(
        eligibilityActivityMembersTable.activityId,
        eligibilityActivitiesTable.id,
      ),
    )
    .where(
      and(
        eq(eligibilityActivityMembersTable.schoolId, schoolId),
        // Constrain the joined activity to the same tenant too — defense in
        // depth so a stray cross-school activityId can never leak an
        // activity name into another school's at-risk report / notices.
        eq(eligibilityActivitiesTable.schoolId, schoolId),
        eq(eligibilityActivityMembersTable.active, true),
        eq(eligibilityActivitiesTable.active, true),
      ),
    );
  return rows;
}
