import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import {
  db,
  classSectionsTable,
  sectionRosterTable,
  staffTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";

const router: IRouter = Router();

async function resolveStaff(
  req: Request,
): Promise<typeof staffTable.$inferSelect | null> {
  const sessionId = req.staffId;
  const queryId = (() => {
    const raw = req.query.staffId;
    if (typeof raw !== "string") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  const id = sessionId ?? queryId;
  if (!id) return null;
  const [staff] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return staff && staff.active ? staff : null;
}

// Returns sections for the signed-in staff (or ?staffId= fallback when cookies
// are blocked, e.g. inside the Replit preview iframe). ?all=1 returns every
// section in the school (used by admins/ESE coordinators for browsing).
// Response shape: { sections: [{ id, period, courseName, isPlanning, teacherStaffId, teacherName, studentIds }] }
router.get("/schedule", async (req, res) => {
  const wantAll = req.query.all === "1";
  const staff = await resolveStaff(req);

  if (!wantAll && !staff) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }

  const filterByTeacher = !wantAll;

  const sections = filterByTeacher
    ? await db
        .select()
        .from(classSectionsTable)
        .where(eq(classSectionsTable.teacherStaffId, staff!.id))
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
