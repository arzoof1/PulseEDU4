import { Router, type IRouter } from "express";
import {
  db,
  studentsTable,
  studentAccommodationsTable,
  schoolAccommodationsTable,
  studentEmergencyContactsTable,
} from "@workspace/db";
import { eq, isNull, and, asc, inArray, or, ilike } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

router.get("/students", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  // Optional ?q= typeahead filter — used by the Admin Hub discipline-log
  // modal so the student picker can narrow the school roster instead of
  // returning every student. Matches first/last/student_id (case-insensitive).
  const qRaw = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const q = qRaw.slice(0, 64);
  const where = q
    ? and(
        eq(studentsTable.schoolId, schoolId),
        or(
          ilike(studentsTable.firstName, `%${q}%`),
          ilike(studentsTable.lastName, `%${q}%`),
          ilike(studentsTable.studentId, `%${q}%`),
        ),
      )
    : eq(studentsTable.schoolId, schoolId);

  const rows = await db
    .select()
    .from(studentsTable)
    .where(where)
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

// Single-student endpoint with emergency contacts (the 4 SIS-derived
// contact slots — read-only, sourced via the Data Importer). Used by
// the student profile drawer.
router.get("/students/:studentId", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const studentId = String(req.params.studentId ?? "");
  if (!studentId) {
    res.status(400).json({ error: "studentId required" });
    return;
  }
  const [stu] = await db
    .select()
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, studentId),
        eq(studentsTable.schoolId, schoolId),
      ),
    );
  if (!stu) {
    res.status(404).json({ error: "Student not found" });
    return;
  }
  const accommodations = await db
    .select({ name: schoolAccommodationsTable.name })
    .from(studentAccommodationsTable)
    .innerJoin(
      schoolAccommodationsTable,
      eq(studentAccommodationsTable.accommodationId, schoolAccommodationsTable.id),
    )
    .where(
      and(
        eq(studentAccommodationsTable.schoolId, schoolId),
        eq(studentAccommodationsTable.studentId, studentId),
        isNull(studentAccommodationsTable.removedAt),
      ),
    );
  const contacts = await db
    .select()
    .from(studentEmergencyContactsTable)
    .where(
      and(
        eq(studentEmergencyContactsTable.schoolId, schoolId),
        eq(studentEmergencyContactsTable.studentId, studentId),
      ),
    )
    .orderBy(asc(studentEmergencyContactsTable.slot));
  res.json({
    ...stu,
    accommodations: accommodations.map((a) => a.name),
    emergencyContacts: contacts,
  });
});

export default router;
