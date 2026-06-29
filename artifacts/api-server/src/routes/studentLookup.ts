import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  studentsTable,
  staffTable,
  classSectionsTable,
  sectionRosterTable,
} from "@workspace/db";
import { eq, and, or, ilike } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { getVisibleStudentIds } from "./insights.js";

const router: IRouter = Router();

// Inline requireStaff — matches the self-contained pattern every route file
// in this codebase follows (students.ts / pickup.ts / interventions.ts).
async function requireStaff(req: Request, res: Response, next: NextFunction) {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Staff not found or inactive" });
    return;
  }
  (req as Request & { staff: typeof staffTable.$inferSelect }).staff = staff;
  next();
}

// ---------------------------------------------------------------------------
// GET /api/student-lookup/search?q=
//
// Typeahead for the Student Lookup sidebar surface. Visibility-scoped via the
// SAME resolver the Student Profile endpoint uses (getVisibleStudentIds) so a
// teacher only ever finds their own roster (+ trusted-adult) students while
// core team / admin / counselor find anyone in the school. Returning exactly
// the openable set avoids the "found but can't open" mismatch.
//
// NO FLEID forward-facing: the canonical studentId is returned only as the
// join key the client passes back to the (already-gated) profile endpoint; the
// human-readable id rendered in results is localSisId.
// ---------------------------------------------------------------------------
router.get("/student-lookup/search", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;

  const qRaw = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const q = qRaw.slice(0, 64);

  const visibility = await getVisibleStudentIds(staff, schoolId);
  // A non-core-team member with an empty visible set can never match — short
  // circuit so we don't run a school-wide query and then filter to nothing.
  if (!visibility.full && visibility.ids.size === 0) {
    res.json({ students: [] });
    return;
  }

  const where = q
    ? and(
        eq(studentsTable.schoolId, schoolId),
        or(
          ilike(studentsTable.firstName, `${q}%`),
          ilike(studentsTable.lastName, `${q}%`),
          ilike(studentsTable.localSisId, `${q}%`),
        ),
      )
    : eq(studentsTable.schoolId, schoolId);

  const rows = await db
    .select({
      studentId: studentsTable.studentId,
      localSisId: studentsTable.localSisId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
    })
    .from(studentsTable)
    .where(where)
    .orderBy(studentsTable.lastName, studentsTable.firstName);

  const scoped = visibility.full
    ? rows
    : rows.filter((r) => visibility.ids.has(r.studentId));
  // Cap the payload — a blank query from a core-team member would otherwise
  // return the whole school; the UI is a picker, not a roster export.
  res.json({ students: scoped.slice(0, 50) });
});

// ---------------------------------------------------------------------------
// GET /api/student-lookup/:studentId/schedule
//
// Per-student class/period schedule (course + teacher per period) for the
// "View schedule" affordance on the Student Profile. Visibility-scoped via
// the SAME resolver as the rest of this router (getVisibleStudentIds) so a
// teacher can only see the schedule of a student they can already open.
//
// student_id is NOT globally unique across schools — both section_roster and
// class_sections are AND-filtered by schoolId so a sister school's section
// can never surface. Planning periods are excluded. Ordered by period.
// ---------------------------------------------------------------------------
router.get(
  "/student-lookup/:studentId/schedule",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
      .staff;
    const studentId = String(req.params.studentId ?? "").trim();
    if (!studentId) {
      res.status(400).json({ error: "studentId required" });
      return;
    }

    // Visibility check FIRST — never leak the existence of an out-of-scope
    // student (mirror the profile + heartbeat-note endpoints).
    const visibility = await getVisibleStudentIds(staff, schoolId);
    if (!visibility.full && !visibility.ids.has(studentId)) {
      res
        .status(403)
        .json({ error: "Not in your roster or trusted-adult list" });
      return;
    }

    const rows = await db
      .select({
        period: classSectionsTable.period,
        courseName: classSectionsTable.courseName,
        teacherName: staffTable.displayName,
      })
      .from(sectionRosterTable)
      .innerJoin(
        classSectionsTable,
        eq(sectionRosterTable.sectionId, classSectionsTable.id),
      )
      .innerJoin(
        staffTable,
        eq(staffTable.id, classSectionsTable.teacherStaffId),
      )
      .where(
        and(
          eq(sectionRosterTable.schoolId, schoolId),
          eq(classSectionsTable.schoolId, schoolId),
          eq(sectionRosterTable.studentId, studentId),
          eq(classSectionsTable.isPlanning, false),
        ),
      )
      .orderBy(classSectionsTable.period);

    res.json({
      schedule: rows.map((r) => ({
        period: r.period,
        courseName: r.courseName,
        teacherName: r.teacherName ?? "",
      })),
    });
  },
);

// ---------------------------------------------------------------------------
// GET /api/student-lookup/:studentId/heartbeat-note
//
// Visibility-scoped read of the current note. We deliberately DON'T reuse
// GET /api/students/:id here — that endpoint is only school-scoped, which
// would let a teacher read an out-of-roster student's note by guessing the
// id. This path gates on the same getVisibleStudentIds set as the snapshot.
// ---------------------------------------------------------------------------
router.get(
  "/student-lookup/:studentId/heartbeat-note",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
      .staff;
    const studentId = String(req.params.studentId ?? "").trim();
    if (!studentId) {
      res.status(400).json({ error: "studentId required" });
      return;
    }

    // Visibility check FIRST — never leak the existence of an out-of-scope
    // student (mirror the profile endpoint's behaviour).
    const visibility = await getVisibleStudentIds(staff, schoolId);
    if (!visibility.full && !visibility.ids.has(studentId)) {
      res
        .status(403)
        .json({ error: "Not in your roster or trusted-adult list" });
      return;
    }

    const [row] = await db
      .select({
        heartbeatNote: studentsTable.heartbeatNote,
        heartbeatNoteUpdatedAt: studentsTable.heartbeatNoteUpdatedAt,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.studentId, studentId),
          eq(studentsTable.schoolId, schoolId),
        ),
      );
    if (!row) {
      res.status(404).json({ error: "Student not found in this school" });
      return;
    }
    res.json({
      message: row.heartbeatNote ?? "",
      updatedAt: row.heartbeatNoteUpdatedAt ?? null,
    });
  },
);

// ---------------------------------------------------------------------------
// PUT /api/student-lookup/:studentId/heartbeat-note
//
// The ONE editable field on the otherwise read-only Student Snapshot: a short
// parent-facing note that surfaces on the student's weekly Friday HeartBEAT
// (PDF + email). Edit is visibility-scoped (a teacher can only write notes for
// students they can see). Empty/whitespace clears the note. Stamps who/when.
// ---------------------------------------------------------------------------
const MAX_NOTE_LEN = 1000;
router.put(
  "/student-lookup/:studentId/heartbeat-note",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
      .staff;
    const studentId = String(req.params.studentId ?? "").trim();
    if (!studentId) {
      res.status(400).json({ error: "studentId required" });
      return;
    }

    const rawMessage =
      typeof req.body?.message === "string" ? req.body.message : "";
    const trimmed = rawMessage.trim();
    if (trimmed.length > MAX_NOTE_LEN) {
      res
        .status(400)
        .json({ error: `Message must be ${MAX_NOTE_LEN} characters or fewer.` });
      return;
    }

    // Visibility check FIRST — never leak the existence of an out-of-scope
    // student, and never let a teacher write to one.
    const visibility = await getVisibleStudentIds(staff, schoolId);
    if (!visibility.full && !visibility.ids.has(studentId)) {
      res
        .status(403)
        .json({ error: "Not in your roster or trusted-adult list" });
      return;
    }

    const value = trimmed.length === 0 ? null : trimmed;
    const nowIso = new Date().toISOString();
    const updated = await db
      .update(studentsTable)
      .set({
        heartbeatNote: value,
        heartbeatNoteUpdatedBy: value === null ? null : staff.id,
        heartbeatNoteUpdatedAt: value === null ? null : nowIso,
      })
      .where(
        and(
          eq(studentsTable.studentId, studentId),
          eq(studentsTable.schoolId, schoolId),
        ),
      )
      .returning({
        heartbeatNote: studentsTable.heartbeatNote,
        heartbeatNoteUpdatedAt: studentsTable.heartbeatNoteUpdatedAt,
      });

    if (updated.length === 0) {
      res.status(404).json({ error: "Student not found in this school" });
      return;
    }
    res.json({
      message: updated[0].heartbeatNote,
      updatedAt: updated[0].heartbeatNoteUpdatedAt,
      updatedByName: staff.displayName ?? null,
    });
  },
);

export default router;
