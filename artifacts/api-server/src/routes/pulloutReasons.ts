// Master list of common pullout reasons. Read by any signed-in staff so the
// pullout request form can show a quick-pick dropdown. Write access is gated
// to admin or behavior specialist (the same people who curate intervention
// types).

import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { db, pulloutReasonsTable, staffTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.session.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function requireSignedIn() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

function requireReasonAdmin() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (
      !staff.isAdmin &&
      !staff.isBehaviorSpecialist &&
      !staff.isMtssCoordinator &&
      !staff.isDean
    ) {
      res.status(403).json({
        error: "Admin, behavior specialist, MTSS coordinator, or dean only",
      });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

router.get("/pullout-reasons", requireSignedIn(), async (_req, res) => {
  const rows = await db
    .select()
    .from(pulloutReasonsTable)
    .orderBy(pulloutReasonsTable.category, pulloutReasonsTable.name);
  res.json(rows);
});

router.post("/pullout-reasons", requireReasonAdmin(), async (req, res) => {
  const { name, category } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const cat =
    typeof category === "string" && category.trim()
      ? category.trim()
      : "General";
  const existing = await db
    .select()
    .from(pulloutReasonsTable)
    .where(sql`lower(${pulloutReasonsTable.name}) = lower(${name.trim()})`);
  if (existing.length > 0) {
    res.status(409).json({ error: "Reason name already exists" });
    return;
  }
  const [row] = await db
    .insert(pulloutReasonsTable)
    .values({ name: name.trim(), category: cat, active: true })
    .returning();
  res.status(201).json(row);
});

router.patch(
  "/pullout-reasons/:id",
  requireReasonAdmin(),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const { name, category, active } = req.body ?? {};
    const updates: Partial<typeof pulloutReasonsTable.$inferInsert> = {};
    if (typeof name === "string" && name.trim()) updates.name = name.trim();
    if (typeof category === "string" && category.trim())
      updates.category = category.trim();
    if (typeof active === "boolean") updates.active = active;
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No updates" });
      return;
    }
    const [row] = await db
      .update(pulloutReasonsTable)
      .set(updates)
      .where(eq(pulloutReasonsTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(row);
  },
);

router.delete(
  "/pullout-reasons/:id",
  requireReasonAdmin(),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [row] = await db
      .delete(pulloutReasonsTable)
      .where(eq(pulloutReasonsTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ ok: true, id: row.id });
  },
);

export default router;
