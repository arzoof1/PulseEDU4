import type { Request, RequestHandler } from "express";
import { eq, and } from "drizzle-orm";
import {
  db,
  plansTable,
  schoolFeatureOverridesTable,
  schoolsTable,
  schoolSettingsTable,
} from "@workspace/db";

// =============================================================================
// Feature licensing — server-side helpers
// =============================================================================
// Layered on top of school_settings.super_feature_*. Plans + overrides are
// the editing UX; the runtime gate reads from school_settings (which the
// existing code already does). Calling applyPlan/applyOverrides writes
// through to those booleans.
//
// `loadEffectiveFeatures(req, schoolId)` is the single read path used by
// `/api/me/features` and the `requireFeature(key)` middleware. Cached on
// the Request object so repeated calls within the same request only do
// one DB round-trip.
// =============================================================================

// -----------------------------------------------------------------------------
// FEATURE_KEYS registry
// -----------------------------------------------------------------------------
// One row per feature the licensing layer knows about. `schoolSettingsKey`
// is the camelCase column on school_settings (or `null` if the feature
// hasn't been hooked up to a super_feature_* flag yet — none today, but
// future features without an existing flag would set null).
//
// `quotas` describes the shape of the quotas the SuperUser admin UI
// renders for this feature. Phase 1 is plumbing only: nothing reads
// these values yet. The shape is enough to render number / string-list
// inputs in the plan + override editors and persist them through.
// -----------------------------------------------------------------------------
export type QuotaSpec = {
  name: string;
  type: "number" | "stringList";
  label: string;
  hint?: string;
};

export type FeatureSpec = {
  key: string;
  label: string;
  description: string;
  // Column on school_settings. NULL = no runtime flag exists for this
  // feature yet (consumers must call `isFeatureEnabled` directly).
  schoolSettingsKey:
    | "superFeatureFamilyComm"
    | "superFeaturePbis"
    | "superFeatureSchoolStore"
    | "superFeatureAccommodations"
    | "superFeatureLogIntervention"
    | "superFeatureRequestPullout"
    | "superFeatureHallPasses"
    | "superFeatureTardyPass"
    | "superFeatureMtssPlans"
    | "superFeatureBehaviorSpecialist"
    | "superFeatureIssDashboard"
    | "superFeatureDisplays"
    | "superFeatureBellSchedule"
    | "superFeatureEarlyWarning"
    | "superFeatureAcademics"
    | "superFeatureDataImports"
    | "superFeatureHouses"
    | "superFeatureParentPortal"
    | "superFeatureAst"
    | null;
  quotas: QuotaSpec[];
};

export const FEATURE_KEYS: FeatureSpec[] = [
  {
    key: "hallPasses",
    label: "Hall Passes",
    description: "Hall pass issuance, queue, and signage tile.",
    schoolSettingsKey: "superFeatureHallPasses",
    quotas: [],
  },
  {
    key: "tardyPass",
    label: "Tardy Pass",
    description: "Tardy logging + parent notifications.",
    schoolSettingsKey: "superFeatureTardyPass",
    quotas: [],
  },
  {
    key: "familyComm",
    label: "Family Communication",
    description: "Two-way parent messaging, contact log.",
    schoolSettingsKey: "superFeatureFamilyComm",
    quotas: [],
  },
  {
    key: "pbis",
    label: "PBIS",
    description:
      "PBIS point tracking, recognition, classroom + school stores.",
    schoolSettingsKey: "superFeaturePbis",
    quotas: [],
  },
  {
    key: "schoolStore",
    label: "School Store",
    description: "School-wide PBIS rewards catalog.",
    schoolSettingsKey: "superFeatureSchoolStore",
    quotas: [],
  },
  {
    key: "houses",
    label: "Houses",
    description: "House assignment, standings, Spotlight.",
    schoolSettingsKey: "superFeatureHouses",
    quotas: [],
  },
  {
    key: "accommodations",
    label: "Accommodations",
    description: "Student accommodation tracking + logs.",
    schoolSettingsKey: "superFeatureAccommodations",
    quotas: [],
  },
  {
    key: "logIntervention",
    label: "Log Intervention",
    description: "Intervention logging surface for teachers.",
    schoolSettingsKey: "superFeatureLogIntervention",
    quotas: [],
  },
  {
    key: "requestPullout",
    label: "Request Pullout",
    description: "Counselor / interventionist pullout requests.",
    schoolSettingsKey: "superFeatureRequestPullout",
    quotas: [],
  },
  {
    key: "mtssPlans",
    label: "MTSS Plans",
    description: "Tier 2 / Tier 3 intervention plans + weekly monitoring.",
    schoolSettingsKey: "superFeatureMtssPlans",
    quotas: [],
  },
  {
    key: "behaviorSpecialist",
    label: "Behavior Specialist",
    description: "Behavior specialist case management surface.",
    schoolSettingsKey: "superFeatureBehaviorSpecialist",
    quotas: [],
  },
  {
    key: "issDashboard",
    label: "ISS Dashboard",
    description: "In-school suspension roster + admin hub tile.",
    schoolSettingsKey: "superFeatureIssDashboard",
    quotas: [],
  },
  {
    key: "displays",
    label: "Display Management",
    description: "Digital signage playlists + Heartbeat signage.",
    schoolSettingsKey: "superFeatureDisplays",
    quotas: [
      {
        name: "maxPlaylists",
        type: "number",
        label: "Max playlists",
        hint: "Plumbing only in Phase 1 — not enforced yet.",
      },
    ],
  },
  {
    key: "bellSchedule",
    label: "Bell Schedule",
    description: "Bell schedule editor + period-aware automations.",
    schoolSettingsKey: "superFeatureBellSchedule",
    quotas: [],
  },
  {
    key: "earlyWarning",
    label: "Early Warning",
    description: "Early-warning insights dashboard.",
    schoolSettingsKey: "superFeatureEarlyWarning",
    quotas: [],
  },
  {
    key: "academics",
    label: "Academics",
    description: "FAST scores, academics dashboards.",
    schoolSettingsKey: "superFeatureAcademics",
    quotas: [],
  },
  {
    key: "dataImports",
    label: "Data Imports",
    description: "Roster / assessment / behavior import surface.",
    schoolSettingsKey: "superFeatureDataImports",
    quotas: [],
  },
  {
    key: "parentPortal",
    label: "Parent Portal",
    description:
      "Secure parent-facing portal with HeartBEAT data + PDF reports.",
    schoolSettingsKey: "superFeatureParentPortal",
    quotas: [
      {
        name: "maxParentAccounts",
        type: "number",
        label: "Max parent accounts",
        hint: "Plumbing only in Phase 1 — not enforced yet.",
      },
    ],
  },
  {
    key: "ast",
    label: "AST (Alternate Schedule Time)",
    description: "HCTA-contract AST request + admin approval workflow.",
    schoolSettingsKey: "superFeatureAst",
    quotas: [],
  },
];

export const FEATURE_KEY_SET = new Set(FEATURE_KEYS.map((f) => f.key));

export function isKnownFeatureKey(k: string): boolean {
  return FEATURE_KEY_SET.has(k);
}

// -----------------------------------------------------------------------------
// Effective feature state (post plan + overrides merge)
// -----------------------------------------------------------------------------
export type EffectiveFeature = {
  enabled: boolean;
  showUpsell: boolean;
  quotas: Record<string, number | string[]>;
};

export type EffectiveFeatureMap = Record<string, EffectiveFeature>;

// Cache the per-request feature map on the Request itself. Multiple
// middlewares + handlers in the same request can call this without
// re-querying.
const REQ_CACHE = new WeakMap<Request, Map<number, EffectiveFeatureMap>>();

export async function loadEffectiveFeatures(
  req: Request,
  schoolId: number,
): Promise<EffectiveFeatureMap> {
  let perReq = REQ_CACHE.get(req);
  if (!perReq) {
    perReq = new Map();
    REQ_CACHE.set(req, perReq);
  }
  const cached = perReq.get(schoolId);
  if (cached) return cached;

  // Read the runtime flags from school_settings — this is the source of
  // truth for `enabled`. Plans / overrides write through to it.
  const [settings] = await db
    .select()
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId))
    .limit(1);

  // Read the plan (for quota defaults) and overrides (for showUpsell +
  // per-school quota overrides).
  const [school] = await db
    .select({ planId: schoolsTable.planId })
    .from(schoolsTable)
    .where(eq(schoolsTable.id, schoolId))
    .limit(1);

  const planRow = school?.planId
    ? (
        await db
          .select()
          .from(plansTable)
          .where(eq(plansTable.id, school.planId))
          .limit(1)
      )[0]
    : null;

  const overrides = await db
    .select()
    .from(schoolFeatureOverridesTable)
    .where(eq(schoolFeatureOverridesTable.schoolId, schoolId));
  const overrideByKey = new Map(overrides.map((o) => [o.featureKey, o]));

  const map: EffectiveFeatureMap = {};
  for (const spec of FEATURE_KEYS) {
    // Runtime enable: prefer the existing super_feature_* boolean if
    // present, otherwise fall back to the plan's `features[key]`. If
    // neither says yes, the feature is off.
    let enabled = false;
    if (spec.schoolSettingsKey && settings) {
      enabled = Boolean(
        (settings as unknown as Record<string, unknown>)[
          spec.schoolSettingsKey
        ],
      );
    } else if (planRow?.features?.[spec.key]) {
      enabled = true;
    }

    // Quota defaults from plan, overlaid with override-specific values.
    const planQuotas: Record<string, number | string[]> =
      (planRow?.quotas?.[spec.key] as Record<string, number | string[]>) ??
      {};
    const override = overrideByKey.get(spec.key);
    const quotas: Record<string, number | string[]> = {
      ...planQuotas,
      ...((override?.quotas as Record<string, number | string[]>) ?? {}),
    };

    const showUpsell = override?.showUpsell ?? false;

    map[spec.key] = { enabled, showUpsell, quotas };
  }

  perReq.set(schoolId, map);
  return map;
}

export async function isFeatureEnabled(
  req: Request,
  schoolId: number,
  key: string,
): Promise<boolean> {
  const map = await loadEffectiveFeatures(req, schoolId);
  return map[key]?.enabled === true;
}

// Express middleware. Returns 404 (looks-like-not-exist) when the
// feature is off — keeps the API surface dark for unlicensed tenants.
export function requireFeature(key: string): RequestHandler {
  return async (req, res, next) => {
    try {
      const schoolId = req.schoolId;
      if (!schoolId) {
        res.status(401).json({ error: "no_school_context" });
        return;
      }
      const ok = await isFeatureEnabled(req, schoolId, key);
      if (!ok) {
        res.status(404).json({ error: "feature_not_available" });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// -----------------------------------------------------------------------------
// applyPlanToSchool / applyOverridesToSchool
// -----------------------------------------------------------------------------
// These are the write paths the SuperUser admin UI calls. They translate
// the plans/overrides records into super_feature_* booleans on
// school_settings so the runtime gating path keeps working unchanged.
//
// Sequence: always applyPlan first, then applyOverrides. Calling
// applyPlan alone wipes any per-school override that was previously
// "on top" — that's why the assign-plan API also re-applies overrides
// after assigning.
// -----------------------------------------------------------------------------
// All apply/reapply helpers accept an optional `tx` so callers can wrap
// the full sequence (plan-pointer update + super_feature_* booleans +
// overrides overlay) in ONE db.transaction. Without that, a mid-sequence
// crash can leave plan_id pointing at plan X while the runtime booleans
// still reflect plan Y — which IS an access-control consistency bug
// because gating reads the booleans. Defaulting `tx` to `db` keeps the
// helpers convenient to call outside a transaction (e.g. seeding).
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function applyPlanToSchool(
  schoolId: number,
  planId: number | null,
  tx: DbOrTx = db,
): Promise<void> {
  // Update the school's plan pointer first.
  await tx
    .update(schoolsTable)
    .set({ planId })
    .where(eq(schoolsTable.id, schoolId));

  // Translate plan.features → super_feature_* booleans. If planId is
  // null we leave the flags alone — the school just has no plan, which
  // is fine for the rare "manually managed" case.
  if (planId == null) return;
  const [planRow] = await tx
    .select()
    .from(plansTable)
    .where(eq(plansTable.id, planId))
    .limit(1);
  if (!planRow) return;

  const patch: Record<string, boolean> = {};
  for (const spec of FEATURE_KEYS) {
    if (!spec.schoolSettingsKey) continue;
    patch[spec.schoolSettingsKey] = planRow.features?.[spec.key] === true;
  }
  if (Object.keys(patch).length > 0) {
    await tx
      .update(schoolSettingsTable)
      .set(patch)
      .where(eq(schoolSettingsTable.schoolId, schoolId));
  }
}

export async function applyOverridesToSchool(
  schoolId: number,
  tx: DbOrTx = db,
): Promise<void> {
  const overrides = await tx
    .select()
    .from(schoolFeatureOverridesTable)
    .where(eq(schoolFeatureOverridesTable.schoolId, schoolId));
  if (overrides.length === 0) return;

  // Honor expiration — an expired override is effectively absent.
  const now = new Date();
  const patch: Record<string, boolean> = {};
  for (const o of overrides) {
    if (o.expiresAt && o.expiresAt.getTime() <= now.getTime()) continue;
    const spec = FEATURE_KEYS.find((f) => f.key === o.featureKey);
    if (!spec?.schoolSettingsKey) continue;
    patch[spec.schoolSettingsKey] = o.enabled;
  }
  if (Object.keys(patch).length > 0) {
    await tx
      .update(schoolSettingsTable)
      .set(patch)
      .where(eq(schoolSettingsTable.schoolId, schoolId));
  }
}

// Combined helper used by every SuperUser write path: plan-change,
// override upsert, override delete. Wraps the whole sequence in a
// transaction by default so partial states cannot persist. Callers
// that are ALREADY inside a transaction must pass `tx` to opt out of
// nesting (Postgres doesn't allow it).
export async function reapplyLicensingToSchool(
  schoolId: number,
  tx?: DbOrTx,
): Promise<void> {
  const runIn = async (t: DbOrTx) => {
    const [school] = await t
      .select({ planId: schoolsTable.planId })
      .from(schoolsTable)
      .where(eq(schoolsTable.id, schoolId))
      .limit(1);
    await applyPlanToSchool(schoolId, school?.planId ?? null, t);
    await applyOverridesToSchool(schoolId, t);
  };
  if (tx) {
    await runIn(tx);
  } else {
    await db.transaction(runIn);
  }
}

// Quota read helper — Phase 1 plumbing. Returns undefined when the
// quota isn't defined for this feature. Consumers should treat
// undefined as "unlimited" until they're explicitly wired in Phase 3.
export async function getQuota(
  req: Request,
  schoolId: number,
  key: string,
  quotaName: string,
): Promise<number | string[] | undefined> {
  const map = await loadEffectiveFeatures(req, schoolId);
  return map[key]?.quotas?.[quotaName];
}

// Used by the SuperUser API to refuse plan deletion while any school
// still references it.
export async function countSchoolsOnPlan(planId: number): Promise<number> {
  const rows = await db
    .select({ id: schoolsTable.id })
    .from(schoolsTable)
    .where(eq(schoolsTable.planId, planId));
  return rows.length;
}

// Used by /api/feature-licensing/schools — small list, OK to do an
// in-memory join on the existing schools + plans rowsets.
export async function listSchoolsWithLicensing(): Promise<
  Array<{
    schoolId: number;
    schoolName: string;
    planId: number | null;
    planKey: string | null;
    planLabel: string | null;
    overrideCount: number;
  }>
> {
  const schools = await db
    .select({
      id: schoolsTable.id,
      name: schoolsTable.name,
      planId: schoolsTable.planId,
    })
    .from(schoolsTable);
  const plans = await db.select().from(plansTable);
  const planById = new Map(plans.map((p) => [p.id, p]));
  const overrides = await db.select().from(schoolFeatureOverridesTable);
  const overrideCountBySchool = new Map<number, number>();
  for (const o of overrides) {
    overrideCountBySchool.set(
      o.schoolId,
      (overrideCountBySchool.get(o.schoolId) ?? 0) + 1,
    );
  }
  return schools.map((s) => {
    const p = s.planId ? planById.get(s.planId) : null;
    return {
      schoolId: s.id,
      schoolName: s.name,
      planId: s.planId ?? null,
      planKey: p?.key ?? null,
      planLabel: p?.label ?? null,
      overrideCount: overrideCountBySchool.get(s.id) ?? 0,
    };
  });
}

// Suppress unused-import warning in builds that tree-shake `and` away.
void and;
