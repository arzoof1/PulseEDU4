import { Router, type IRouter, type Request, type Response } from "express";
import { db, staffTable, schoolsTable } from "@workspace/db";
import { and, asc, eq, inArray, ne } from "drizzle-orm";

const router: IRouter = Router();

// =============================================================================
// Staff Preview — staff "Preview as another staff member" QA tool.
//
// Lets Admin / DistrictAdmin / SuperUser temporarily sign in as any other
// staff member in their scope so they can verify role-gated UI/behavior
// without juggling test accounts. Sister tool to /admin/parent-preview.
//
// Backed by staff.preview_target_staff_id (a DB column on the IMPERSONATOR's
// row) rather than the session. The reason is the Replit preview iframe:
// session cookies are routinely blocked there, so any auth/state that lives
// in the session is silently dropped on bearer-only requests. Storing the
// pointer on the staff row makes it survive whatever transport the client
// is using. The global middleware in app.ts reads the pointer and swaps
// req.staffId from impersonator → target on every request.
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
//   - Refuses nested previews. If you're already previewing, the START
//     endpoint refuses with 409. End the current preview first.
//   - Everything is read-through-the-impersonated-staff-row, including audit
//     fields like createdBy on writes — anything the previewer changes is
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

// Resolve the IMPERSONATOR (the real signed-in staff). When previewing,
// the global middleware has already swapped req.staffId to the target;
// the original lives in req.impersonatorStaffId. For these routes — start
// and end of a preview — we always operate on the original.
async function gateImpersonator(req: Request, res: Response) {
  const sid = req.impersonatorStaffId ?? req.staffId ?? null;
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
    const actor = await gateImpersonator(req, res);
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
// Set staff.preview_target_staff_id on the IMPERSONATOR's row. The global
// middleware will pick it up on the next request and swap req.staffId.
// ---------------------------------------------------------------------------
router.post(
  "/admin/staff-preview",
  async (req: Request, res: Response): Promise<void> => {
    // Disallow nested previews — keeps the model simple. End the current
    // preview first, then start a new one.
    if (req.impersonatorStaffId) {
      res.status(409).json({
        error:
          "Already previewing. End the current preview before starting a new one.",
      });
      return;
    }
    const actor = await gateImpersonator(req, res);
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

    await db
      .update(staffTable)
      .set({ previewTargetStaffId: target.id })
      .where(eq(staffTable.id, actor.id));

    res.json({
      ok: true,
      redirectTo: "/",
      targetStaffId: target.id,
      targetDisplayName: target.displayName,
    });
  },
);

// ---------------------------------------------------------------------------
// POST /api/admin/staff-preview/end
// Clear staff.preview_target_staff_id on the impersonator. The global
// middleware then stops swapping and the next request resolves to the
// real signed-in staff again.
// ---------------------------------------------------------------------------
router.post(
  "/admin/staff-preview/end",
  async (req: Request, res: Response): Promise<void> => {
    // Normal case: middleware swapped us, so req.impersonatorStaffId is
    // the original actor whose row holds the pointer. Edge case: the
    // original actor lost admin privileges while a pointer was still
    // set, so the middleware refused to swap and req.impersonatorStaffId
    // is null. In that case the unswapped req.staffId IS the original
    // actor, and we still want to let them clear their own pointer so
    // they aren't permanently stranded. Middleware also self-clears
    // this case on the NEXT request, but doing it here makes "End
    // preview" feel synchronous.
    let impersonatorId = req.impersonatorStaffId ?? null;
    if (!impersonatorId && req.staffId) {
      const [self] = await db
        .select({ previewTargetStaffId: staffTable.previewTargetStaffId })
        .from(staffTable)
        .where(eq(staffTable.id, req.staffId));
      if (self?.previewTargetStaffId) {
        impersonatorId = req.staffId;
      }
    }
    if (!impersonatorId) {
      res.status(400).json({ error: "Not currently previewing" });
      return;
    }
    await db
      .update(staffTable)
      .set({ previewTargetStaffId: null })
      .where(eq(staffTable.id, impersonatorId));

    res.json({ ok: true, redirectTo: "/" });
  },
);

export default router;
