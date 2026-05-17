// Feature licensing — SuperUser admin API + per-user `/me/features` read.
//
// Plans CRUD, school-plan assignment, and per-school overrides all live
// here. Every write path re-applies the resulting licensing state to the
// affected school(s) so the runtime gate (super_feature_* booleans on
// school_settings) stays in sync.

import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  staffTable,
  plansTable,
  schoolFeatureOverridesTable,
  schoolsTable,
} from "@workspace/db";
import {
  FEATURE_KEYS,
  isKnownFeatureKey,
  loadEffectiveFeatures,
  applyPlanToSchool,
  applyOverridesToSchool,
  reapplyLicensingToSchool,
  lockSchoolForLicensing,
  countSchoolsOnPlan,
  listSchoolsWithLicensing,
  listFeatureLicensingAudit,
  listSchoolsNearQuota,
} from "../lib/featureLicensing.js";
import { getDistrictIdForSchool } from "../lib/scope.js";

// Cross-district guard for per-school licensing mutations. SuperUser is
// district-scoped by default; the env gate ALLOW_CROSS_DISTRICT_SUPERUSER=1
// (same gate the tenancy admin routes use) unlocks reach to other
// districts for the demo/control tier. Without this guard a SuperUser in
// District A could mutate plan/overrides on any school in District B by
// supplying its id — matching scope to the rest of tenancy.ts closes that
// gap and keeps the multi-tenant boundary consistent.
async function assertSchoolInCallerDistrict(
  callerSchoolId: number,
  targetSchoolId: number,
  res: Response,
): Promise<boolean> {
  if (process.env.ALLOW_CROSS_DISTRICT_SUPERUSER === "1") return true;
  const callerDistrictId = await getDistrictIdForSchool(callerSchoolId);
  const targetDistrictId = await getDistrictIdForSchool(targetSchoolId);
  if (callerDistrictId === null || callerDistrictId !== targetDistrictId) {
    res.status(403).json({
      error: "Cannot manage licensing on a school in another district",
    });
    return false;
  }
  return true;
}

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

// SuperUser is the only role that manages licensing. Admins can read the
// catalog (feature-keys + plans list) so the school-settings UI can show
// "your plan: X" badges in a later phase, but writes are SuperUser-only.
function isSuperUser(s: StaffRow): boolean {
  return Boolean(s.isSuperUser);
}

async function requireSuperUser(
  req: Request,
  res: Response,
): Promise<StaffRow | null> {
  const s = await loadStaff(req);
  if (!s) {
    res.status(401).json({ error: "unauthorized" });
    return null;
  }
  if (!isSuperUser(s)) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return s;
}

// Global plan rows (plansTable) are shared across every district. A
// district-scoped SuperUser editing one of them mutates metadata that
// other districts' schools depend on — even though the per-school
// reapply fan-out is already district-scoped, the plan row itself
// (label / description / features / quotas) is global. Gate global
// plan CRUD behind the same ALLOW_CROSS_DISTRICT_SUPERUSER env flag
// that tenancy.ts and the per-school overrides routes already use, so
// only a SuperUser operating at the cross-district control tier can
// create / edit / delete plans. When a real `isCrossDistrictSuperUser`
// staff flag lands (see Open work in replit.md), swap the env check
// here for that flag — the call sites won't need to change.
async function requireCrossDistrictSuperUser(
  req: Request,
  res: Response,
): Promise<StaffRow | null> {
  const s = await requireSuperUser(req, res);
  if (!s) return null;
  if (process.env.ALLOW_CROSS_DISTRICT_SUPERUSER !== "1") {
    res.status(403).json({
      error:
        "Global plan CRUD requires a cross-district SuperUser. Use per-school overrides instead.",
    });
    return null;
  }
  return s;
}

// ----------------------------------------------------------------------------
// Registry — every signed-in staff can read it (informational only)
// ----------------------------------------------------------------------------
router.get("/feature-licensing/feature-keys", async (req, res, next) => {
  try {
    const s = await loadStaff(req);
    if (!s) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.json({ features: FEATURE_KEYS });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------------------
// /api/me/features — effective feature map for the caller's school.
// Any signed-in staff (used by the client FeaturesProvider on boot).
// ----------------------------------------------------------------------------
router.get("/me/features", async (req, res, next) => {
  try {
    const s = await loadStaff(req);
    if (!s) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const schoolId = req.schoolId;
    if (!schoolId) {
      // No school context (e.g. SuperUser pre-switch). Return an empty
      // map — every gate falls closed, the client treats it as "loading
      // / no licensing yet" and renders nothing licensed-gated.
      res.json({ features: {} });
      return;
    }
    const map = await loadEffectiveFeatures(req, schoolId);
    res.json({ features: map });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------------------
// Plans CRUD
// ----------------------------------------------------------------------------
router.get("/feature-licensing/plans", async (req, res, next) => {
  try {
    // Read-only list visible to any admin (so a future School Settings
    // banner can show "Your plan: Pro" without a SuperUser gate).
    const s = await loadStaff(req);
    if (!s) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!(s.isAdmin || s.isDistrictAdmin || s.isSuperUser)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const plans = await db.select().from(plansTable);
    // Surface the global-plan-CRUD capability so the admin UI can hide
    // Add/Edit/Delete buttons that would otherwise 403 for a
    // district-scoped SuperUser (see requireCrossDistrictSuperUser).
    const canManageGlobalPlans =
      Boolean(s.isSuperUser) &&
      process.env.ALLOW_CROSS_DISTRICT_SUPERUSER === "1";
    res.json({ plans, canManageGlobalPlans });
  } catch (err) {
    next(err);
  }
});

router.post("/feature-licensing/plans", async (req, res, next) => {
  try {
    if (!(await requireCrossDistrictSuperUser(req, res))) return;
    const { key, label, description, features, quotas } = req.body ?? {};
    if (typeof key !== "string" || !/^[a-z0-9_]+$/i.test(key)) {
      res.status(400).json({ error: "invalid_key" });
      return;
    }
    if (typeof label !== "string" || !label.trim()) {
      res.status(400).json({ error: "invalid_label" });
      return;
    }
    const cleanedFeatures = sanitizeFeatures(features);
    const cleanedQuotas = sanitizeQuotas(quotas);
    const [created] = await db
      .insert(plansTable)
      .values({
        key: key.trim(),
        label: label.trim(),
        description: typeof description === "string" ? description : null,
        features: cleanedFeatures,
        quotas: cleanedQuotas,
      })
      .returning();
    res.json({ plan: created });
  } catch (err) {
    next(err);
  }
});

router.patch("/feature-licensing/plans/:id", async (req, res, next) => {
  try {
    const actor = await requireCrossDistrictSuperUser(req, res);
    if (!actor) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const { label, description, features, quotas } = req.body ?? {};
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof label === "string" && label.trim()) patch.label = label.trim();
    if (typeof description === "string" || description === null) {
      patch.description = description;
    }
    if (features !== undefined) patch.features = sanitizeFeatures(features);
    if (quotas !== undefined) patch.quotas = sanitizeQuotas(quotas);
    const [updated] = await db
      .update(plansTable)
      .set(patch)
      .where(eq(plansTable.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // Re-apply to every school on this plan so flag changes propagate
    // without the SuperUser having to touch each school manually.
    // Wrap the entire fan-out in one tx so a mid-loop failure can't
    // leave half the schools on old flags and half on new — plan edits
    // are rare enough that the wider lock window is acceptable.
    //
    // Cross-district scoping: by default a district-scoped SuperUser
    // can only propagate plan edits into their OWN district's schools,
    // even though plans themselves are global rows. Without this filter
    // a SuperUser in District A who edits a plan that District B also
    // uses would silently rewrite B's super_feature_* booleans. The
    // ALLOW_CROSS_DISTRICT_SUPERUSER=1 env gate (same one tenancy.ts
    // uses) restores the platform-wide reach for the demo/control tier.
    const crossDistrict =
      process.env.ALLOW_CROSS_DISTRICT_SUPERUSER === "1";
    const callerDistrictId = crossDistrict
      ? null
      : await getDistrictIdForSchool(actor.schoolId);
    const allSchoolsOnPlan = await db
      .select({ id: schoolsTable.id, districtId: schoolsTable.districtId })
      .from(schoolsTable)
      .where(eq(schoolsTable.planId, id));
    const schoolsOnPlan = crossDistrict
      ? allSchoolsOnPlan
      : allSchoolsOnPlan.filter((s) => s.districtId === callerDistrictId);
    const skippedCrossDistrictCount =
      allSchoolsOnPlan.length - schoolsOnPlan.length;
    await db.transaction(async (tx) => {
      for (const s of schoolsOnPlan) {
        await reapplyLicensingToSchool(s.id, tx);
      }
    });
    res.json({
      plan: updated,
      reappliedSchoolCount: schoolsOnPlan.length,
      skippedCrossDistrictCount,
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/feature-licensing/plans/:id", async (req, res, next) => {
  try {
    if (!(await requireCrossDistrictSuperUser(req, res))) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const refs = await countSchoolsOnPlan(id);
    if (refs > 0) {
      res
        .status(409)
        .json({ error: "plan_in_use", schoolCount: refs });
      return;
    }
    await db.delete(plansTable).where(eq(plansTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------------------
// Schools — listing + plan assignment + overrides
// ----------------------------------------------------------------------------
router.get("/feature-licensing/schools", async (req, res, next) => {
  try {
    if (!(await requireSuperUser(req, res))) return;
    const schools = await listSchoolsWithLicensing();
    res.json({ schools });
  } catch (err) {
    next(err);
  }
});

router.patch(
  "/feature-licensing/schools/:id/plan",
  async (req, res, next) => {
    try {
      const actor = await requireSuperUser(req, res);
      if (!actor) return;
      const schoolId = Number(req.params.id);
      if (!Number.isFinite(schoolId)) {
        res.status(400).json({ error: "invalid_id" });
        return;
      }
      if (!(await assertSchoolInCallerDistrict(actor.schoolId, schoolId, res)))
        return;
      const { planId } = req.body ?? {};
      const planIdNum =
        planId === null || planId === undefined ? null : Number(planId);
      if (planIdNum !== null && !Number.isFinite(planIdNum)) {
        res.status(400).json({ error: "invalid_plan_id" });
        return;
      }
      if (planIdNum !== null) {
        const [p] = await db
          .select({ id: plansTable.id })
          .from(plansTable)
          .where(eq(plansTable.id, planIdNum))
          .limit(1);
        if (!p) {
          res.status(404).json({ error: "plan_not_found" });
          return;
        }
      }
      // Wrap plan-pointer + super_feature_* booleans + overrides
      // overlay in ONE tx, gated behind the per-school licensing lock,
      // so concurrent override mutations can't interleave and persist
      // stale plan/flag state. Pointer write happens FIRST under the
      // lock, then reapply re-reads the (now-current) pointer and
      // applies flag + override overlay.
      await db.transaction(async (tx) => {
        const locked = await lockSchoolForLicensing(schoolId, tx);
        if (!locked) {
          throw new Error("school_not_found");
        }
        await applyPlanToSchool(schoolId, planIdNum, tx);
        await applyOverridesToSchool(schoolId, tx);
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/feature-licensing/schools/:id/overrides",
  async (req, res, next) => {
    try {
      if (!(await requireSuperUser(req, res))) return;
      const schoolId = Number(req.params.id);
      if (!Number.isFinite(schoolId)) {
        res.status(400).json({ error: "invalid_id" });
        return;
      }
      const overrides = await db
        .select()
        .from(schoolFeatureOverridesTable)
        .where(eq(schoolFeatureOverridesTable.schoolId, schoolId));
      res.json({ overrides });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/feature-licensing/schools/:id/overrides",
  async (req, res, next) => {
    try {
      const actor = await requireSuperUser(req, res);
      if (!actor) return;
      const schoolId = Number(req.params.id);
      if (!Number.isFinite(schoolId)) {
        res.status(400).json({ error: "invalid_id" });
        return;
      }
      if (!(await assertSchoolInCallerDistrict(actor.schoolId, schoolId, res)))
        return;
      const {
        featureKey,
        enabled,
        showUpsell,
        quotas,
        expiresAt,
        reason,
      } = req.body ?? {};
      if (typeof featureKey !== "string" || !isKnownFeatureKey(featureKey)) {
        res.status(400).json({ error: "invalid_feature_key" });
        return;
      }
      if (typeof enabled !== "boolean") {
        res.status(400).json({ error: "invalid_enabled" });
        return;
      }
      // Reason isn't strictly required by schema but the UX should
      // push for one; we accept null/empty here for SuperUser
      // flexibility (e.g. quick toggles during onboarding).
      const cleanedReason =
        typeof reason === "string" && reason.trim() ? reason.trim() : null;
      const cleanedExpiresAt =
        expiresAt && typeof expiresAt === "string"
          ? new Date(expiresAt)
          : null;
      const cleanedQuotas =
        quotas && typeof quotas === "object" && !Array.isArray(quotas)
          ? (quotas as Record<string, number | string[]>)
          : {};
      // Upsert + reapply in one tx — the new override row must land
      // and the super_feature_* booleans must reflect it atomically.
      const row = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(schoolFeatureOverridesTable)
          .where(
            and(
              eq(schoolFeatureOverridesTable.schoolId, schoolId),
              eq(schoolFeatureOverridesTable.featureKey, featureKey),
            ),
          )
          .limit(1);
        let saved;
        if (existing) {
          [saved] = await tx
            .update(schoolFeatureOverridesTable)
            .set({
              enabled,
              showUpsell: Boolean(showUpsell),
              quotas: cleanedQuotas,
              expiresAt: cleanedExpiresAt,
              reason: cleanedReason,
              grantedByStaffId: actor.id,
            })
            .where(eq(schoolFeatureOverridesTable.id, existing.id))
            .returning();
        } else {
          [saved] = await tx
            .insert(schoolFeatureOverridesTable)
            .values({
              schoolId,
              featureKey,
              enabled,
              showUpsell: Boolean(showUpsell),
              quotas: cleanedQuotas,
              expiresAt: cleanedExpiresAt,
              reason: cleanedReason,
              grantedByStaffId: actor.id,
            })
            .returning();
        }
        await reapplyLicensingToSchool(schoolId, tx);
        return saved;
      });
      res.json({ override: row });
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  "/feature-licensing/schools/:id/overrides/:overrideId",
  async (req, res, next) => {
    try {
      const actor = await requireSuperUser(req, res);
      if (!actor) return;
      const schoolId = Number(req.params.id);
      const overrideId = Number(req.params.overrideId);
      if (!Number.isFinite(schoolId) || !Number.isFinite(overrideId)) {
        res.status(400).json({ error: "invalid_id" });
        return;
      }
      if (!(await assertSchoolInCallerDistrict(actor.schoolId, schoolId, res)))
        return;
      // Delete + reapply atomically so the runtime booleans can't be
      // left reflecting the dead override.
      await db.transaction(async (tx) => {
        await tx
          .delete(schoolFeatureOverridesTable)
          .where(
            and(
              eq(schoolFeatureOverridesTable.id, overrideId),
              eq(schoolFeatureOverridesTable.schoolId, schoolId),
            ),
          );
        // After removing an override we need to re-apply the plan from
        // scratch so the super_feature_* boolean returns to the plan's
        // intended value rather than staying at the override's last
        // setting.
        await reapplyLicensingToSchool(schoolId, tx);
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// ----------------------------------------------------------------------------
// Audit log (Phase 3) — read-only viewer for the SuperUser surface.
// The expired-override sweep cron writes here on every run; admins
// previously had no UI to see what was swept.
// ----------------------------------------------------------------------------
router.get("/feature-licensing/audit", async (req, res, next) => {
  try {
    if (!(await requireSuperUser(req, res))) return;
    const limitRaw = req.query.limit;
    const limit =
      typeof limitRaw === "string" && /^\d+$/.test(limitRaw)
        ? Number(limitRaw)
        : 100;
    const rows = await listFeatureLicensingAudit({ limit });
    res.json({ entries: rows });
  } catch (err) {
    next(err);
  }
});

router.get(
  "/feature-licensing/schools/:id/audit",
  async (req, res, next) => {
    try {
      if (!(await requireSuperUser(req, res))) return;
      const schoolId = Number(req.params.id);
      if (!Number.isFinite(schoolId)) {
        res.status(400).json({ error: "invalid_id" });
        return;
      }
      const limitRaw = req.query.limit;
      const limit =
        typeof limitRaw === "string" && /^\d+$/.test(limitRaw)
          ? Number(limitRaw)
          : 100;
      const rows = await listFeatureLicensingAudit({ schoolId, limit });
      res.json({ entries: rows });
    } catch (err) {
      next(err);
    }
  },
);

// ----------------------------------------------------------------------------
// Quota telemetry (Phase 3) — schools-near-quota tile.
// Returns one row per (school, feature, quotaName) where usage ≥ threshold.
// Threshold defaults to 0.80; SuperUser can pass `?threshold=0.5` to dig in.
// ----------------------------------------------------------------------------
router.get(
  "/feature-licensing/quota-telemetry",
  async (req, res, next) => {
    try {
      if (!(await requireSuperUser(req, res))) return;
      const raw = req.query.threshold;
      let threshold = 0.8;
      if (typeof raw === "string" && raw.trim()) {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0 && n <= 2) threshold = n;
      }
      const rows = await listSchoolsNearQuota(threshold);
      res.json({ threshold, rows });
    } catch (err) {
      next(err);
    }
  },
);

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function sanitizeFeatures(input: unknown): Record<string, true> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, true> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!isKnownFeatureKey(k)) continue;
    if (v === true) out[k] = true;
  }
  return out;
}

function sanitizeQuotas(
  input: unknown,
): Record<string, Record<string, number | string[]>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, Record<string, number | string[]>> = {};
  for (const [featureKey, perFeature] of Object.entries(
    input as Record<string, unknown>,
  )) {
    if (!isKnownFeatureKey(featureKey)) continue;
    if (!perFeature || typeof perFeature !== "object" || Array.isArray(perFeature))
      continue;
    const cleaned: Record<string, number | string[]> = {};
    for (const [quotaName, quotaVal] of Object.entries(
      perFeature as Record<string, unknown>,
    )) {
      if (typeof quotaVal === "number" && Number.isFinite(quotaVal)) {
        cleaned[quotaName] = quotaVal;
      } else if (
        Array.isArray(quotaVal) &&
        quotaVal.every((s) => typeof s === "string")
      ) {
        cleaned[quotaName] = quotaVal as string[];
      }
    }
    if (Object.keys(cleaned).length > 0) out[featureKey] = cleaned;
  }
  return out;
}

export default router;
