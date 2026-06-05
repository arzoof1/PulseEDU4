import { db, studentsTable } from "@workspace/db";
import { and, eq, or } from "drizzle-orm";

// Accept either the canonical FLEID (e.g. "FL000008101387") or the
// student-facing local SIS ID (e.g. "8101387") and return the FLEID
// for downstream inserts / joins. Returns null if neither matches a
// student in this school. The FLEID is the system-of-record identifier
// for FAST integration, parent-portal linking, and audit logs — every
// table that stores `student_id` stores the FLEID. The local SIS ID is
// purely the credential staff and students know the kid by, so every
// UI entry point should accept it and translate here.
export async function resolveStudentIdInput(
  schoolId: number,
  input: string,
): Promise<string | null> {
  const q = String(input ?? "").trim();
  if (!q) return null;
  const [hit] = await db
    .select({ studentId: studentsTable.studentId })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        or(
          eq(studentsTable.studentId, q),
          eq(studentsTable.localSisId, q),
        ),
      ),
    )
    .limit(1);
  return hit?.studentId ?? null;
}
