import { Router, type IRouter } from "express";
import { db, schoolSettingsTable, staffTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { bindObjectToSchool } from "./storage.js";
import { isCoreTeam } from "../lib/coreTeam.js";
import { reconcileSchoolYearFlip } from "../lib/schoolYearFlip.js";
import { clearMfaPolicyCache } from "../lib/mfaPolicyCache.js";
import { writeAuthAudit } from "../lib/authAudit.js";

const router: IRouter = Router();

// Six per-school feature flags. The two-tier model means each feature has
// both an admin-controlled `feature_*` column and a SuperUser-controlled
// `super_feature_*` column. A feature is "effective" only when both are
// true. Centralizing the list here keeps the GET enrichment, the PUT
// validation, and the response-side `effectiveFeatures` map in sync.
// Centralized list of every per-school feature flag. Keep in sync with
// the columns in lib/db/src/schema/schoolSettings.ts and with the
// client-side `effectiveFeatures` map in App.tsx. Adding a key here
// automatically wires GET enrichment, PUT validation, and the
// `/superuser/school-plans` PATCH validator.
export const FEATURE_KEYS = [
  "FamilyComm",
  "Pbis",
  "SchoolStore",
  "SchoolStoreNotify",
  "Accommodations",
  "LogIntervention",
  "RequestPullout",
  "HallPasses",
  "TardyPass",
  "MtssPlans",
  "BehaviorSpecialist",
  "IssDashboard",
  "Displays",
  "BellSchedule",
  "EarlyWarning",
  "Academics",
  "DataImports",
  "Houses",
  "ParentPortal",
  "AcademicEvidence",
  "Eligibility",
  "DataChats",
  "Pickup",
  "Ticketing",
  "Tours",
  "Esign",
  "BrainLab",
  "Gradebook",
  "SchoolGrade",
  "SafetyPlans",
  "AiAssist",
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
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

// Fields a non-admin may change here — each ALSO carries its own per-field
// role check below (e.g. a PBIS coordinator adjusting intervention windows).
// Every other setting is admin-only. Without this base gate, any authenticated
// staff member (incl. a plain teacher) could persist the ungated fields
// (schoolName, hall-pass limits, kiosk welcome text, security toggles, ...).
const NON_ADMIN_SETTINGS_FIELDS = new Set<string>([
  "interventionEffectivenessDays",
  "pbisNegativeAffectsTotal",
  "schoolStoreInventoryMode",
  "issDailyCapacity",
  "issCapacityBehavior",
]);

router.put("/school-settings", async (req, res): Promise<void> => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  // Base authorization: school settings is an admin surface. Non-admins are
  // permitted only when every submitted field is in the coordinator allowlist
  // (the per-field checks below then enforce the exact role). This closes the
  // broken-access-control gap where ungated fields were writable by any staff.
  {
    const actorId = req.staffId;
    let actor:
      | {
          isAdmin: boolean | null;
          isDistrictAdmin: boolean | null;
          isSuperUser: boolean | null;
          active: boolean | null;
        }
      | undefined;
    if (actorId) {
      [actor] = await db
        .select({
          isAdmin: staffTable.isAdmin,
          isDistrictAdmin: staffTable.isDistrictAdmin,
          isSuperUser: staffTable.isSuperUser,
          active: staffTable.active,
        })
        .from(staffTable)
        .where(eq(staffTable.id, actorId));
    }
    const isSettingsAdmin = Boolean(
      actor &&
        actor.active &&
        (actor.isAdmin || actor.isDistrictAdmin || actor.isSuperUser),
    );
    if (!isSettingsAdmin) {
      const disallowed = Object.keys(req.body ?? {}).filter(
        (k) => !NON_ADMIN_SETTINGS_FIELDS.has(k),
      );
      if (disallowed.length > 0) {
        res
          .status(403)
          .json({ error: "Only a school admin may change school settings." });
        return;
      }
    }
  }
  const current = await getOrCreate(schoolId);
  const {
    schoolName,
    fromName,
    emailSignature,
    periodCount,
    hallPassMaxMinutes,
    hallPassDefaultMinutes,
    hallPassAutoEndMinutes,
    globalDailyHallPassLimit,
    pbisQuietTeacherDays,
    pbisInvisibleStudentDays,
    pbisInvisibleDaysTier1,
    pbisInvisibleDaysTier2,
    pbisInvisibleDaysTier3,
    pbisReasonImbalancePct,
    pbisColdPeriodMultiple,
    interventionEffectivenessDays,
    pbisNegativeAffectsTotal,
    schoolWideExpectationAcronym,
    schoolWideExpectationLetters,
    issDailyCapacity,
    issCapacityBehavior,
    finderShowAbsentBanner,
    staffDirectoryShowCellPhone,
    manualRosterUploadEnabled,
    strictHouseNameMatch,
    notifyParentEligibility,
    notifyParentPbisMilestone,
    notifyParentTardy,
    notifyParentEventTickets,
    notifyParentEsign,
    tourFamilyNurtureEnabled,
    pickupCutoffTime,
    pickupTeacherViewScope,
    pickupInCarStepEnabled,
    pickupWalkedOutDisplaySeconds,
    kioskWelcomeTemplate,
    kioskWelcomeMessages,
    workweekStart,
    compTimeRequireAuthForm,
    compTimeAuthFormObjectKey,
    fastHistoryYearsVisible,
    restroomAccessControlEnabled,
    ireadyAp1Cuts,
    onTimeAttendanceEnabled,
    onTimeMaxPoints,
    onTimeLotteryEnabled,
    onTimeLotteryLabel,
    onTimeLotteryBonusPoints,
    onTimeLotteryRevealLeadMinutes,
    schoolStoreInventoryMode,
    gpaEnabled,
    teacherFamilyMessagingEnabled,
    watchlistAbsenceThreshold,
    watchlistBehaviorThreshold,
    watchlistTardyThreshold,
    watchlistIssThreshold,
    mfaRequiredPrivileged,
    mfaRequiredStaff,
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
  if (hallPassAutoEndMinutes !== undefined) {
    if (
      typeof hallPassAutoEndMinutes !== "number" ||
      !Number.isInteger(hallPassAutoEndMinutes) ||
      hallPassAutoEndMinutes < 1 ||
      hallPassAutoEndMinutes > 240
    ) {
      res.status(400).json({
        error: "hallPassAutoEndMinutes must be an integer between 1 and 240",
      });
      return;
    }
    updates.hallPassAutoEndMinutes = hallPassAutoEndMinutes;
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
      "pbisInvisibleDaysTier1",
      pbisInvisibleDaysTier1,
      1,
      180,
      "pbisInvisibleDaysTier1",
    ),
    intRange(
      "pbisInvisibleDaysTier2",
      pbisInvisibleDaysTier2,
      1,
      180,
      "pbisInvisibleDaysTier2",
    ),
    intRange(
      "pbisInvisibleDaysTier3",
      pbisInvisibleDaysTier3,
      1,
      180,
      "pbisInvisibleDaysTier3",
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
    // Classroom-intervention effectiveness window. 1..90 days.
    intRange(
      "interventionEffectivenessDays",
      interventionEffectivenessDays,
      1,
      90,
      "interventionEffectivenessDays",
    ),
    // FAST history visibility (Phase 1 of Historical FAST work).
    // 2..5 — minimum 2 so the trajectory chip always has at least
    // a prior year to compare against; 5 cap matches the FAST launch
    // (FL 22-23). Older imports stay dormant.
    intRange(
      "fastHistoryYearsVisible",
      fastHistoryYearsVisible,
      2,
      5,
      "fastHistoryYearsVisible",
    ),
    // On-Time Attendance — max points awarded for the earliest passing-window
    // scan (the ceil(min-until-bell) value is capped at this).
    intRange("onTimeMaxPoints", onTimeMaxPoints, 1, 10, "onTimeMaxPoints"),
    // Tardy Lottery — bonus points each winner receives, and how many minutes
    // before end-of-day the draw is revealed.
    intRange(
      "onTimeLotteryBonusPoints",
      onTimeLotteryBonusPoints,
      1,
      500,
      "onTimeLotteryBonusPoints",
    ),
    intRange(
      "onTimeLotteryRevealLeadMinutes",
      onTimeLotteryRevealLeadMinutes,
      5,
      240,
      "onTimeLotteryRevealLeadMinutes",
    ),
    // Watch List (Insights) "Needs Attention" thresholds. Any settings-
    // manager (the gate on the Settings page itself) may tune these — they
    // only affect which students the Watch List surfaces by default.
    intRange(
      "watchlistAbsenceThreshold",
      watchlistAbsenceThreshold,
      1,
      180,
      "watchlistAbsenceThreshold",
    ),
    intRange(
      "watchlistBehaviorThreshold",
      watchlistBehaviorThreshold,
      1,
      100,
      "watchlistBehaviorThreshold",
    ),
    intRange(
      "watchlistTardyThreshold",
      watchlistTardyThreshold,
      1,
      100,
      "watchlistTardyThreshold",
    ),
    intRange(
      "watchlistIssThreshold",
      watchlistIssThreshold,
      1,
      100,
      "watchlistIssThreshold",
    ),
  ]) {
    if (err) {
      res.status(400).json({ error: err });
      return;
    }
  }

  // The intervention effectiveness window is a school-wide PBIS policy. Only
  // admins / PBIS coordinators / behavior specialists may change it — same gate
  // as `pbisNegativeAffectsTotal`. `intRange` above already wrote the value into
  // `updates`, so reject here (before the DB write) for unprivileged staff.
  if (interventionEffectivenessDays !== undefined) {
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
      res.status(403).json({
        error:
          "Only admin, PBIS coordinator, or behavior specialist may change this",
      });
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

  // School Store inventory mode — `simple` (in-stock boolean) vs `quantity`
  // (tracked on-hand counts). School-wide PBIS-store policy, so it shares the
  // admin / PBIS coordinator / behavior specialist gate. Validated enum.
  if (schoolStoreInventoryMode !== undefined) {
    if (
      schoolStoreInventoryMode !== "simple" &&
      schoolStoreInventoryMode !== "quantity"
    ) {
      res.status(400).json({
        error: "schoolStoreInventoryMode must be 'simple' or 'quantity'",
      });
      return;
    }
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
      res.status(403).json({
        error:
          "Only admin, PBIS coordinator, or behavior specialist may change this",
      });
      return;
    }
    updates.schoolStoreInventoryMode = schoolStoreInventoryMode;
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
  // ISS daily capacity + behavior. Soft = warn but allow override; hard
  // = block creation when full. Capacity null = no limit.
  // School-wide ISS policy — only admins / Dean / Behavior Specialist /
  // MTSS Coordinator may flip these. Other authenticated staff get
  // rejected before any write happens.
  // -----------------------------------------------------------------
  if (issDailyCapacity !== undefined || issCapacityBehavior !== undefined) {
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
          s.isDean ||
          s.isBehaviorSpecialist ||
          s.isMtssCoordinator)
      ) {
        allowed = true;
      }
    }
    if (!allowed) {
      res.status(403).json({
        error:
          "Only admin, Dean, Behavior Specialist, or MTSS Coordinator may change ISS settings",
      });
      return;
    }
  }
  if (issDailyCapacity !== undefined) {
    if (issDailyCapacity === null) {
      updates.issDailyCapacity = null;
    } else if (
      typeof issDailyCapacity !== "number" ||
      !Number.isInteger(issDailyCapacity) ||
      issDailyCapacity < 0 ||
      issDailyCapacity > 1000
    ) {
      res.status(400).json({
        error: "issDailyCapacity must be null or an integer between 0 and 1000",
      });
      return;
    } else {
      updates.issDailyCapacity = issDailyCapacity;
    }
  }
  // Finder absent-banner toggle. School-wide policy — anyone who can
  // already manage School Settings can flip it; no extra role gate beyond
  // the page itself. Boolean only.
  if (finderShowAbsentBanner !== undefined) {
    if (typeof finderShowAbsentBanner !== "boolean") {
      res
        .status(400)
        .json({ error: "finderShowAbsentBanner must be a boolean" });
      return;
    }
    updates.finderShowAbsentBanner = finderShowAbsentBanner;
  }
  // Staff Directory cell-phone visibility toggle. School-wide policy —
  // any settings-manager can flip it. Boolean only.
  if (manualRosterUploadEnabled !== undefined) {
    if (typeof manualRosterUploadEnabled !== "boolean") {
      res
        .status(400)
        .json({ error: "manualRosterUploadEnabled must be a boolean" });
      return;
    }
    updates.manualRosterUploadEnabled = manualRosterUploadEnabled;
  }
  if (strictHouseNameMatch !== undefined) {
    if (typeof strictHouseNameMatch !== "boolean") {
      res
        .status(400)
        .json({ error: "strictHouseNameMatch must be a boolean" });
      return;
    }
    updates.strictHouseNameMatch = strictHouseNameMatch;
  }
  // Restroom Access Control on/off. School-wide policy — any settings-
  // manager can flip it (same gate as the rest of this PUT). Boolean only.
  if (restroomAccessControlEnabled !== undefined) {
    if (typeof restroomAccessControlEnabled !== "boolean") {
      res
        .status(400)
        .json({ error: "restroomAccessControlEnabled must be a boolean" });
      return;
    }
    updates.restroomAccessControlEnabled = restroomAccessControlEnabled;
  }

  // MFA enforcement policy (Gate A / Section 1) — a security control, so only
  // Admin / District Admin / SuperUser may change it (not every settings
  // editor). Both flags default FALSE; turning one on requires MFA at login
  // for that tier (privileged = SuperUser/District Admin/School Admin).
  if (mfaRequiredPrivileged !== undefined || mfaRequiredStaff !== undefined) {
    const [actor] = req.staffId
      ? await db
          .select({
            isAdmin: staffTable.isAdmin,
            isDistrictAdmin: staffTable.isDistrictAdmin,
            isSuperUser: staffTable.isSuperUser,
          })
          .from(staffTable)
          .where(eq(staffTable.id, req.staffId))
          .limit(1)
      : [];
    if (!actor || !(actor.isAdmin || actor.isDistrictAdmin || actor.isSuperUser)) {
      res
        .status(403)
        .json({ error: "Only an admin can change two-factor policy." });
      return;
    }
    if (mfaRequiredPrivileged !== undefined) {
      if (typeof mfaRequiredPrivileged !== "boolean") {
        res
          .status(400)
          .json({ error: "mfaRequiredPrivileged must be a boolean" });
        return;
      }
      updates.mfaRequiredPrivileged = mfaRequiredPrivileged;
    }
    if (mfaRequiredStaff !== undefined) {
      if (typeof mfaRequiredStaff !== "boolean") {
        res.status(400).json({ error: "mfaRequiredStaff must be a boolean" });
        return;
      }
      updates.mfaRequiredStaff = mfaRequiredStaff;
    }
  }
  if (staffDirectoryShowCellPhone !== undefined) {
    if (typeof staffDirectoryShowCellPhone !== "boolean") {
      res
        .status(400)
        .json({ error: "staffDirectoryShowCellPhone must be a boolean" });
      return;
    }
    updates.staffDirectoryShowCellPhone = staffDirectoryShowCellPhone;
  }
  // -----------------------------------------------------------------
  // Parent Notifications panel (Family Communication). ADMIN-ONLY master
  // switches for each automated/recurring parent notification. These are a
  // stricter gate than the rest of this PUT (settings-managers cannot flip
  // them) because they decide what external email families receive.
  // tourFamilyNurtureEnabled is REUSED here (also editable from Tours
  // settings) so the panel drives it on the same save — both paths write
  // the one column, so they stay in sync.
  // -----------------------------------------------------------------
  const parentNotifyFields: Array<[string, unknown]> = [
    ["notifyParentEligibility", notifyParentEligibility],
    ["notifyParentPbisMilestone", notifyParentPbisMilestone],
    ["notifyParentTardy", notifyParentTardy],
    ["notifyParentEventTickets", notifyParentEventTickets],
    ["notifyParentEsign", notifyParentEsign],
    ["tourFamilyNurtureEnabled", tourFamilyNurtureEnabled],
  ];
  if (parentNotifyFields.some(([, v]) => v !== undefined)) {
    let notifyActor: typeof staffTable.$inferSelect | undefined;
    if (req.staffId) {
      const [s] = await db
        .select()
        .from(staffTable)
        .where(eq(staffTable.id, req.staffId));
      notifyActor = s;
    }
    const isAdminUser = Boolean(
      notifyActor?.active &&
        (notifyActor?.isAdmin || notifyActor?.isSuperUser),
    );
    if (!isAdminUser) {
      res.status(403).json({
        error: "Only an admin may change parent notification settings",
      });
      return;
    }
    for (const [key, val] of parentNotifyFields) {
      if (val === undefined) continue;
      if (typeof val !== "boolean") {
        res.status(400).json({ error: `${key} must be a boolean` });
        return;
      }
      (updates as Record<string, unknown>)[key] = val;
    }
  }
  // -----------------------------------------------------------------
  // On-Time Attendance + Tardy Lottery toggles and the lottery label.
  // Any settings-manager can flip these (same gate as the rest of the
  // PUT); the int-valued knobs are validated in the intRange block above.
  // -----------------------------------------------------------------
  if (onTimeAttendanceEnabled !== undefined) {
    if (typeof onTimeAttendanceEnabled !== "boolean") {
      res
        .status(400)
        .json({ error: "onTimeAttendanceEnabled must be a boolean" });
      return;
    }
    updates.onTimeAttendanceEnabled = onTimeAttendanceEnabled;
  }
  if (onTimeLotteryEnabled !== undefined) {
    if (typeof onTimeLotteryEnabled !== "boolean") {
      res
        .status(400)
        .json({ error: "onTimeLotteryEnabled must be a boolean" });
      return;
    }
    updates.onTimeLotteryEnabled = onTimeLotteryEnabled;
  }
  // -----------------------------------------------------------------
  // GPA display toggle. School-wide policy that decides whether the
  // unweighted 4.0 GPA is computed + surfaced anywhere (Student Profile,
  // Snapshot, parent comms). CORE TEAM (or admin/SuperUser) only — a
  // stricter gate than the rest of this PUT — since it changes what an
  // academic metric every staff member sees. Boolean only. Default OFF.
  // -----------------------------------------------------------------
  if (gpaEnabled !== undefined) {
    if (typeof gpaEnabled !== "boolean") {
      res.status(400).json({ error: "gpaEnabled must be a boolean" });
      return;
    }
    // Only CHANGING the flag requires Core Team. The bulk settings save
    // (sent by any settings-manager) echoes the current value back; gating
    // on change keeps that save from 403-ing while still blocking a real
    // flip by a non-Core-Team actor.
    if (gpaEnabled !== current.gpaEnabled) {
      let gpaActor: typeof staffTable.$inferSelect | undefined;
      if (req.staffId) {
        const [s] = await db
          .select()
          .from(staffTable)
          .where(eq(staffTable.id, req.staffId));
        gpaActor = s;
      }
      if (!(gpaActor?.active && isCoreTeam(gpaActor))) {
        res.status(403).json({
          error: "Only Core Team may change the GPA setting",
        });
        return;
      }
      updates.gpaEnabled = gpaEnabled;
    }
  }
  // -----------------------------------------------------------------
  // Teacher Family Messaging permission. Admin-controlled opt-in that lets
  // non-Core-Team teachers send Family Messages to their OWN periods/students.
  // ADMIN-ONLY (stricter than the bulk save) — gate on CHANGE so the echo-back
  // bulk save by any settings-manager doesn't 403. Boolean only. Default OFF.
  // -----------------------------------------------------------------
  if (teacherFamilyMessagingEnabled !== undefined) {
    if (typeof teacherFamilyMessagingEnabled !== "boolean") {
      res.status(400).json({
        error: "teacherFamilyMessagingEnabled must be a boolean",
      });
      return;
    }
    if (teacherFamilyMessagingEnabled !== current.teacherFamilyMessagingEnabled) {
      let tfmActor: typeof staffTable.$inferSelect | undefined;
      if (req.staffId) {
        const [s] = await db
          .select()
          .from(staffTable)
          .where(eq(staffTable.id, req.staffId));
        tfmActor = s;
      }
      const isAdminUser = Boolean(
        tfmActor?.active && (tfmActor?.isAdmin || tfmActor?.isSuperUser),
      );
      if (!isAdminUser) {
        res.status(403).json({
          error: "Only an admin may change teacher Family Messaging",
        });
        return;
      }
      updates.teacherFamilyMessagingEnabled = teacherFamilyMessagingEnabled;
    }
  }
  if (onTimeLotteryLabel !== undefined) {
    if (typeof onTimeLotteryLabel !== "string") {
      res
        .status(400)
        .json({ error: "onTimeLotteryLabel must be a string" });
      return;
    }
    const cleaned = onTimeLotteryLabel.trim().slice(0, 60);
    // Non-null column with a default — empty resets to the default label.
    updates.onTimeLotteryLabel =
      cleaned.length === 0 ? "On-Time Champions" : cleaned;
  }
  // Pick-Up cutoff time: "HH:MM" 24h, validated lexically. Used by the
  // Admin Hub "Still on campus" reconciliation tile and (eventually)
  // QR signed-token expiry. Any settings-manager can flip it.
  if (pickupCutoffTime !== undefined) {
    if (
      typeof pickupCutoffTime !== "string" ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(pickupCutoffTime)
    ) {
      res
        .status(400)
        .json({ error: "pickupCutoffTime must be HH:MM (24h)" });
      return;
    }
    updates.pickupCutoffTime = pickupCutoffTime;
  }
  // Pick-Up teacher-view scope: controls what /pickup/teacher returns
  // and what releases that page is allowed to write.
  if (pickupTeacherViewScope !== undefined) {
    if (
      pickupTeacherViewScope !== "all_students" &&
      pickupTeacherViewScope !== "own_roster"
    ) {
      res.status(400).json({
        error:
          "pickupTeacherViewScope must be 'all_students' or 'own_roster'",
      });
      return;
    }
    updates.pickupTeacherViewScope = pickupTeacherViewScope;
  }
  // "In car" terminal step toggle. When false, walking_out becomes the
  // terminal staff action and rows drop from the live display after
  // pickupWalkedOutDisplaySeconds. The release event itself is kept
  // in the audit log forever.
  if (pickupInCarStepEnabled !== undefined) {
    if (typeof pickupInCarStepEnabled !== "boolean") {
      res
        .status(400)
        .json({ error: "pickupInCarStepEnabled must be a boolean" });
      return;
    }
    updates.pickupInCarStepEnabled = pickupInCarStepEnabled;
  }
  if (pickupWalkedOutDisplaySeconds !== undefined) {
    if (
      typeof pickupWalkedOutDisplaySeconds !== "number" ||
      !Number.isInteger(pickupWalkedOutDisplaySeconds) ||
      pickupWalkedOutDisplaySeconds < 60 ||
      pickupWalkedOutDisplaySeconds > 1800
    ) {
      res.status(400).json({
        error:
          "pickupWalkedOutDisplaySeconds must be an integer between 60 and 1800",
      });
      return;
    }
    updates.pickupWalkedOutDisplaySeconds = pickupWalkedOutDisplaySeconds;
  }
  if (issCapacityBehavior !== undefined) {
    if (issCapacityBehavior !== "soft" && issCapacityBehavior !== "hard") {
      res
        .status(400)
        .json({ error: "issCapacityBehavior must be 'soft' or 'hard'" });
      return;
    }
    updates.issCapacityBehavior = issCapacityBehavior;
  }

  // -----------------------------------------------------------------
  // Kiosk welcome template + per-house overrides (Phase 3).
  // Length-capped to prevent runaway storage / signage layouts; any
  // settings-manager can edit (same gate as the rest of this PUT).
  // -----------------------------------------------------------------
  if (kioskWelcomeTemplate !== undefined) {
    if (typeof kioskWelcomeTemplate !== "string") {
      res
        .status(400)
        .json({ error: "kioskWelcomeTemplate must be a string" });
      return;
    }
    // Hard-reject overlong templates instead of silently truncating so
    // the editor surfaces the issue (truncation hid mistakes in the
    // per-house preview).
    if (kioskWelcomeTemplate.length > 240) {
      res.status(400).json({
        error: "kioskWelcomeTemplate must be 240 characters or fewer",
      });
      return;
    }
    const cleaned = kioskWelcomeTemplate.trim();
    updates.kioskWelcomeTemplate =
      cleaned.length === 0 ? "Welcome, {firstName}!" : cleaned;
  }
  if (kioskWelcomeMessages !== undefined) {
    if (
      kioskWelcomeMessages === null ||
      typeof kioskWelcomeMessages !== "object" ||
      Array.isArray(kioskWelcomeMessages)
    ) {
      if (kioskWelcomeMessages === null) {
        updates.kioskWelcomeMessages = {};
      } else {
        res.status(400).json({
          error: "kioskWelcomeMessages must be an object or null",
        });
        return;
      }
    } else {
      const sanitized: Record<string, string> = {};
      for (const [k, v] of Object.entries(
        kioskWelcomeMessages as Record<string, unknown>,
      )) {
        if (typeof v !== "string") continue;
        // Same hard-reject as the default template — surface mistakes
        // rather than silently truncating per-house overrides.
        if (v.length > 240) {
          res.status(400).json({
            error: `kioskWelcomeMessages[${k}] must be 240 characters or fewer`,
          });
          return;
        }
        const cleaned = v.trim();
        if (cleaned.length === 0) continue;
        // House id key is stringified integer; ignore anything else.
        if (!/^\d+$/.test(k)) continue;
        sanitized[k] = cleaned;
      }
      updates.kioskWelcomeMessages = sanitized;
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

  // Time Tracking settings (shared by AST + Comp Time). Admin only —
  // these are policy controls that govern FLSA-relevant overtime
  // accrual for the whole school. Non-admin role changes here are
  // rejected even though the other settings on this PUT are typically
  // unrestricted (their UI is gated client-side).
  if (
    workweekStart !== undefined ||
    compTimeRequireAuthForm !== undefined ||
    compTimeAuthFormObjectKey !== undefined
  ) {
    const staffId = req.staffId;
    let meRow: typeof staffTable.$inferSelect | undefined;
    if (staffId) {
      [meRow] = await db
        .select()
        .from(staffTable)
        .where(eq(staffTable.id, staffId));
    }
    const isPolicyAdmin = Boolean(
      meRow?.active &&
        (meRow.isAdmin || meRow.isDistrictAdmin || meRow.isSuperUser),
    );
    if (!isPolicyAdmin) {
      res.status(403).json({
        error: "forbidden",
        message: "Only admins can change Time Tracking policy settings.",
      });
      return;
    }
  }
  if (workweekStart !== undefined) {
    if (workweekStart !== "sunday" && workweekStart !== "monday") {
      res
        .status(400)
        .json({ error: "workweekStart must be 'sunday' or 'monday'" });
      return;
    }
    updates.workweekStart = workweekStart;
  }
  if (compTimeRequireAuthForm !== undefined) {
    if (typeof compTimeRequireAuthForm !== "boolean") {
      res
        .status(400)
        .json({ error: "compTimeRequireAuthForm must be boolean" });
      return;
    }
    updates.compTimeRequireAuthForm = compTimeRequireAuthForm;
  }
  if (compTimeAuthFormObjectKey !== undefined) {
    if (
      compTimeAuthFormObjectKey !== null &&
      typeof compTimeAuthFormObjectKey !== "string"
    ) {
      res.status(400).json({
        error: "compTimeAuthFormObjectKey must be a string or null",
      });
      return;
    }
    if (compTimeAuthFormObjectKey) {
      // Bind the freshly-uploaded object to this school's ACL so the
      // PDF can only be served to staff of this school and can't be
      // a spoofed cross-tenant path.
      const bound = await bindObjectToSchool(
        compTimeAuthFormObjectKey,
        schoolId,
      );
      if (!bound) {
        res.status(400).json({
          error: "compTimeAuthFormObjectKey_invalid",
          message:
            "Uploaded template could not be verified. Please re-upload.",
        });
        return;
      }
    }
    updates.compTimeAuthFormObjectKey = compTimeAuthFormObjectKey || null;
  }

  if (ireadyAp1Cuts !== undefined) {
    // Per-grade, per-subject iReady AP1 cut scores. Shape:
    // { ela: { "6": 480, ... }, math: { "7": 500, ... } }. Validate
    // each value is a finite positive integer and keys are plain grade
    // strings; drop anything malformed so a bad client can't poison the
    // map. An empty value for a grade clears that cut.
    if (
      typeof ireadyAp1Cuts !== "object" ||
      ireadyAp1Cuts === null ||
      Array.isArray(ireadyAp1Cuts)
    ) {
      res.status(400).json({ error: "ireadyAp1Cuts must be an object" });
      return;
    }
    const clean: { ela: Record<string, number>; math: Record<string, number> } =
      { ela: {}, math: {} };
    for (const subject of ["ela", "math"] as const) {
      const raw = (ireadyAp1Cuts as Record<string, unknown>)[subject];
      if (raw == null) continue;
      if (typeof raw !== "object" || Array.isArray(raw)) {
        res.status(400).json({
          error: `ireadyAp1Cuts.${subject} must be a grade→score map`,
        });
        return;
      }
      for (const [grade, value] of Object.entries(
        raw as Record<string, unknown>,
      )) {
        if (!/^\d{1,2}$/.test(grade)) continue;
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value <= 0 ||
          value > 1000
        ) {
          continue;
        }
        clean[subject][grade] = value;
      }
    }
    updates.ireadyAp1Cuts = clean;
  }

  // School-controlled school-year "flip" date (YYYY-MM-DD, school-local) —
  // admin/SuperUser only. Advances the FAST/Insights reporting year on/after
  // the date; null clears/postpones. Enforced inline (this route has no
  // route-level admin guard). Reconciled below after the row persists.
  if ("schoolYearFlipDate" in (req.body ?? {})) {
    const staffId = req.staffId;
    let flipActor: typeof staffTable.$inferSelect | undefined;
    if (staffId) {
      const [s] = await db
        .select()
        .from(staffTable)
        .where(eq(staffTable.id, staffId));
      flipActor = s;
    }
    const isAdminUser = Boolean(
      flipActor?.active && (flipActor?.isAdmin || flipActor?.isSuperUser),
    );
    if (!isAdminUser) {
      res.status(403).json({
        error: "Only an admin may schedule the school-year flip",
      });
      return;
    }
    const raw = req.body.schoolYearFlipDate;
    if (raw === null || raw === "") {
      updates.schoolYearFlipDate = null;
    } else if (
      typeof raw === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())
    ) {
      updates.schoolYearFlipDate = raw.trim();
    } else {
      res.status(400).json({
        error: "schoolYearFlipDate must be YYYY-MM-DD or null",
      });
      return;
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

  // A change to the MFA policy flags must take effect immediately, not after
  // the enrollment gate's cache TTL — drop the cached decisions now.
  if ("mfaRequiredPrivileged" in updates || "mfaRequiredStaff" in updates) {
    clearMfaPolicyCache();
    const [actor] = req.staffId
      ? await db
          .select({ name: staffTable.displayName })
          .from(staffTable)
          .where(eq(staffTable.id, req.staffId))
      : [];
    await writeAuthAudit({
      action: "mfa_policy_changed",
      schoolId,
      actorStaffId: req.staffId ?? null,
      actorName: actor?.name ?? null,
      ip: req.ip ?? null,
      payload: {
        ...("mfaRequiredPrivileged" in updates
          ? { mfaRequiredPrivileged: updated?.mfaRequiredPrivileged }
          : {}),
        ...("mfaRequiredStaff" in updates
          ? { mfaRequiredStaff: updated?.mfaRequiredStaff }
          : {}),
      },
    });
  }

  // A flip-date change may activate or reverse the reporting-year flip and
  // re-tag the outgoing year's FAST rows. Reconcile, then return the fresh
  // row so the response reflects the resulting active state.
  if ("schoolYearFlipDate" in updates) {
    await reconcileSchoolYearFlip(schoolId);
    const fresh = await getOrCreate(schoolId);
    res.json(withEffective(fresh));
    return;
  }

  res.json(withEffective(updated));
});

export default router;
