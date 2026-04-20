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

function pickRoleUpdates(
  body: unknown,
): Partial<Record<RoleFlag | "active", boolean>> {
  if (!body || typeof body !== "object") return {};
  const src = body as Record<string, unknown>;
  const out: Partial<Record<RoleFlag | "active", boolean>> = {};
  for (const key of [...ROLE_FLAGS, "active" as const]) {
    if (typeof src[key] === "boolean") out[key] = src[key] as boolean;
  }
  return out;
}

// List all staff with their role flags. Admin only.
router.get(
  "/admin/staff",
  requireAdmin(),
  async (_req: Request, res: Response) => {
    const rows = await db
      .select({
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
      })
      .from(staffTable)
      .orderBy(asc(staffTable.displayName));
    res.json(rows);
  },
);

// Update role flags / active for a single staff member. Admin only.
// Body: any subset of the boolean flags.
router.patch(
  "/admin/staff/:id",
  requireAdmin(),
  async (req: Request, res: Response) => {
    const targetId = Number(req.params.id);
    if (!Number.isFinite(targetId)) {
      res.status(400).json({ error: "Invalid staff id" });
      return;
    }
    const updates = pickRoleUpdates(req.body);
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
      .returning({
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
      });
    res.json(updated);
  },
);

export default router;
