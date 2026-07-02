import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  staffTable,
  schoolSettingsTable,
  classSectionsTable,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam } from "../lib/coreTeam.js";
import {
  clampDepartment,
  inferDepartment,
} from "../lib/teacherDepartments.js";

const router: IRouter = Router();

// Staff Directory — per-school list of active staff with their default
// room (read-only, fed by the SIS staff import) and two PulseEDU-owned
// phone columns. The cell number is the sensitive one; visibility is
// controlled by school_settings.staffDirectoryShowCellPhone.
//
//   - GET  /api/staff-directory         list every active staff in school
//   - PUT  /api/staff-directory/:id     update workExtension + cellPhone
//                                       (Core Team / Admin / SuperUser)
//
// Read access: every signed-in staff member can list the directory; the
// server redacts cellPhone to null when the caller is not entitled to
// see it. The client never sees the value it isn't allowed to see, so a
// curious user can't pull it out of devtools.

// Light normalization: keep digits, +, (, ), -, space, x. Empty input
// becomes null (i.e. "clear this field"). Caps length so a typo can't
// blow up the column.
function normalizePhone(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const cleaned = raw
    .replace(/[^\d+()\-\s xX]/g, "")
    .trim()
    .slice(0, 32);
  return cleaned.length > 0 ? cleaned : null;
}

interface RequesterContext {
  isCoreTeamCaller: boolean;
  showCellPhone: boolean;
}

async function loadRequesterContext(
  schoolId: number,
  staffId: number,
): Promise<RequesterContext> {
  const [me] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  const isCoreTeamCaller = !!me && isCoreTeam(me);
  const [settings] = await db
    .select({
      staffDirectoryShowCellPhone: schoolSettingsTable.staffDirectoryShowCellPhone,
    })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  const settingOn = Boolean(settings?.staffDirectoryShowCellPhone);
  return { isCoreTeamCaller, showCellPhone: isCoreTeamCaller || settingOn };
}

router.get("/staff-directory", async (req: Request, res: Response) => {
  if (!req.staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const ctx = await loadRequesterContext(schoolId, req.staffId);

  const rows = await db
    .select({
      id: staffTable.id,
      displayName: staffTable.displayName,
      email: staffTable.email,
      department: staffTable.department,
      defaultRoom: staffTable.defaultRoom,
      externalId: staffTable.externalId,
      workExtension: staffTable.workExtension,
      cellPhone: staffTable.cellPhone,
      isAdmin: staffTable.isAdmin,
      isDistrictAdmin: staffTable.isDistrictAdmin,
      isSuperUser: staffTable.isSuperUser,
      isEseCoordinator: staffTable.isEseCoordinator,
      isPbisCoordinator: staffTable.isPbisCoordinator,
      isBehaviorSpecialist: staffTable.isBehaviorSpecialist,
      isMtssCoordinator: staffTable.isMtssCoordinator,
      isCounselor: staffTable.isCounselor,
      isGuidanceCounselor: staffTable.isGuidanceCounselor,
      isDean: staffTable.isDean,
      isSchoolPsychologist: staffTable.isSchoolPsychologist,
      isIssTeacher: staffTable.isIssTeacher,
      isSocialWorker: staffTable.isSocialWorker,
    })
    .from(staffTable)
    .where(
      and(eq(staffTable.schoolId, schoolId), eq(staffTable.active, true)),
    )
    .orderBy(asc(staffTable.displayName));

  // Infer each teacher's department from their non-planning course names
  // (same helper the Teacher Roster picker uses) so every teacher chooser
  // groups identically. Falls back to the SIS staff.department column for
  // staff without sections; "Other" when neither is available.
  const sections = await db
    .select({
      teacherStaffId: classSectionsTable.teacherStaffId,
      courseName: classSectionsTable.courseName,
      isPlanning: classSectionsTable.isPlanning,
    })
    .from(classSectionsTable)
    .where(eq(classSectionsTable.schoolId, schoolId));
  const coursesByTeacher = new Map<number, string[]>();
  for (const s of sections) {
    if (s.isPlanning) continue;
    const list = coursesByTeacher.get(s.teacherStaffId) ?? [];
    list.push(s.courseName);
    coursesByTeacher.set(s.teacherStaffId, list);
  }

  res.json({
    canEdit: ctx.isCoreTeamCaller,
    showCellPhone: ctx.showCellPhone,
    staff: rows.map((r) => {
      const courses = coursesByTeacher.get(r.id) ?? [];
      return {
        ...r,
        department:
          courses.length > 0
            ? inferDepartment(courses)
            : clampDepartment(r.department),
        // Hard-redact server-side when caller isn't entitled. Client never
        // receives the value it isn't allowed to see.
        cellPhone: ctx.showCellPhone ? r.cellPhone : null,
      };
    }),
  });
});

router.put(
  "/staff-directory/:id",
  async (req: Request, res: Response): Promise<void> => {
    if (!req.staffId) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;

    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      res.status(400).json({ error: "Invalid staff id" });
      return;
    }

    // Editor gate: Core Team / Admin / SuperUser only. Self-edit by
    // ordinary staff is intentionally not supported in v1 — keeps the
    // directory authoritative.
    const [me] = await db
      .select()
      .from(staffTable)
      .where(eq(staffTable.id, req.staffId));
    if (!me || !me.active || !isCoreTeam(me)) {
      res.status(403).json({
        error:
          "Only Core Team (Admin, Behavior Specialist, MTSS Coordinator, School Psychologist, or SuperUser) may edit the staff directory",
      });
      return;
    }

    // Confirm target staff is in the same school. Drizzle's WHERE on the
    // update would catch a cross-tenant id, but we want a clean 404 vs
    // a silent no-op.
    const [target] = await db
      .select({ id: staffTable.id })
      .from(staffTable)
      .where(
        and(eq(staffTable.id, targetId), eq(staffTable.schoolId, schoolId)),
      );
    if (!target) {
      res.status(404).json({ error: "Staff member not found in your school" });
      return;
    }

    const { workExtension, cellPhone } = (req.body ?? {}) as {
      workExtension?: unknown;
      cellPhone?: unknown;
    };

    const updates: { workExtension?: string | null; cellPhone?: string | null } = {};
    const normalizedExt = normalizePhone(workExtension);
    if (normalizedExt !== undefined) updates.workExtension = normalizedExt;
    const normalizedCell = normalizePhone(cellPhone);
    if (normalizedCell !== undefined) updates.cellPhone = normalizedCell;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    const [updated] = await db
      .update(staffTable)
      .set(updates)
      .where(
        and(eq(staffTable.id, targetId), eq(staffTable.schoolId, schoolId)),
      )
      .returning({
        id: staffTable.id,
        workExtension: staffTable.workExtension,
        cellPhone: staffTable.cellPhone,
      });

    res.json(updated);
  },
);

export default router;
