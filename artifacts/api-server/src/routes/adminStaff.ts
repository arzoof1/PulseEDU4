import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import bcrypt from "bcryptjs";
import { db, staffTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  // Privileged admin surface: ONLY trust the server-side session. We do not
  // accept ?staffId= or actorStaffId from the client here, because those
  // values are caller-controlled and would let any unauthenticated user
  // impersonate any staff member (including SuperUser) and escalate
  // privileges via these endpoints.
  const id = req.session.staffId;
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
} as const;

// List all staff with full role + capability flags.
router.get(
  "/admin/staff",
  requireAdminOrSuper(),
  async (_req: Request, res: Response) => {
    const rows = await db
      .select(STAFF_SELECT)
      .from(staffTable)
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
    const updates = pickBoolUpdates(req.body);
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

    const [target] = await db
      .select()
      .from(staffTable)
      .where(eq(staffTable.id, targetId));
    if (!target) {
      res.status(404).json({ error: "Staff not found" });
      return;
    }

    const [updated] = await db
      .update(staffTable)
      .set(updates)
      .where(eq(staffTable.id, targetId))
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

    const passwordHash = await bcrypt.hash(password, 10);
    const [row] = await db
      .insert(staffTable)
      .values({
        email: normEmail,
        displayName: displayName.trim(),
        passwordHash,
        ...updates,
      })
      .returning(STAFF_SELECT);
    res.status(201).json(row);
  },
);

export default router;
