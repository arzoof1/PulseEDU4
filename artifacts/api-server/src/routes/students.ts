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
  // student_id is NOT globally unique across schools, so an in-memory
  // membership filter on the school's roster would still mis-attribute an
  // assignment that belongs to a different school's student with the same
  // student_id. AND-filter the assignments themselves by schoolId in SQL.
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
    .where(
      and(
        eq(studentAccommodationsTable.schoolId, schoolId),
        isNull(studentAccommodationsTable.removedAt),
      ),
    );

  const byStudent = new Map<string, string[]>();
  for (const a of assignments) {
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
