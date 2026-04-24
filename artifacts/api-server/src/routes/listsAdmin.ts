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
  trustedAdultInterventionsTable,
  staffTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

async function loadStaff(req: Request, res: Response) {
  const staffId = req.staffId;
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
  (s) => s.isAdmin || s.isPbisCoordinator || s.isBehaviorSpecialist,
  "Admin, PBIS coordinator, or behavior specialist",
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
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const rows = await db
    .select()
    .from(pbisReasonsTable)
    .where(eq(pbisReasonsTable.schoolId, schoolId))
    .orderBy(
      pbisReasonsTable.category,
      pbisReasonsTable.sortOrder,
      pbisReasonsTable.name,
    );
  res.json(rows);
});

function normalizePolarity(v: unknown): "positive" | "negative" | null {
  if (v === undefined) return "positive"; // default for new rows
  if (v === "positive" || v === "negative") return v;
  return null;
}

router.post("/pbis-reasons", requirePbisAdmin, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const { name, category, defaultPoints, polarity, sortOrder } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const cat =
    typeof category === "string" && category.trim() ? category.trim() : "General";
  let pts = 1;
  if (defaultPoints !== undefined && defaultPoints !== null) {
    const n = Number(defaultPoints);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      res
        .status(400)
        .json({ error: "defaultPoints must be a positive integer" });
      return;
    }
    pts = n;
  }
  const pol = normalizePolarity(polarity);
  if (!pol) {
    res.status(400).json({ error: "polarity must be 'positive' or 'negative'" });
    return;
  }
  // Duplicate-name check is per-school only.
  const existing = await db
    .select()
    .from(pbisReasonsTable)
    .where(
      and(
        eq(pbisReasonsTable.schoolId, schoolId),
        sql`lower(${pbisReasonsTable.name}) = lower(${name.trim()})`,
      ),
    );
  if (existing.length > 0) {
    res.status(409).json({ error: "Behavior name already exists" });
    return;
  }
  // Default sort_order = max(existing in same category) + 1, so new tiles
  // land at the end of their category instead of jumping to position 0.
  let order = 0;
  if (typeof sortOrder === "number" && Number.isInteger(sortOrder)) {
    order = sortOrder;
  } else {
    const [{ maxOrder }] = await db
      .select({ maxOrder: sql<number>`coalesce(max(${pbisReasonsTable.sortOrder}), -1)` })
      .from(pbisReasonsTable)
      .where(
        and(
          eq(pbisReasonsTable.schoolId, schoolId),
          eq(pbisReasonsTable.category, cat),
        ),
      );
    order = (maxOrder ?? -1) + 1;
  }
  const [row] = await db
    .insert(pbisReasonsTable)
    .values({
      schoolId,
      name: name.trim(),
      category: cat,
      defaultPoints: pts,
      polarity: pol,
      sortOrder: order,
      active: true,
    })
    .returning();
  res.status(201).json(row);
});

router.patch("/pbis-reasons/:id", requirePbisAdmin, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const { name, category, defaultPoints, active, polarity, sortOrder } =
    req.body ?? {};
  const updates: Partial<typeof pbisReasonsTable.$inferInsert> = {};
  if (typeof name === "string" && name.trim()) updates.name = name.trim();
  if (typeof category === "string" && category.trim())
    updates.category = category.trim();
  if (defaultPoints !== undefined && defaultPoints !== null) {
    const n = Number(defaultPoints);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      res
        .status(400)
        .json({ error: "defaultPoints must be a positive integer" });
      return;
    }
    updates.defaultPoints = n;
  }
  if (typeof active === "boolean") updates.active = active;
  if (polarity !== undefined) {
    if (polarity !== "positive" && polarity !== "negative") {
      res
        .status(400)
        .json({ error: "polarity must be 'positive' or 'negative'" });
      return;
    }
    updates.polarity = polarity;
  }
  if (sortOrder !== undefined) {
    if (typeof sortOrder !== "number" || !Number.isInteger(sortOrder)) {
      res.status(400).json({ error: "sortOrder must be an integer" });
      return;
    }
    updates.sortOrder = sortOrder;
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No updates" });
    return;
  }
  const [row] = await db
    .update(pbisReasonsTable)
    .set(updates)
    .where(
      and(
        eq(pbisReasonsTable.id, id),
        eq(pbisReasonsTable.schoolId, schoolId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(row);
});

// Batch reorder. Body: { items: [{id, sortOrder, category?}] }. All ids must
// belong to the caller's school — any cross-school id is rejected before any
// write happens.
router.post("/pbis-reasons/reorder", requirePbisAdmin, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const items = req.body?.items;
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: "items array required" });
    return;
  }
  for (const it of items) {
    if (
      !it ||
      typeof it.id !== "number" ||
      !Number.isInteger(it.id) ||
      typeof it.sortOrder !== "number" ||
      !Number.isInteger(it.sortOrder)
    ) {
      res
        .status(400)
        .json({ error: "each item needs integer id and sortOrder" });
      return;
    }
    if (it.category !== undefined && typeof it.category !== "string") {
      res.status(400).json({ error: "category must be a string" });
      return;
    }
  }
  const ids = items.map((i: { id: number }) => i.id);
  const owned = await db
    .select({ id: pbisReasonsTable.id })
    .from(pbisReasonsTable)
    .where(
      and(
        eq(pbisReasonsTable.schoolId, schoolId),
        sql`${pbisReasonsTable.id} = ANY(${ids})`,
      ),
    );
  if (owned.length !== ids.length) {
    res.status(403).json({ error: "Some behaviors are not in your school" });
    return;
  }
  // Wrap in a transaction so a partial failure can't leave the rubric in a
  // half-reordered state across two concurrent drag operations.
  await db.transaction(async (tx) => {
    for (const it of items) {
      const upd: Partial<typeof pbisReasonsTable.$inferInsert> = {
        sortOrder: it.sortOrder,
      };
      if (typeof it.category === "string" && it.category.trim()) {
        upd.category = it.category.trim();
      }
      await tx
        .update(pbisReasonsTable)
        .set(upd)
        .where(
          and(
            eq(pbisReasonsTable.id, it.id),
            eq(pbisReasonsTable.schoolId, schoolId),
          ),
        );
    }
  });
  res.json({ ok: true, count: items.length });
});

// ---- Intervention Types ----
// Per-school: every endpoint AND-filters by req.schoolId so school A cannot
// list, edit, or delete school B's intervention types — and uniqueness is
// per-school so each school can own its own "Verbal Redirect" entry.

router.get("/intervention-types", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const rows = await db
    .select()
    .from(interventionTypesTable)
    .where(eq(interventionTypesTable.schoolId, schoolId))
    .orderBy(interventionTypesTable.category, interventionTypesTable.name);
  res.json(rows);
});

router.post("/intervention-types", requireInterventionAdmin, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
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
    .where(
      and(
        eq(interventionTypesTable.schoolId, schoolId),
        sql`lower(${interventionTypesTable.name}) = lower(${name.trim()})`,
      ),
    );
  if (existing.length > 0) {
    res.status(409).json({ error: "Intervention name already exists" });
    return;
  }
  const [row] = await db
    .insert(interventionTypesTable)
    .values({
      schoolId,
      name: name.trim(),
      category: cat,
      requiresNote: reqNote,
      active: true,
    })
    .returning();
  res.status(201).json(row);
});

router.delete("/intervention-types/:id", requireInterventionAdmin, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [row] = await db
    .delete(interventionTypesTable)
    .where(
      and(
        eq(interventionTypesTable.id, id),
        eq(interventionTypesTable.schoolId, schoolId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ ok: true, id: row.id });
});

router.patch("/intervention-types/:id", requireInterventionAdmin, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
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
    .where(
      and(
        eq(interventionTypesTable.id, id),
        eq(interventionTypesTable.schoolId, schoolId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(row);
});

// ---- Trusted Adult Interventions ----
// Per-school, same isolation rules as Intervention Types.

router.get("/trusted-adult-interventions", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const rows = await db
    .select()
    .from(trustedAdultInterventionsTable)
    .where(eq(trustedAdultInterventionsTable.schoolId, schoolId))
    .orderBy(trustedAdultInterventionsTable.category, trustedAdultInterventionsTable.name);
  res.json(rows);
});

router.post("/trusted-adult-interventions", requireInterventionAdmin, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const { name, category } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const cat =
    typeof category === "string" && category.trim()
      ? category.trim()
      : "Trusted Adult";
  const existing = await db
    .select()
    .from(trustedAdultInterventionsTable)
    .where(
      and(
        eq(trustedAdultInterventionsTable.schoolId, schoolId),
        sql`lower(${trustedAdultInterventionsTable.name}) = lower(${name.trim()})`,
      ),
    );
  if (existing.length > 0) {
    res.status(409).json({ error: "Intervention name already exists" });
    return;
  }
  const [row] = await db
    .insert(trustedAdultInterventionsTable)
    .values({ schoolId, name: name.trim(), category: cat, active: true })
    .returning();
  res.status(201).json(row);
});

router.patch("/trusted-adult-interventions/:id", requireInterventionAdmin, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const { name, category, active } = req.body ?? {};
  const updates: Partial<typeof trustedAdultInterventionsTable.$inferInsert> = {};
  if (typeof name === "string" && name.trim()) updates.name = name.trim();
  if (typeof category === "string" && category.trim())
    updates.category = category.trim();
  if (typeof active === "boolean") updates.active = active;
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No updates" });
    return;
  }
  const [row] = await db
    .update(trustedAdultInterventionsTable)
    .set(updates)
    .where(
      and(
        eq(trustedAdultInterventionsTable.id, id),
        eq(trustedAdultInterventionsTable.schoolId, schoolId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(row);
});

router.delete("/trusted-adult-interventions/:id", requireInterventionAdmin, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [row] = await db
    .delete(trustedAdultInterventionsTable)
    .where(
      and(
        eq(trustedAdultInterventionsTable.id, id),
        eq(trustedAdultInterventionsTable.schoolId, schoolId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ ok: true, id: row.id });
});

export default router;
