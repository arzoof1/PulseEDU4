import type { Request, RequestHandler, Response } from "express";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import {
  db,
  displayPlaylistsTable,
  featureLicensingAuditLogTable,
  parentInvitesTable,
  parentsTable,
  plansTable,
  schoolFeatureOverridesTable,
  schoolsTable,
  schoolSettingsTable,
  staffFeaturePilotsTable,
  staffTable,
} from "@workspace/db";
import { verifyParentAuthToken } from "./authToken.js";
import { isAiGloballyEnabled } from "./aiGlobalSwitch.js";

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
    | "superFeatureCompTime"
    | "superFeatureEligibility"
    | "superFeatureSchoolStoreNotify"
    | "superFeatureDataChats"
    | "superFeaturePickup"
    | "superFeatureTicketing"
    | "superFeatureTours"
    | "superFeatureEsign"
    | "superFeatureBrainLab"
    | "superFeatureGradebook"
    | "superFeatureSchoolGrade"
    | "superFeatureSafetyPlans"
    | "superFeatureAiAssist"
    | null;
  quotas: QuotaSpec[];
  // Staff-pilot eligibility. Default (undefined) = pilotable. Set FALSE
  // for family-facing features where a half-piloted rollout would look
  // broken/inconsistent to parents (only pilot teachers' actions would
  // reach families). Enforced in the pilot-management API, mirrored in
  // the School Features UI.
  pilotable?: boolean;
  // Dependency metadata consumed by the plan + per-school override editors to
  // highlight (and, for `requires`, hard-block) incoherent feature combos.
  //   requires:   HARD deps — this feature is non-functional without the
  //               target (e.g. School Store has nothing to redeem without the
  //               PBIS points economy). Enabling this while a required dep is
  //               off BLOCKS save in the editor.
  //   recommends: SOFT deps — this feature works without the target but is
  //               materially better with it (e.g. Tardy Pass + Bell Schedule
  //               for lost-instruction minutes). Shown as a non-blocking warn.
  // Keep `requires` conservative: a wrong hard edge becomes a wall in the
  // editor. Anything "works, just degraded" belongs in `recommends`.
  requires?: string[];
  recommends?: string[];
};

export const FEATURE_KEYS: FeatureSpec[] = [
  {
    key: "hallPasses",
    label: "Hall Passes",
    description: "Hall pass issuance, queue, and signage tile.",
    schoolSettingsKey: "superFeatureHallPasses",
    recommends: ["bellSchedule"],
    quotas: [],
  },
  {
    key: "tardyPass",
    label: "Tardy Pass",
    description: "Tardy logging + parent notifications.",
    schoolSettingsKey: "superFeatureTardyPass",
    recommends: ["bellSchedule"],
    quotas: [],
  },
  {
    key: "familyComm",
    label: "Family Communication",
    description: "Two-way parent messaging, contact log.",
    schoolSettingsKey: "superFeatureFamilyComm",
    pilotable: false,
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
    requires: ["pbis"],
    quotas: [],
  },
  {
    key: "schoolStoreNotify",
    label: "School Store Fulfillment Notify",
    description:
      "Email families when a redeemed School Store item is fulfilled.",
    schoolSettingsKey: "superFeatureSchoolStoreNotify",
    requires: ["schoolStore"],
    recommends: ["familyComm"],
    pilotable: false,
    quotas: [],
  },
  {
    key: "houses",
    label: "Houses",
    description: "House assignment, standings, Spotlight.",
    schoolSettingsKey: "superFeatureHouses",
    requires: ["pbis"],
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
    recommends: ["academics"],
    quotas: [],
  },
  {
    key: "behaviorSpecialist",
    label: "Behavior Specialist",
    description: "Behavior specialist case management surface.",
    schoolSettingsKey: "superFeatureBehaviorSpecialist",
    recommends: ["mtssPlans"],
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
        hint:
          "Counts active playlists (school + owner-staff). Undefined or " +
          "non-positive = unlimited.",
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
    recommends: ["academics"],
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
    recommends: ["familyComm"],
    pilotable: false,
    quotas: [
      {
        name: "maxParentAccounts",
        type: "number",
        label: "Max parent accounts",
        hint:
          "Counts accepted parents + live pending invites. Undefined or " +
          "non-positive = unlimited.",
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
  {
    key: "compTime",
    label: "Comp Time (FLSA)",
    description:
      "Compensatory-time bank for non-exempt staff: 1.5x earn over 40h/wk, 240h cap, admin approval workflow that mirrors AST.",
    schoolSettingsKey: "superFeatureCompTime",
    quotas: [],
  },
  {
    key: "eligibility",
    label: "Eligibility Hub",
    description:
      "Attendance-based participation eligibility for athletics, clubs, and activities: rosters, at-risk report, parent notes, daily upload, notifications.",
    schoolSettingsKey: "superFeatureEligibility",
    quotas: [],
  },
  // ---------------------------------------------------------------------------
  // Feature-checklist completion (July 2026): modules that shipped always-on
  // now have real switches. Runtime columns default TRUE (see seed.ts) so
  // existing schools see no change.
  // ---------------------------------------------------------------------------
  {
    key: "dataChats",
    label: "Data Chat Campaigns",
    description:
      "Admin-pushed teacher↔student check-in campaigns, queue, follow-ups, compliance reports.",
    schoolSettingsKey: "superFeatureDataChats",
    recommends: ["academics"],
    quotas: [],
  },
  {
    key: "pickup",
    label: "Parent Pick-Up",
    description:
      "Curb keypad, walker gate, car-tag authorizations, dismissal reconciliation.",
    schoolSettingsKey: "superFeaturePickup",
    quotas: [],
  },
  {
    key: "ticketing",
    label: "Event Ticketing",
    description:
      "Free-ticket events with per-grade quotas, QR tickets, volunteer scanning.",
    schoolSettingsKey: "superFeatureTicketing",
    pilotable: false,
    quotas: [],
  },
  {
    key: "tours",
    label: "School Tours",
    description:
      "Public brag page, tour-request lead pipeline, live tour capture, conversion reports.",
    schoolSettingsKey: "superFeatureTours",
    quotas: [],
  },
  {
    key: "esign",
    label: "E-Sign",
    description: "Staff-created e-signature documents with public sign links.",
    schoolSettingsKey: "superFeatureEsign",
    quotas: [],
  },
  {
    key: "brainLab",
    label: "PulseBrainLab",
    description:
      "Brain-based intervention curriculum: groups, sessions, scan routing, family mirror.",
    schoolSettingsKey: "superFeatureBrainLab",
    quotas: [],
  },
  {
    key: "gradebook",
    label: "Gradebook / Current Grades",
    description:
      "Gradebook xlsx importer, current-grade surfaces, optional GPA.",
    schoolSettingsKey: "superFeatureGradebook",
    requires: ["dataImports"],
    quotas: [],
  },
  {
    key: "schoolGrade",
    label: "School Grade Calculator",
    description:
      "Florida MS school-grade estimate per PM window (admin / Core Team).",
    schoolSettingsKey: "superFeatureSchoolGrade",
    recommends: ["academics"],
    quotas: [],
  },
  {
    key: "safetyPlans",
    label: "Safety Plans",
    description:
      "Per-student behavioral/physical safety checklists with audit logs.",
    schoolSettingsKey: "superFeatureSafetyPlans",
    quotas: [],
  },
  {
    key: "aiAssist",
    label: "AI Assistance",
    description:
      "Master switch for AI-powered features: Help Assistant, PulseDNA drafting, watchlist consistency checks, mention suggestions, and tour page translation. Disable when district policy or DPA review requires AI off.",
    schoolSettingsKey: "superFeatureAiAssist",
    pilotable: false,
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

  // Staff-pilot grants for the acting staff member (if this is a staff
  // session). A pilot row lets a specific staffer use a feature whose
  // school-wide admin toggle is OFF — but only when the district half
  // (super_feature_*) is licensed. District license always wins.
  const actorStaffId = req.staffId ?? null;
  const pilotKeys = new Set<string>();
  if (actorStaffId) {
    const pilotRows = await db
      .select({ featureKey: staffFeaturePilotsTable.featureKey })
      .from(staffFeaturePilotsTable)
      .where(
        and(
          eq(staffFeaturePilotsTable.schoolId, schoolId),
          eq(staffFeaturePilotsTable.staffId, actorStaffId),
        ),
      );
    for (const r of pilotRows) pilotKeys.add(r.featureKey);
  }

  const overrides = await db
    .select()
    .from(schoolFeatureOverridesTable)
    .where(eq(schoolFeatureOverridesTable.schoolId, schoolId));
  // Drop expired overrides at read time so `showUpsell` + per-override
  // quotas don't keep leaking after the override's expiration date. The
  // `enabled` boolean is read from school_settings.super_feature_* and
  // will lag until the next reapply (cron sweep is Phase 4 work).
  const now = Date.now();
  const overrideByKey = new Map(
    overrides
      .filter((o) => !o.expiresAt || o.expiresAt.getTime() > now)
      .map((o) => [o.featureKey, o]),
  );

  const map: EffectiveFeatureMap = {};
  for (const spec of FEATURE_KEYS) {
    // Runtime enable: a feature is live when BOTH switches are on:
    //   super_feature_* (SuperUser / billing-tier "available to school")
    //   feature_*       (Admin "do we want it on right now?")
    // This mirrors the two-tier contract documented in
    // lib/db/src/schema/schoolSettings.ts. Reading super_feature_* alone
    // bypasses the admin Off switch — a teacher would then see features
    // their principal explicitly turned off in School Settings, which
    // is exactly the bug we hit at Parrott Middle.
    //
    // Derive the admin key by stripping the "super" prefix:
    // `superFeatureHallPasses` → `featureHallPasses`.
    let enabled = false;
    if (spec.schoolSettingsKey && settings) {
      const row = settings as unknown as Record<string, unknown>;
      const superKey = spec.schoolSettingsKey;
      const adminKey =
        "feature" + superKey.slice("superFeature".length);
      const superOn = Boolean(row[superKey]);
      // Admin key may not exist for newer features (e.g. AST shipped
      // without a paired feature_* column). Default to TRUE so absence
      // of the admin toggle behaves the same as "admin has not chosen
      // to turn it off."
      const adminOn = adminKey in row ? Boolean(row[adminKey]) : true;
      enabled = superOn && adminOn;
      // Staff pilot: school toggle OFF, but this staffer has a pilot
      // grant AND the district licenses the feature AND the feature is
      // pilotable. Never widens past the district gate.
      if (
        !enabled &&
        superOn &&
        spec.pilotable !== false &&
        pilotKeys.has(spec.key)
      ) {
        enabled = true;
      }
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

  // Deployment kill switch: force aiAssist off for every school when the
  // env master switch is off, so `/api/me/features` matches route gates.
  if (!isAiGloballyEnabled() && map.aiAssist) {
    map.aiAssist = { ...map.aiAssist, enabled: false, showUpsell: false };
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

// Signage-aware variant of `requireFeature`. A handful of staff routes
// double as unauthenticated kiosk endpoints (e.g. `/api/houses` and the
// pulse signage tile) and resolve their school context from a
// `?schoolId=N` query param when no staff session is present. Standard
// `requireFeature` would 401 those callers because `req.schoolId` is
// only populated for authenticated staff. This variant accepts EITHER
// `req.schoolId` OR a positive-integer `?schoolId` query param; if
// neither resolves, it passes through so the downstream route can
// return its own context error.
export function requireFeatureAllowingSignageSchool(
  key: string,
): RequestHandler {
  return async (req, res, next) => {
    try {
      let schoolId: number | null = req.schoolId ?? null;
      if (!schoolId) {
        const raw = req.query.schoolId;
        const candidate = Number(Array.isArray(raw) ? raw[0] : raw);
        if (Number.isFinite(candidate) && candidate > 0) {
          schoolId = Math.floor(candidate);
        }
      }
      if (!schoolId) {
        // Let the route return its own 400/401 about missing schoolId.
        next();
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

// Parent-aware variant of `requireFeature`. Parent sessions don't have
// `req.schoolId` (they use `req.parentId`), so we resolve the school by
// looking up the parent row's `school_id`. Mirrors the parent-id
// resolution pattern used by parentSnapshot / parentHeartbeatPrefs so
// the gate works whether it's mounted before or after the route-local
// resolver.
//
// On feature OFF, returns 403 with `{error: "parent_portal_disabled"}`
// so the parent client can render a friendly "school has paused the
// parent portal" screen rather than a generic error. If the request is
// not authenticated as a parent, we pass through so the downstream
// route returns its own 401.
const PARENT_SCHOOL_CACHE = new WeakMap<Request, Map<number, number | null>>();

async function resolveParentSchoolId(
  req: Request,
  parentId: number,
): Promise<number | null> {
  let cache = PARENT_SCHOOL_CACHE.get(req);
  if (!cache) {
    cache = new Map();
    PARENT_SCHOOL_CACHE.set(req, cache);
  }
  const cached = cache.get(parentId);
  if (cached !== undefined) return cached;
  const [row] = await db
    .select({ schoolId: parentsTable.schoolId })
    .from(parentsTable)
    .where(eq(parentsTable.id, parentId))
    .limit(1);
  const sid = row?.schoolId ?? null;
  cache.set(parentId, sid);
  return sid;
}

export function requireFeatureForParent(key: string): RequestHandler {
  return async (req, res, next) => {
    try {
      let pid: number | null = req.parentId ?? req.session.parentId ?? null;
      if (!pid) {
        const auth = req.headers.authorization;
        if (typeof auth === "string" && auth.startsWith("Bearer ")) {
          pid = verifyParentAuthToken(auth.slice(7).trim());
        }
      }
      if (!pid) {
        // Let the downstream route return its standard 401.
        next();
        return;
      }
      req.parentId = pid;
      const schoolId = await resolveParentSchoolId(req, pid);
      if (!schoolId) {
        next();
        return;
      }
      const ok = await isFeatureEnabled(req, schoolId, key);
      if (!ok) {
        res.status(403).json({ error: "parent_portal_disabled" });
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

// Per-school lock used to serialize licensing mutations. Without this,
// two concurrent SuperUser writes (e.g. assign-plan + override-upsert
// landing within ms of each other) can interleave their read-then-write
// of `schools.plan_id` + `school_settings.super_feature_*` and persist a
// state that reflects neither caller's intent. `SELECT ... FOR UPDATE`
// on the schools row makes the licensing critical section linearizable:
// the second tx blocks until the first commits, then re-reads.
export async function lockSchoolForLicensing(
  schoolId: number,
  tx: DbOrTx,
): Promise<{ planId: number | null } | null> {
  const rows = await tx.execute<{ plan_id: number | null }>(
    sql`SELECT plan_id FROM schools WHERE id = ${schoolId} FOR UPDATE`,
  );
  const row = (rows as unknown as { rows: { plan_id: number | null }[] }).rows?.[0];
  if (!row) return null;
  return { planId: row.plan_id };
}

// Internal: translate a plan's `features` JSONB into the runtime
// super_feature_* booleans. Does NOT touch `schools.plan_id` — the
// caller (assign-plan route) is responsible for the pointer write so
// reapply-during-an-override-upsert never re-writes the pointer from
// a possibly-stale read.
async function applyPlanFlagsToSchool(
  schoolId: number,
  planId: number | null,
  tx: DbOrTx,
): Promise<void> {
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

export async function applyPlanToSchool(
  schoolId: number,
  planId: number | null,
  tx: DbOrTx = db,
): Promise<void> {
  // Pointer write — only called when the caller explicitly intends to
  // change the plan assignment. Reapply paths (override upsert/delete)
  // must NOT call this directly; they go through reapplyLicensingToSchool
  // which preserves the existing pointer under the row lock.
  await tx
    .update(schoolsTable)
    .set({ planId })
    .where(eq(schoolsTable.id, schoolId));
  await applyPlanFlagsToSchool(schoolId, planId, tx);
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
    // FOR UPDATE row lock — serializes this critical section against
    // concurrent assign-plan / override-upsert / override-delete on the
    // same school. Subsequent reads inside this tx see a consistent
    // snapshot; the next caller blocks until we commit.
    const locked = await lockSchoolForLicensing(schoolId, t);
    if (!locked) return;
    // Re-apply the flag portion only — pointer write was already done
    // by the assign-plan route (if this reapply was triggered by a plan
    // change) or is irrelevant (override mutations don't touch the
    // pointer). This avoids the stale-read overwrite the architect
    // flagged where a slow override tx would re-write plan_id with the
    // value it saw before a faster assign-plan tx committed.
    await applyPlanFlagsToSchool(schoolId, locked.planId, t);
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

// =============================================================================
// Quota enforcement helpers
// =============================================================================
// Phase 2 — first quota consumer is `parentPortal.maxParentAccounts`.
// "Account slot" = accepted parent rows + live (pending, not-expired)
// invites. Counted together so a tenant can't game the quota by
// blasting out invites that haven't accepted yet.
//
// Returns `{ allowed: true }` when the quota is undefined (unlimited)
// or when the proposed addition keeps the school under the limit.
// Returns `{ allowed: false, quota, current }` otherwise. Callers
// translate that into the 4xx response shape they want.

export type QuotaCheckResult =
  | { allowed: true; quota: number | null; current: number }
  | { allowed: false; quota: number; current: number };

export async function checkParentAccountQuota(
  req: Request,
  schoolId: number,
  additional: number,
): Promise<QuotaCheckResult> {
  const raw = await getQuota(req, schoolId, "parentPortal", "maxParentAccounts");
  // Quota MUST be a positive integer to enforce. Undefined / non-number
  // / non-positive => treat as unlimited (no rollout breakage if a
  // SuperUser accidentally types `0` while editing the plan JSON).
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return { allowed: true, quota: null, current: 0 };
  }
  const quota = Math.floor(raw);

  // accepted parents
  const parentRows = await db
    .select({ id: parentsTable.id })
    .from(parentsTable)
    .where(eq(parentsTable.schoolId, schoolId));

  // live (pending, not-yet-expired) invites — re-counted on every check
  // because cron-driven expiration would otherwise lag the gate.
  const now = new Date();
  const inviteRows = await db
    .select({ id: parentInvitesTable.id })
    .from(parentInvitesTable)
    .where(
      and(
        eq(parentInvitesTable.schoolId, schoolId),
        eq(parentInvitesTable.status, "pending"),
        sql`${parentInvitesTable.expiresAt} > ${now}`,
      ),
    );

  const current = parentRows.length + inviteRows.length;
  if (current + Math.max(0, additional) > quota) {
    return { allowed: false, quota, current };
  }
  return { allowed: true, quota, current };
}

// Convenience for routes: write the 403 + return false when the quota
// would be exceeded; return true otherwise. Keeps the route bodies
// readable.
export async function enforceParentAccountQuota(
  req: Request,
  res: Response,
  schoolId: number,
  additional: number,
): Promise<boolean> {
  const r = await checkParentAccountQuota(req, schoolId, additional);
  if (!r.allowed) {
    res.status(403).json({
      error: "quota_exceeded",
      message:
        `This school has reached its Parent Portal seat limit ` +
        `(${r.current}/${r.quota}). Ask your district admin to ` +
        `raise the quota for this school.`,
      quota: r.quota,
      current: r.current,
      feature: "parentPortal",
      quotaName: "maxParentAccounts",
    });
    return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// Display playlist quota — second consumer of the quota system (Phase 3).
// -----------------------------------------------------------------------------
// "Slot" = one row in display_playlists for this school where active=true.
// Inactive (kill-switched) playlists do NOT count — admins flip `active`
// off to retire a TV without losing config, and we don't want that to
// keep eating quota. Mirrors the parent-account check shape exactly so
// the UI + route handlers feel uniform.
export async function checkDisplayPlaylistQuota(
  req: Request,
  schoolId: number,
  additional: number,
): Promise<QuotaCheckResult> {
  const raw = await getQuota(req, schoolId, "displays", "maxPlaylists");
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return { allowed: true, quota: null, current: 0 };
  }
  const quota = Math.floor(raw);
  const rows = await db
    .select({ id: displayPlaylistsTable.id })
    .from(displayPlaylistsTable)
    .where(
      and(
        eq(displayPlaylistsTable.schoolId, schoolId),
        eq(displayPlaylistsTable.active, true),
      ),
    );
  const current = rows.length;
  if (current + Math.max(0, additional) > quota) {
    return { allowed: false, quota, current };
  }
  return { allowed: true, quota, current };
}

export async function enforceDisplayPlaylistQuota(
  req: Request,
  res: Response,
  schoolId: number,
  additional: number,
): Promise<boolean> {
  const r = await checkDisplayPlaylistQuota(req, schoolId, additional);
  if (!r.allowed) {
    res.status(403).json({
      error: "quota_exceeded",
      message:
        `This school has reached its Display playlist limit ` +
        `(${r.current}/${r.quota}). Deactivate an unused playlist or ` +
        `ask your district admin to raise the quota.`,
      quota: r.quota,
      current: r.current,
      feature: "displays",
      quotaName: "maxPlaylists",
    });
    return false;
  }
  return true;
}

// =============================================================================
// Audit-log listing helpers (Phase 3)
// =============================================================================
// The expired-override sweep cron writes to feature_licensing_audit_log on
// every run; until now the SuperUser had no UI to see what was swept and
// when. These helpers feed the audit viewer in SchoolLicensingPage and
// the "recent activity" tile on the SuperUser dashboard.

export type AuditRowWithActor = {
  id: number;
  schoolId: number;
  schoolName: string | null;
  action: string;
  overrideId: number | null;
  featureKey: string | null;
  payload: Record<string, unknown>;
  actorStaffId: number | null;
  actorName: string | null;
  createdAt: Date;
};

// Recent rows, optionally filtered to one school. `limit` is hard-capped
// at 500 — this is an admin surface, not a paginated firehose.
export async function listFeatureLicensingAudit(opts: {
  schoolId?: number;
  limit?: number;
}): Promise<AuditRowWithActor[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  // Join schools + staff in-memory rather than chaining drizzle joins —
  // audit volume is low (1 row per swept override per day) so the
  // simple two-extra-selects shape is fine and easier to read.
  const baseRows = await (opts.schoolId !== undefined
    ? db
        .select()
        .from(featureLicensingAuditLogTable)
        .where(eq(featureLicensingAuditLogTable.schoolId, opts.schoolId))
        .orderBy(desc(featureLicensingAuditLogTable.createdAt))
        .limit(limit)
    : db
        .select()
        .from(featureLicensingAuditLogTable)
        .orderBy(desc(featureLicensingAuditLogTable.createdAt))
        .limit(limit));
  if (baseRows.length === 0) return [];
  const schoolIds = Array.from(new Set(baseRows.map((r) => r.schoolId)));
  // Filter the name lookup to only the schools we actually need — keeps
  // the round-trip small even if the schools table grows.
  const schoolRows = await db
    .select({ id: schoolsTable.id, name: schoolsTable.name })
    .from(schoolsTable)
    .where(inArray(schoolsTable.id, schoolIds));
  const schoolNameById = new Map(schoolRows.map((s) => [s.id, s.name]));
  return baseRows.map((r) => ({
    id: r.id,
    schoolId: r.schoolId,
    schoolName: schoolNameById.get(r.schoolId) ?? null,
    action: r.action,
    overrideId: r.overrideId,
    featureKey: r.featureKey,
    payload: r.payload,
    actorStaffId: r.actorStaffId,
    actorName: r.actorName,
    createdAt: r.createdAt,
  }));
}

// =============================================================================
// Quota telemetry — schools-near-quota tile (Phase 3)
// =============================================================================
// One row per (school, feature, quotaName) where usage is ≥ `threshold`
// (default 0.80). Walks every school once, calls the existing
// check-*-quota helpers per feature so the count math stays in ONE
// place (no chance of the tile and the gate drifting). Empty plan
// caches per call (`{} as Request`) — these helpers don't actually
// use any request state beyond REQ_CACHE, and a fresh per-school
// "request" is fine because we're already iterating per-school anyway.

export type QuotaTelemetryRow = {
  schoolId: number;
  schoolName: string;
  feature: string;
  quotaName: string;
  current: number;
  quota: number;
  pct: number; // 0..1+
};

const KNOWN_SEAT_QUOTAS: Array<{
  feature: string;
  quotaName: string;
  check: (
    req: Request,
    schoolId: number,
    additional: number,
  ) => Promise<QuotaCheckResult>;
}> = [
  {
    feature: "parentPortal",
    quotaName: "maxParentAccounts",
    check: checkParentAccountQuota,
  },
  {
    feature: "displays",
    quotaName: "maxPlaylists",
    check: checkDisplayPlaylistQuota,
  },
];

export async function listSchoolsNearQuota(
  threshold = 0.8,
): Promise<QuotaTelemetryRow[]> {
  const schools = await db
    .select({ id: schoolsTable.id, name: schoolsTable.name })
    .from(schoolsTable);
  const out: QuotaTelemetryRow[] = [];
  for (const s of schools) {
    // Synthetic per-school request object — only needs to satisfy the
    // WeakMap cache key contract in loadEffectiveFeatures. Using a
    // fresh `{}` each iteration means no cross-school cache pollution.
    const fakeReq = {} as Request;
    for (const spec of KNOWN_SEAT_QUOTAS) {
      try {
        const r = await spec.check(fakeReq, s.id, 0);
        // Unlimited (quota === null) → skip.
        if (r.allowed && r.quota === null) continue;
        const quota = r.quota ?? 0;
        if (quota <= 0) continue;
        const pct = r.current / quota;
        if (pct >= threshold) {
          out.push({
            schoolId: s.id,
            schoolName: s.name,
            feature: spec.feature,
            quotaName: spec.quotaName,
            current: r.current,
            quota,
            pct,
          });
        }
      } catch {
        // One school's broken settings shouldn't break the whole tile.
      }
    }
  }
  // Worst offenders first so the tile preview shows the loudest schools.
  out.sort((a, b) => b.pct - a.pct);
  return out;
}

// Suppress unused-import warning in builds that tree-shake helpers away.
void and;
void staffTable;
