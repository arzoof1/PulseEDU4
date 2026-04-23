import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  classSectionsTable,
  sectionRosterTable,
  staffTable,
} from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

async function resolveStaff(
  req: Request,
): Promise<typeof staffTable.$inferSelect | null> {
  // Session-only — no ?staffId query fallback. The previous fallback was an
  // intra-school impersonation surface (any signed-in user could request
  // another teacher's schedule view). Session and schoolId are set by the
  // same auth middleware, so if the cookie is missing, requireSchool 401s
  // anyway and the fallback served no real purpose.
  const id = req.staffId;
  if (!id) return null;
  const [staff] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return staff && staff.active ? staff : null;
}

// Returns sections for the signed-in staff. ?all=1 returns every section in
// the SAME school as the caller (used by admins/ESE coordinators for
// browsing). All paths require a signed-in session and AND-filter every
// query by the caller's schoolId — this prevents school A from listing
// school B's sections, teachers, or roster.
router.get("/schedule", async (req: Request, res: Response) => {
  const wantAll = req.query.all === "1";
  const staff = await resolveStaff(req);

  if (!staff) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  // ?all=1 lets admins/ESE coordinators browse every section in their school.
  // Mirror the client-side gate at the API boundary as defense-in-depth so a
  // non-privileged user can't bypass UI checks by hitting the URL directly.
  if (wantAll && !staff.isAdmin && !staff.isEseCoordinator) {
    res.status(403).json({ error: "Admin or ESE coordinator only" });
    return;
  }

  const filterByTeacher = !wantAll;

  const sections = filterByTeacher
    ? await db
        .select()
        .from(classSectionsTable)
        .where(
          and(
            eq(classSectionsTable.schoolId, schoolId),
            eq(classSectionsTable.teacherStaffId, staff.id),
          ),
        )
    : await db
        .select()
        .from(classSectionsTable)
        .where(eq(classSectionsTable.schoolId, schoolId));

  if (sections.length === 0) {
    res.json({ sections: [] });
    return;
  }

  const teacherIds = Array.from(new Set(sections.map((s) => s.teacherStaffId)));
  const teachers = teacherIds.length
    ? await db
        .select()
        .from(staffTable)
        .where(
          and(
            eq(staffTable.schoolId, schoolId),
            inArray(staffTable.id, teacherIds),
          ),
        )
    : [];
  const teacherById = new Map(teachers.map((t) => [t.id, t]));

  const sectionIds = sections.map((s) => s.id);
  const rosterRows = sectionIds.length
    ? await db
        .select()
        .from(sectionRosterTable)
        .where(
          and(
            eq(sectionRosterTable.schoolId, schoolId),
            inArray(sectionRosterTable.sectionId, sectionIds),
          ),
        )
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
