import { Router, type IRouter } from "express";
import { db, schoolSettingsTable, staffTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

// Six per-school feature flags. The two-tier model means each feature has
// both an admin-controlled `feature_*` column and a SuperUser-controlled
// `super_feature_*` column. A feature is "effective" only when both are
// true. Centralizing the list here keeps the GET enrichment, the PUT
// validation, and the response-side `effectiveFeatures` map in sync.
const FEATURE_KEYS = [
  "FamilyComm",
  "Pbis",
  "SchoolStore",
  "Accommodations",
  "LogIntervention",
  "RequestPullout",
] as const;
type FeatureKey = (typeof FEATURE_KEYS)[number];
type SettingsRow = typeof schoolSettingsTable.$inferSelect;

function adminCol(k: FeatureKey): keyof SettingsRow {
  return (`feature${k}` as unknown) as keyof SettingsRow;
}
function superCol(k: FeatureKey): keyof SettingsRow {
  return (`superFeature${k}` as unknown) as keyof SettingsRow;
}

// Build the derived `effectiveFeatures` map from a settings row. Each
// entry is `super && admin` — the value any feature-gated UI should
// actually consult.
function effectiveFeatures(row: SettingsRow): Record<FeatureKey, boolean> {
  const out = {} as Record<FeatureKey, boolean>;
  for (const k of FEATURE_KEYS) {
    out[k] =
      Boolean(row[superCol(k)]) && Boolean(row[adminCol(k)]);
  }
  return out;
}

function withEffective(row: SettingsRow) {
  return { ...row, effectiveFeatures: effectiveFeatures(row) };
}

// Read or lazily create the settings row for a given school. The
// `school_settings_school_id_unique` index guarantees one row per school,
// so the second concurrent request just hits the existing row.
async function getOrCreate(schoolId: number) {
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
    // Another concurrent request inserted first — just re-read.
    const [row2] = await db
      .select()
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId));
    return row2;
  }
}

router.get("/school-settings", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const row = await getOrCreate(schoolId);
  res.json(withEffective(row));
});

router.put("/school-settings", async (req, res): Promise<void> => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const current = await getOrCreate(schoolId);
  const {
    schoolName,
    fromName,
    emailSignature,
    periodCount,
    hallPassMaxMinutes,
    hallPassDefaultMinutes,
    globalDailyHallPassLimit,
    pbisQuietTeacherDays,
    pbisInvisibleStudentDays,
    pbisReasonImbalancePct,
    pbisColdPeriodMultiple,
    pbisNegativeAffectsTotal,
    schoolWideExpectationAcronym,
    schoolWideExpectationLetters,
  } = req.body ?? {};

  const updates: Partial<typeof schoolSettingsTable.$inferInsert> = {};
  if (typeof schoolName === "string" && schoolName.trim()) {
    updates.schoolName = schoolName.trim();
  }
  if (typeof fromName === "string" && fromName.trim()) {
    updates.fromName = fromName.trim();
  }
  if (typeof emailSignature === "string") {
    updates.emailSignature = emailSignature;
  }
  if (periodCount !== undefined) {
    if (
      typeof periodCount !== "number" ||
      !Number.isInteger(periodCount) ||
      periodCount < 1 ||
      periodCount > 12
    ) {
      res
        .status(400)
        .json({ error: "periodCount must be an integer between 1 and 12" });
      return;
    }
    updates.periodCount = periodCount;
  }
  if (hallPassMaxMinutes !== undefined) {
    if (
      typeof hallPassMaxMinutes !== "number" ||
      !Number.isInteger(hallPassMaxMinutes) ||
      hallPassMaxMinutes < 1 ||
      hallPassMaxMinutes > 240
    ) {
      res.status(400).json({
        error: "hallPassMaxMinutes must be an integer between 1 and 240",
      });
      return;
    }
    updates.hallPassMaxMinutes = hallPassMaxMinutes;
  }
  if (hallPassDefaultMinutes !== undefined) {
    if (
      typeof hallPassDefaultMinutes !== "number" ||
      !Number.isInteger(hallPassDefaultMinutes) ||
      hallPassDefaultMinutes < 1 ||
      hallPassDefaultMinutes > 240
    ) {
      res.status(400).json({
        error:
          "hallPassDefaultMinutes must be an integer between 1 and 240",
      });
      return;
    }
    updates.hallPassDefaultMinutes = hallPassDefaultMinutes;
  }
  if (globalDailyHallPassLimit !== undefined) {
    if (globalDailyHallPassLimit === null) {
      updates.globalDailyHallPassLimit = null;
    } else if (
      typeof globalDailyHallPassLimit !== "number" ||
      !Number.isInteger(globalDailyHallPassLimit) ||
      globalDailyHallPassLimit < 1 ||
      globalDailyHallPassLimit > 100
    ) {
      res.status(400).json({
        error:
          "globalDailyHallPassLimit must be null or an integer between 1 and 100",
      });
      return;
    } else {
      updates.globalDailyHallPassLimit = globalDailyHallPassLimit;
    }
  }

  const intRange = (
    name: string,
    val: unknown,
    min: number,
    max: number,
    field: keyof typeof schoolSettingsTable.$inferInsert,
  ): string | null => {
    if (val === undefined) return null;
    if (
      typeof val !== "number" ||
      !Number.isInteger(val) ||
      val < min ||
      val > max
    ) {
      return `${name} must be an integer between ${min} and ${max}`;
    }
    (updates as Record<string, unknown>)[field as string] = val;
    return null;
  };

  for (const err of [
    intRange(
      "pbisQuietTeacherDays",
      pbisQuietTeacherDays,
      1,
      60,
      "pbisQuietTeacherDays",
    ),
    intRange(
      "pbisInvisibleStudentDays",
      pbisInvisibleStudentDays,
      1,
      180,
      "pbisInvisibleStudentDays",
    ),
    intRange(
      "pbisReasonImbalancePct",
      pbisReasonImbalancePct,
      10,
      100,
      "pbisReasonImbalancePct",
    ),
    intRange(
      "pbisColdPeriodMultiple",
      pbisColdPeriodMultiple,
      2,
      20,
      "pbisColdPeriodMultiple",
    ),
  ]) {
    if (err) {
      res.status(400).json({ error: err });
      return;
    }
  }

  if (pbisNegativeAffectsTotal !== undefined) {
    if (typeof pbisNegativeAffectsTotal !== "boolean") {
      res
        .status(400)
        .json({ error: "pbisNegativeAffectsTotal must be a boolean" });
      return;
    }
    // School-wide PBIS policy — only admins / PBIS coordinators / behavior
    // specialists may flip this. Other authenticated staff get rejected
    // before any write happens.
    const staffId = req.staffId;
    let allowed = false;
    if (staffId) {
      const [s] = await db
        .select()
        .from(staffTable)
        .where(eq(staffTable.id, staffId));
      if (
        s &&
        s.active &&
        (s.isSuperUser ||
          s.isAdmin ||
          s.isPbisCoordinator ||
          s.isBehaviorSpecialist)
      ) {
        allowed = true;
      }
    }
    if (!allowed) {
      res
        .status(403)
        .json({ error: "Only admin, PBIS coordinator, or behavior specialist may change this" });
      return;
    }
    updates.pbisNegativeAffectsTotal = pbisNegativeAffectsTotal;
  }

  // -----------------------------------------------------------------
  // School-wide expectation acronym + letters (PRIDE config). Tier 3
  // weekly form reads these to render its optional expectations row.
  // -----------------------------------------------------------------
  if (schoolWideExpectationAcronym !== undefined) {
    if (
      schoolWideExpectationAcronym === null ||
      typeof schoolWideExpectationAcronym === "string"
    ) {
      const trimmed =
        typeof schoolWideExpectationAcronym === "string"
          ? schoolWideExpectationAcronym.trim().toUpperCase().slice(0, 12)
          : "";
      // Column is non-null with default "PRIDE"; treat empty/null as reset
      updates.schoolWideExpectationAcronym =
        trimmed && trimmed.length > 0 ? trimmed : "PRIDE";
    } else {
      res
        .status(400)
        .json({ error: "schoolWideExpectationAcronym must be a string or null" });
      return;
    }
  }
  if (schoolWideExpectationLetters !== undefined) {
    if (schoolWideExpectationLetters === null) {
      // Column is non-null with a default; treat null as "reset to empty"
      updates.schoolWideExpectationLetters = [];
    } else if (Array.isArray(schoolWideExpectationLetters)) {
      const sanitized: Array<{ letter: string; word: string }> = [];
      for (const item of schoolWideExpectationLetters) {
        if (
          item &&
          typeof item === "object" &&
          typeof (item as { letter?: unknown }).letter === "string" &&
          typeof (item as { word?: unknown }).word === "string"
        ) {
          const l = (item as { letter: string }).letter.toUpperCase().slice(0, 1);
          const w = (item as { word: string }).word.slice(0, 60);
          if (l) sanitized.push({ letter: l, word: w });
        }
      }
      updates.schoolWideExpectationLetters = sanitized;
    } else {
      res
        .status(400)
        .json({ error: "schoolWideExpectationLetters must be an array or null" });
      return;
    }
  }

  // -----------------------------------------------------------------
  // Feature-flag updates. Loaded staff row is reused so we only hit the
  // DB once even when several flags arrive in the same payload.
  // -----------------------------------------------------------------
  const incomingFeatureFields: Array<{
    key: FeatureKey;
    isSuper: boolean;
    value: unknown;
    bodyKey: string;
  }> = [];
  for (const k of FEATURE_KEYS) {
    const adminKey = `feature${k}`;
    const superKey = `superFeature${k}`;
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, adminKey)) {
      incomingFeatureFields.push({
        key: k,
        isSuper: false,
        value: (req.body as Record<string, unknown>)[adminKey],
        bodyKey: adminKey,
      });
    }
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, superKey)) {
      incomingFeatureFields.push({
        key: k,
        isSuper: true,
        value: (req.body as Record<string, unknown>)[superKey],
        bodyKey: superKey,
      });
    }
  }

  if (incomingFeatureFields.length > 0) {
    const staffId = req.staffId;
    let me: typeof staffTable.$inferSelect | undefined;
    if (staffId) {
      const [s] = await db
        .select()
        .from(staffTable)
        .where(eq(staffTable.id, staffId));
      me = s;
    }
    const isAdminUser = Boolean(me?.active && (me?.isAdmin || me?.isSuperUser));
    const isSuperUser = Boolean(me?.active && me?.isSuperUser);

    for (const f of incomingFeatureFields) {
      if (typeof f.value !== "boolean") {
        res
          .status(400)
          .json({ error: `${f.bodyKey} must be a boolean` });
        return;
      }
      if (f.isSuper) {
        // Same unchanged-value escape hatch the admin branch uses: the
        // client always sends the full settings object, so an admin
        // submitting plain settings would otherwise 403 just for
        // round-tripping the SuperUser-only fields untouched.
        const currentSuper = Boolean(current[superCol(f.key)]);
        if (f.value === currentSuper) {
          continue;
        }
        if (!isSuperUser) {
          res.status(403).json({
            error: `Only a SuperUser may change ${f.bodyKey}`,
          });
          return;
        }
        (updates as Record<string, unknown>)[
          superCol(f.key) as string
        ] = f.value;
      } else {
        if (!isAdminUser) {
          res.status(403).json({
            error: `Only an admin or SuperUser may change ${f.bodyKey}`,
          });
          return;
        }
        // Admin enable is only permitted when the SuperUser flag is on.
        // Important: skip this check when the admin field's value is
        // *unchanged* from the current DB row. The client sends the
        // whole settings object on every save, so a SuperUser flipping
        // super_X off while the admin checkbox stays at its existing
        // (true) value would otherwise be 403-rejected for what is
        // effectively a no-op on the admin column.
        const currentAdmin = Boolean(current[adminCol(f.key)]);
        const adminChanged = f.value !== currentAdmin;
        if (adminChanged && f.value === true) {
          const incomingSuperVal = incomingFeatureFields.find(
            (x) => x.isSuper && x.key === f.key,
          )?.value;
          const supersededBy =
            typeof incomingSuperVal === "boolean"
              ? incomingSuperVal
              : Boolean(current[superCol(f.key)]);
          if (!supersededBy) {
            res.status(403).json({
              error: `Cannot enable ${f.bodyKey}: feature is disabled by SuperUser for this school`,
            });
            return;
          }
        }
        if (adminChanged) {
          (updates as Record<string, unknown>)[
            adminCol(f.key) as string
          ] = f.value;
        }
      }
    }
  }

  if (Object.keys(updates).length === 0) {
    res.json(withEffective(current));
    return;
  }

  // Always scope by both id AND schoolId — defensive, in case the
  // settings row id ever leaks across schools.
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
  res.json(withEffective(updated));
});

export default router;
