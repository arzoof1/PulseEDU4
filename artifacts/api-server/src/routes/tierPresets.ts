import { Router, type IRouter } from "express";
import { db, tierPresetsTable, staffTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { FEATURE_KEYS, type FeatureKey } from "./schoolSettings.js";

const router: IRouter = Router();

async function requireSuperUser(
  req: import("express").Request,
  res: import("express").Response,
): Promise<boolean> {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Not authenticated" });
    return false;
  }
  const [s] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!s || !s.active || !s.isSuperUser) {
    res.status(403).json({ error: "SuperUser required" });
    return false;
  }
  return true;
}

// Validate a featureKeys[] payload — every entry must be a known
// FEATURE_KEYS member.
function sanitizeFeatureKeys(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const valid = new Set<string>(FEATURE_KEYS);
  const out: string[] = [];
  for (const x of input) {
    if (typeof x !== "string" || !valid.has(x)) return null;
    if (!out.includes(x)) out.push(x);
  }
  return out;
}

router.get("/superuser/tier-presets", async (req, res) => {
  if (!(await requireSuperUser(req, res))) return;
  const rows = await db
    .select()
    .from(tierPresetsTable)
    .orderBy(tierPresetsTable.id);
  res.json({ presets: rows, featureKeys: FEATURE_KEYS });
});

router.post("/superuser/tier-presets", async (req, res) => {
  if (!(await requireSuperUser(req, res))) return;
  const name =
    typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const description =
    typeof req.body?.description === "string" ? req.body.description : "";
  const featureKeys = sanitizeFeatureKeys(req.body?.featureKeys);
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (!featureKeys) {
    res.status(400).json({
      error: "featureKeys must be an array of valid FeatureKey strings",
    });
    return;
  }
  try {
    const [created] = await db
      .insert(tierPresetsTable)
      .values({ name, description, isBuiltIn: false, featureKeys })
      .returning();
    res.json(created);
  } catch (e) {
    res.status(400).json({ error: "Preset name must be unique" });
  }
});

router.patch("/superuser/tier-presets/:id", async (req, res) => {
  if (!(await requireSuperUser(req, res))) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "id must be a number" });
    return;
  }
  const [existing] = await db
    .select()
    .from(tierPresetsTable)
    .where(eq(tierPresetsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Preset not found" });
    return;
  }
  if (existing.isBuiltIn && (req.body?.name || req.body?.description)) {
    // Built-in presets allow editing the feature_keys array (so a
    // SuperUser can rebalance "Pro") but not the name/description.
  }
  const updates: Partial<typeof tierPresetsTable.$inferInsert> = {};
  if (typeof req.body?.name === "string" && !existing.isBuiltIn) {
    const n = req.body.name.trim();
    if (n) updates.name = n;
  }
  if (typeof req.body?.description === "string" && !existing.isBuiltIn) {
    updates.description = req.body.description;
  }
  if (req.body?.featureKeys !== undefined) {
    const keys = sanitizeFeatureKeys(req.body.featureKeys);
    if (!keys) {
      res
        .status(400)
        .json({ error: "featureKeys must be an array of valid FeatureKey strings" });
      return;
    }
    updates.featureKeys = keys;
  }
  if (Object.keys(updates).length === 0) {
    res.json(existing);
    return;
  }
  const [updated] = await db
    .update(tierPresetsTable)
    .set(updates)
    .where(eq(tierPresetsTable.id, id))
    .returning();
  res.json(updated);
});

router.delete("/superuser/tier-presets/:id", async (req, res) => {
  if (!(await requireSuperUser(req, res))) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "id must be a number" });
    return;
  }
  const [existing] = await db
    .select()
    .from(tierPresetsTable)
    .where(eq(tierPresetsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Preset not found" });
    return;
  }
  if (existing.isBuiltIn) {
    res.status(400).json({ error: "Built-in presets cannot be deleted" });
    return;
  }
  await db.delete(tierPresetsTable).where(eq(tierPresetsTable.id, id));
  res.json({ ok: true });
});

export default router;
