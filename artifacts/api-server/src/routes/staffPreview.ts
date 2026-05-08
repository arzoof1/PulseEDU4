import { Router, type IRouter, type Request, type Response } from "express";
import { db, staffTable, schoolsTable } from "@workspace/db";
import { and, asc, eq, inArray, ne } from "drizzle-orm";

declare module "express-session" {
  interface SessionData {
    // When set, the caller is currently previewing as another staff member.
    // Holds the ORIGINAL staffId so we can swap back without re-login.
    impersonatorStaffId?: number;
  }
}

const router: IRouter = Router();

// =============================================================================
// Staff Preview — staff "Preview as another staff member" QA tool.
//
// Lets Admin / DistrictAdmin / SuperUser temporarily sign in as any other
// staff member in their scope so they can verify role-gated UI/behavior
// without juggling test accounts. Sister tool to /admin/parent-preview.
//
// Safety:
//   - Gated to isAdmin / isDistrictAdmin / isSuperUser (mirrors the client
//     check that hides the menu tile for everyone else).
//   - Scope: SuperUser/DistrictAdmin → any staff in their district. Admin
//     → only staff in their own school. Never cross-district.
//   - Refuses to impersonate yourself, refuses to impersonate inactive staff,
//     refuses to impersonate a SuperUser or DistrictAdmin (privilege
//     escalation guard — a school admin must not be able to "preview as"
//     someone with district-wide reach).
//   - Session keeps `impersonatorStaffId` = the original staff id so
//     /auth/me can surface a banner and POST /staff-preview/end can restore
//     the session without a re-login.
//   - Everything is read-through-the-real-staff-row, including audit fields
//     like createdBy on writes — anything the previewer changes is
//     attributed to the impersonated staff. Use for visual / role-gate QA;
//     do NOT use to perform real student-facing changes you want attributed
//     to your own admin account.
// =============================================================================

async function loadDistrictSchoolIds(schoolId: number): Promise<number[]> {
  const [school] = await db
    .select({ districtId: schoolsTable.districtId })
    .from(schoolsTable)
    .where(eq(schoolsTable.id, schoolId));
  if (!school?.districtId) return [schoolId];
  const rows = await db
    .select({ id: schoolsTable.id })
    .from(schoolsTable)
    .where(eq(schoolsTable.districtId, school.districtId));
  return rows.map((r) => r.id);
}

async function gateActor(req: Request, res: Response) {
  const sid = req.staffId ?? null;
  if (!sid) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  const [actor] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, sid));
  if (
    !actor ||
    !actor.active ||
    !(actor.isAdmin || actor.isDistrictAdmin || actor.isSuperUser)
  ) {
    res
      .status(403)
      .json({ error: "Admin, District Admin, or SuperUser only" });
    return null;
  }
  return actor;
}

// ---------------------------------------------------------------------------
// GET /api/admin/staff-preview/list
// Returns staff in scope, with id, name, email, school, role flags. Excludes
// the caller and inactive rows. Excludes SuperUser/DistrictAdmin so a
// school admin can't escalate via preview.
// ---------------------------------------------------------------------------
router.get(
  "/admin/staff-preview/list",
  async (req: Request, res: Response): Promise<void> => {
    const actor = await gateActor(req, res);
    if (!actor) return;

    const scopeIds =
      actor.isSuperUser || actor.isDistrictAdmin
        ? await loadDistrictSchoolIds(actor.schoolId)
        : [actor.schoolId];

    const rows = await db
      .select({
        id: staffTable.id,
        displayName: staffTable.displayName,
        email: staffTable.email,
        schoolId: staffTable.schoolId,
        isAdmin: staffTable.isAdmin,
        isDistrictAdmin: staffTable.isDistrictAdmin,
        isSuperUser: staffTable.isSuperUser,
        isEseCoordinator: staffTable.isEseCoordinator,
        isPbisCoordinator: staffTable.isPbisCoordinator,
        isBehaviorSpecialist: staffTable.isBehaviorSpecialist,
        isIssTeacher: staffTable.isIssTeacher,
        isDean: staffTable.isDean,
        isMtssCoordinator: staffTable.isMtssCoordinator,
        isCounselor: staffTable.isCounselor,
        isSocialWorker: staffTable.isSocialWorker,
        isSchoolPsychologist: staffTable.isSchoolPsychologist,
        isGuidanceCounselor: staffTable.isGuidanceCounselor,
      })
      .from(staffTable)
      .where(
        and(
          inArray(staffTable.schoolId, scopeIds),
          eq(staffTable.active, true),
          ne(staffTable.id, actor.id),
        ),
      )
      .orderBy(asc(staffTable.displayName));

    // Filter out privileged accounts at the application layer. (Doing it in
    // SQL would require a more complex `or` chain; the row count is small
    // enough that an in-memory filter is fine.)
    const safe = rows.filter(
      (r) => !r.isSuperUser && !r.isDistrictAdmin,
    );
    res.json(safe);
  },
);

// ---------------------------------------------------------------------------
// POST /api/admin/staff-preview { targetStaffId }
// Swap the session to a different staff identity. Stores the original id
// in session.impersonatorStaffId so /staff-preview/end can restore.
// ---------------------------------------------------------------------------
router.post(
  "/admin/staff-preview",
  async (req: Request, res: Response): Promise<void> => {
    const actor = await gateActor(req, res);
    if (!actor) return;

    const targetId = Number(req.body?.targetStaffId);
    if (!Number.isInteger(targetId) || targetId < 1) {
      res.status(400).json({ error: "targetStaffId is required" });
      return;
    }
    if (targetId === actor.id) {
      res.status(400).json({ error: "Already signed in as this user" });
      return;
    }

    const [target] = await db
      .select()
      .from(staffTable)
      .where(eq(staffTable.id, targetId));
    if (!target || !target.active) {
      res.status(404).json({ error: "Target staff not found or inactive" });
      return;
    }
    if (target.isSuperUser || target.isDistrictAdmin) {
      res.status(403).json({
        error: "Cannot preview as a SuperUser or District Admin",
      });
      return;
    }

    const scopeIds =
      actor.isSuperUser || actor.isDistrictAdmin
        ? await loadDistrictSchoolIds(actor.schoolId)
        : [actor.schoolId];
    if (!scopeIds.includes(target.schoolId)) {
      res.status(403).json({ error: "Target is outside your scope" });
      return;
    }

    // Preserve the ORIGINAL impersonator across nested previews so a
    // SuperUser previewing as Admin → previewing as Teacher still has a
    // single click back to SuperUser.
    const originalImpersonator =
      req.session.impersonatorStaffId ?? actor.id;

    req.session.regenerate((err) => {
      if (err) {
        res.status(500).json({ error: "Could not start preview session" });
        return;
      }
      req.session.staffId = target.id;
      req.session.impersonatorStaffId = originalImpersonator;
      // Drop any stale parent identity / cross-school override.
      delete req.session.parentId;
      delete req.session.activeSchoolId;
      req.session.save((saveErr) => {
        if (saveErr) {
          res.status(500).json({ error: "Could not save preview session" });
          return;
        }
        res.json({ ok: true, redirectTo: "/" });
      });
    });
  },
);

// ---------------------------------------------------------------------------
// POST /api/admin/staff-preview/end
// Restore the original staff session from impersonatorStaffId.
// ---------------------------------------------------------------------------
router.post(
  "/admin/staff-preview/end",
  async (req: Request, res: Response): Promise<void> => {
    const original = req.session.impersonatorStaffId ?? null;
    if (!original) {
      res.status(400).json({ error: "Not currently previewing" });
      return;
    }
    const [origStaff] = await db
      .select({ id: staffTable.id, active: staffTable.active })
      .from(staffTable)
      .where(eq(staffTable.id, original));
    if (!origStaff || !origStaff.active) {
      // Original account no longer valid — wipe the session entirely so the
      // user is forced through real login again.
      req.session.destroy(() => {
        res.clearCookie("pulseed.sid");
        res.status(401).json({ error: "Original account no longer active" });
      });
      return;
    }

    req.session.regenerate((err) => {
      if (err) {
        res.status(500).json({ error: "Could not restore session" });
        return;
      }
      req.session.staffId = origStaff.id;
      delete req.session.impersonatorStaffId;
      delete req.session.parentId;
      delete req.session.activeSchoolId;
      req.session.save((saveErr) => {
        if (saveErr) {
          res.status(500).json({ error: "Could not save restored session" });
          return;
        }
        res.json({ ok: true, redirectTo: "/" });
      });
    });
  },
);

export default router;
