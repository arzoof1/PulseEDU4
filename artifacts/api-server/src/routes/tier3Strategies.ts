// Tier 3 strategy catalog (categories + items). Read open to any signed-
// in staff (so the Tier 3 weekly form can render the checklist for
// teachers); writes are Core Team only.
//
// Routes:
//   GET    /api/tier3-strategy-categories
//   POST   /api/tier3-strategy-categories
//   PATCH  /api/tier3-strategy-categories/:id
//   DELETE /api/tier3-strategy-categories/:id   (soft-delete via active)
//   GET    /api/tier3-strategies
//   POST   /api/tier3-strategies
//   PATCH  /api/tier3-strategies/:id
//   DELETE /api/tier3-strategies/:id
//
// On first read of either list for a school, we lazily seed the three
// default categories (Preventative / Replacement / Reinforce) so a brand-
// new school sees a sensible starter list before Core Team customizes it.
import { Router, type IRouter } from "express";
import {
  db,
  staffTable,
  tier3StrategyCategoriesTable,
  tier3StrategiesTable,
} from "@workspace/db";
import { and, eq, asc } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam } from "../lib/coreTeam.js";

const router: IRouter = Router();

const DEFAULT_CATEGORIES: Array<{ name: string; sortOrder: number }> = [
  { name: "Preventative Procedures", sortOrder: 0 },
  { name: "Replacement Behavior Procedures", sortOrder: 1 },
  { name: "Procedures to Reinforce Replacement Behavior", sortOrder: 2 },
];

async function loadStaff(
  req: import("express").Request,
  res: import("express").Response,
) {
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

async function ensureDefaultCategories(schoolId: number): Promise<void> {
  const existing = await db
    .select({ id: tier3StrategyCategoriesTable.id })
    .from(tier3StrategyCategoriesTable)
    .where(eq(tier3StrategyCategoriesTable.schoolId, schoolId))
    .limit(1);
  if (existing.length > 0) return;
  await db.insert(tier3StrategyCategoriesTable).values(
    DEFAULT_CATEGORIES.map((c) => ({
      schoolId,
      name: c.name,
      sortOrder: c.sortOrder,
    })),
  );
}

function clampName(v: unknown, max = 200): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

// =============================== CATEGORIES ===============================
router.get("/tier3-strategy-categories", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  await ensureDefaultCategories(schoolId);
  const rows = await db
    .select()
    .from(tier3StrategyCategoriesTable)
    .where(eq(tier3StrategyCategoriesTable.schoolId, schoolId))
    .orderBy(
      asc(tier3StrategyCategoriesTable.sortOrder),
      asc(tier3StrategyCategoriesTable.id),
    );
  res.json(rows);
});

router.post("/tier3-strategy-categories", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  if (!isCoreTeam(staff)) {
    res.status(403).json({ error: "Core Team only" });
    return;
  }
  const name = clampName(req.body?.name);
  const sortOrder = Number.isInteger(Number(req.body?.sortOrder))
    ? Number(req.body.sortOrder)
    : 0;
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  try {
    const [row] = await db
      .insert(tier3StrategyCategoriesTable)
      .values({ schoolId, name, sortOrder })
      .returning();
    res.status(201).json(row);
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "23505"
    ) {
      res.status(409).json({ error: "Category name already exists" });
      return;
    }
    throw err;
  }
});

router.patch("/tier3-strategy-categories/:id", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  if (!isCoreTeam(staff)) {
    res.status(403).json({ error: "Core Team only" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }
  const patch: Record<string, unknown> = {};
  if (typeof req.body?.name === "string") {
    const n = clampName(req.body.name);
    if (!n) {
      res.status(400).json({ error: "name cannot be empty" });
      return;
    }
    patch.name = n;
  }
  if (req.body?.sortOrder !== undefined) {
    const n = Number(req.body.sortOrder);
    if (!Number.isInteger(n)) {
      res.status(400).json({ error: "sortOrder must be an integer" });
      return;
    }
    patch.sortOrder = n;
  }
  if (req.body?.active !== undefined) {
    patch.active = Boolean(req.body.active);
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "No editable fields supplied" });
    return;
  }
  const [row] = await db
    .update(tier3StrategyCategoriesTable)
    .set(patch)
    .where(
      and(
        eq(tier3StrategyCategoriesTable.id, id),
        eq(tier3StrategyCategoriesTable.schoolId, schoolId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Category not found" });
    return;
  }
  res.json(row);
});

router.delete("/tier3-strategy-categories/:id", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  if (!isCoreTeam(staff)) {
    res.status(403).json({ error: "Core Team only" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }
  // Soft-delete: flip active=false on the category and all its strategies.
  await db
    .update(tier3StrategyCategoriesTable)
    .set({ active: false })
    .where(
      and(
        eq(tier3StrategyCategoriesTable.id, id),
        eq(tier3StrategyCategoriesTable.schoolId, schoolId),
      ),
    );
  await db
    .update(tier3StrategiesTable)
    .set({ active: false })
    .where(
      and(
        eq(tier3StrategiesTable.categoryId, id),
        eq(tier3StrategiesTable.schoolId, schoolId),
      ),
    );
  res.json({ ok: true });
});

// =============================== STRATEGIES ===============================
router.get("/tier3-strategies", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const rows = await db
    .select()
    .from(tier3StrategiesTable)
    .where(eq(tier3StrategiesTable.schoolId, schoolId))
    .orderBy(
      asc(tier3StrategiesTable.categoryId),
      asc(tier3StrategiesTable.sortOrder),
      asc(tier3StrategiesTable.id),
    );
  res.json(rows);
});

router.post("/tier3-strategies", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  if (!isCoreTeam(staff)) {
    res.status(403).json({ error: "Core Team only" });
    return;
  }
  const categoryId = Number(req.body?.categoryId);
  const name = clampName(req.body?.name);
  const sortOrder = Number.isInteger(Number(req.body?.sortOrder))
    ? Number(req.body.sortOrder)
    : 0;
  if (!Number.isInteger(categoryId) || categoryId < 1) {
    res.status(400).json({ error: "categoryId is required" });
    return;
  }
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  // Category must belong to this school.
  const [cat] = await db
    .select({ id: tier3StrategyCategoriesTable.id })
    .from(tier3StrategyCategoriesTable)
    .where(
      and(
        eq(tier3StrategyCategoriesTable.id, categoryId),
        eq(tier3StrategyCategoriesTable.schoolId, schoolId),
      ),
    );
  if (!cat) {
    res.status(404).json({ error: "Category not found" });
    return;
  }
  try {
    const [row] = await db
      .insert(tier3StrategiesTable)
      .values({ schoolId, categoryId, name, sortOrder })
      .returning();
    res.status(201).json(row);
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "23505"
    ) {
      res.status(409).json({ error: "Strategy name already exists in category" });
      return;
    }
    throw err;
  }
});

router.patch("/tier3-strategies/:id", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  if (!isCoreTeam(staff)) {
    res.status(403).json({ error: "Core Team only" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }
  const patch: Record<string, unknown> = {};
  if (typeof req.body?.name === "string") {
    const n = clampName(req.body.name);
    if (!n) {
      res.status(400).json({ error: "name cannot be empty" });
      return;
    }
    patch.name = n;
  }
  if (req.body?.sortOrder !== undefined) {
    const n = Number(req.body.sortOrder);
    if (!Number.isInteger(n)) {
      res.status(400).json({ error: "sortOrder must be an integer" });
      return;
    }
    patch.sortOrder = n;
  }
  if (req.body?.categoryId !== undefined) {
    const cid = Number(req.body.categoryId);
    if (!Number.isInteger(cid) || cid < 1) {
      res.status(400).json({ error: "categoryId must be positive int" });
      return;
    }
    const [cat] = await db
      .select({ id: tier3StrategyCategoriesTable.id })
      .from(tier3StrategyCategoriesTable)
      .where(
        and(
          eq(tier3StrategyCategoriesTable.id, cid),
          eq(tier3StrategyCategoriesTable.schoolId, schoolId),
        ),
      );
    if (!cat) {
      res.status(404).json({ error: "Category not found" });
      return;
    }
    patch.categoryId = cid;
  }
  if (req.body?.active !== undefined) {
    patch.active = Boolean(req.body.active);
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "No editable fields supplied" });
    return;
  }
  const [row] = await db
    .update(tier3StrategiesTable)
    .set(patch)
    .where(
      and(
        eq(tier3StrategiesTable.id, id),
        eq(tier3StrategiesTable.schoolId, schoolId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Strategy not found" });
    return;
  }
  res.json(row);
});

router.delete("/tier3-strategies/:id", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  if (!isCoreTeam(staff)) {
    res.status(403).json({ error: "Core Team only" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }
  await db
    .update(tier3StrategiesTable)
    .set({ active: false })
    .where(
      and(
        eq(tier3StrategiesTable.id, id),
        eq(tier3StrategiesTable.schoolId, schoolId),
      ),
    );
  res.json({ ok: true });
});

export default router;
