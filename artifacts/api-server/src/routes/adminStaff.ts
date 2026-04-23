import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import bcrypt from "bcryptjs";
import { db, staffTable } from "@workspace/db";
import { and, eq, asc, inArray, sql } from "drizzle-orm";
import { verifyAuthToken } from "../lib/authToken.js";
import {
  getDistrictIdForSchool,
  getSchoolIdsForDistrict,
} from "../lib/scope";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  // Trust the server-side session OR a server-signed bearer token issued at
  // login. The bearer token is HMAC-signed with SESSION_SECRET so it can't
  // be forged or modified — that lets the privileged endpoints work inside
  // the Replit preview iframe (where the cookie is sometimes blocked)
  // without ever trusting a raw caller-supplied staffId.
  let id = req.staffId ?? null;
  if (!id) {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      id = verifyAuthToken(auth.slice(7).trim());
    }
  }
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

// Admin OR SuperUser may use this surface. Page-level cap_staff_roles also
// admits a non-admin who's been explicitly granted the page.
function requireAdminOrSuper() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!staff.isAdmin && !staff.isSuperUser && !staff.capStaffRoles) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

const ROLE_FLAGS = [
  "isSuperUser",
  "isAdmin",
  "isEseCoordinator",
  "isPbisCoordinator",
  "isBehaviorSpecialist",
  "isIssTeacher",
  "isDean",
  "isMtssCoordinator",
  "isCounselor",
  "isSocialWorker",
] as const;
type RoleFlag = (typeof ROLE_FLAGS)[number];

const CAP_FLAGS = [
  "capHallPasses",
  "capTardies",
  "capStudentActivity",
  "capPbisAward",
  "capParentEmail",
  "capSupportNotes",
  "capAccommodationLog",
  "capPulloutsRequest",
  "capInterventionLog",
  "capReports",
  "capKioskActivate",
  "capHallPassesViewAll",
  "capPbisManage",
  "capAccommodationManage",
  "capPulloutsVerify",
  "capPulloutsReview",
  "capInterventionManage",
  "capIssDashboard",
  "capManageLocations",
  "capStaffRoles",
  "capManageRoles",
] as const;
type CapFlag = (typeof CAP_FLAGS)[number];

const ALL_BOOL_FIELDS = [...ROLE_FLAGS, ...CAP_FLAGS, "active" as const];

function pickBoolUpdates(
  body: unknown,
): Partial<Record<(typeof ALL_BOOL_FIELDS)[number], boolean>> {
  if (!body || typeof body !== "object") return {};
  const src = body as Record<string, unknown>;
  const out: Partial<Record<(typeof ALL_BOOL_FIELDS)[number], boolean>> = {};
  for (const key of ALL_BOOL_FIELDS) {
    if (typeof src[key] === "boolean") out[key] = src[key] as boolean;
  }
  return out;
}

const STAFF_SELECT = {
  id: staffTable.id,
  email: staffTable.email,
  displayName: staffTable.displayName,
  active: staffTable.active,
  isSuperUser: staffTable.isSuperUser,
  isAdmin: staffTable.isAdmin,
  isEseCoordinator: staffTable.isEseCoordinator,
  isPbisCoordinator: staffTable.isPbisCoordinator,
  isBehaviorSpecialist: staffTable.isBehaviorSpecialist,
  isIssTeacher: staffTable.isIssTeacher,
  isDean: staffTable.isDean,
  isMtssCoordinator: staffTable.isMtssCoordinator,
  isCounselor: staffTable.isCounselor,
  isSocialWorker: staffTable.isSocialWorker,
  capHallPasses: staffTable.capHallPasses,
  capTardies: staffTable.capTardies,
  capStudentActivity: staffTable.capStudentActivity,
  capPbisAward: staffTable.capPbisAward,
  capParentEmail: staffTable.capParentEmail,
  capSupportNotes: staffTable.capSupportNotes,
  capAccommodationLog: staffTable.capAccommodationLog,
  capPulloutsRequest: staffTable.capPulloutsRequest,
  capInterventionLog: staffTable.capInterventionLog,
  capReports: staffTable.capReports,
  capKioskActivate: staffTable.capKioskActivate,
  capHallPassesViewAll: staffTable.capHallPassesViewAll,
  capPbisManage: staffTable.capPbisManage,
  capAccommodationManage: staffTable.capAccommodationManage,
  capPulloutsVerify: staffTable.capPulloutsVerify,
  capPulloutsReview: staffTable.capPulloutsReview,
  capInterventionManage: staffTable.capInterventionManage,
  capIssDashboard: staffTable.capIssDashboard,
  capManageLocations: staffTable.capManageLocations,
  capStaffRoles: staffTable.capStaffRoles,
  capManageRoles: staffTable.capManageRoles,
  defaultRoom: staffTable.defaultRoom,
  schoolId: staffTable.schoolId,
} as const;

// List staff with full role + capability flags. SuperUsers see every school
// in their own district (the role is district-wide, not cross-district —
// before D6 the SuperUser branch was unscoped, which leaked across
// districts the moment Pasco was added). Everyone else — including school
// admins and cap_staff_roles holders — sees only their own school.
router.get(
  "/admin/staff",
  requireAdminOrSuper(),
  async (req: Request, res: Response) => {
    const actor = (req as Request & { staff: StaffRow }).staff;
    if (actor.isSuperUser) {
      const districtId = await getDistrictIdForSchool(actor.schoolId);
      const districtSchoolIds =
        districtId !== null ? await getSchoolIdsForDistrict(districtId) : [];
      const rows =
        districtSchoolIds.length === 0
          ? []
          : await db
              .select(STAFF_SELECT)
              .from(staffTable)
              .where(inArray(staffTable.schoolId, districtSchoolIds))
              .orderBy(asc(staffTable.displayName));
      res.json(rows);
      return;
    }
    const rows = await db
      .select(STAFF_SELECT)
      .from(staffTable)
      .where(eq(staffTable.schoolId, actor.schoolId))
      .orderBy(asc(staffTable.displayName));
    res.json(rows);
  },
);

// Update any subset of role/capability flags + active for one staff member.
router.patch(
  "/admin/staff/:id",
  requireAdminOrSuper(),
  async (req: Request, res: Response) => {
    const targetId = Number(req.params.id);
    if (!Number.isFinite(targetId)) {
      res.status(400).json({ error: "Invalid staff id" });
      return;
    }
    const updates: Record<string, unknown> = pickBoolUpdates(req.body);
    // Optional string field: defaultRoom. Empty string clears it (NULL).
    const body = (req.body ?? {}) as Record<string, unknown>;
    if ("defaultRoom" in body) {
      const v = body.defaultRoom;
      if (v === null || (typeof v === "string" && v.trim() === "")) {
        updates.defaultRoom = null;
      } else if (typeof v === "string") {
        updates.defaultRoom = v.trim();
      } else {
        res.status(400).json({ error: "defaultRoom must be a string or null" });
        return;
      }
    }
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No valid fields in request body" });
      return;
    }

    const actor = (req as Request & { staff: StaffRow }).staff;

    // Only SuperUser may grant or remove SuperUser. Only SuperUser/Admin may
    // change Admin. cap_staff_roles by itself does NOT permit escalation —
    // the dangerous caps (cap_staff_roles, cap_manage_roles) are also
    // restricted to Admin/SuperUser to prevent a cap_staff_roles holder
    // from bootstrapping themselves into full control.
    if ("isSuperUser" in updates && !actor.isSuperUser) {
      res.status(403).json({ error: "Only a SuperUser can change SuperUser." });
      return;
    }
    if ("isAdmin" in updates && !actor.isSuperUser && !actor.isAdmin) {
      res.status(403).json({ error: "Only Admin/SuperUser can change Admin." });
      return;
    }
    if (
      ("capStaffRoles" in updates || "capManageRoles" in updates) &&
      !actor.isSuperUser &&
      !actor.isAdmin
    ) {
      res
        .status(403)
        .json({ error: "Only Admin/SuperUser can change role-management capabilities." });
      return;
    }

    if (targetId === actor.id) {
      if (updates.isSuperUser === false && actor.isSuperUser) {
        res
          .status(409)
          .json({ error: "You cannot remove your own SuperUser role." });
        return;
      }
      if (updates.isAdmin === false && actor.isAdmin && !actor.isSuperUser) {
        res
          .status(409)
          .json({ error: "You cannot remove your own admin role." });
        return;
      }
      if (updates.active === false) {
        res
          .status(409)
          .json({ error: "You cannot deactivate your own account." });
        return;
      }
      if (updates.capStaffRoles === false || updates.capManageRoles === false) {
        res
          .status(409)
          .json({ error: "You cannot revoke your own role-management access." });
        return;
      }
    }

    // Non-SuperUsers can only manage staff in their own school. SuperUsers
    // retain district-wide reach but NOT cross-district reach (since D6 /
    // Pasco onboarding). The target must be in the actor's district.
    const actorDistrictSchoolIds = actor.isSuperUser
      ? await (async () => {
          const did = await getDistrictIdForSchool(actor.schoolId);
          return did !== null ? await getSchoolIdsForDistrict(did) : [];
        })()
      : null;

    const [target] = await db
      .select()
      .from(staffTable)
      .where(
        actor.isSuperUser
          ? and(
              eq(staffTable.id, targetId),
              actorDistrictSchoolIds && actorDistrictSchoolIds.length > 0
                ? inArray(staffTable.schoolId, actorDistrictSchoolIds)
                : sql`false`,
            )
          : and(
              eq(staffTable.id, targetId),
              eq(staffTable.schoolId, actor.schoolId),
            ),
      );
    if (!target) {
      res.status(404).json({ error: "Staff not found" });
      return;
    }

    const [updated] = await db
      .update(staffTable)
      .set(updates)
      .where(
        actor.isSuperUser
          ? and(
              eq(staffTable.id, targetId),
              actorDistrictSchoolIds && actorDistrictSchoolIds.length > 0
                ? inArray(staffTable.schoolId, actorDistrictSchoolIds)
                : sql`false`,
            )
          : and(
              eq(staffTable.id, targetId),
              eq(staffTable.schoolId, actor.schoolId),
            ),
      )
      .returning(STAFF_SELECT);
    res.json(updated);
  },
);

// Create a new staff member. Admin/SuperUser only.
router.post(
  "/admin/staff",
  requireAdminOrSuper(),
  async (req: Request, res: Response) => {
    const actor = (req as Request & { staff: StaffRow }).staff;
    const { email, displayName, password } = (req.body ?? {}) as {
      email?: unknown;
      displayName?: unknown;
      password?: unknown;
    };
    if (
      typeof email !== "string" ||
      typeof displayName !== "string" ||
      typeof password !== "string" ||
      !email.trim() ||
      !displayName.trim() ||
      password.length < 8
    ) {
      res.status(400).json({
        error: "email, displayName, and password (min 8 chars) are required",
      });
      return;
    }
    const normEmail = email.trim().toLowerCase();
    const [existing] = await db
      .select({ id: staffTable.id })
      .from(staffTable)
      .where(eq(staffTable.email, normEmail));
    if (existing) {
      res.status(409).json({ error: "A staff member with that email exists." });
      return;
    }

    const updates = pickBoolUpdates(req.body);
    // Same privilege gating as the patch endpoint. A cap_staff_roles holder
    // who is not Admin/SuperUser must not be able to create users with
    // SuperUser/Admin or with the role-management caps themselves — that
    // would be a privilege-escalation bootstrap.
    if (updates.isSuperUser && !actor.isSuperUser) delete updates.isSuperUser;
    if (updates.isAdmin && !actor.isSuperUser && !actor.isAdmin) {
      delete updates.isAdmin;
    }
    if (!actor.isSuperUser && !actor.isAdmin) {
      delete updates.capStaffRoles;
      delete updates.capManageRoles;
    }

    // School assignment for the new row:
    //   * SuperUser may target any school via body.schoolId IN THEIR OWN
    //     DISTRICT (defaults to their own school if not supplied). Cross-
    //     district seeding is rejected — that would be a Hernando admin
    //     creating staff inside a Pasco school.
    //   * Everyone else creates strictly into their own school — body
    //     overrides are ignored to prevent cross-school staff seeding.
    const bodySchoolId = Number((req.body as { schoolId?: unknown })?.schoolId);
    let targetSchoolId = actor.schoolId;
    if (
      actor.isSuperUser &&
      Number.isInteger(bodySchoolId) &&
      bodySchoolId > 0
    ) {
      const actorDistrictId = await getDistrictIdForSchool(actor.schoolId);
      const targetDistrictId = await getDistrictIdForSchool(bodySchoolId);
      if (
        actorDistrictId === null ||
        targetDistrictId === null ||
        actorDistrictId !== targetDistrictId
      ) {
        res
          .status(403)
          .json({ error: "Cannot create staff in a school outside your district." });
        return;
      }
      targetSchoolId = bodySchoolId;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const [row] = await db
      .insert(staffTable)
      .values({
        email: normEmail,
        displayName: displayName.trim(),
        passwordHash,
        schoolId: targetSchoolId,
        ...updates,
      })
      .returning(STAFF_SELECT);
    res.status(201).json(row);
  },
);

// Admin / SuperUser resets another staff member's password.
//   - Non-SuperUser cannot reset a SuperUser's password (would let them
//     take over a SuperUser account).
//   - Non-Admin/SuperUser (i.e. someone holding only cap_staff_roles) is
//     blocked entirely — password reset is a privileged operation, not a
//     matrix-edit operation.
router.post(
  "/admin/staff/:id/password",
  requireAdminOrSuper(),
  async (req: Request, res: Response) => {
    const actor = (req as Request & { staff: StaffRow }).staff;
    if (!actor.isAdmin && !actor.isSuperUser) {
      res
        .status(403)
        .json({ error: "Only Admin or SuperUser can reset passwords." });
      return;
    }

    const targetId = Number(req.params.id);
    if (!Number.isFinite(targetId)) {
      res.status(400).json({ error: "Invalid staff id" });
      return;
    }

    // Self-reset must go through /auth/change-password (which proves the
    // caller knows the current password). Going through the admin path
    // would let anyone with admin/super skip that proof for themselves.
    if (targetId === actor.id) {
      res.status(409).json({
        error: "Use Change Password to update your own password.",
      });
      return;
    }

    const { newPassword } = (req.body ?? {}) as { newPassword?: unknown };
    if (typeof newPassword !== "string" || newPassword.length < 8) {
      res
        .status(400)
        .json({ error: "newPassword (min 8 chars) is required" });
      return;
    }

    // Same scoping as PATCH: non-SuperUser admins may only reset passwords
    // for staff in their own school. Without this, a school A admin who
    // knew a school B staff id could take over that account. SuperUser is
    // district-scoped (since D6) — no cross-district password resets.
    const actorDistrictSchoolIdsPwd = actor.isSuperUser
      ? await (async () => {
          const did = await getDistrictIdForSchool(actor.schoolId);
          return did !== null ? await getSchoolIdsForDistrict(did) : [];
        })()
      : null;

    const [target] = await db
      .select()
      .from(staffTable)
      .where(
        actor.isSuperUser
          ? and(
              eq(staffTable.id, targetId),
              actorDistrictSchoolIdsPwd && actorDistrictSchoolIdsPwd.length > 0
                ? inArray(staffTable.schoolId, actorDistrictSchoolIdsPwd)
                : sql`false`,
            )
          : and(
              eq(staffTable.id, targetId),
              eq(staffTable.schoolId, actor.schoolId),
            ),
      );
    if (!target) {
      res.status(404).json({ error: "Staff not found" });
      return;
    }

    if (!target.active) {
      res.status(409).json({
        error: "Reactivate this account before resetting its password.",
      });
      return;
    }

    if (target.isSuperUser && !actor.isSuperUser) {
      res
        .status(403)
        .json({ error: "Only a SuperUser can reset a SuperUser's password." });
      return;
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await db
      .update(staffTable)
      .set({ passwordHash })
      .where(eq(staffTable.id, targetId));

    res.json({ ok: true });
  },
);

export default router;
