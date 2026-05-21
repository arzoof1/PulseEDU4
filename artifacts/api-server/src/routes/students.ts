import { Router, type IRouter } from "express";
import {
  db,
  studentsTable,
  studentAccommodationsTable,
  schoolAccommodationsTable,
  studentEmergencyContactsTable,
} from "@workspace/db";
import { eq, isNull, and, asc, inArray, or, ilike, gt } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();
const DEFAULT_STUDENT_LIMIT = 100;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_STUDENT_LIMIT = 200;
const MAX_SEARCH_LIMIT = 50;

type StudentCursor = {
  lastName: string;
  firstName: string;
  id: number;
};

function parseLimit(value: unknown, defaultLimit: number, maxLimit: number): number {
  const raw = typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(raw)) return defaultLimit;
  return Math.min(Math.max(raw, 1), maxLimit);
}

function encodeCursor(row: StudentCursor): string {
  return Buffer.from(JSON.stringify(row), "utf8").toString("base64url");
}

function parseCursor(value: unknown): StudentCursor | null | "invalid" {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) return "invalid";
  try {
    const data = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as
      | Partial<StudentCursor>
      | null;
    if (
      !data ||
      typeof data.lastName !== "string" ||
      typeof data.firstName !== "string" ||
      typeof data.id !== "number" ||
      !Number.isInteger(data.id)
    ) {
      return "invalid";
    }
    return { lastName: data.lastName, firstName: data.firstName, id: data.id };
  } catch {
    return "invalid";
  }
}

router.get("/students", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  // Optional ?q= typeahead filter — used by the Admin Hub discipline-log
  // modal so the student picker can narrow the school roster instead of
  // returning every student. Matches first/last/student_id (case-insensitive).
  const qRaw = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const q = qRaw.slice(0, 64);
  const cursor = parseCursor(req.query.cursor);
  if (cursor === "invalid") {
    res.status(400).json({ error: "Invalid cursor" });
    return;
  }
  const limit = parseLimit(
    req.query.limit,
    q ? DEFAULT_SEARCH_LIMIT : DEFAULT_STUDENT_LIMIT,
    q ? MAX_SEARCH_LIMIT : MAX_STUDENT_LIMIT,
  );
  const searchFilter = q
    ? and(
        // Prefix match: typing "joh" returns "John Smith" or
        // "Mike Johnson" — but NOT "Stephanie Cohen". Matches the
        // beginning of first or last name only. Student ID stays a
        // prefix match too (admins typically know the leading digits).
        or(
          ilike(studentsTable.firstName, `${q}%`),
          ilike(studentsTable.lastName, `${q}%`),
          ilike(studentsTable.studentId, `${q}%`),
        ),
      )
    : undefined;
  const cursorFilter = cursor
    ? or(
        gt(studentsTable.lastName, cursor.lastName),
        and(
          eq(studentsTable.lastName, cursor.lastName),
          gt(studentsTable.firstName, cursor.firstName),
        ),
        and(
          eq(studentsTable.lastName, cursor.lastName),
          eq(studentsTable.firstName, cursor.firstName),
          gt(studentsTable.id, cursor.id),
        ),
      )
    : undefined;
  const where = and(
    eq(studentsTable.schoolId, schoolId),
    ...(searchFilter ? [searchFilter] : []),
    ...(cursorFilter ? [cursorFilter] : []),
  );

  const rows = await db
    .select()
    .from(studentsTable)
    .where(where)
    .orderBy(asc(studentsTable.lastName), asc(studentsTable.firstName), asc(studentsTable.id))
    .limit(limit + 1);
  const pageRows = rows.slice(0, limit);
  const nextRow = rows.length > limit ? pageRows[pageRows.length - 1] : undefined;

  // student_id is NOT globally unique across schools, so an in-memory
  // membership filter on the school's roster would still mis-attribute an
  // assignment that belongs to a different school's student with the same
  // student_id. AND-filter the assignments themselves by schoolId in SQL.
  const studentIds = pageRows.map((r) => r.studentId);
  const assignments = studentIds.length
    ? await db
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
            inArray(studentAccommodationsTable.studentId, studentIds),
            isNull(studentAccommodationsTable.removedAt),
          ),
        )
    : [];

  const byStudent = new Map<string, string[]>();
  for (const a of assignments) {
    const list = byStudent.get(a.studentId) ?? [];
    list.push(a.name);
    byStudent.set(a.studentId, list);
  }

  res.json({
    items: pageRows.map((r) => ({
      ...r,
      accommodations: byStudent.get(r.studentId) ?? [],
    })),
    nextCursor: nextRow
      ? encodeCursor({
          lastName: nextRow.lastName,
          firstName: nextRow.firstName,
          id: nextRow.id,
        })
      : null,
  });
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
