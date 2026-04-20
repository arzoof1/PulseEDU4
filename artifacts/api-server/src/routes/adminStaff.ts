import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { db, staffTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.session.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function requireAdmin() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!staff.isAdmin) {
      res.status(403).json({ error: "Admin only" });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

// Legacy role flags — used as labels and quick-set presets in the admin UI.
const ROLE_FLAGS = [
  "isAdmin",
  "isEseCoordinator",
  "isPbisCoordinator",
  "isBehaviorSpecialist",
  "isIssTeacher",
  "isDean",
  "isMtssCoordinator",
] as const;
type RoleFlag = (typeof ROLE_FLAGS)[number];

// Per-page capability flags — the new mechanism that gates access to each
// sidebar page. Defined here once so both the GET projection and PATCH
// whitelist stay in sync.
const CAP_FLAGS = [
  "capHallPasses",
  "capHallPassesViewAll",
  "capTardies",
  "capStudentActivity",
  "capPbisAward",
  "capPbisManage",
  "capParentEmail",
  "capSupportNotes",
  "capAccommodationLog",
  "capAccommodationManage",
  "capPulloutsRequest",
  "capPulloutsVerify",
  "capPulloutsReview",
  "capInterventionLog",
  "capInterventionManage",
  "capReports",
  "capIssDashboard",
  "capKioskActivate",
  "capManageLocations",
] as const;
type CapFlag = (typeof CAP_FLAGS)[number];

const ALL_BOOL_FIELDS = [...ROLE_FLAGS, ...CAP_FLAGS, "active"] as const;
type AnyBoolField = (typeof ALL_BOOL_FIELDS)[number];

function pickStaffUpdates(
  body: unknown,
): Partial<Record<AnyBoolField, boolean>> {
  if (!body || typeof body !== "object") return {};
  const src = body as Record<string, unknown>;
  const out: Partial<Record<AnyBoolField, boolean>> = {};
  for (const key of ALL_BOOL_FIELDS) {
    if (typeof src[key] === "boolean") out[key] = src[key] as boolean;
  }
  return out;
}

// Projection used by both the list endpoint and the patch return value, so
// the row shape stays identical on read and on write.
const STAFF_LIST_PROJECTION = {
  id: staffTable.id,
  email: staffTable.email,
  displayName: staffTable.displayName,
  active: staffTable.active,
  isAdmin: staffTable.isAdmin,
  isEseCoordinator: staffTable.isEseCoordinator,
  isPbisCoordinator: staffTable.isPbisCoordinator,
  isBehaviorSpecialist: staffTable.isBehaviorSpecialist,
  isIssTeacher: staffTable.isIssTeacher,
  isDean: staffTable.isDean,
  isMtssCoordinator: staffTable.isMtssCoordinator,
  capHallPasses: staffTable.capHallPasses,
  capHallPassesViewAll: staffTable.capHallPassesViewAll,
  capTardies: staffTable.capTardies,
  capStudentActivity: staffTable.capStudentActivity,
  capPbisAward: staffTable.capPbisAward,
  capPbisManage: staffTable.capPbisManage,
  capParentEmail: staffTable.capParentEmail,
  capSupportNotes: staffTable.capSupportNotes,
  capAccommodationLog: staffTable.capAccommodationLog,
  capAccommodationManage: staffTable.capAccommodationManage,
  capPulloutsRequest: staffTable.capPulloutsRequest,
  capPulloutsVerify: staffTable.capPulloutsVerify,
  capPulloutsReview: staffTable.capPulloutsReview,
  capInterventionLog: staffTable.capInterventionLog,
  capInterventionManage: staffTable.capInterventionManage,
  capReports: staffTable.capReports,
  capIssDashboard: staffTable.capIssDashboard,
  capKioskActivate: staffTable.capKioskActivate,
  capManageLocations: staffTable.capManageLocations,
} as const;

// List all staff with their role + capability flags. Admin only.
router.get(
  "/admin/staff",
  requireAdmin(),
  async (_req: Request, res: Response) => {
    const rows = await db
      .select(STAFF_LIST_PROJECTION)
      .from(staffTable)
      .orderBy(asc(staffTable.displayName));
    res.json(rows);
  },
);

// Update role / capability / active flags for a single staff member. Admin
// only. Body: any subset of the boolean fields. Multiple fields can be sent
// in one PATCH (used by the role-preset shortcut in the UI).
router.patch(
  "/admin/staff/:id",
  requireAdmin(),
  async (req: Request, res: Response) => {
    const targetId = Number(req.params.id);
    if (!Number.isFinite(targetId)) {
      res.status(400).json({ error: "Invalid staff id" });
      return;
    }
    const updates = pickStaffUpdates(req.body);
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No valid fields in request body" });
      return;
    }

    const actor = (req as Request & { staff: StaffRow }).staff;

    // Don't let an admin demote themselves or deactivate themselves —
    // prevents lockout.
    if (targetId === actor.id) {
      if (updates.isAdmin === false) {
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
      .returning(STAFF_LIST_PROJECTION);
    res.json(updated);
  },
);

export default router;
