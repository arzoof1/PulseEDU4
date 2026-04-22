import { Router, type IRouter } from "express";
import {
  db,
  studentsTable,
  studentAccommodationsTable,
  schoolAccommodationsTable,
} from "@workspace/db";
import { eq, isNull, and } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

router.get("/students", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const rows = await db
    .select()
    .from(studentsTable)
    .where(eq(studentsTable.schoolId, schoolId))
    .orderBy(studentsTable.lastName, studentsTable.firstName);
  // Accommodations join is naturally scoped because it joins to studentsTable
  // (via accommodation_id -> school_accommodations) and we filter by the
  // student's school via the studentId membership below. No need to filter
  // the join itself.
  const assignments = await db
    .select({
      studentId: studentAccommodationsTable.studentId,
      name: schoolAccommodationsTable.name,
    })
    .from(studentAccommodationsTable)
    .innerJoin(
      schoolAccommodationsTable,
      eq(studentAccommodationsTable.accommodationId, schoolAccommodationsTable.id),
    )
    .where(isNull(studentAccommodationsTable.removedAt));

  const studentIdsInSchool = new Set(rows.map((r) => r.studentId));
  const byStudent = new Map<string, string[]>();
  for (const a of assignments) {
    if (!studentIdsInSchool.has(a.studentId)) continue;
    const list = byStudent.get(a.studentId) ?? [];
    list.push(a.name);
    byStudent.set(a.studentId, list);
  }

  res.json(
    rows.map((r) => ({
      ...r,
      accommodations: byStudent.get(r.studentId) ?? [],
    })),
  );
});

export default router;
