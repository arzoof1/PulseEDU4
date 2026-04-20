import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import {
  db,
  classSectionsTable,
  sectionRosterTable,
  staffTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";

const router: IRouter = Router();

async function requireStaff(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const staffId = req.session.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  (req as Request & { staff: typeof staff }).staff = staff;
  next();
}

// Returns sections for the signed-in staff. Admins (or ?all=1) get every section.
// Response shape: { sections: [{ id, period, courseName, isPlanning, teacherStaffId, teacherName, studentIds }] }
router.get("/schedule", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect }).staff;
  const wantAll = req.query.all === "1";
  const filterByTeacher = !(wantAll && staff.capManageStaff);

  const sections = filterByTeacher
    ? await db
        .select()
        .from(classSectionsTable)
        .where(eq(classSectionsTable.teacherStaffId, staff.id))
    : await db.select().from(classSectionsTable);

  if (sections.length === 0) {
    res.json({ sections: [] });
    return;
  }

  const teacherIds = Array.from(new Set(sections.map((s) => s.teacherStaffId)));
  const teachers = teacherIds.length
    ? await db.select().from(staffTable)
    : [];
  const teacherById = new Map(teachers.map((t) => [t.id, t]));

  const sectionIds = sections.map((s) => s.id);
  const rosterRows = sectionIds.length
    ? await db.select().from(sectionRosterTable)
    : [];

  const studentsBySection = new Map<number, string[]>();
  for (const r of rosterRows) {
    const list = studentsBySection.get(r.sectionId) ?? [];
    list.push(r.studentId);
    studentsBySection.set(r.sectionId, list);
  }

  res.json({
    sections: sections.map((s) => ({
      id: s.id,
      period: s.period,
      courseName: s.courseName,
      isPlanning: s.isPlanning,
      teacherStaffId: s.teacherStaffId,
      teacherName: teacherById.get(s.teacherStaffId)?.displayName ?? "",
      studentIds: studentsBySection.get(s.id) ?? [],
    })),
  });
});

export default router;
