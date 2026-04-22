// Master list of "check-in/check-out with" options used by the Check-In/Out
// modal dropdown. Read by any signed-in staff. Write access is gated to
// admin, behavior specialist, MTSS coordinator, or dean.

import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { db, checkInWithOptionsTable, staffTable } from "@workspace/db";
import { and, eq, ne, sql } from "drizzle-orm";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
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

function requireListAdmin() {
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
        error:
          "Admin, behavior specialist, MTSS coordinator, or dean only",
      });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

router.get("/check-in-with-options", requireSignedIn(), async (_req, res) => {
  const rows = await db
    .select()
    .from(checkInWithOptionsTable)
    .orderBy(checkInWithOptionsTable.position, checkInWithOptionsTable.label);
  res.json(rows);
});

router.post(
  "/check-in-with-options",
  requireListAdmin(),
  async (req, res) => {
    const { label } = req.body ?? {};
    if (typeof label !== "string" || !label.trim()) {
      res.status(400).json({ error: "label is required" });
      return;
    }
    const trimmed = label.trim();
    const existing = await db
      .select()
      .from(checkInWithOptionsTable)
      .where(
        sql`lower(${checkInWithOptionsTable.label}) = lower(${trimmed})`,
      );
    if (existing.length > 0) {
      res.status(409).json({ error: "Label already exists (it may be in the Removed list — restore it instead)" });
      return;
    }
    const [{ max }] = await db
      .select({
        max: sql<number>`coalesce(max(${checkInWithOptionsTable.position}), -1)`,
      })
      .from(checkInWithOptionsTable);
    const [row] = await db
      .insert(checkInWithOptionsTable)
      .values({
        label: trimmed,
        position: (max ?? -1) + 1,
        isActive: true,
      })
      .returning();
    res.status(201).json(row);
  },
);

router.patch(
  "/check-in-with-options/:id",
  requireListAdmin(),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const { label, position, isActive } = req.body ?? {};
    const updates: Partial<typeof checkInWithOptionsTable.$inferInsert> = {};
    if (typeof label === "string" && label.trim()) {
      const trimmed = label.trim();
      const dup = await db
        .select()
        .from(checkInWithOptionsTable)
        .where(
          and(
            sql`lower(${checkInWithOptionsTable.label}) = lower(${trimmed})`,
            ne(checkInWithOptionsTable.id, id),
          ),
        );
      if (dup.length > 0) {
        res.status(409).json({ error: "Label already exists (it may be in the Removed list — restore it instead)" });
        return;
      }
      updates.label = trimmed;
    }
    if (typeof position === "number" && Number.isInteger(position))
      updates.position = position;
    if (typeof isActive === "boolean") updates.isActive = isActive;
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No updates" });
      return;
    }
    const [row] = await db
      .update(checkInWithOptionsTable)
      .set(updates)
      .where(eq(checkInWithOptionsTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(row);
  },
);

// Soft-delete: mark inactive so historical tardy/check-in records still
// resolve cleanly against the original label.
router.delete(
  "/check-in-with-options/:id",
  requireListAdmin(),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [row] = await db
      .update(checkInWithOptionsTable)
      .set({ isActive: false })
      .where(eq(checkInWithOptionsTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ ok: true, id: row.id });
  },
);

export default router;
