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
  type ClassComposerGroupRecipe,
  type ClassComposerPlanRow,
  type ClassComposerPlanGroupRow,
} from "@workspace/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import {
  isCoreTeam as isCoreTeamShared,
  canEditSafetyPlan,
} from "../lib/coreTeam.js";
import { renderComposerPlanPdf } from "../lib/composerPlanPdf.js";
import { schoolYearLabelFor, DEFAULT_SCHOOL_TZ } from "../lib/schoolYear.js";
import {
  computeSkillProfiles,
  clusterProfilesIntoGroups,
  clusterProfilesBalanced,
  summarizeSection,
  tallyLevelMix,
  isIntensiveCourseName,
  type StudentSkillProfile,
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
  const schoolYear = schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ);
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

function pickWindow(
  req: Request,
  available: Array<{ schoolYear: string; window: string }>,
): { schoolYear: string; window: string } {
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
    schoolYear: schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ),
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
  const schoolYear = schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ);
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
  const mode: "intensive" | "regular" | "cusp" =
    rawMode === "regular" ? "regular" : rawMode === "cusp" ? "cusp" : "intensive";
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
  const eligibilityMaxPctDefault = mode === "intensive" ? 70 : 100;
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
  const { schoolYear, window } = pickWindow(req, available);

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
    mode === "intensive" ? new Set([1, 2]) : mode === "cusp" ? new Set([2, 3]) : null;
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
    : useBalanced
      ? clusterProfilesBalanced(eligible, sections, seats)
      : clusterProfilesIntoGroups(eligible, sections, seats);

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
  const { schoolYear, window } = pickWindow(req, available);

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
      : schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ);
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
  res.json({ plan, groups });
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

// Shared helper: gather PDF/CSV student rows for a plan's groups by
// hydrating each group's stored student_ids with current FAST profiles.
async function hydratePlanStudents(
  schoolId: number,
  plan: ClassComposerPlanRow,
  groups: ClassComposerPlanGroupRow[],
): Promise<
  Array<{
    group: ClassComposerPlanGroupRow;
    students: Array<{
      studentId: string;
      localSisId: string | null;
      firstName: string;
      lastName: string;
      grade: number | null;
      fastLevel: number | null;
      overallPct: number | null;
    }>;
  }>
> {
  const allIds = Array.from(new Set(groups.flatMap((g) => g.studentIds)));
  if (allIds.length === 0) {
    return groups.map((g) => ({ group: g, students: [] }));
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
  const profile = await computeSkillProfiles({
    schoolId,
    subject: plan.subject,
    schoolYear: available[0]?.schoolYear ?? plan.schoolYear,
    window: available[0]?.window ?? "pm3",
    studentIds: allIds,
  });
  const profById = new Map(profile.map((p) => [p.studentId, p]));

  // Fall back to a plain students table read for kids with no profile
  // (unscored) so we still print their names.
  const studentRows = await db
    .select({
      studentId: studentsTable.studentId,
      localSisId: studentsTable.localSisId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        inArray(studentsTable.studentId, allIds),
      ),
    );
  const baseById = new Map(studentRows.map((s) => [s.studentId, s]));

  return groups.map((g) => ({
    group: g,
    students: g.studentIds.map((sid: string) => {
      const p = profById.get(sid);
      const b = baseById.get(sid);
      return {
        studentId: sid,
        localSisId: p?.localSisId ?? b?.localSisId ?? null,
        firstName: p?.firstName ?? b?.firstName ?? "(unknown)",
        lastName: p?.lastName ?? b?.lastName ?? "",
        grade: p?.grade ?? b?.grade ?? null,
        fastLevel: p?.fastLevel ?? null,
        overallPct: p?.overallPct ?? null,
      };
    }),
  }));
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
  const lines: string[] = [
    [
      "plan_id",
      "plan_name",
      "subject",
      "grade",
      "school_year",
      "group_index",
      "group_name",
      "student_id",
      "local_sis_id",
      "last_name",
      "first_name",
      "student_grade",
      "fast_level",
      "overall_pct",
    ]
      .map(esc)
      .join(","),
  ];
  for (const { group, students } of hydrated) {
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
          s.studentId,
          s.localSisId,
          s.lastName,
          s.firstName,
          s.grade,
          s.fastLevel != null ? `L${s.fastLevel}` : null,
          s.overallPct != null ? Math.round(s.overallPct) : null,
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
    groups: hydrated.map(({ group, students }) => ({
      groupIndex: group.groupIndex,
      name: group.name,
      recipeSummary: group.recipe?.summary ?? "",
      seatsPerSection: group.seatsPerSection,
      students,
    })),
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
