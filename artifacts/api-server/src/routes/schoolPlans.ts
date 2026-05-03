import { Router, type IRouter } from "express";
import {
  db,
  schoolSettingsTable,
  schoolsTable,
  staffTable,
  tierPresetsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { FEATURE_KEYS, type FeatureKey } from "./schoolSettings.js";

const router: IRouter = Router();

// Helper: caller must be a SuperUser. Returns true if allowed, otherwise
// writes a 401/403 response and returns false.
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

function adminCol(k: FeatureKey): keyof typeof schoolSettingsTable.$inferSelect {
  return (`feature${k}` as unknown) as keyof typeof schoolSettingsTable.$inferSelect;
}
function superCol(k: FeatureKey): keyof typeof schoolSettingsTable.$inferSelect {
  return (`superFeature${k}` as unknown) as keyof typeof schoolSettingsTable.$inferSelect;
}

// Lazy-create the settings row for a school. Mirrors the helper inside
// schoolSettings.ts so the school-plans grid never returns "no row" for
// a brand-new school.
async function getOrCreateSettings(schoolId: number) {
  const [row] = await db
    .select()
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  if (row) return row;
  try {
    const [created] = await db
      .insert(schoolSettingsTable)
      .values({ schoolId })
      .returning();
    return created;
  } catch {
    const [r2] = await db
      .select()
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId));
    return r2;
  }
}

// GET /superuser/school-plans
// Returns every school × every flag in one payload. Used by the
// SchoolPlansAdminPage grid.
router.get("/superuser/school-plans", async (req, res) => {
  if (!(await requireSuperUser(req, res))) return;

  const schools = await db
    .select({ id: schoolsTable.id, name: schoolsTable.name })
    .from(schoolsTable)
    .orderBy(schoolsTable.name);

  const settings = await db.select().from(schoolSettingsTable);
  const settingsBySchool = new Map(settings.map((s) => [s.schoolId, s]));

  // Lazy-create rows for any schools that don't have one yet so the
  // PATCH endpoint always finds a row to update.
  const out: Array<{
    schoolId: number;
    schoolName: string;
    tierPresetId: number | null;
    superFlags: Record<FeatureKey, boolean>;
    adminFlags: Record<FeatureKey, boolean>;
  }> = [];

  for (const school of schools) {
    let row = settingsBySchool.get(school.id);
    if (!row) row = await getOrCreateSettings(school.id);
    if (!row) continue;
    const superFlags = {} as Record<FeatureKey, boolean>;
    const adminFlags = {} as Record<FeatureKey, boolean>;
    for (const k of FEATURE_KEYS) {
      superFlags[k] = Boolean(row[superCol(k)]);
      adminFlags[k] = Boolean(row[adminCol(k)]);
    }
    out.push({
      schoolId: school.id,
      schoolName: school.name,
      tierPresetId: row.tierPresetId ?? null,
      superFlags,
      adminFlags,
    });
  }

  res.json({ schools: out, featureKeys: FEATURE_KEYS });
});

// PATCH /superuser/school-plans/:schoolId
// Body: { superFlags?: Partial<Record<FeatureKey, boolean>> }
// Updates one or more `super_feature_*` columns on a single school.
router.patch("/superuser/school-plans/:schoolId", async (req, res) => {
  if (!(await requireSuperUser(req, res))) return;

  const schoolId = Number(req.params.schoolId);
  if (!Number.isFinite(schoolId)) {
    res.status(400).json({ error: "schoolId must be a number" });
    return;
  }
  const incoming = (req.body?.superFlags ?? {}) as Record<string, unknown>;

  const updates: Partial<typeof schoolSettingsTable.$inferInsert> = {};
  for (const k of FEATURE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(incoming, k)) {
      const v = incoming[k];
      if (typeof v !== "boolean") {
        res
          .status(400)
          .json({ error: `superFlags.${k} must be a boolean` });
        return;
      }
      (updates as Record<string, unknown>)[superCol(k) as string] = v;
    }
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No flag updates supplied" });
    return;
  }

  const current = await getOrCreateSettings(schoolId);
  if (!current) {
    res.status(404).json({ error: "School not found" });
    return;
  }

  // Flipping a super flag to false invalidates the preset pointer (the
  // school no longer matches any preset exactly). We just clear it; the
  // grid will re-suggest a preset based on which is the closest match.
  (updates as Record<string, unknown>).tierPresetId = null;

  const [updated] = await db
    .update(schoolSettingsTable)
    .set(updates)
    .where(
      and(
        eq(schoolSettingsTable.id, current.id),
        eq(schoolSettingsTable.schoolId, schoolId),
      ),
    )
    .returning();

  const superFlags = {} as Record<FeatureKey, boolean>;
  for (const k of FEATURE_KEYS) superFlags[k] = Boolean(updated[superCol(k)]);
  res.json({ schoolId, superFlags, tierPresetId: updated.tierPresetId ?? null });
});

// POST /superuser/school-plans/:schoolId/apply-preset
// Body: { presetId: number }
// Bulk-sets every super_feature_* on the school: ON for keys listed in
// preset.featureKeys, OFF for everything else. Records the preset id
// on the row for the "Currently: Pro" badge in the grid.
router.post("/superuser/school-plans/:schoolId/apply-preset", async (req, res) => {
  if (!(await requireSuperUser(req, res))) return;

  const schoolId = Number(req.params.schoolId);
  if (!Number.isFinite(schoolId)) {
    res.status(400).json({ error: "schoolId must be a number" });
    return;
  }
  const presetId = Number(req.body?.presetId);
  if (!Number.isFinite(presetId)) {
    res.status(400).json({ error: "presetId must be a number" });
    return;
  }

  const [preset] = await db
    .select()
    .from(tierPresetsTable)
    .where(eq(tierPresetsTable.id, presetId));
  if (!preset) {
    res.status(404).json({ error: "Preset not found" });
    return;
  }
  const onSet = new Set(preset.featureKeys ?? []);

  const current = await getOrCreateSettings(schoolId);
  if (!current) {
    res.status(404).json({ error: "School not found" });
    return;
  }

  const updates: Partial<typeof schoolSettingsTable.$inferInsert> = {
    tierPresetId: preset.id,
  };
  for (const k of FEATURE_KEYS) {
    (updates as Record<string, unknown>)[superCol(k) as string] = onSet.has(k);
  }

  const [updated] = await db
    .update(schoolSettingsTable)
    .set(updates)
    .where(
      and(
        eq(schoolSettingsTable.id, current.id),
        eq(schoolSettingsTable.schoolId, schoolId),
      ),
    )
    .returning();

  const superFlags = {} as Record<FeatureKey, boolean>;
  for (const k of FEATURE_KEYS) superFlags[k] = Boolean(updated[superCol(k)]);
  res.json({ schoolId, superFlags, tierPresetId: updated.tierPresetId ?? null });
});

export default router;
