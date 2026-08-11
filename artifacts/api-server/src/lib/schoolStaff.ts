// Who counts as "staff at this school".
//
// staff.school_id is a SINGLE column — a person's home school — but real
// districts share teachers. A technical high school is largely staffed by
// teachers whose home campus is elsewhere; ESE and itinerant specialists work
// across several schools. Because staff.email is globally unique, roster sync
// deliberately REUSES the existing account for such a teacher rather than
// creating a duplicate (sisRosterSync.ts, "Teacher already exists under ANOTHER
// school"), and leaves school_id pointing at whichever school synced first.
//
// Their class_sections and section_roster rows land at the correct school, so
// their schedules and students are right — but any roster or count keyed purely
// on staff.school_id renders them invisible there. That is what produced Nature
// Coast showing students, sections and enrollments but ZERO teachers.
//
// Rather than migrate the tenancy anchor (staff.school_id is read across auth,
// authorization scoping, and every roster in the app), membership is DERIVED:
// you belong to a school if it is your home school OR you teach a section
// there. class_sections.school_id already records exactly that, so no schema
// change and no backfill is needed — the data was always there, just unused.
//
// Scope note: this widens who is LISTED and COUNTED at a school. It is
// deliberately NOT used for authorization — permission checks continue to key
// on staff.school_id / req.schoolId so this cannot widen anyone's access.

import { db, classSectionsTable, staffTable } from "@workspace/db";
import { and, eq, inArray, or, sql } from "drizzle-orm";

/**
 * staff.id for every person who teaches at least one section at this school
 * but whose home school is elsewhere. Empty for a school with no shared staff.
 */
export async function visitingTeacherStaffIds(
  schoolId: number,
): Promise<number[]> {
  const rows = await db
    .selectDistinct({ staffId: classSectionsTable.teacherStaffId })
    .from(classSectionsTable)
    .where(eq(classSectionsTable.schoolId, schoolId));
  const ids = rows.map((r) => r.staffId).filter((id): id is number => id != null);
  if (ids.length === 0) return [];

  // Keep only those whose home school is NOT this one — home-school staff are
  // already matched by the school_id predicate at every call site.
  const visiting = await db
    .select({ id: staffTable.id })
    .from(staffTable)
    .where(
      and(inArray(staffTable.id, ids), sql`${staffTable.schoolId} <> ${schoolId}`),
    );
  return visiting.map((r) => r.id);
}

/**
 * Drizzle predicate matching all staff at this school: home-school members plus
 * teachers visiting from another campus. Use for rosters and counts.
 */
export async function staffAtSchoolWhere(schoolId: number) {
  const visitingIds = await visitingTeacherStaffIds(schoolId);
  if (visitingIds.length === 0) {
    return eq(staffTable.schoolId, schoolId);
  }
  return or(
    eq(staffTable.schoolId, schoolId),
    inArray(staffTable.id, visitingIds),
  )!;
}
