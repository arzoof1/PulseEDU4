// Intensive Group Insights — Phase A (suggestion) + Phase B (insights).
//
// Routes (all admin/Core-Team gated; read-only on existing tables):
//
//   GET /api/intensive-groups/windows?subject=
//        → list of {schoolYear, window, label} this school has data
//          for in the given subject, newest first.
//
//   GET /api/intensive-groups/suggest
//          ?subject=&grade=&sections=N&seats=S
//          &schoolYear=&window=&eligibilityMaxPct=70
//        → N proposed groups built from FAST item responses. Read-
//          only; nothing is persisted.
//
//   GET /api/intensive-groups/insights?sectionId=
//        → group profile + sub-groups + homogeneity score + drift
//          for the section's CURRENTLY-ENROLLED roster. Reads from
//          section_roster (which is rebuilt from RosterOne).
//
//   GET /api/intensive-groups/sections
//        → all intensive sections at this school (course-name
//          heuristic), grouped by teacher. Powers the Class
//          Composer + the teacher tab's "switch section" picker.

import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  classSectionsTable,
  sectionRosterTable,
  staffTable,
  studentsTable,
  studentFastItemResponsesTable,
  studentFastScoresTable,
  schoolSettingsTable,
  schoolsTable,
  classComposerPlansTable,
  classComposerPlanGroupsTable,
  classComposerPlanGroupRefreshesTable,
  studentMtssPlansTable,
  safetyPlansTable,
  studentRetentionsTable,
  ossLogsTable,
  issAdminLogsTable,
  type ClassComposerFocusStandard,
  type ClassComposerRefreshDriftSummary,
  type ClassComposerGroupRecipe,
  type ClassComposerPlanRow,
  type ClassComposerPlanGroupRow,
} from "@workspace/db";
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import {
  isCoreTeam as isCoreTeamShared,
  canEditSafetyPlan,
} from "../lib/coreTeam.js";
import { renderComposerPlanPdf } from "../lib/composerPlanPdf.js";
import { schoolYearLabelFor, DEFAULT_SCHOOL_TZ } from "../lib/schoolYear.js";
import { getActiveSchoolYear } from "../lib/fastHistory.js";
import {
  computeSkillProfiles,
  clusterProfilesIntoGroups,
  clusterProfilesBalanced,
  clusterByBenchmarkDeficit,
  pickFocusStandards,
  deficitMoveImprovement,
  summarizeSection,
  tallyLevelMix,
  isIntensiveCourseName,
  type StudentSkillProfile,
  type SuggestedFocusStandard,
} from "../lib/skillProfile.js";
import {
  chartGradeFor,
  hasChart,
  levelMin,
  placeOnChart,
  placePm3,
  type Subject,
} from "../lib/fastCutScores.js";

const FAST_SUBJECTS_SET = new Set<Subject>(["ela", "math", "algebra1", "geometry"]);

// "Other subject" pairing for the double-counters filter. Only the
// FAST-tested ELA↔Math pair counts in school-grade accountability;
// EOC subjects don't pair this way, so doubleCounters is a no-op
// for algebra1/geometry callers.
function otherSubjectFor(subject: string): Subject | null {
  if (subject === "ela") return "math";
  if (subject === "math") return "ela";
  return null;
}

// Derive a level (1..5 | null) from a raw score for a given window
// using the same chart selection placeOnChart/placePm3 use. Mirrors
// the deriveFastLevel helper in skillProfile.ts so the route can do
// per-window level placement for double-counters + trajectory checks
// without re-fetching item responses.
function deriveLevelForWindow(
  score: number | null | undefined,
  subject: string,
  grade: number | null,
  window: string,
): 1 | 2 | 3 | 4 | 5 | null {
  if (score == null || grade == null) return null;
  if (!FAST_SUBJECTS_SET.has(subject as Subject)) return null;
  const s = subject as Subject;
  if (!hasChart(s, grade)) return null;
  const placement =
    window === "pm3" ? placePm3(score, s, grade) : placeOnChart(score, s, grade);
  return placement ? placement.level : null;
}

const router: IRouter = Router();

const VALID_SUBJECTS = new Set(["ela", "math", "algebra1", "geometry"]);
const VALID_WINDOWS = new Set(["pm1", "pm2", "pm3"]);

// -----------------------------------------------------------------------------
// PM-readiness probe — shared by the Admin Hub banner and the
// "Run Class Composer after PM upload" onboarding step.
//
// "Ready" = the school has PM3 FAST item responses for BOTH ELA and
// Math in the current school year. We pick PM3 deliberately: PM1 is
// baseline, PM2 is mid-year, PM3 is the most actionable window for
// proposing next-quarter intensive groupings.
//
// Returns { schoolYear, window, ready, subjects: ['ela','math'],
//           dismissed: boolean }. The dismissal token compares
// "<sy>|<window>" so the banner re-appears when a NEW window arrives
// even if the admin dismissed the previous one.
// -----------------------------------------------------------------------------
async function probePmReadiness(schoolId: number): Promise<{
  schoolYear: string;
  window: "pm3";
  ready: boolean;
  subjects: { ela: boolean; math: boolean };
  dismissed: boolean;
  dismissedToken: string | null;
}> {
  const schoolYear = await getActiveSchoolYear(schoolId, DEFAULT_SCHOOL_TZ);
  // Single round-trip grouped by subject. The composite index on
  // fast_item_results covers (school_id, subject, school_year, window).
  const r = await db.execute(sql`
    SELECT subject, COUNT(*)::int AS c
      FROM student_fast_item_responses
     WHERE school_id = ${schoolId}
       AND school_year = ${schoolYear}
       AND window = 'pm3'
       AND subject IN ('ela','math')
     GROUP BY subject
  `);
  const counts = new Map<string, number>();
  for (const row of r.rows as Array<{ subject: string; c: number }>) {
    counts.set(row.subject, Number(row.c ?? 0));
  }
  const ela = (counts.get("ela") ?? 0) > 0;
  const math = (counts.get("math") ?? 0) > 0;
  const ready = ela && math;

  const [settings] = await db
    .select({
      dismissed: schoolSettingsTable.classComposerBannerDismissedSy,
    })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId))
    .limit(1);
  const dismissedToken = settings?.dismissed ?? null;
  const currentToken = `${schoolYear}|pm3`;
  const dismissed = dismissedToken === currentToken;

  return {
    schoolYear,
    window: "pm3",
    ready,
    subjects: { ela, math },
    dismissed,
    dismissedToken,
  };
}

// Exposed for the onboarding step's autoCheck so it doesn't duplicate
// the readiness probe logic.
export async function isPmReadinessComplete(schoolId: number): Promise<boolean> {
  const p = await probePmReadiness(schoolId);
  return p.ready;
}

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request, res: Response): Promise<StaffRow | null> {
  if (!req.staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, req.staffId));
  if (!s || !s.active) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  return s;
}

// Admin OR Core Team (admin, BS, MTSS coord, PBIS coord, superuser).
// Plain teachers and ESE coordinators are out — same gate the rest of
// insights uses.
function canManageGroups(s: StaffRow): boolean {
  return Boolean(s.isAdmin) || isCoreTeamShared(s);
}

// Teacher tab insights are visible to the section's own teacher OR
// any Core Team member. Same gate as TeacherRosterPage's "view
// another teacher's roster".
function canViewSectionInsights(s: StaffRow, teacherStaffId: number): boolean {
  if (s.id === teacherStaffId) return true;
  return Boolean(s.isAdmin) || isCoreTeamShared(s);
}

async function pickWindow(
  req: Request,
  available: Array<{ schoolYear: string; window: string }>,
  schoolId: number,
): Promise<{ schoolYear: string; window: string }> {
  const rawWindow = req.query.window;
  const rawSY = req.query.schoolYear;
  if (
    typeof rawWindow === "string" &&
    VALID_WINDOWS.has(rawWindow) &&
    typeof rawSY === "string" &&
    rawSY.length > 0
  ) {
    return { schoolYear: rawSY, window: rawWindow };
  }
  if (available.length > 0) return available[0];
  return {
    schoolYear: await getActiveSchoolYear(schoolId, DEFAULT_SCHOOL_TZ),
    window: "pm3",
  };
}

async function listAvailableWindows(
  schoolId: number,
  subject: string,
  studentIds: string[] | null,
): Promise<Array<{ schoolYear: string; window: string; label: string }>> {
  const conds = [
    eq(studentFastItemResponsesTable.schoolId, schoolId),
    eq(studentFastItemResponsesTable.subject, subject),
  ];
  if (studentIds !== null) {
    if (studentIds.length === 0) return [];
    conds.push(inArray(studentFastItemResponsesTable.studentId, studentIds));
  }
  const rows = await db
    .selectDistinct({
      schoolYear: studentFastItemResponsesTable.schoolYear,
      window: studentFastItemResponsesTable.window,
    })
    .from(studentFastItemResponsesTable)
    .where(and(...conds));
  const rank: Record<string, number> = { pm3: 0, pm2: 1, pm1: 2 };
  rows.sort((a, b) => {
    if (a.schoolYear !== b.schoolYear) {
      return b.schoolYear.localeCompare(a.schoolYear);
    }
    return (rank[a.window] ?? 9) - (rank[b.window] ?? 9);
  });
  return rows.map((r) => ({
    schoolYear: r.schoolYear,
    window: r.window,
    label: `${r.schoolYear} ${r.window.toUpperCase()}`,
  }));
}

// ---------------------------------------------------------------------
// GET /pm-readiness — Admin Hub banner + onboarding-step probe.
// Returns whether ELA + Math PM3 are both loaded for the current SY,
// plus the per-school dismissal state. Admin/Core-Team gated.
// ---------------------------------------------------------------------
router.get("/intensive-groups/pm-readiness", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!canManageGroups(staff)) {
    res.status(403).json({ error: "Admin or Core Team required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const probe = await probePmReadiness(schoolId);
  res.json(probe);
});

// ---------------------------------------------------------------------
// POST /pm-readiness/dismiss — record dismissal for current SY+window.
// Body: {} (idempotent — token is derived server-side). Admin only.
// The banner re-appears automatically when a new window arrives.
// ---------------------------------------------------------------------
router.post("/intensive-groups/pm-readiness/dismiss", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!Boolean(staff.isAdmin) && !isCoreTeamShared(staff)) {
    res.status(403).json({ error: "Admin or Core Team required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const schoolYear = await getActiveSchoolYear(schoolId, DEFAULT_SCHOOL_TZ);
  const token = `${schoolYear}|pm3`;
  await db
    .update(schoolSettingsTable)
    .set({ classComposerBannerDismissedSy: token })
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  req.log?.info(
    { schoolId, token, by: staff.id },
    "[intensive-groups] PM banner dismissed",
  );
  res.json({ ok: true, dismissedToken: token });
});

// ---------------------------------------------------------------------
// GET /skillcluster-banners — Admin Hub banner probe for the
// PM1/PM2/PM3 refresh workflow.
//
// Returns an array of banner objects (zero, one, two, or three) for
// the current school year. A banner appears when ALL hold:
//   (a) FAST item data is loaded for that PM window for at least one
//       subject covered by an active skill-cluster plan;
//   (b) ≥1 finalized (or draft, post-lock) skill-cluster plan exists
//       at this school for the current school year — without one,
//       there are no rosters to refresh focus standards against;
//   (c) the token "<schoolYear>|<pmWindow>|skillcluster_refresh"
//       is NOT in school_settings.skillcluster_banner_dismissals.
//
// Banner copy varies by window:
//   pm1 → "review schedule fit" (drift / sanity-check workflow)
//   pm2 → "refresh focus standards"
//   pm3 → "refresh focus standards"
// ---------------------------------------------------------------------
router.get("/intensive-groups/skillcluster-banners", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!canManageGroups(staff)) {
    res.status(403).json({ error: "Admin or Core Team required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const schoolYear = await getActiveSchoolYear(schoolId, DEFAULT_SCHOOL_TZ);

  // (b) active skill-cluster plans this SY. We scan plan rows by SY
  // then filter by group recipe.mode in code because recipe is JSONB
  // — keeps the query simple and the index hot path on
  // (school_id, subject, grade, school_year).
  const plans = await db
    .select({
      id: classComposerPlansTable.id,
      subject: classComposerPlansTable.subject,
    })
    .from(classComposerPlansTable)
    .where(
      and(
        eq(classComposerPlansTable.schoolId, schoolId),
        eq(classComposerPlansTable.schoolYear, schoolYear),
      ),
    );
  let subjectsWithSkillcluster = new Set<string>();
  if (plans.length > 0) {
    const planIds = plans.map((p) => p.id);
    const groups = await db
      .select({
        planId: classComposerPlanGroupsTable.planId,
        recipe: classComposerPlanGroupsTable.recipe,
      })
      .from(classComposerPlanGroupsTable)
      .where(
        and(
          eq(classComposerPlanGroupsTable.schoolId, schoolId),
          inArray(classComposerPlanGroupsTable.planId, planIds),
        ),
      );
    const skillPlanIds = new Set(
      groups
        .filter((g) => g.recipe?.mode === "skillcluster")
        .map((g) => g.planId),
    );
    subjectsWithSkillcluster = new Set(
      plans.filter((p) => skillPlanIds.has(p.id)).map((p) => p.subject),
    );
  }
  if (subjectsWithSkillcluster.size === 0) {
    res.json({ schoolYear, banners: [] });
    return;
  }

  // (a) FAST PM-window data for those subjects.
  const subjectList = Array.from(subjectsWithSkillcluster);
  const r = await db.execute(sql`
    SELECT subject, window, COUNT(*)::int AS c
      FROM student_fast_item_responses
     WHERE school_id = ${schoolId}
       AND school_year = ${schoolYear}
       AND window IN ('pm1','pm2','pm3')
       AND subject = ANY(${subjectList}::text[])
     GROUP BY subject, window
  `);
  const dataByWindow = new Map<string, Set<string>>();
  for (const row of r.rows as Array<{
    subject: string;
    window: string;
    c: number;
  }>) {
    if ((row.c ?? 0) <= 0) continue;
    const prior = dataByWindow.get(row.window) ?? new Set<string>();
    prior.add(row.subject);
    dataByWindow.set(row.window, prior);
  }

  // (c) dismissal state.
  const [settings] = await db
    .select({
      dismissals: schoolSettingsTable.skillclusterBannerDismissals,
    })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId))
    .limit(1);
  const dismissed = new Set<string>(settings?.dismissals ?? []);

  const COPY: Record<string, { title: string; description: string }> = {
    pm1: {
      title: "PM1 complete — review schedule fit",
      description:
        "Check whether any skill-cluster students would now fit better in a different group. Rosters won't auto-shuffle — suggestions only.",
    },
    pm2: {
      title: "PM2 complete — refresh focus standards",
      description:
        "Re-pick each skill-cluster group's focus standards using the latest PM2 data.",
    },
    pm3: {
      title: "PM3 complete — refresh focus standards",
      description:
        "Re-pick each skill-cluster group's focus standards using the latest PM3 data.",
    },
  };

  const banners: Array<{
    pmWindow: string;
    token: string;
    title: string;
    description: string;
    subjects: string[];
  }> = [];
  for (const pmWindow of ["pm1", "pm2", "pm3"] as const) {
    const subjectsReady = dataByWindow.get(pmWindow);
    if (!subjectsReady || subjectsReady.size === 0) continue;
    const token = `${schoolYear}|${pmWindow}|skillcluster_refresh`;
    if (dismissed.has(token)) continue;
    banners.push({
      pmWindow,
      token,
      title: COPY[pmWindow].title,
      description: COPY[pmWindow].description,
      subjects: Array.from(subjectsReady).sort(),
    });
  }

  res.json({ schoolYear, banners });
});

router.post(
  "/intensive-groups/skillcluster-banners/dismiss",
  async (req, res) => {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    if (!canManageGroups(staff)) {
      res.status(403).json({ error: "Admin or Core Team required" });
      return;
    }
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const body = (req.body ?? {}) as { token?: string };
    const token = typeof body.token === "string" ? body.token.trim() : "";
    // Validate the token shape so a stray POST can't pollute the
    // array. Token must look like "<sy>|<pm1|pm2|pm3>|skillcluster_refresh".
    if (!/^[^|]+\|pm[123]\|skillcluster_refresh$/.test(token)) {
      res.status(400).json({ error: "Invalid token" });
      return;
    }
    const [settings] = await db
      .select({
        dismissals: schoolSettingsTable.skillclusterBannerDismissals,
      })
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId))
      .limit(1);
    const prior = settings?.dismissals ?? [];
    if (prior.includes(token)) {
      res.json({ ok: true, dismissals: prior });
      return;
    }
    const next = [...prior, token];
    await db
      .update(schoolSettingsTable)
      .set({ skillclusterBannerDismissals: next })
      .where(eq(schoolSettingsTable.schoolId, schoolId));
    req.log?.info(
      { schoolId, token, by: staff.id },
      "[intensive-groups] Skillcluster banner dismissed",
    );
    res.json({ ok: true, dismissals: next });
  },
);

// ---------------------------------------------------------------------
// GET /windows
// ---------------------------------------------------------------------
router.get("/intensive-groups/windows", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!canManageGroups(staff)) {
    res.status(403).json({ error: "Admin or Core Team required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const subject =
    typeof req.query.subject === "string" ? req.query.subject : "ela";
  if (!VALID_SUBJECTS.has(subject)) {
    res.status(400).json({ error: "Invalid subject" });
    return;
  }
  const available = await listAvailableWindows(schoolId, subject, null);
  res.json({ subject, available });
});

// ---------------------------------------------------------------------
// GET /sections — all intensive sections at this school.
// ---------------------------------------------------------------------
router.get("/intensive-groups/sections", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  // Visible scope: a teacher sees only their own; Core Team sees all.
  const rows = await db
    .select({
      id: classSectionsTable.id,
      period: classSectionsTable.period,
      courseName: classSectionsTable.courseName,
      teacherStaffId: classSectionsTable.teacherStaffId,
      teacherName: staffTable.displayName,
    })
    .from(classSectionsTable)
    .innerJoin(
      staffTable,
      eq(staffTable.id, classSectionsTable.teacherStaffId),
    )
    .where(
      and(
        eq(classSectionsTable.schoolId, schoolId),
        eq(classSectionsTable.isPlanning, false),
      ),
    );
  // Group Insights works for any section (regular or intensive) —
  // the engine just needs FAST scores for enrolled students. We
  // still tag `isIntensive` in the response so the UI can badge
  // intensive sections, but we no longer filter them out here.
  const filtered = rows
    .filter((r) => canManageGroups(staff) || r.teacherStaffId === staff.id)
    .map((r) => ({ ...r, isIntensive: isIntensiveCourseName(r.courseName) }));
  filtered.sort((a, b) => {
    const t = (a.teacherName ?? "").localeCompare(b.teacherName ?? "");
    if (t !== 0) return t;
    return a.period - b.period;
  });
  res.json({ sections: filtered });
});

// ---------------------------------------------------------------------
// GET /suggest — Phase A scheduler-facing recommendation.
// ---------------------------------------------------------------------
router.get("/intensive-groups/suggest", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!canManageGroups(staff)) {
    res.status(403).json({ error: "Admin or Core Team required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const subject =
    typeof req.query.subject === "string" ? req.query.subject : "ela";
  if (!VALID_SUBJECTS.has(subject)) {
    res.status(400).json({ error: "Invalid subject" });
    return;
  }
  const grade = Number(req.query.grade);
  if (!Number.isInteger(grade) || grade < 0 || grade > 12) {
    res.status(400).json({ error: "Invalid grade" });
    return;
  }
  const sections = Math.max(1, Math.min(20, Number(req.query.sections) || 4));
  const seats = Math.max(2, Math.min(35, Number(req.query.seats) || 22));

  // Class type. "intensive" (default — back-compat) restricts the
  // pool to FAST levels 1–2; "regular" opens it to all levels 1–5;
  // "cusp" restricts the pool to bubble kids near a cut score (see
  // cusp params below).
  const rawMode = typeof req.query.mode === "string" ? req.query.mode : "";
  const mode: "intensive" | "regular" | "cusp" | "skillcluster" =
    rawMode === "regular"
      ? "regular"
      : rawMode === "cusp"
        ? "cusp"
        : rawMode === "skillcluster"
          ? "skillcluster"
          : "intensive";
  // Skill-cluster: how many focus standards to publish per group
  // (default 5, clamped to 3..7). Ignored in other modes.
  const focusCount = Math.max(
    3,
    Math.min(7, Number(req.query.focusCount) || 5),
  );
  // Arrangement (regular only). "homogeneous" reuses the intensive
  // skill-cluster algorithm; "balanced" uses the round-robin
  // clusterer that evens out level + skill across sections.
  const arrangement =
    req.query.arrangement === "balanced" ? "balanced" : "homogeneous";

  // Cusp params (cusp mode only; ignored otherwise). cuspPointsBelow
  // and cuspPointsAbove are the asymmetric ± points-from-cut windows
  // for below-the-L3-cut and above-the-L3-cut (i.e. below-the-L4-cut)
  // candidates respectively. Legacy callers can still pass a single
  // `cuspPoints` value and it applies to both sides — UI was updated
  // to send the two split values explicitly. cuspDirection selects
  // which side(s) to consider. cuspDoubleCounters narrows to kids
  // who are ALSO cusp in the other FAST subject (school-grade
  // double-counters). cuspTrajectory narrows to kids who were
  // L3 in an earlier window and slid to L2 in the current window
  // (the "losing ground" cohort).
  const cuspPointsLegacy = Math.max(
    1,
    Math.min(60, Number(req.query.cuspPoints) || 15),
  );
  const cuspPointsBelow = Math.max(
    1,
    Math.min(
      60,
      req.query.cuspPointsBelow == null
        ? cuspPointsLegacy
        : Number(req.query.cuspPointsBelow) || cuspPointsLegacy,
    ),
  );
  const cuspPointsAbove = Math.max(
    1,
    Math.min(
      60,
      req.query.cuspPointsAbove == null
        ? cuspPointsLegacy
        : Number(req.query.cuspPointsAbove) || cuspPointsLegacy,
    ),
  );
  const cuspDirectionRaw =
    typeof req.query.cuspDirection === "string" ? req.query.cuspDirection : "";
  const cuspDirection: "both" | "below" | "above" | "strand" =
    cuspDirectionRaw === "below"
      ? "below"
      : cuspDirectionRaw === "above"
        ? "above"
        : cuspDirectionRaw === "strand"
          ? "strand"
          : "both";
  const cuspDoubleCounters = req.query.cuspDoubleCounters === "true";
  const cuspTrajectory = req.query.cuspTrajectory === "true";
  // trajectoryFilter (Phase 1 Historical FAST work). Layered on top of
  // the existing cuspTrajectory toggle:
  //  - ""               → existing behavior (slipped: prior L3 → current L2).
  //  - "first_time_l3"  → ALSO include candidates whose prior PM was
  //                       L1 or L2 and current is L3 (climbers — first
  //                       time hitting proficient; worth small-group
  //                       coverage so they don't slide back).
  //  - "consistent_l3+" → restrict candidates to those who have been
  //                       L3+ in BOTH the prior AND current windows
  //                       (stable proficient — useful for enrichment
  //                       cusp recipes).
  const trajectoryFilterRaw =
    typeof req.query.trajectoryFilter === "string"
      ? req.query.trajectoryFilter
      : "";
  const trajectoryFilter: "" | "first_time_l3" | "consistent_l3_plus" =
    trajectoryFilterRaw === "first_time_l3"
      ? "first_time_l3"
      : trajectoryFilterRaw === "consistent_l3_plus"
        ? "consistent_l3_plus"
        : "";

  // Strand-cusp + double-counters is not supportable cheaply — the
  // strand check needs item-response categories for BOTH subjects.
  // Reject the combination explicitly rather than silently
  // approximating it (the UI also greys the checkbox out when
  // direction=strand).
  if (mode === "cusp" && cuspDirection === "strand" && cuspDoubleCounters) {
    res.status(400).json({
      error:
        "Double-counters is not available with the Strand-cusp direction. Pick a different direction or turn off double-counters.",
    });
    return;
  }

  // calcOnly skips clustering — used by the inline cusp calculator
  // to refresh the live "X eligible → Y sections" headcount cheaply
  // as the admin tweaks thresholds. Returns groups: [], overflow: [].
  const calcOnly = req.query.calcOnly === "true";

  // Eligibility default differs by mode: intensive keeps the legacy
  // 70% mastery filter (a defensible "struggling" floor); regular
  // and cusp default to 100% (no overall-mastery filter — the level
  // / cusp gate is the primary one).
  const eligibilityMaxPctDefault =
    mode === "intensive" || mode === "skillcluster" ? 70 : 100;
  const eligibilityMaxPct = Math.max(
    0,
    Math.min(
      100,
      req.query.eligibilityMaxPct == null
        ? eligibilityMaxPctDefault
        : Number(req.query.eligibilityMaxPct),
    ),
  );

  // Grade-scoped roster: all students at this school in the grade.
  const studentsAtGrade = await db
    .select({ studentId: studentsTable.studentId })
    .from(studentsTable)
    .where(
      and(eq(studentsTable.schoolId, schoolId), eq(studentsTable.grade, grade)),
    );
  let studentIds = studentsAtGrade.map((s) => s.studentId);

  // Master Plan workflow: when a plan is open the client passes the
  // union of already-locked student_ids as excludeStudentIds so the
  // candidate pool + clustering only consider students who are still
  // available. Comma-separated list; unknown ids are silently dropped.
  const excludeParam =
    typeof req.query.excludeStudentIds === "string"
      ? req.query.excludeStudentIds
      : "";
  if (excludeParam.length > 0) {
    const excludeSet = new Set(
      excludeParam
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
    if (excludeSet.size > 0) {
      studentIds = studentIds.filter((id) => !excludeSet.has(id));
    }
  }

  const available = await listAvailableWindows(schoolId, subject, studentIds);
  const { schoolYear, window } = await pickWindow(req, available, schoolId);

  const profiles = await computeSkillProfiles({
    schoolId,
    subject,
    schoolYear,
    window,
    studentIds,
  });

  // Level gate — intensive restricts to FAST 1 & 2; regular keeps
  // all levels (1..5); cusp gates by the cusp filter below instead.
  // Students with NO fastLevel (no PM score or no chart) are excluded
  // from the level gate in intensive/cusp modes (they go to
  // "unscored") and INCLUDED in regular mode (the arrangement still
  // works off topGaps / round-robin).
  const allowedLevels =
    mode === "intensive" || mode === "skillcluster"
      ? new Set([1, 2])
      : mode === "cusp"
        ? new Set([2, 3])
        : null;
  const passesLevel = (p: StudentSkillProfile): boolean => {
    if (allowedLevels == null) return true;
    return p.fastLevel != null && allowedLevels.has(p.fastLevel);
  };

  // ----- Cusp-mode auxiliary data -----
  // doubleCounters needs the OTHER FAST subject's score in the same
  // window so we can re-check the cusp condition on the other side.
  // trajectory needs PM1/PM2 scores so we can flag the "was L3,
  // dropped to L2" cohort. Only fetch when actually requested to
  // keep the route cheap when cusp isn't in play.
  let otherSubjectLevelById: Map<string, 1 | 2 | 3 | 4 | 5 | null> | null = null;
  let otherSubjectScoreById: Map<string, number | null> | null = null;
  if (mode === "cusp" && cuspDoubleCounters) {
    const other = otherSubjectFor(subject);
    if (other) {
      const rows = await db
        .select({
          studentId: studentFastScoresTable.studentId,
          pm1: studentFastScoresTable.pm1,
          pm2: studentFastScoresTable.pm2,
          pm3: studentFastScoresTable.pm3,
        })
        .from(studentFastScoresTable)
        .where(
          and(
            eq(studentFastScoresTable.schoolId, schoolId),
            eq(studentFastScoresTable.subject, other),
            eq(studentFastScoresTable.schoolYear, schoolYear),
            inArray(studentFastScoresTable.studentId, studentIds),
          ),
        );
      otherSubjectLevelById = new Map();
      otherSubjectScoreById = new Map();
      const gradeByStudent = new Map(profiles.map((p) => [p.studentId, p.grade]));
      for (const r of rows) {
        const raw =
          window === "pm1" ? r.pm1 : window === "pm2" ? r.pm2 : r.pm3;
        otherSubjectScoreById.set(r.studentId, raw ?? null);
        otherSubjectLevelById.set(
          r.studentId,
          deriveLevelForWindow(raw, other, gradeByStudent.get(r.studentId) ?? null, window),
        );
      }
    }
  }

  // Trajectory only makes sense if there IS a prior window relative
  // to the current selection. PM1 has no prior → silently no-op.
  // PM2 → consider PM1 only. PM3 → consider PM1 or PM2.
  const trajectoryActive =
    mode === "cusp" && cuspTrajectory && (window === "pm2" || window === "pm3");
  let priorPm1LevelById: Map<string, 1 | 2 | 3 | 4 | 5 | null> | null = null;
  let priorPm2LevelById: Map<string, 1 | 2 | 3 | 4 | 5 | null> | null = null;
  if (trajectoryActive) {
    const rows = await db
      .select({
        studentId: studentFastScoresTable.studentId,
        pm1: studentFastScoresTable.pm1,
        pm2: studentFastScoresTable.pm2,
      })
      .from(studentFastScoresTable)
      .where(
        and(
          eq(studentFastScoresTable.schoolId, schoolId),
          eq(studentFastScoresTable.subject, subject),
          eq(studentFastScoresTable.schoolYear, schoolYear),
          inArray(studentFastScoresTable.studentId, studentIds),
        ),
      );
    priorPm1LevelById = new Map();
    priorPm2LevelById = new Map();
    const gradeByStudent = new Map(profiles.map((p) => [p.studentId, p.grade]));
    for (const r of rows) {
      const g = gradeByStudent.get(r.studentId) ?? null;
      priorPm1LevelById.set(
        r.studentId,
        deriveLevelForWindow(r.pm1, subject, g, "pm1"),
      );
      priorPm2LevelById.set(
        r.studentId,
        deriveLevelForWindow(r.pm2, subject, g, "pm2"),
      );
    }
  }

  // ----- Cusp filter -----
  // For each candidate compute whether they fall in the requested
  // cusp window using the same chart the placement helpers use
  // (current grade for PM1/PM2, prior grade for PM3, grade-agnostic
  // for EOC). If the chart is missing we can't place them on a cut,
  // so they're excluded from cusp mode.
  const passesCusp = (p: StudentSkillProfile): boolean => {
    if (mode !== "cusp") return true;
    if (p.fastLevel == null || p.fastScore == null || p.grade == null) {
      return false;
    }
    const chartGrade = chartGradeFor(subject as Subject, p.grade, window);
    const l3Min = levelMin(subject as Subject, chartGrade, 3);
    const l4Min = levelMin(subject as Subject, chartGrade, 4);
    if (l3Min == null || l4Min == null) return false;

    // Below-cut cusp: L2 students within cuspPointsBelow of the L3 floor.
    const belowCusp =
      p.fastLevel === 2 && p.fastScore >= l3Min - cuspPointsBelow;
    // Above-cut cusp: L3 students within cuspPointsAbove of the L4 floor
    // (i.e. close to slipping up to proficient).
    const aboveCusp =
      p.fastLevel === 3 && p.fastScore >= l4Min - cuspPointsAbove;
    // Strand-cusp: L3 students with at least one Below-strand (<50%)
    // — passing overall but hiding a weakness worth small-grouping.
    const strandCusp = p.fastLevel === 3 && p.hasBelowStrand;

    let baseHit = false;
    if (cuspDirection === "below") baseHit = belowCusp;
    else if (cuspDirection === "above") baseHit = aboveCusp;
    else if (cuspDirection === "strand") baseHit = strandCusp;
    else baseHit = belowCusp || aboveCusp; // "both"

    if (!baseHit) return false;

    // Double-counters filter: ALSO cusp in the other FAST subject.
    // Apply the same direction logic against the other-subject score
    // (using the student's grade for the other subject's chart). Any
    // student missing the other-subject score fails the filter.
    if (cuspDoubleCounters && otherSubjectLevelById && otherSubjectScoreById) {
      const other = otherSubjectFor(subject);
      if (!other) return false;
      const oLvl = otherSubjectLevelById.get(p.studentId);
      const oScore = otherSubjectScoreById.get(p.studentId);
      if (oLvl == null || oScore == null) return false;
      const oChartGrade = chartGradeFor(other, p.grade, window);
      const oL3Min = levelMin(other, oChartGrade, 3);
      const oL4Min = levelMin(other, oChartGrade, 4);
      if (oL3Min == null || oL4Min == null) return false;
      const oBelow = oLvl === 2 && oScore >= oL3Min - cuspPointsBelow;
      const oAbove = oLvl === 3 && oScore >= oL4Min - cuspPointsAbove;
      const oStrand = oLvl === 3; // strand check requires re-querying
      // For "strand" direction we can't cheaply re-check the other
      // subject's strand without re-computing categories; require
      // just that they're L3 in the other subject.
      let oHit = false;
      if (cuspDirection === "below") oHit = oBelow;
      else if (cuspDirection === "above") oHit = oAbove;
      else if (cuspDirection === "strand") oHit = oStrand;
      else oHit = oBelow || oAbove;
      if (!oHit) return false;
    }

    // Trajectory filter: was L3 in a window PRIOR to the current
    // selection, slid to L2 in the current window. Only meaningful
    // for current-window L2 students. PM1 has no prior, so trajectory
    // there is treated as "no matches" by trajectoryActive=false; if
    // the admin still toggles it on PM1 we reject everyone.
    if (cuspTrajectory) {
      if (!trajectoryActive) return false;
      const priorL = (
        priorPm2LevelById != null && window === "pm3"
          ? priorPm2LevelById.get(p.studentId)
          : null
      ) ?? (priorPm1LevelById != null ? priorPm1LevelById.get(p.studentId) : null);
      // Default ("") — slipped: prior L3 → current L2.
      // "first_time_l3" — climber: prior L1 or L2 → current L3.
      // "consistent_l3_plus" — stable: prior L3+ AND current L3+.
      if (trajectoryFilter === "first_time_l3") {
        if (p.fastLevel !== 3) return false;
        if (priorL == null || priorL >= 3) return false;
      } else if (trajectoryFilter === "consistent_l3_plus") {
        if (p.fastLevel == null || p.fastLevel < 3) return false;
        if (priorL == null || priorL < 3) return false;
      } else {
        if (p.fastLevel !== 2) return false;
        const wasL3InPm1 =
          priorPm1LevelById != null &&
          priorPm1LevelById.get(p.studentId) === 3;
        const wasL3InPm2 =
          window === "pm3" &&
          priorPm2LevelById != null &&
          priorPm2LevelById.get(p.studentId) === 3;
        if (!wasL3InPm1 && !wasL3InPm2) return false;
      }
    }

    return true;
  };

  // Eligibility filter: students at or below the threshold overall
  // AND passing the level + cusp gates. Students with no item-
  // response data are routed to the "unscored" tail so admins can
  // place them manually.
  const eligible = profiles.filter(
    (p) =>
      p.overallPct != null &&
      p.overallPct <= eligibilityMaxPct &&
      passesLevel(p) &&
      passesCusp(p),
  );
  const unscored = profiles.filter((p) => p.overallPct == null);

  // calcOnly mode skips the clustering entirely — the client only
  // wants headcount + level mix for the live calculator readout.
  const useBalanced = mode === "regular" && arrangement === "balanced";
  const clustered = calcOnly
    ? { groups: [], overflow: [] }
    : mode === "skillcluster"
      ? clusterByBenchmarkDeficit(eligible, sections, seats)
      : useBalanced
        ? clusterProfilesBalanced(eligible, sections, seats)
        : clusterProfilesIntoGroups(eligible, sections, seats);

  // Skill-cluster: pick N focus standards per group from the group's
  // combined item responses. Floors (≤50% group avg, ≥60% coverage)
  // shipped in pickFocusStandards.
  if (mode === "skillcluster") {
    for (const g of clustered.groups) {
      g.focusStandards = pickFocusStandards(g.students, { count: focusCount });
    }
  }

  // Attach a level-mix tally to each group + the candidate pool so
  // the UI can render the "Levels: 1×8 2×12 3×2" chip strip.
  const groupsWithMix = clustered.groups.map((g) => ({
    ...g,
    levelMix: tallyLevelMix(g.students),
  }));

  // Cusp summary — surfaced on cusp mode so the UI can show the
  // L3 / L4 cut floors actually used + the sections-needed math
  // for the live calculator readout. Null in other modes.
  let cusp:
    | {
        // Legacy single value kept on the response so older clients keep
        // working; equals the max of below/above as a "widest window"
        // proxy. New clients should read cuspPointsBelow/cuspPointsAbove.
        cuspPoints: number;
        cuspPointsBelow: number;
        cuspPointsAbove: number;
        cuspDirection: "both" | "below" | "above" | "strand";
        cuspDoubleCounters: boolean;
        cuspTrajectory: boolean;
        trajectoryFilter: "" | "first_time_l3" | "consistent_l3_plus";
        chartGradeUsed: number | null;
        l3Min: number | null;
        l4Min: number | null;
        belowCutFloor: number | null;
        aboveCutFloor: number | null;
        sectionsNeeded: number;
      }
    | null = null;
  if (mode === "cusp") {
    // Pick a representative chart-grade from the candidate pool so
    // the UI can show "L3 floor = 232 (chart: G6)" etc. All students
    // in the pool share a grade (we filter by grade above), so this
    // is unambiguous.
    const sampleGrade = profiles[0]?.grade ?? grade;
    const cg = chartGradeFor(subject as Subject, sampleGrade, window);
    const l3 = levelMin(subject as Subject, cg, 3);
    const l4 = levelMin(subject as Subject, cg, 4);
    cusp = {
      cuspPoints: Math.max(cuspPointsBelow, cuspPointsAbove),
      cuspPointsBelow,
      cuspPointsAbove,
      cuspDirection,
      cuspDoubleCounters,
      cuspTrajectory,
      trajectoryFilter,
      chartGradeUsed: cg,
      l3Min: l3,
      l4Min: l4,
      belowCutFloor: l3 != null ? l3 - cuspPointsBelow : null,
      aboveCutFloor: l4 != null ? l4 - cuspPointsAbove : null,
      sectionsNeeded: Math.max(1, Math.ceil(eligible.length / Math.max(1, seats))),
    };
  }

  res.json({
    subject,
    grade,
    schoolYear,
    window,
    available,
    mode,
    arrangement: mode === "regular" ? arrangement : null,
    cusp,
    focusCount: mode === "skillcluster" ? focusCount : null,
    calcOnly,
    eligibilityMaxPct,
    requested: { sections, seats },
    candidatePool: {
      totalAtGrade: profiles.length,
      eligible: eligible.length,
      unscored: unscored.length,
      levelMix: tallyLevelMix(eligible),
    },
    groups: groupsWithMix,
    overflow: clustered.overflow.map((p) => ({
      studentId: p.studentId,
      localSisId: p.localSisId,
      firstName: p.firstName,
      lastName: p.lastName,
      grade: p.grade,
      overallPct: p.overallPct,
      fastLevel: p.fastLevel,
      topGaps: p.topGaps,
    })),
    unscored: unscored.map((p) => ({
      studentId: p.studentId,
      localSisId: p.localSisId,
      firstName: p.firstName,
      lastName: p.lastName,
      grade: p.grade,
    })),
  });
});

// ---------------------------------------------------------------------
// GET /insights?sectionId= — Phase B teacher-facing insights.
// ---------------------------------------------------------------------
router.get("/intensive-groups/insights", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const sectionId = Number(req.query.sectionId);
  if (!Number.isInteger(sectionId) || sectionId <= 0) {
    res.status(400).json({ error: "Invalid sectionId" });
    return;
  }
  const [section] = await db
    .select()
    .from(classSectionsTable)
    .where(
      and(
        eq(classSectionsTable.id, sectionId),
        eq(classSectionsTable.schoolId, schoolId),
      ),
    );
  if (!section) {
    res.status(404).json({ error: "Section not found" });
    return;
  }
  if (!canViewSectionInsights(staff, section.teacherStaffId)) {
    res.status(403).json({ error: "Not your section" });
    return;
  }

  // Subject inferred from course name. ELA-ish → ela, else math.
  const courseLower = section.courseName.toLowerCase();
  let subject: string = "ela";
  if (/math|algebra|geometry/.test(courseLower)) {
    if (/algebra\s*1|algebra\s*i\b/.test(courseLower)) subject = "algebra1";
    else if (/geometry/.test(courseLower)) subject = "geometry";
    else subject = "math";
  }

  const rosterRows = await db
    .select({ studentId: sectionRosterTable.studentId })
    .from(sectionRosterTable)
    .where(
      and(
        eq(sectionRosterTable.schoolId, schoolId),
        eq(sectionRosterTable.sectionId, sectionId),
      ),
    );
  const studentIds = Array.from(new Set(rosterRows.map((r) => r.studentId)));

  const available = await listAvailableWindows(schoolId, subject, studentIds);
  const { schoolYear, window } = await pickWindow(req, available, schoolId);

  // Roster profiles for the current window.
  const profiles = await computeSkillProfiles({
    schoolId,
    subject,
    schoolYear,
    window,
    studentIds,
  });

  const sectionProfile = summarizeSection(profiles);

  // Sub-groups: cluster within the period into k=3 mini-groups.
  // Seats per sub-group ceil(rosterSize/3) so all kids land.
  const k = Math.min(3, Math.max(1, Math.ceil(profiles.length / 6)));
  const subgroupSeats = Math.ceil(Math.max(profiles.length, 1) / k);
  const subgroupResult = clusterProfilesIntoGroups(profiles, k, subgroupSeats);
  const subgroups = subgroupResult.groups;

  // Drift panel — only meaningful when there's an earlier window
  // in the same school year to compare against.
  let drift: {
    comparedWindow: string | null;
    outgrew: Array<{ studentId: string; name: string | null }>;
    wouldNowFit: Array<{ studentId: string; name: string | null }>;
  } | null = null;

  // "Earlier" = the immediately-prior PM window in the SAME school
  // year. `available` is sorted PM3→PM2→PM1 within each SY, so
  // picking the first entry whose rank is strictly higher than the
  // current window guarantees chronological "prior" (PM2 compares
  // against PM1, PM3 against PM2). Never compares across SYs and
  // never picks a later window.
  const rank: Record<string, number> = { pm3: 0, pm2: 1, pm1: 2 };
  const currentRank = rank[window] ?? -1;
  const earlier = available.find(
    (a) =>
      a.schoolYear === schoolYear &&
      a.window !== window &&
      (rank[a.window] ?? -1) > currentRank,
  );
  if (earlier && profiles.length > 0) {
    // Pull THIS section's prior-window profiles and the rest of the
    // grade's current-window profiles in parallel.
    const sectionGrades = Array.from(
      new Set(
        profiles.map((p) => p.grade).filter((g): g is number => g != null),
      ),
    );
    const peerStudentsRows =
      sectionGrades.length === 0
        ? []
        : await db
            .select({ studentId: studentsTable.studentId })
            .from(studentsTable)
            .where(
              and(
                eq(studentsTable.schoolId, schoolId),
                inArray(studentsTable.grade, sectionGrades),
              ),
            );
    const peerIds = peerStudentsRows
      .map((r) => r.studentId)
      .filter((id) => !studentIds.includes(id));

    const [priorProfiles, peerProfiles] = await Promise.all([
      computeSkillProfiles({
        schoolId,
        subject,
        schoolYear,
        window: earlier.window,
        studentIds,
      }),
      peerIds.length > 0
        ? computeSkillProfiles({
            schoolId,
            subject,
            schoolYear,
            window,
            studentIds: peerIds,
          })
        : Promise.resolve([] as StudentSkillProfile[]),
    ]);

    const focusCats = new Set(
      sectionProfile.dominantCategories.slice(0, 2).map((d) => d.category),
    );
    // Outgrew = was below 80% in focus cat in prior window, now above.
    const priorById = new Map(priorProfiles.map((p) => [p.studentId, p]));
    const outgrew: Array<{ studentId: string; name: string | null }> = [];
    for (const p of profiles) {
      if (focusCats.size === 0) break;
      const cur = p.categories.find((c) => focusCats.has(c.category));
      const prior = priorById.get(p.studentId);
      const old = prior?.categories.find((c) => focusCats.has(c.category));
      if (cur && old && old.pct < 80 && cur.pct >= 80) {
        outgrew.push({
          studentId: p.studentId,
          name:
            p.firstName && p.lastName ? `${p.firstName} ${p.lastName}` : null,
        });
      }
    }
    // Would now fit = NOT in this section, top-2 gap matches focus
    // categories, and overall pct ≤ section avg.
    const sectionAvg =
      profiles.length > 0
        ? profiles.reduce((s, p) => s + (p.overallPct ?? 100), 0) /
          profiles.length
        : 100;
    const wouldNowFit: Array<{ studentId: string; name: string | null }> = [];
    for (const p of peerProfiles) {
      if (p.overallPct == null || p.overallPct > sectionAvg) continue;
      const studentTop2 = new Set(p.topGaps.slice(0, 2));
      let hit = false;
      for (const c of focusCats) {
        if (studentTop2.has(c)) {
          hit = true;
          break;
        }
      }
      if (hit) {
        wouldNowFit.push({
          studentId: p.studentId,
          name:
            p.firstName && p.lastName ? `${p.firstName} ${p.lastName}` : null,
        });
      }
    }
    // Cap each at 10 so the UI panel stays scannable.
    drift = {
      comparedWindow: earlier.window,
      outgrew: outgrew.slice(0, 10),
      wouldNowFit: wouldNowFit.slice(0, 10),
    };
  }

  // NOTE: an earlier draft tried to surface a "ceiling" comparison by
  // re-clustering the same roster into one group, but clustering a
  // fixed set into k=1 just returns that same set — the comparison
  // was meaningless. A real counterfactual would require pulling a
  // grade-wide candidate pool and recruiting a fresh section of the
  // same seat count; that belongs in the Composer, not on a teacher's
  // read-only roster tab. Field intentionally omitted from the
  // response until that work lands.

  res.json({
    section: {
      id: section.id,
      period: section.period,
      courseName: section.courseName,
      teacherStaffId: section.teacherStaffId,
      isIntensive: isIntensiveCourseName(section.courseName),
    },
    subject,
    schoolYear,
    window,
    available,
    rosterSize: studentIds.length,
    sectionProfile,
    subgroups,
    drift,
    profiles: profiles.map((p) => ({
      studentId: p.studentId,
      firstName: p.firstName,
      lastName: p.lastName,
      grade: p.grade,
      topGaps: p.topGaps,
      overallPct: p.overallPct,
    })),
  });
});

// =====================================================================
// Class Composer "Master Plans" — saved plans the master scheduler uses
// to lock candidate groups, exclude already-placed students from
// subsequent /suggest calls, and produce printable artifacts (CSV +
// PDF). Nothing here writes to section_roster or class_sections — the
// plan is paper-only.
//
// Routes (all gated to admin + Core Team + Guidance Counselor via
// canEditSafetyPlan — MTSS is already Core Team):
//
//   GET    /api/intensive-groups/plans?subject=&grade=&schoolYear=
//   POST   /api/intensive-groups/plans
//   GET    /api/intensive-groups/plans/:id
//   PATCH  /api/intensive-groups/plans/:id              (rename)
//   DELETE /api/intensive-groups/plans/:id
//   POST   /api/intensive-groups/plans/:id/finalize
//   POST   /api/intensive-groups/plans/:id/unfinalize
//   POST   /api/intensive-groups/plans/:id/groups       (lock a group)
//   PATCH  /api/intensive-groups/plans/:id/groups/:gid  (rename / move student)
//   DELETE /api/intensive-groups/plans/:id/groups/:gid  (unlock)
//   GET    /api/intensive-groups/plans/:id/csv
//   GET    /api/intensive-groups/plans/:id/pdf
// =====================================================================

// publicId — 8 chars, alphanumeric uppercase, no I/O/0/1 (visual
// confusion). Generated client-side here because the table doesn't
// have a unique constraint (collisions are astronomically unlikely
// at 32^8 ≈ 1e12 keyspace + per-school dataset sizes).
const PUBLIC_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generatePlanPublicId(): string {
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += PUBLIC_ID_ALPHABET[Math.floor(Math.random() * PUBLIC_ID_ALPHABET.length)];
  }
  return out;
}

function canManagePlans(s: StaffRow): boolean {
  return Boolean(s.isAdmin) || canEditSafetyPlan(s);
}

async function loadPlanOr404(
  req: Request,
  res: Response,
  schoolId: number,
): Promise<ClassComposerPlanRow | null> {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid plan id" });
    return null;
  }
  const [plan] = await db
    .select()
    .from(classComposerPlansTable)
    .where(
      and(
        eq(classComposerPlansTable.id, id),
        eq(classComposerPlansTable.schoolId, schoolId),
      ),
    );
  if (!plan) {
    res.status(404).json({ error: "Plan not found" });
    return null;
  }
  return plan;
}

async function loadPlanGroups(
  planId: number,
  schoolId: number,
): Promise<ClassComposerPlanGroupRow[]> {
  // Always include schoolId in the filter as belt-and-suspenders even
  // though the planId already implies a school via loadPlanOr404 — keeps
  // a stray bug from leaking data across tenants.
  return db
    .select()
    .from(classComposerPlanGroupsTable)
    .where(
      and(
        eq(classComposerPlanGroupsTable.planId, planId),
        eq(classComposerPlanGroupsTable.schoolId, schoolId),
      ),
    )
    .orderBy(asc(classComposerPlanGroupsTable.groupIndex));
}

function requireDraft(plan: ClassComposerPlanRow, res: Response): boolean {
  if (plan.status !== "draft") {
    res
      .status(409)
      .json({ error: "Plan is finalized. Unfinalize first to edit." });
    return false;
  }
  return true;
}

// ---------- GET /plans (list) ----------
router.get("/intensive-groups/plans", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!canManagePlans(staff)) {
    res.status(403).json({ error: "Admin, Core Team, or Counselor required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const conds = [eq(classComposerPlansTable.schoolId, schoolId)];
  if (typeof req.query.subject === "string" && req.query.subject.length > 0) {
    conds.push(eq(classComposerPlansTable.subject, req.query.subject));
  }
  if (req.query.grade != null) {
    const g = Number(req.query.grade);
    if (Number.isInteger(g)) conds.push(eq(classComposerPlansTable.grade, g));
  }
  if (
    typeof req.query.schoolYear === "string" &&
    req.query.schoolYear.length > 0
  ) {
    conds.push(eq(classComposerPlansTable.schoolYear, req.query.schoolYear));
  }

  const plans = await db
    .select()
    .from(classComposerPlansTable)
    .where(and(...conds))
    .orderBy(desc(classComposerPlansTable.updatedAt));

  // Per-plan group + student counts in one round trip.
  const planIds = plans.map((p) => p.id);
  let countsByPlan = new Map<number, { groups: number; students: number }>();
  if (planIds.length > 0) {
    const rows = await db
      .select({
        planId: classComposerPlanGroupsTable.planId,
        groupCount: sql<number>`count(*)::int`,
        studentCount: sql<number>`COALESCE(SUM(array_length(${classComposerPlanGroupsTable.studentIds}, 1)), 0)::int`,
      })
      .from(classComposerPlanGroupsTable)
      .where(inArray(classComposerPlanGroupsTable.planId, planIds))
      .groupBy(classComposerPlanGroupsTable.planId);
    countsByPlan = new Map(
      rows.map((r) => [r.planId, { groups: r.groupCount, students: r.studentCount }]),
    );
  }

  res.json({
    plans: plans.map((p) => ({
      id: p.id,
      name: p.name,
      subject: p.subject,
      grade: p.grade,
      schoolYear: p.schoolYear,
      status: p.status,
      publicId: p.publicId,
      createdByStaffId: p.createdByStaffId,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      finalizedAt: p.finalizedAt,
      groupCount: countsByPlan.get(p.id)?.groups ?? 0,
      studentCount: countsByPlan.get(p.id)?.students ?? 0,
    })),
  });
});

// ---------- POST /plans (create) ----------
router.post("/intensive-groups/plans", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!canManagePlans(staff)) {
    res.status(403).json({ error: "Admin, Core Team, or Counselor required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const body = (req.body ?? {}) as {
    name?: string;
    subject?: string;
    grade?: number;
    schoolYear?: string;
  };
  const name = (body.name ?? "").trim();
  const subject = (body.subject ?? "").trim();
  const grade = Number(body.grade);
  const schoolYear =
    typeof body.schoolYear === "string" && body.schoolYear.length > 0
      ? body.schoolYear
      : await getActiveSchoolYear(schoolId, DEFAULT_SCHOOL_TZ);
  if (name.length === 0 || name.length > 120) {
    res.status(400).json({ error: "Name is required (1–120 chars)" });
    return;
  }
  if (!VALID_SUBJECTS.has(subject)) {
    res.status(400).json({ error: "Invalid subject" });
    return;
  }
  if (!Number.isInteger(grade) || grade < 0 || grade > 12) {
    res.status(400).json({ error: "Invalid grade" });
    return;
  }

  const [created] = await db
    .insert(classComposerPlansTable)
    .values({
      schoolId,
      schoolYear,
      subject,
      grade,
      name,
      status: "draft",
      publicId: generatePlanPublicId(),
      createdByStaffId: staff.id,
    })
    .returning();
  res.status(201).json({ plan: created });
});

// ---------- GET /plans/:id ----------
router.get("/intensive-groups/plans/:id", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!canManagePlans(staff)) {
    res.status(403).json({ error: "Admin, Core Team, or Counselor required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const plan = await loadPlanOr404(req, res, schoolId);
  if (!plan) return;
  const groups = await loadPlanGroups(plan.id, schoolId);
  // Build studentId → localSisId lookup so the client can render
  // school-friendly IDs on locked-group chips. Tenant-scoped query.
  const allIds = Array.from(new Set(groups.flatMap((g) => g.studentIds)));
  const studentLookup: Record<string, { localSisId: string | null }> = {};
  if (allIds.length > 0) {
    const rows = await db
      .select({
        studentId: studentsTable.studentId,
        localSisId: studentsTable.localSisId,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          inArray(studentsTable.studentId, allIds),
        ),
      );
    for (const r of rows) {
      studentLookup[r.studentId] = { localSisId: r.localSisId };
    }
  }
  res.json({ plan, groups, studentLookup });
});

// ---------- PATCH /plans/:id (rename) ----------
router.patch("/intensive-groups/plans/:id", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!canManagePlans(staff)) {
    res.status(403).json({ error: "Admin, Core Team, or Counselor required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const plan = await loadPlanOr404(req, res, schoolId);
  if (!plan) return;

  const body = (req.body ?? {}) as { name?: string };
  const name = (body.name ?? "").trim();
  if (name.length === 0 || name.length > 120) {
    res.status(400).json({ error: "Name is required (1–120 chars)" });
    return;
  }
  const [updated] = await db
    .update(classComposerPlansTable)
    .set({ name, updatedAt: new Date() })
    .where(eq(classComposerPlansTable.id, plan.id))
    .returning();
  res.json({ plan: updated });
});

// ---------- DELETE /plans/:id ----------
router.delete("/intensive-groups/plans/:id", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!canManagePlans(staff)) {
    res.status(403).json({ error: "Admin, Core Team, or Counselor required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const plan = await loadPlanOr404(req, res, schoolId);
  if (!plan) return;
  await db
    .delete(classComposerPlanGroupsTable)
    .where(eq(classComposerPlanGroupsTable.planId, plan.id));
  await db
    .delete(classComposerPlansTable)
    .where(eq(classComposerPlansTable.id, plan.id));
  res.json({ ok: true });
});

// ---------- POST /plans/:id/finalize ----------
router.post("/intensive-groups/plans/:id/finalize", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!canManagePlans(staff)) {
    res.status(403).json({ error: "Admin, Core Team, or Counselor required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const plan = await loadPlanOr404(req, res, schoolId);
  if (!plan) return;
  const [updated] = await db
    .update(classComposerPlansTable)
    .set({ status: "final", finalizedAt: new Date(), updatedAt: new Date() })
    .where(eq(classComposerPlansTable.id, plan.id))
    .returning();
  res.json({ plan: updated });
});

// ---------- POST /plans/:id/unfinalize ----------
router.post("/intensive-groups/plans/:id/unfinalize", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!canManagePlans(staff)) {
    res.status(403).json({ error: "Admin, Core Team, or Counselor required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const plan = await loadPlanOr404(req, res, schoolId);
  if (!plan) return;
  const [updated] = await db
    .update(classComposerPlansTable)
    .set({ status: "draft", finalizedAt: null, updatedAt: new Date() })
    .where(eq(classComposerPlansTable.id, plan.id))
    .returning();
  res.json({ plan: updated });
});

// ---------- POST /plans/:id/groups (lock a group) ----------
router.post("/intensive-groups/plans/:id/groups", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!canManagePlans(staff)) {
    res.status(403).json({ error: "Admin, Core Team, or Counselor required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const plan = await loadPlanOr404(req, res, schoolId);
  if (!plan) return;
  if (!requireDraft(plan, res)) return;

  const body = (req.body ?? {}) as {
    name?: string;
    recipe?: ClassComposerGroupRecipe;
    studentIds?: string[];
    seatsPerSection?: number;
  };
  const name = (body.name ?? "").trim();
  if (name.length === 0 || name.length > 120) {
    res.status(400).json({ error: "Group name required (1–120 chars)" });
    return;
  }
  if (!body.recipe || typeof body.recipe !== "object") {
    res.status(400).json({ error: "Recipe required" });
    return;
  }
  const studentIds = Array.isArray(body.studentIds)
    ? body.studentIds.filter((s) => typeof s === "string" && s.length > 0)
    : [];
  const seats = Math.max(
    1,
    Math.min(35, Number(body.seatsPerSection) || studentIds.length || 22),
  );

  // Exclude students already locked in another group of this plan.
  const existingGroups = await loadPlanGroups(plan.id, schoolId);
  const alreadyLocked = new Set<string>();
  for (const g of existingGroups) {
    for (const sid of g.studentIds) alreadyLocked.add(sid);
  }
  const duplicates = studentIds.filter((s) => alreadyLocked.has(s));
  if (duplicates.length > 0) {
    res.status(409).json({
      error: "Some students are already locked in another group of this plan.",
      duplicates,
    });
    return;
  }

  const nextIndex =
    existingGroups.length === 0
      ? 1
      : Math.max(...existingGroups.map((g) => g.groupIndex)) + 1;

  // Accept initial focus standards from the client (skill-cluster
  // lock payloads send them straight from the suggestion). Shape is
  // a thin array — anything not matching the expected fields is
  // dropped so a malformed body can't poison the JSONB column.
  const rawFocus = (body as { focusStandards?: unknown }).focusStandards;
  let focusStandards: ClassComposerFocusStandard[] | null = null;
  if (Array.isArray(rawFocus)) {
    focusStandards = rawFocus
      .filter(
        (f): f is Record<string, unknown> =>
          typeof f === "object" && f !== null,
      )
      .map((f) => ({
        benchmarkCode: String(f.benchmarkCode ?? ""),
        friendlyLabel: String(f.friendlyLabel ?? ""),
        groupAvgPct: Number(f.groupAvgPct ?? 0),
        coverage: Number(f.coverage ?? 0),
        sourceWindow: String(f.sourceWindow ?? body.recipe?.window ?? ""),
        sourceSchoolYear: String(f.sourceSchoolYear ?? plan.schoolYear),
      }))
      .filter((f) => f.benchmarkCode.length > 0);
    if (focusStandards.length === 0) focusStandards = null;
  }

  const [created] = await db
    .insert(classComposerPlanGroupsTable)
    .values({
      planId: plan.id,
      schoolId,
      groupIndex: nextIndex,
      name,
      recipe: body.recipe,
      studentIds,
      seatsPerSection: seats,
      focusStandards,
    })
    .returning();
  await db
    .update(classComposerPlansTable)
    .set({ updatedAt: new Date() })
    .where(eq(classComposerPlansTable.id, plan.id));
  res.status(201).json({ group: created });
});

// ---------- PATCH /plans/:id/groups/:gid (rename / move students) ----------
router.patch("/intensive-groups/plans/:id/groups/:gid", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!canManagePlans(staff)) {
    res.status(403).json({ error: "Admin, Core Team, or Counselor required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const plan = await loadPlanOr404(req, res, schoolId);
  if (!plan) return;
  if (!requireDraft(plan, res)) return;

  const gid = Number(req.params.gid);
  if (!Number.isInteger(gid) || gid <= 0) {
    res.status(400).json({ error: "Invalid group id" });
    return;
  }
  const allGroups = await loadPlanGroups(plan.id, schoolId);
  const target = allGroups.find((g) => g.id === gid);
  if (!target) {
    res.status(404).json({ error: "Group not found" });
    return;
  }

  const body = (req.body ?? {}) as {
    name?: string;
    studentIds?: string[];
    seatsPerSection?: number;
  };

  const updates: Partial<ClassComposerPlanGroupRow> = {};
  if (typeof body.name === "string") {
    const n = body.name.trim();
    if (n.length === 0 || n.length > 120) {
      res.status(400).json({ error: "Group name 1–120 chars" });
      return;
    }
    updates.name = n;
  }
  if (Array.isArray(body.studentIds)) {
    const newIds = body.studentIds.filter(
      (s) => typeof s === "string" && s.length > 0,
    );
    // No student may appear in two groups of the same plan.
    const lockedElsewhere = new Set<string>();
    for (const g of allGroups) {
      if (g.id === gid) continue;
      for (const sid of g.studentIds) lockedElsewhere.add(sid);
    }
    const conflicts = newIds.filter((s) => lockedElsewhere.has(s));
    if (conflicts.length > 0) {
      res.status(409).json({
        error:
          "Some students are already locked in another group of this plan.",
        duplicates: conflicts,
      });
      return;
    }
    updates.studentIds = newIds;
  }
  if (body.seatsPerSection != null) {
    const s = Math.max(1, Math.min(35, Number(body.seatsPerSection)));
    updates.seatsPerSection = s;
  }

  if (Object.keys(updates).length === 0) {
    res.json({ group: target });
    return;
  }
  const [updated] = await db
    .update(classComposerPlanGroupsTable)
    .set(updates)
    .where(eq(classComposerPlanGroupsTable.id, gid))
    .returning();
  await db
    .update(classComposerPlansTable)
    .set({ updatedAt: new Date() })
    .where(eq(classComposerPlansTable.id, plan.id));
  res.json({ group: updated });
});

// ---------- POST /plans/:id/move-student (atomic move) ----------
// Atomic equivalent of two PATCH /groups calls. Wrap the read +
// two writes in a single transaction so a half-applied move cannot
// drop a student from both groups if the second write fails.
router.post("/intensive-groups/plans/:id/move-student", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!canManagePlans(staff)) {
    res.status(403).json({ error: "Admin, Core Team, or Counselor required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const plan = await loadPlanOr404(req, res, schoolId);
  if (!plan) return;
  if (!requireDraft(plan, res)) return;

  const body = (req.body ?? {}) as {
    studentId?: string;
    fromGroupId?: number;
    toGroupId?: number | null; // null = remove (no destination)
  };
  const sid = (body.studentId ?? "").trim();
  const fromId = Number(body.fromGroupId);
  const toId =
    body.toGroupId == null
      ? null
      : Number.isInteger(Number(body.toGroupId))
        ? Number(body.toGroupId)
        : NaN;
  if (sid.length === 0) {
    res.status(400).json({ error: "studentId required" });
    return;
  }
  if (!Number.isInteger(fromId) || fromId <= 0) {
    res.status(400).json({ error: "fromGroupId required" });
    return;
  }
  if (toId !== null && (!Number.isInteger(toId) || toId <= 0)) {
    res.status(400).json({ error: "toGroupId invalid" });
    return;
  }
  if (toId !== null && toId === fromId) {
    res.status(400).json({ error: "Source and destination must differ" });
    return;
  }

  try {
    await db.transaction(async (tx) => {
      // Lock both groups for update so a concurrent move can't
      // also try to take the same student.
      const rows = await tx
        .select()
        .from(classComposerPlanGroupsTable)
        .where(
          and(
            eq(classComposerPlanGroupsTable.planId, plan.id),
            eq(classComposerPlanGroupsTable.schoolId, schoolId),
          ),
        )
        .for("update");
      const from = rows.find((g) => g.id === fromId);
      if (!from) throw new Error("Source group not found in plan");
      const to = toId !== null ? rows.find((g) => g.id === toId) : null;
      if (toId !== null && !to) throw new Error("Destination group not found");
      if (!from.studentIds.includes(sid)) {
        throw new Error("Student not in source group");
      }
      if (to && to.studentIds.includes(sid)) {
        throw new Error("Student is already in destination group");
      }
      await tx
        .update(classComposerPlanGroupsTable)
        .set({ studentIds: from.studentIds.filter((id) => id !== sid) })
        .where(eq(classComposerPlanGroupsTable.id, from.id));
      if (to) {
        await tx
          .update(classComposerPlanGroupsTable)
          .set({ studentIds: [...to.studentIds, sid] })
          .where(eq(classComposerPlanGroupsTable.id, to.id));
      }
      await tx
        .update(classComposerPlansTable)
        .set({ updatedAt: new Date() })
        .where(eq(classComposerPlansTable.id, plan.id));
    });
  } catch (e) {
    res.status(409).json({ error: (e as Error).message });
    return;
  }
  const groups = await loadPlanGroups(plan.id, schoolId);
  res.json({ groups });
});

// ---------- DELETE /plans/:id/groups/:gid (unlock) ----------
router.delete("/intensive-groups/plans/:id/groups/:gid", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!canManagePlans(staff)) {
    res.status(403).json({ error: "Admin, Core Team, or Counselor required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const plan = await loadPlanOr404(req, res, schoolId);
  if (!plan) return;
  if (!requireDraft(plan, res)) return;
  const gid = Number(req.params.gid);
  if (!Number.isInteger(gid) || gid <= 0) {
    res.status(400).json({ error: "Invalid group id" });
    return;
  }
  await db
    .delete(classComposerPlanGroupsTable)
    .where(
      and(
        eq(classComposerPlanGroupsTable.id, gid),
        eq(classComposerPlanGroupsTable.planId, plan.id),
      ),
    );
  await db
    .update(classComposerPlansTable)
    .set({ updatedAt: new Date() })
    .where(eq(classComposerPlansTable.id, plan.id));
  res.json({ ok: true });
});

// ---------- Skill-cluster PM-refresh endpoints ----------
//
// Three companion endpoints used by the locked-group cards in the
// composer + the Admin Hub banner flow. None of them ever mutate
// student_ids — rosters are immutable once locked, per the product
// rule. They only touch focus_standards + the append-only audit
// table.
//
//   * POST /plans/:id/groups/:gid/refresh-focus   — recompute focus
//     standards from a given PM window, write audit row + update
//     focus_standards. 422 if <70% of the locked roster has data
//     in that window.
//   * POST /plans/:id/groups/:gid/check-fit       — read-only PM1
//     sanity check. Returns the drift summary (per-student best-fit
//     suggestions over the 25% threshold) without writing focus.
//     Always records an audit row so the banner can dedupe.
//   * POST /plans/:id/groups/:gid/dismiss-check   — record a
//     'dismiss' audit row so the banner stops nagging.

const PM_WINDOWS = new Set(["pm1", "pm2", "pm3"]);
const COVERAGE_FLOOR_FOR_REFRESH = 0.7;
const DRIFT_IMPROVEMENT_THRESHOLD = 0.25;

function parsePmWindow(req: Request, res: Response): string | null {
  const body = (req.body ?? {}) as { pmWindow?: string };
  const w = typeof body.pmWindow === "string" ? body.pmWindow.toLowerCase() : "";
  if (!PM_WINDOWS.has(w)) {
    res
      .status(400)
      .json({ error: "pmWindow must be one of: pm1, pm2, pm3" });
    return null;
  }
  return w;
}

async function loadPlanGroupOr404(
  planId: number,
  schoolId: number,
  gid: number,
  res: Response,
): Promise<ClassComposerPlanGroupRow | null> {
  const [row] = await db
    .select()
    .from(classComposerPlanGroupsTable)
    .where(
      and(
        eq(classComposerPlanGroupsTable.id, gid),
        eq(classComposerPlanGroupsTable.planId, planId),
        eq(classComposerPlanGroupsTable.schoolId, schoolId),
      ),
    );
  if (!row) {
    res.status(404).json({ error: "Group not found" });
    return null;
  }
  return row;
}

router.post(
  "/intensive-groups/plans/:id/groups/:gid/refresh-focus",
  async (req, res) => {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    if (!canManagePlans(staff)) {
      res
        .status(403)
        .json({ error: "Admin, Core Team, or Counselor required" });
      return;
    }
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const plan = await loadPlanOr404(req, res, schoolId);
    if (!plan) return;
    const gid = Number(req.params.gid);
    if (!Number.isInteger(gid) || gid <= 0) {
      res.status(400).json({ error: "Invalid group id" });
      return;
    }
    const pmWindow = parsePmWindow(req, res);
    if (!pmWindow) return;
    const group = await loadPlanGroupOr404(plan.id, schoolId, gid, res);
    if (!group) return;

    // Only skill-cluster groups carry focus standards. Block early
    // with a clear message rather than silently writing focus to
    // an intensive/regular/cusp group.
    if (group.recipe.mode !== "skillcluster") {
      res.status(409).json({
        error: "Focus standards only apply to skill-cluster groups.",
      });
      return;
    }

    const roster = group.studentIds;
    if (roster.length === 0) {
      res.status(422).json({ error: "Group has no students." });
      return;
    }

    const profiles = await computeSkillProfiles({
      schoolId,
      subject: plan.subject,
      schoolYear: plan.schoolYear,
      window: pmWindow,
      studentIds: roster,
    });
    const profilesWithData = profiles.filter((p) => p.benchmarks.length > 0);
    const coverage = profilesWithData.length / roster.length;
    if (coverage < COVERAGE_FLOOR_FOR_REFRESH) {
      res.status(422).json({
        error:
          `Only ${Math.round(coverage * 100)}% of the locked roster has ` +
          `${pmWindow.toUpperCase()} item data. Need at least ` +
          `${Math.round(COVERAGE_FLOOR_FOR_REFRESH * 100)}% before refresh.`,
        coverage,
        studentsWithData: profilesWithData.length,
        rosterSize: roster.length,
      });
      return;
    }

    const focusCount = Math.max(3, Math.min(7, group.recipe.focusCount ?? 5));
    const picked = pickFocusStandards(profiles, { count: focusCount });
    const newFocus: ClassComposerFocusStandard[] = picked.map((f) => ({
      ...f,
      sourceWindow: pmWindow,
      sourceSchoolYear: plan.schoolYear,
    }));

    const priorFocus = group.focusStandards;
    await db.insert(classComposerPlanGroupRefreshesTable).values({
      planId: plan.id,
      planGroupId: gid,
      schoolId,
      schoolYear: plan.schoolYear,
      pmWindow,
      action: "refresh",
      priorFocus,
      newFocus,
      driftSummary: null,
      staffId: staff.id,
    });
    const [updated] = await db
      .update(classComposerPlanGroupsTable)
      .set({ focusStandards: newFocus })
      .where(eq(classComposerPlanGroupsTable.id, gid))
      .returning();
    await db
      .update(classComposerPlansTable)
      .set({ updatedAt: new Date() })
      .where(eq(classComposerPlansTable.id, plan.id));

    res.json({
      group: updated,
      priorFocus,
      newFocus,
      coverage,
      studentsWithData: profilesWithData.length,
      rosterSize: roster.length,
    });
  },
);

router.post(
  "/intensive-groups/plans/:id/groups/:gid/check-fit",
  async (req, res) => {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    if (!canManagePlans(staff)) {
      res
        .status(403)
        .json({ error: "Admin, Core Team, or Counselor required" });
      return;
    }
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const plan = await loadPlanOr404(req, res, schoolId);
    if (!plan) return;
    const gid = Number(req.params.gid);
    if (!Number.isInteger(gid) || gid <= 0) {
      res.status(400).json({ error: "Invalid group id" });
      return;
    }
    const pmWindow = parsePmWindow(req, res);
    if (!pmWindow) return;
    const group = await loadPlanGroupOr404(plan.id, schoolId, gid, res);
    if (!group) return;
    if (group.recipe.mode !== "skillcluster") {
      res.status(409).json({
        error: "Check-fit only applies to skill-cluster groups.",
      });
      return;
    }

    // Pull the full set of plan groups so we can compute each student's
    // best-fit across the *plan*, not just their current group.
    const allGroups = await loadPlanGroups(plan.id, schoolId);
    const skillGroups = allGroups.filter(
      (g) => g.recipe.mode === "skillcluster",
    );
    const allRoster = Array.from(
      new Set(skillGroups.flatMap((g) => g.studentIds)),
    );
    const profiles = await computeSkillProfiles({
      schoolId,
      subject: plan.subject,
      schoolYear: plan.schoolYear,
      window: pmWindow,
      studentIds: allRoster,
    });
    const profById = new Map(profiles.map((p) => [p.studentId, p]));
    const profilesByGroup = new Map<number, StudentSkillProfile[]>();
    for (const g of skillGroups) {
      profilesByGroup.set(
        g.id,
        g.studentIds
          .map((id) => profById.get(id))
          .filter((x): x is StudentSkillProfile => Boolean(x)),
      );
    }

    const myMembers = profilesByGroup.get(gid) ?? [];
    const myCoverage =
      myMembers.length === 0
        ? 0
        : myMembers.filter((p) => p.benchmarks.length > 0).length /
          myMembers.length;

    const suggested: ClassComposerRefreshDriftSummary["suggestedMoves"] = [];
    for (const student of myMembers) {
      if (student.benchmarks.length === 0) continue;
      // Best other-group improvement. Receiving group must have an
      // open seat — rosters never auto-shuffle, so a full group can't
      // accept this student even if it's a better fit on paper.
      let bestImprovement = 0;
      let bestGroupId: number | null = null;
      for (const other of skillGroups) {
        if (other.id === gid) continue;
        if (other.studentIds.length >= other.seatsPerSection) continue;
        const otherMembers = profilesByGroup.get(other.id) ?? [];
        if (otherMembers.length === 0) continue;
        const improvement = deficitMoveImprovement(
          student,
          myMembers,
          otherMembers,
        );
        if (improvement > bestImprovement) {
          bestImprovement = improvement;
          bestGroupId = other.id;
        }
      }
      if (
        bestGroupId != null &&
        bestImprovement >= DRIFT_IMPROVEMENT_THRESHOLD
      ) {
        suggested.push({
          studentId: student.studentId,
          fromGroupId: gid,
          toGroupId: bestGroupId,
          improvementPct: Math.round(bestImprovement * 100),
        });
      }
    }

    const driftSummary: ClassComposerRefreshDriftSummary = {
      suggestedMoves: suggested,
      studentsAnalyzed: myMembers.length,
      studentsWithCoverage: myMembers.filter((p) => p.benchmarks.length > 0)
        .length,
    };

    await db.insert(classComposerPlanGroupRefreshesTable).values({
      planId: plan.id,
      planGroupId: gid,
      schoolId,
      schoolYear: plan.schoolYear,
      pmWindow,
      action: "suggest_schedule",
      priorFocus: group.focusStandards,
      newFocus: null,
      driftSummary,
      staffId: staff.id,
    });

    res.json({
      driftSummary,
      coverage: myCoverage,
      threshold: DRIFT_IMPROVEMENT_THRESHOLD,
    });
  },
);

router.post(
  "/intensive-groups/plans/:id/groups/:gid/dismiss-check",
  async (req, res) => {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    if (!canManagePlans(staff)) {
      res
        .status(403)
        .json({ error: "Admin, Core Team, or Counselor required" });
      return;
    }
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const plan = await loadPlanOr404(req, res, schoolId);
    if (!plan) return;
    const gid = Number(req.params.gid);
    if (!Number.isInteger(gid) || gid <= 0) {
      res.status(400).json({ error: "Invalid group id" });
      return;
    }
    const pmWindow = parsePmWindow(req, res);
    if (!pmWindow) return;
    const group = await loadPlanGroupOr404(plan.id, schoolId, gid, res);
    if (!group) return;

    await db.insert(classComposerPlanGroupRefreshesTable).values({
      planId: plan.id,
      planGroupId: gid,
      schoolId,
      schoolYear: plan.schoolYear,
      pmWindow,
      action: "dismiss",
      priorFocus: group.focusStandards,
      newFocus: null,
      driftSummary: null,
      staffId: staff.id,
    });
    res.json({ ok: true });
  },
);

// Course-name match used to attribute a "current section" to each
// student for the plan's subject — best-effort heuristic since we
// don't store subject on class_sections. Combined with the intensive
// regex below to prefer the most relevant section when a student is
// enrolled in multiple matching periods.
function courseNameMatchesSubject(
  courseName: string | null | undefined,
  subject: string,
): boolean {
  if (!courseName) return false;
  const n = courseName.toLowerCase();
  switch (subject) {
    case "ela":
      return /\b(ela|english|reading|language\s+arts|literature|read\s*180)\b/.test(
        n,
      );
    case "math":
      return /\b(math|mathematics|math\s*180|saxon)\b/.test(n);
    case "algebra1":
      return /\balgebra\b/.test(n);
    case "geometry":
      return /\bgeometry\b/.test(n);
    default:
      return false;
  }
}

export interface HydratedPlanStudent {
  studentId: string;
  localSisId: string | null;
  firstName: string;
  lastName: string;
  grade: number | null;
  fastLevel: number | null;
  overallPct: number | null;
  ese: boolean;
  is504: boolean;
  ell: boolean;
  // Per-benchmark mastery — keyed by benchmarkCode for fast lookup
  // when filling the focus-standards matrix on the PDF.
  benchmarkPctByCode: Record<string, number>;
  // Student's personal weakest benchmark codes (lowest mastery first)
  // — used to compute focus-standard "fit count" (how many of the
  // group's focus standards land in this student's personal bottom-N).
  bottomBenchmarkCodes: string[];
  // Top weak instructional strands for this student (≤3 weakest),
  // surfaced as a per-student strand mini-row on the PDF.
  strands: Array<{ category: string; pct: number }>;
  // Best-guess current period/section for the plan's subject. Picks
  // the intensive-named section first, then the lowest period.
  currentSection: {
    courseName: string;
    period: number;
    teacherName: string | null;
  } | null;
  // PM1 / PM2 / PM3 FAST achievement levels for the plan's subject +
  // school year, derived from student_fast_scores scale scores via
  // fastCutScores. Surfaced as a trajectory chip on the PDF so the
  // teacher can see "is this kid trending up, flat, down?" without
  // a separate report.
  pmLevels: {
    pm1: number | null;
    pm2: number | null;
    pm3: number | null;
  };
  // Context flags pulled from the school's other modules — used to
  // tell the teacher what they're walking into (e.g. "this group
  // has 4 kids on active safety plans, 2 ever retained, 5 with
  // discipline events in the last 30 days").
  hasActiveMtss: boolean;
  hasActiveSafetyPlan: boolean;
  everRetained: boolean;
  disciplineDays30: number;
}

// Shared helper: gather PDF/CSV student rows for a plan's groups by
// hydrating each group's stored student_ids with current FAST profiles.
interface HydratedPlanResult {
  groups: Array<{
    group: ClassComposerPlanGroupRow;
    students: HydratedPlanStudent[];
  }>;
  // Kept around so the PDF route can re-run clusterByBenchmarkDeficit
  // on a per-group basis for the "Suggested sub-pods" block without
  // re-querying item responses.
  profilesByStudent: Map<string, StudentSkillProfile>;
}

async function hydratePlanStudents(
  schoolId: number,
  plan: ClassComposerPlanRow,
  groups: ClassComposerPlanGroupRow[],
): Promise<HydratedPlanResult> {
  const allIds = Array.from(new Set(groups.flatMap((g) => g.studentIds)));
  if (allIds.length === 0) {
    return {
      groups: groups.map((g) => ({ group: g, students: [] })),
      profilesByStudent: new Map(),
    };
  }
  // We compute the profile in the same window as the *most recently*
  // selected pool. We don't store the window on the plan, so use the
  // newest available window for the plan's subject — gives the PDF
  // current-state numbers even after a re-shuffle. Acceptable because
  // the recipe summary on each group already pins the window used at
  // lock time.
  const available = await listAvailableWindows(
    schoolId,
    plan.subject,
    allIds,
  );
  // IMPORTANT: anchor skill profiles to the plan's own school year so
  // the per-group weakest-benchmarks table and within-class sub-pods
  // in the exported PDF stay consistent with the plan's PM trajectory
  // and context columns (which are already scoped to plan.schoolYear).
  // Picking `available[0]` here would silently pull a newer SY's FAST
  // data for historical plans and produce internally inconsistent
  // exports.
  const planYearWindows = available.filter(
    (w) => w.schoolYear === plan.schoolYear,
  );
  const profile = await computeSkillProfiles({
    schoolId,
    subject: plan.subject,
    schoolYear: plan.schoolYear,
    window: planYearWindows[0]?.window ?? "pm3",
    studentIds: allIds,
  });
  const profById = new Map(profile.map((p) => [p.studentId, p]));

  // Fall back to a plain students table read for kids with no profile
  // (unscored) so we still print their names + program flags.
  const studentRows = await db
    .select({
      studentId: studentsTable.studentId,
      localSisId: studentsTable.localSisId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
      ese: studentsTable.ese,
      is504: studentsTable.is504,
      ell: studentsTable.ell,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        inArray(studentsTable.studentId, allIds),
      ),
    );
  const baseById = new Map(studentRows.map((s) => [s.studentId, s]));

  // Current section lookup — one query for all rostered students,
  // filtered to non-planning sections at this school, then narrowed
  // by subject + ranked (intensive first, then lowest period).
  const sectionRows = await db
    .select({
      studentId: sectionRosterTable.studentId,
      courseName: classSectionsTable.courseName,
      period: classSectionsTable.period,
      teacherName: staffTable.displayName,
    })
    .from(sectionRosterTable)
    .innerJoin(
      classSectionsTable,
      eq(classSectionsTable.id, sectionRosterTable.sectionId),
    )
    .leftJoin(staffTable, eq(staffTable.id, classSectionsTable.teacherStaffId))
    .where(
      and(
        eq(sectionRosterTable.schoolId, schoolId),
        eq(classSectionsTable.schoolId, schoolId),
        eq(classSectionsTable.isPlanning, false),
        inArray(sectionRosterTable.studentId, allIds),
      ),
    );
  const sectionByStudent = new Map<
    string,
    HydratedPlanStudent["currentSection"]
  >();
  for (const r of sectionRows) {
    if (!courseNameMatchesSubject(r.courseName, plan.subject)) continue;
    const prior = sectionByStudent.get(r.studentId);
    const isIntensive = isIntensiveCourseName(r.courseName);
    const priorIntensive = prior ? isIntensiveCourseName(prior.courseName) : false;
    if (
      !prior ||
      (isIntensive && !priorIntensive) ||
      (isIntensive === priorIntensive && r.period < prior.period)
    ) {
      sectionByStudent.set(r.studentId, {
        courseName: r.courseName,
        period: r.period,
        teacherName: r.teacherName ?? null,
      });
    }
  }

  // ----- PM trajectory + context flags -----
  // PM scale scores for the plan's subject + current school year.
  // Converted to whole levels via fastCutScores.placeOnChart using
  // the plan.grade as chart-grade (all plan students are same grade
  // by construction). PM3 uses prior-grade chart per FL convention.
  // ossLogs + issAdminLogs combined gives a 30-day discipline-event
  // count; ledger duplication between modules is rare in practice.
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [
    pmScoreRows,
    mtssRows,
    safetyRows,
    retentionRows,
    ossRows,
    issRows,
  ] = await Promise.all([
    db
      .select({
        studentId: studentFastScoresTable.studentId,
        pm1: studentFastScoresTable.pm1,
        pm2: studentFastScoresTable.pm2,
        pm3: studentFastScoresTable.pm3,
      })
      .from(studentFastScoresTable)
      .where(
        and(
          eq(studentFastScoresTable.schoolId, schoolId),
          eq(studentFastScoresTable.subject, plan.subject),
          eq(studentFastScoresTable.schoolYear, plan.schoolYear),
          eq(studentFastScoresTable.isHistorical, false),
          inArray(studentFastScoresTable.studentId, allIds),
        ),
      ),
    db
      .select({ studentId: studentMtssPlansTable.studentId })
      .from(studentMtssPlansTable)
      .where(
        and(
          eq(studentMtssPlansTable.schoolId, schoolId),
          isNull(studentMtssPlansTable.closedAt),
          inArray(studentMtssPlansTable.studentId, allIds),
        ),
      ),
    db
      .select({ studentId: safetyPlansTable.studentId })
      .from(safetyPlansTable)
      .where(
        and(
          eq(safetyPlansTable.schoolId, schoolId),
          eq(safetyPlansTable.status, "active"),
          inArray(safetyPlansTable.studentId, allIds),
        ),
      ),
    db
      .select({ studentId: studentRetentionsTable.studentId })
      .from(studentRetentionsTable)
      .where(
        and(
          eq(studentRetentionsTable.schoolId, schoolId),
          inArray(studentRetentionsTable.studentId, allIds),
        ),
      ),
    db
      .select({ studentId: ossLogsTable.studentId })
      .from(ossLogsTable)
      .where(
        and(
          eq(ossLogsTable.schoolId, schoolId),
          isNull(ossLogsTable.cancelledAt),
          gte(ossLogsTable.createdAt, since30),
          inArray(ossLogsTable.studentId, allIds),
        ),
      ),
    db
      .select({ studentId: issAdminLogsTable.studentId })
      .from(issAdminLogsTable)
      .where(
        and(
          eq(issAdminLogsTable.schoolId, schoolId),
          isNull(issAdminLogsTable.cancelledAt),
          gte(issAdminLogsTable.createdAt, since30),
          inArray(issAdminLogsTable.studentId, allIds),
        ),
      ),
  ]);
  const pmById = new Map(pmScoreRows.map((r) => [r.studentId, r]));
  const activeMtssSet = new Set(mtssRows.map((r) => r.studentId));
  const activeSafetySet = new Set(safetyRows.map((r) => r.studentId));
  const retainedSet = new Set(retentionRows.map((r) => r.studentId));
  const discCountById = new Map<string, number>();
  for (const r of [...ossRows, ...issRows]) {
    discCountById.set(r.studentId, (discCountById.get(r.studentId) ?? 0) + 1);
  }

  const planSubject = plan.subject as Subject;
  const subjectHasChart = FAST_SUBJECTS_SET.has(planSubject);
  function levelFromScale(
    scale: number | null,
    window: "pm1" | "pm2" | "pm3",
  ): number | null {
    if (scale == null || !subjectHasChart) return null;
    const chartGrade = chartGradeFor(planSubject, plan.grade, window);
    const placement = placeOnChart(scale, planSubject, chartGrade);
    return placement ? placement.level : null;
  }

  const result = groups.map((g) => ({
    group: g,
    students: g.studentIds.map((sid: string): HydratedPlanStudent => {
      const p = profById.get(sid);
      const b = baseById.get(sid);
      const pctByCode: Record<string, number> = {};
      if (p) {
        for (const bm of p.benchmarks) pctByCode[bm.benchmarkCode] = bm.pct;
      }
      // "Personal bottom-7" — the student's seven weakest benchmark
      // codes by mastery %. Used to compute fit-count vs. the group's
      // focus standards on the PDF.
      const bottomCodes = p
        ? [...p.benchmarks]
            .sort((a, b) => a.pct - b.pct)
            .slice(0, 7)
            .map((bm) => bm.benchmarkCode)
        : [];
      const strands = p
        ? p.categories
            .slice(0, 3)
            .map((c) => ({ category: c.category, pct: Math.round(c.pct) }))
        : [];
      const pm = pmById.get(sid);
      return {
        studentId: sid,
        localSisId: p?.localSisId ?? b?.localSisId ?? null,
        firstName: p?.firstName ?? b?.firstName ?? "(unknown)",
        lastName: p?.lastName ?? b?.lastName ?? "",
        grade: p?.grade ?? b?.grade ?? null,
        fastLevel: p?.fastLevel ?? null,
        overallPct: p?.overallPct ?? null,
        ese: b?.ese ?? false,
        is504: b?.is504 ?? false,
        ell: b?.ell ?? false,
        benchmarkPctByCode: pctByCode,
        bottomBenchmarkCodes: bottomCodes,
        strands,
        currentSection: sectionByStudent.get(sid) ?? null,
        pmLevels: {
          pm1: levelFromScale(pm?.pm1 ?? null, "pm1"),
          pm2: levelFromScale(pm?.pm2 ?? null, "pm2"),
          pm3: levelFromScale(pm?.pm3 ?? null, "pm3"),
        },
        hasActiveMtss: activeMtssSet.has(sid),
        hasActiveSafetyPlan: activeSafetySet.has(sid),
        everRetained: retainedSet.has(sid),
        disciplineDays30: discCountById.get(sid) ?? 0,
      };
    }),
  }));

  return { groups: result, profilesByStudent: profById };
}

// ---------- GET /plans/:id/csv ----------
router.get("/intensive-groups/plans/:id/csv", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!canManagePlans(staff)) {
    res.status(403).json({ error: "Admin, Core Team, or Counselor required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const plan = await loadPlanOr404(req, res, schoolId);
  if (!plan) return;
  const groups = await loadPlanGroups(plan.id, schoolId);
  const hydrated = await hydratePlanStudents(schoolId, plan, groups);

  const esc = (v: string | number | null | undefined): string => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Skill-cluster plans carry up to N focus standards per group.
  // Surface them as flat columns (focus_standard_1 / focus_avg_pct_1
  // …) so the school can pivot the CSV in Excel. We widen the header
  // to fit the busiest group; groups with fewer focus standards just
  // leave the trailing columns blank.
  const maxFocus = hydrated.groups.reduce(
    (m, { group }) => Math.max(m, group.focusStandards?.length ?? 0),
    0,
  );
  const focusHeaders: string[] = [];
  for (let i = 1; i <= maxFocus; i++) {
    focusHeaders.push(`focus_standard_${i}`, `focus_avg_pct_${i}`);
  }
  const lines: string[] = [
    [
      "plan_id",
      "plan_name",
      "subject",
      "grade",
      "school_year",
      "group_index",
      "group_name",
      "local_sis_id",
      "last_name",
      "first_name",
      "student_grade",
      "fast_level",
      "overall_pct",
      ...focusHeaders,
    ]
      .map(esc)
      .join(","),
  ];
  for (const { group, students } of hydrated.groups) {
    const fs = group.focusStandards ?? [];
    const focusCells: Array<string | number | null> = [];
    for (let i = 0; i < maxFocus; i++) {
      const f = fs[i];
      focusCells.push(f ? f.benchmarkCode : null);
      focusCells.push(f ? f.groupAvgPct : null);
    }
    for (const s of students) {
      lines.push(
        [
          plan.publicId,
          plan.name,
          plan.subject,
          plan.grade,
          plan.schoolYear,
          group.groupIndex,
          group.name,
          s.localSisId,
          s.lastName,
          s.firstName,
          s.grade,
          s.fastLevel != null ? `L${s.fastLevel}` : null,
          s.overallPct != null ? Math.round(s.overallPct) : null,
          ...focusCells,
        ]
          .map(esc)
          .join(","),
      );
    }
  }
  const slug = plan.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${slug || "composer-plan"}.csv"`,
  );
  res.send(lines.join("\n") + "\n");
});

// ---------- GET /plans/:id/pdf ----------
router.get("/intensive-groups/plans/:id/pdf", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!canManagePlans(staff)) {
    res.status(403).json({ error: "Admin, Core Team, or Counselor required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const plan = await loadPlanOr404(req, res, schoolId);
  if (!plan) return;
  const groups = await loadPlanGroups(plan.id, schoolId);
  const hydrated = await hydratePlanStudents(schoolId, plan, groups);

  const [school] = await db
    .select({ name: schoolsTable.name })
    .from(schoolsTable)
    .where(eq(schoolsTable.id, schoolId));
  const [savedBy] = await db
    .select({ displayName: staffTable.displayName })
    .from(staffTable)
    .where(eq(staffTable.id, plan.createdByStaffId));

  // Per-group derived data — kept here (route layer) so the PDF
  // renderer stays a pure formatter. weakestBenchmarks aggregates
  // every student's mastery-by-code into a 5-deep "what does this
  // whole group most need to work on?" table. subPods runs the
  // skill-cluster engine recursively inside the group to suggest
  // 2 or 3 within-class small-groups (only when the section is
  // large enough — under 8 students, sub-pods aren't useful).
  // context is the simple count of active MTSS / safety / ever
  // retained / 30-day discipline events the teacher walks into.
  const pdfGroups = hydrated.groups.map(({ group, students }) => {
    // Aggregate benchmark mastery across the group, then take the
    // 5 lowest-avg codes with at least 50% of the group having any
    // response for that code.
    const aggMap = new Map<string, { sum: number; n: number }>();
    for (const s of students) {
      for (const [code, pct] of Object.entries(s.benchmarkPctByCode)) {
        const cur = aggMap.get(code) ?? { sum: 0, n: 0 };
        cur.sum += pct;
        cur.n += 1;
        aggMap.set(code, cur);
      }
    }
    const minCoverage = Math.max(1, Math.ceil(students.length * 0.5));
    const weakestBenchmarks = Array.from(aggMap.entries())
      .filter(([, v]) => v.n >= minCoverage)
      .map(([code, v]) => ({
        benchmarkCode: code,
        avgPct: Math.round(v.sum / v.n),
        coveragePct: Math.round((v.n / Math.max(1, students.length)) * 100),
      }))
      .sort((a, b) => a.avgPct - b.avgPct)
      .slice(0, 5);

    // Sub-pods: only meaningful for ≥8-student groups. numPods scales
    // 8→2, 12→3, capped at 3 (more than 3 sub-pods inside one classroom
    // is operational overkill).
    let subPods: Array<{
      podIndex: number;
      dominantCategory: string | null;
      memberNames: string[];
    }> = [];
    if (students.length >= 8) {
      const profiles = students
        .map((s) => hydrated.profilesByStudent.get(s.studentId))
        .filter((p): p is StudentSkillProfile => !!p);
      if (profiles.length >= 6) {
        const numPods = Math.min(3, Math.max(2, Math.ceil(profiles.length / 5)));
        const seats = Math.ceil(profiles.length / numPods);
        const cluster = clusterByBenchmarkDeficit(profiles, numPods, seats);
        subPods = cluster.groups.map((p, idx) => ({
          podIndex: idx + 1,
          dominantCategory: p.dominantCategory,
          memberNames: p.students.map(
            (sp) => `${sp.firstName ?? ""} ${sp.lastName ?? ""}`.trim(),
          ),
        }));
      }
    }

    return {
      groupIndex: group.groupIndex,
      name: group.name,
      recipeSummary: group.recipe?.summary ?? "",
      seatsPerSection: group.seatsPerSection,
      students,
      focusStandards: group.focusStandards ?? null,
      weakestBenchmarks,
      subPods,
      context: {
        activeMtss: students.filter((s) => s.hasActiveMtss).length,
        activeSafetyPlan: students.filter((s) => s.hasActiveSafetyPlan).length,
        everRetained: students.filter((s) => s.everRetained).length,
        disciplineEvents30: students.reduce(
          (a, s) => a + s.disciplineDays30,
          0,
        ),
      },
    };
  });

  const buf = await renderComposerPlanPdf({
    schoolName: school?.name ?? "School",
    planName: plan.name,
    publicId: plan.publicId,
    subject: plan.subject,
    grade: plan.grade,
    schoolYear: plan.schoolYear,
    status: plan.status === "final" ? "final" : "draft",
    createdAt: plan.createdAt,
    finalizedAt: plan.finalizedAt,
    savedByName: savedBy?.displayName ?? "Unknown",
    groups: pdfGroups,
  });
  const slug = plan.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${slug || "composer-plan"}.pdf"`,
  );
  res.send(buf);
});

export default router;
