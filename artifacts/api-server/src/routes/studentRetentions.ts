// Student retention indicator — read + admin write endpoints.
//
// Routes:
//   GET    /api/students/:studentId/retentions
//   POST   /api/students/:studentId/retentions     body: { gradeLevel }
//   DELETE /api/students/:studentId/retentions/:gradeLevel
//
// Read access: any signed-in staff in the school (the indicator surfaces
// on Teacher Roster, Student Profile, and the Parent Portal).
//
// Write access: Admin / Behavior Specialist / MTSS Coordinator /
// Guidance Counselor / SuperUser. Mirrors the safety-plan editor gate
// (canEditSafetyPlan) — these are the same staff who own behavioral
// case-management.
import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import {
  db,
  studentRetentionsTable,
  studentsTable,
  staffTable,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { canEditSafetyPlan } from "../lib/coreTeam.js";

const router: IRouter = Router();

async function loadStaff(req: Request, res: Response) {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  return staff;
}

async function ensureStudentInSchool(
  schoolId: number,
  studentIdText: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: studentsTable.id })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, studentIdText),
        eq(studentsTable.schoolId, schoolId),
      ),
    );
  return Boolean(row);
}

// GET — list retained grade levels for the student, ascending.
router.get("/students/:studentId/retentions", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const studentId = String(req.params.studentId ?? "").trim();
  if (!studentId) {
    res.status(400).json({ error: "Missing studentId" });
    return;
  }
  if (!(await ensureStudentInSchool(schoolId, studentId))) {
    res.status(404).json({ error: "Student not found in this school" });
    return;
  }
  const rows = await db
    .select()
    .from(studentRetentionsTable)
    .where(
      and(
        eq(studentRetentionsTable.schoolId, schoolId),
        eq(studentRetentionsTable.studentId, studentId),
      ),
    )
    .orderBy(asc(studentRetentionsTable.gradeLevel));
  res.json({
    studentId,
    retentions: rows.map((r) => ({
      id: r.id,
      gradeLevel: r.gradeLevel,
      notes: r.notes,
      createdAt: r.createdAt,
      createdByName: r.createdByName,
    })),
  });
});

// POST — mark a retention. Idempotent on the (school, student, grade)
// unique index: a duplicate POST returns the existing row and does
// NOT 4xx, so a Core Team member double-clicking can't error out.
router.post("/students/:studentId/retentions", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!canEditSafetyPlan(staff)) {
    res.status(403).json({
      error:
        "Only Admins, Behavior Specialists, MTSS Coordinators, and Guidance Counselors can edit retention status",
    });
    return;
  }
  const studentId = String(req.params.studentId ?? "").trim();
  if (!studentId) {
    res.status(400).json({ error: "Missing studentId" });
    return;
  }
  if (!(await ensureStudentInSchool(schoolId, studentId))) {
    res.status(404).json({ error: "Student not found in this school" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const gradeRaw = body.gradeLevel;
  const gradeLevel = Number(gradeRaw);
  if (!Number.isInteger(gradeLevel) || gradeLevel < 0 || gradeLevel > 12) {
    res.status(400).json({ error: "gradeLevel must be an integer 0..12" });
    return;
  }
  const notes =
    typeof body.notes === "string" ? body.notes.trim().slice(0, 500) : null;

  // Try insert; on conflict return the existing row.
  const [inserted] = await db
    .insert(studentRetentionsTable)
    .values({
      schoolId,
      studentId,
      gradeLevel,
      notes: notes || null,
      createdByStaffId: staff.id,
      createdByName: staff.displayName,
    })
    .onConflictDoNothing({
      target: [
        studentRetentionsTable.schoolId,
        studentRetentionsTable.studentId,
        studentRetentionsTable.gradeLevel,
      ],
    })
    .returning();
  let row = inserted;
  if (!row) {
    [row] = await db
      .select()
      .from(studentRetentionsTable)
      .where(
        and(
          eq(studentRetentionsTable.schoolId, schoolId),
          eq(studentRetentionsTable.studentId, studentId),
          eq(studentRetentionsTable.gradeLevel, gradeLevel),
        ),
      );
  }
  res.status(201).json({
    id: row.id,
    gradeLevel: row.gradeLevel,
    notes: row.notes,
    createdAt: row.createdAt,
    createdByName: row.createdByName,
  });
});

// DELETE — remove a single retention by grade. 204 on success or no-op.
router.delete(
  "/students/:studentId/retentions/:gradeLevel",
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const staff = await loadStaff(req, res);
    if (!staff) return;
    if (!canEditSafetyPlan(staff)) {
      res.status(403).json({
        error:
          "Only Admins, Behavior Specialists, MTSS Coordinators, and Guidance Counselors can edit retention status",
      });
      return;
    }
    const studentId = String(req.params.studentId ?? "").trim();
    const gradeLevel = Number(req.params.gradeLevel);
    if (!studentId || !Number.isInteger(gradeLevel)) {
      res.status(400).json({ error: "Bad parameters" });
      return;
    }
    await db
      .delete(studentRetentionsTable)
      .where(
        and(
          eq(studentRetentionsTable.schoolId, schoolId),
          eq(studentRetentionsTable.studentId, studentId),
          eq(studentRetentionsTable.gradeLevel, gradeLevel),
        ),
      );
    res.status(204).end();
  },
);

export default router;
