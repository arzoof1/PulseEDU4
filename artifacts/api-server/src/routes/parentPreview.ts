import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  parentsTable,
  parentStudentsTable,
  studentsTable,
  staffTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";

const router: IRouter = Router();

// =============================================================================
// Parent Portal — staff "Preview as parent" tool.
//
// Lets an Admin / SuperUser instantly view the parent-facing HeartBEAT for any
// student in their school WITHOUT going through the real invite + email +
// accept-password flow. Useful for QA + support.
//
// Safety / production-isolation:
//   - Gated to staff who are isAdmin or isSuperUser on the active school.
//   - Uses a single sentinel parent row per school, keyed off a reserved
//     `__preview@pulseedu.local` email. Never receives real invites or emails;
//     never carries a password (passwordHash stays NULL so /parent-auth/login
//     refuses it).
//   - Re-uses parent_students (the existing M:N table) but REPLACES links each
//     time so the previewer only ever sees the chosen student.
//   - The staff session cookie is replaced with a parent session — so the
//     preview lives in its own browser tab. Sign out from the parent header
//     to drop the preview session.
// =============================================================================

const PREVIEW_EMAIL = "__preview@pulseedu.local";
const PREVIEW_DISPLAY_NAME = "Preview Parent";

router.post(
  "/admin/parent-preview",
  async (req: Request, res: Response): Promise<void> => {
    const sid = req.staffId ?? null;
    if (!sid) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    const [staff] = await db
      .select({
        isAdmin: staffTable.isAdmin,
        isSuperUser: staffTable.isSuperUser,
      })
      .from(staffTable)
      .where(eq(staffTable.id, sid));
    if (!staff || (!staff.isAdmin && !staff.isSuperUser)) {
      res.status(403).json({ error: "Admin or SuperUser only" });
      return;
    }
    const schoolId = req.schoolId;
    if (!schoolId) {
      res.status(400).json({ error: "No active school" });
      return;
    }
    const studentRowId = Number(req.body?.studentRowId);
    if (!Number.isInteger(studentRowId) || studentRowId < 1) {
      res.status(400).json({ error: "studentRowId is required" });
      return;
    }

    // Confirm the student belongs to this school. Prevents a SuperUser hopping
    // schools without an active context, and prevents a school admin from
    // previewing another school's student.
    const [student] = await db
      .select({ id: studentsTable.id, schoolId: studentsTable.schoolId })
      .from(studentsTable)
      .where(eq(studentsTable.id, studentRowId));
    if (!student || student.schoolId !== schoolId) {
      res.status(404).json({ error: "Student not found in active school" });
      return;
    }

    // Find-or-create the sentinel preview parent for this school.
    let [preview] = await db
      .select()
      .from(parentsTable)
      .where(
        and(
          eq(parentsTable.schoolId, schoolId),
          eq(parentsTable.email, PREVIEW_EMAIL),
        ),
      );
    if (!preview) {
      const inserted = await db
        .insert(parentsTable)
        .values({
          schoolId,
          email: PREVIEW_EMAIL,
          // Null password — login endpoint rejects rows with no password.
          passwordHash: null,
          displayName: PREVIEW_DISPLAY_NAME,
          active: true,
        })
        .returning();
      preview = inserted[0];
    }

    // Replace links so the preview parent only sees the chosen student. Avoids
    // confusion from sibling switcher carrying over a previous preview pick.
    await db
      .delete(parentStudentsTable)
      .where(eq(parentStudentsTable.parentId, preview.id));
    await db.insert(parentStudentsTable).values({
      parentId: preview.id,
      studentId: student.id,
    });

    // Swap session: drop staff identity, install parent identity.
    req.session.regenerate((err) => {
      if (err) {
        res.status(500).json({ error: "Could not start preview session" });
        return;
      }
      req.session.parentId = preview.id;
      delete req.session.staffId;
      delete req.session.activeSchoolId;
      req.session.save((saveErr) => {
        if (saveErr) {
          res.status(500).json({ error: "Could not save preview session" });
          return;
        }
        res.json({ ok: true, redirectTo: "/parent" });
      });
    });
  },
);

export default router;
