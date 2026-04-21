import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  pbisMilestonesTable,
  pbisMilestoneEmailsTable,
  staffTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function isManager(s: StaffRow): boolean {
  return s.isAdmin || s.isPbisCoordinator;
}

router.get("/pbis-milestones", async (req: Request, res: Response) => {
  const staff = await loadStaff(req);
  if (!staff) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const rows = await db.select().from(pbisMilestonesTable);
  rows.sort((a, b) => a.points - b.points);
  res.json(rows);
});

router.post("/pbis-milestones", async (req: Request, res: Response) => {
  const staff = await loadStaff(req);
  if (!staff || !isManager(staff)) {
    res.status(403).json({ error: "Admin or PBIS coordinator only" });
    return;
  }
  const points = Number(req.body?.points);
  if (!Number.isFinite(points) || points <= 0) {
    res.status(400).json({ error: "points must be a positive number" });
    return;
  }
  try {
    const [row] = await db
      .insert(pbisMilestonesTable)
      .values({
        points: Math.trunc(points),
        active: true,
        createdAt: new Date().toISOString(),
      })
      .returning();
    res.status(201).json(row);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/unique/i.test(msg)) {
      res.status(409).json({ error: "That milestone already exists" });
      return;
    }
    res.status(500).json({ error: msg });
  }
});

router.patch("/pbis-milestones/:id", async (req: Request, res: Response) => {
  const staff = await loadStaff(req);
  if (!staff || !isManager(staff)) {
    res.status(403).json({ error: "Admin or PBIS coordinator only" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Bad id" });
    return;
  }
  const active = req.body?.active;
  if (typeof active !== "boolean") {
    res.status(400).json({ error: "active boolean required" });
    return;
  }
  const [row] = await db
    .update(pbisMilestonesTable)
    .set({ active })
    .where(eq(pbisMilestonesTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(row);
});

router.get(
  "/pbis-milestone-emails",
  async (req: Request, res: Response) => {
    const staff = await loadStaff(req);
    if (!staff || !isManager(staff)) {
      res.status(403).json({ error: "Admin or PBIS coordinator only" });
      return;
    }
    const rows = await db.select().from(pbisMilestoneEmailsTable);
    rows.sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));
    res.json(rows.slice(0, 100));
  },
);

export default router;
