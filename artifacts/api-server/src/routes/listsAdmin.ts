// Manage controlled vocabularies used elsewhere in PulseED:
//   - PBIS Reasons (positive behaviors awarded to students)
//   - Classroom Intervention Types
//
// Public read endpoints (any signed-in staff). Write endpoints gated by role:
//   PBIS Reasons      -> admin OR PBIS coordinator
//   Intervention list -> admin OR behavior specialist
//
// Modeled directly on accommodationsAdmin.ts.

import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  pbisReasonsTable,
  interventionTypesTable,
  staffTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

async function loadStaff(req: Request, res: Response) {
  const staffId = req.session.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  return staff;
}

function requireRole(check: (s: typeof staffTable.$inferSelect) => boolean, label: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    if (!check(staff)) {
      res.status(403).json({ error: `${label} only` });
      return;
    }
    (req as Request & { staff: typeof staff }).staff = staff;
    next();
  };
}

const requirePbisAdmin = requireRole(
  (s) => s.isAdmin || s.isPbisCoordinator,
  "PBIS coordinator or admin",
);
const requireInterventionAdmin = requireRole(
  (s) =>
    s.isAdmin || s.isBehaviorSpecialist || s.isMtssCoordinator || s.isDean,
  "Admin, behavior specialist, MTSS coordinator, or dean",
);

// ---- PBIS Reasons ----

router.get("/pbis-reasons", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const rows = await db
    .select()
    .from(pbisReasonsTable)
    .orderBy(pbisReasonsTable.category, pbisReasonsTable.name);
  res.json(rows);
});

router.post("/pbis-reasons", requirePbisAdmin, async (req, res) => {
  const { name, category, defaultPoints } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const cat =
    typeof category === "string" && category.trim() ? category.trim() : "General";
  let pts = 1;
  if (defaultPoints !== undefined && defaultPoints !== null) {
    const n = Number(defaultPoints);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      res.status(400).json({ error: "defaultPoints must be an integer" });
      return;
    }
    pts = n;
  }
  const existing = await db
    .select()
    .from(pbisReasonsTable)
    .where(eq(pbisReasonsTable.name, name.trim()));
  if (existing.length > 0) {
    res.status(409).json({ error: "Reason name already exists" });
    return;
  }
  const [row] = await db
    .insert(pbisReasonsTable)
    .values({ name: name.trim(), category: cat, defaultPoints: pts, active: true })
    .returning();
  res.status(201).json(row);
});

router.patch("/pbis-reasons/:id", requirePbisAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const { name, category, defaultPoints, active } = req.body ?? {};
  const updates: Partial<typeof pbisReasonsTable.$inferInsert> = {};
  if (typeof name === "string" && name.trim()) updates.name = name.trim();
  if (typeof category === "string" && category.trim())
    updates.category = category.trim();
  if (defaultPoints !== undefined && defaultPoints !== null) {
    const n = Number(defaultPoints);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      res.status(400).json({ error: "defaultPoints must be an integer" });
      return;
    }
    updates.defaultPoints = n;
  }
  if (typeof active === "boolean") updates.active = active;
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No updates" });
    return;
  }
  const [row] = await db
    .update(pbisReasonsTable)
    .set(updates)
    .where(eq(pbisReasonsTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(row);
});

// ---- Intervention Types ----

router.get("/intervention-types", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const rows = await db
    .select()
    .from(interventionTypesTable)
    .orderBy(interventionTypesTable.category, interventionTypesTable.name);
  res.json(rows);
});

router.post("/intervention-types", requireInterventionAdmin, async (req, res) => {
  const { name, category, requiresNote } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const cat =
    typeof category === "string" && category.trim() ? category.trim() : "Classroom";
  const reqNote = typeof requiresNote === "boolean" ? requiresNote : false;
  const existing = await db
    .select()
    .from(interventionTypesTable)
    .where(eq(interventionTypesTable.name, name.trim()));
  if (existing.length > 0) {
    res.status(409).json({ error: "Intervention name already exists" });
    return;
  }
  const [row] = await db
    .insert(interventionTypesTable)
    .values({
      name: name.trim(),
      category: cat,
      requiresNote: reqNote,
      active: true,
    })
    .returning();
  res.status(201).json(row);
});

router.delete("/intervention-types/:id", requireInterventionAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [row] = await db
    .delete(interventionTypesTable)
    .where(eq(interventionTypesTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ ok: true, id: row.id });
});

router.patch("/intervention-types/:id", requireInterventionAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const { name, category, requiresNote, active } = req.body ?? {};
  const updates: Partial<typeof interventionTypesTable.$inferInsert> = {};
  if (typeof name === "string" && name.trim()) updates.name = name.trim();
  if (typeof category === "string" && category.trim())
    updates.category = category.trim();
  if (typeof requiresNote === "boolean") updates.requiresNote = requiresNote;
  if (typeof active === "boolean") updates.active = active;
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No updates" });
    return;
  }
  const [row] = await db
    .update(interventionTypesTable)
    .set(updates)
    .where(eq(interventionTypesTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(row);
});

export default router;
