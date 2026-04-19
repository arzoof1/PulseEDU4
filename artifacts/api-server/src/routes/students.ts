import { Router, type IRouter } from "express";
import {
  db,
  studentsTable,
  studentAccommodationsTable,
  schoolAccommodationsTable,
} from "@workspace/db";
import { eq, isNull, and } from "drizzle-orm";

const router: IRouter = Router();

router.get("/students", async (_req, res) => {
  const rows = await db.select().from(studentsTable).orderBy(studentsTable.id);
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
