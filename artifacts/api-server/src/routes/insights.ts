// Insights — eduCLIMBER-style whole-child synthesis. Two endpoints:
//
//   GET /api/insights/students/:studentId/profile
//        Single-student deep page. Header (demographics, MTSS tier),
//        five pillars (academics, behavior, attendance/flow, supports,
//        family), and a list of derived risk callouts.
//
//   GET /api/insights/watchlist
//        Filterable list of students with quick-glance status chips.
//        Filters: grade, gender, ell, ese, 504, ct_ela, ct_math, tier,
//        bq_ela, bq_math. Time window applies to behavior + flow counts.
//
// Both endpoints honor the v1 visibility model:
//   * core team (Admin / SuperUser / MTSS / Behavior / PBIS Coord) →
//     every student at the active school.
//   * everyone else → students on their roster (section_roster ⨝
//     class_sections) UNION students linked to them via the
//     student_trusted_adults table.
//
// Time windows are 3/7/15/30 days, or a custom from/to range.

import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  studentsTable,
  staffTable,
  classSectionsTable,
  sectionRosterTable,
  studentTrustedAdultsTable,
  studentMtssPlansTable,
  studentFastScoresTable,
  assessmentsTable,
  pbisEntriesTable,
  supportNotesTable,
  tardiesTable,
  issAttendanceDayTable,
  studentAttendanceDayTable,
  weatherDayTable,
  hallPassesTable,
  pulloutsTable,
  studentAccommodationsTable,
  schoolAccommodationsTable,
  interventionEntriesTable,
  parentStudentsTable,
  studentSeparationsTable,
  studentRetentionsTable,
  housesTable,
} from "@workspace/db";
import { and, eq, inArray, isNull, gte, lte, sql, desc, or } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import {
  placePm3,
  placeOnChart,
  hasChart,
  bucketTarget,
  SUB_LEVEL_LABEL,
  type Subject,
} from "../lib/fastCutScores.js";
import { schoolYearLabelFor, DEFAULT_SCHOOL_TZ } from "../lib/schoolYear.js";
import { loadFastHistory, pickHistory } from "../lib/fastHistory.js";
import {
  parseInsightsFilters,
  applyInsightsFilters,
  hasAnyInsightsFilter,
  narrowCohort,
  type InsightsFilters,
} from "../lib/insightsFilters.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Auth + visibility helpers
// ---------------------------------------------------------------------------

async function loadStaff(req: Request, res: Response) {
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

function isCoreTeam(s: typeof staffTable.$inferSelect): boolean {
  return Boolean(
    s.isSuperUser ||
      s.isAdmin ||
      s.isBehaviorSpecialist ||
      s.isMtssCoordinator ||
      s.isPbisCoordinator,
  );
}

// Returns the set of student business IDs (text) this staff member is
// allowed to view at this school. Core team gets everyone; everyone else
// gets their roster ∪ trusted-adult assignments.
//
// `coreTeamShortcut` short-circuits the union for performance — the watch-
// list and profile callers test isCoreTeam first and pass true here, in
// which case we return the full school set with a single query.
async function getVisibleStudentIds(
  staff: typeof staffTable.$inferSelect,
  schoolId: number,
): Promise<{ ids: Set<string>; full: boolean }> {
  if (isCoreTeam(staff)) {
    // Full set marker — caller can skip the studentId filter entirely.
    return { ids: new Set(), full: true };
  }
  // Roster: students in any section taught by this staff at this school.
  // We deliberately use sectionRoster (not periodRoster) here because that
  // is the canonical "this teacher's students" join in this codebase — see
  // routes/teacherRoster.ts which builds the same set the same way. The
  // periodRoster table has no school_id and no teacher mapping, so it
  // can't safely scope visibility on its own; period-based access is
  // already covered by sectionRoster filtered by class_sections.period.
  const rosterRows = await db
    .select({ studentId: sectionRosterTable.studentId })
    .from(sectionRosterTable)
    .innerJoin(
      classSectionsTable,
      eq(classSectionsTable.id, sectionRosterTable.sectionId),
    )
    .where(
      and(
        eq(sectionRosterTable.schoolId, schoolId),
        eq(classSectionsTable.teacherStaffId, staff.id),
        eq(classSectionsTable.isPlanning, false),
      ),
    );
  // Trusted-adult assignments.
  const trustedRows = await db
    .select({ studentId: studentTrustedAdultsTable.studentId })
    .from(studentTrustedAdultsTable)
    .where(
      and(
        eq(studentTrustedAdultsTable.schoolId, schoolId),
        eq(studentTrustedAdultsTable.staffId, staff.id),
      ),
    );
  const ids = new Set<string>();
  for (const r of rosterRows) ids.add(r.studentId);
  for (const r of trustedRows) ids.add(r.studentId);
  return { ids, full: false };
}

// ---------------------------------------------------------------------------
// Time-window parsing — 3/7/15/30 day chips + custom range
// ---------------------------------------------------------------------------

type TimeWindow = {
  from: Date;
  to: Date;
  label: string;
  days: number | null;
};

function parseTimeWindow(req: Request): TimeWindow {
  const now = new Date();
  const winRaw = typeof req.query.window === "string" ? req.query.window : "";
  const win = winRaw.toLowerCase();

  if (win === "custom") {
    const fromRaw = typeof req.query.from === "string" ? req.query.from : "";
    const toRaw = typeof req.query.to === "string" ? req.query.to : "";
    const from = fromRaw ? new Date(fromRaw) : null;
    const to = toRaw ? new Date(toRaw) : null;
    if (from && !Number.isNaN(from.getTime()) && to && !Number.isNaN(to.getTime())) {
      // Inclusive end-of-day for the `to` bound — the picker sends date-only.
      const toEod = new Date(to);
      toEod.setHours(23, 59, 59, 999);
      return {
        from,
        to: toEod,
        label: `${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`,
        days: null,
      };
    }
    // Fall through to default if custom range was malformed.
  }

  // Preset chips. Default to 30d ("month") matching the project's spec.
  const presetDays: Record<string, number> = {
    "3": 3,
    "7": 7,
    "15": 15,
    "30": 30,
    month: 30,
  };
  const days = presetDays[win] ?? 30;
  const from = new Date(now);
  from.setDate(from.getDate() - days);
  return {
    from,
    to: now,
    label: `Last ${days} days`,
    days,
  };
}

// ---------------------------------------------------------------------------
// Risk rules — pure functions over the loaded data. Order matters for the
// "top risk flag" chip on the watchlist (first hit wins, severity-then-
// alphabetical within same severity).
// ---------------------------------------------------------------------------

type RiskFlag = {
  code: string;
  severity: "info" | "watch" | "high";
  label: string;
};

const SEVERITY_RANK: Record<RiskFlag["severity"], number> = {
  high: 0,
  watch: 1,
  info: 2,
};

function topRisk(flags: RiskFlag[]): RiskFlag | null {
  if (flags.length === 0) return null;
  const sorted = [...flags].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.code.localeCompare(b.code),
  );
  return sorted[0];
}

// ---------------------------------------------------------------------------
// GET /api/insights/students/:studentId/profile
// ---------------------------------------------------------------------------

// Per-subject LG bucket "moving target" trajectory.
//
// Per FL LG rules: prior-year PM3 placed on the PRIOR-grade chart sets
// the baseline sub-level; the target is the next sub-level's minimum
// scale score on the CURRENT-grade chart. The target is fixed all year;
// what moves is how far the student sits from it after each PM window.
//
// Returns null when there is no prior-year PM3, no current-grade chart
// (EOC subjects without grade-keyed charts), or the student is already
// at L5 (no next stop on the climb path).
type BucketWindow = "prior" | "pm1" | "pm2" | "pm3";
interface BucketTrajectoryPoint {
  window: BucketWindow;
  score: number | null;
  gap: number | null; // target − score; positive = still need to climb
  delta: number | null; // previous gap − current gap; positive = closing
}
interface BucketTrajectory {
  targetScore: number;
  targetSubLevelLabel: string;
  baselineSubLevel: string;
  baselineScore: number;
  latestWindow: BucketWindow;
  lgMet: boolean;
  trajectory: BucketTrajectoryPoint[];
}
function buildBucketTrajectory(
  subject: Subject,
  grade: number,
  priorYearScore: number | null,
  pm1: number | null,
  pm2: number | null,
  pm3: number | null,
): BucketTrajectory | null {
  if (priorYearScore == null) return null;
  const baselinePlacement = placePm3(priorYearScore, subject, grade);
  if (!baselinePlacement) return null;
  const target = bucketTarget(subject, grade, baselinePlacement.subLevel);
  if (!target) return null;

  const windows: Array<{ window: BucketWindow; score: number | null }> = [
    { window: "prior", score: priorYearScore },
    { window: "pm1", score: pm1 },
    { window: "pm2", score: pm2 },
    { window: "pm3", score: pm3 },
  ];

  let lastGap: number | null = null;
  let latestWindow: BucketWindow = "prior";
  const trajectory: BucketTrajectoryPoint[] = windows.map((w) => {
    if (w.score == null) {
      return { window: w.window, score: null, gap: null, delta: null };
    }
    const gap = target.score - w.score;
    const delta = lastGap == null ? null : lastGap - gap;
    lastGap = gap;
    latestWindow = w.window;
    return { window: w.window, score: w.score, gap, delta };
  });

  // LG considered met when the most recent PM (pm3 preferred, else pm2,
  // else pm1) lands at or above the target on the current-grade chart.
  // Phase 2 within-level sub-tier moves are handled by the teacher
  // roster route; for the profile bucket strip the simpler "cleared
  // the target" check is what the trajectory pill needs.
  const latestScore = pm3 ?? pm2 ?? pm1 ?? null;
  const lgMet = latestScore != null && latestScore >= target.score;

  return {
    targetScore: target.score,
    targetSubLevelLabel: SUB_LEVEL_LABEL[target.nextStop],
    baselineSubLevel: SUB_LEVEL_LABEL[baselinePlacement.subLevel],
    baselineScore: priorYearScore,
    latestWindow,
    lgMet,
    trajectory,
  };
}

// (retention indicator data is loaded per request below — not at module scope.)
router.get("/insights/students/:studentId/profile", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req, res);
  if (!staff) return;

  const studentId = String(req.params.studentId ?? "").trim();
  if (!studentId) {
    res.status(400).json({ error: "Missing studentId" });
    return;
  }

  // Visibility check FIRST — we don't want to leak the existence of a
  // student to a teacher who isn't supposed to see them.
  const visibility = await getVisibleStudentIds(staff, schoolId);
  let visibilityPath: "core" | "roster" | "trusted_adult" | null = null;
  if (visibility.full) {
    visibilityPath = "core";
  } else if (visibility.ids.has(studentId)) {
    // We don't yet know whether it was the roster path or the trusted-
    // adult path; do a single small lookup to disambiguate (purely for
    // the UI's "Why am I seeing this?" hint).
    const [tLink] = await db
      .select({ id: studentTrustedAdultsTable.id })
      .from(studentTrustedAdultsTable)
      .where(
        and(
          eq(studentTrustedAdultsTable.schoolId, schoolId),
          eq(studentTrustedAdultsTable.staffId, staff.id),
          eq(studentTrustedAdultsTable.studentId, studentId),
        ),
      );
    visibilityPath = tLink ? "trusted_adult" : "roster";
  }
  if (!visibilityPath) {
    res.status(403).json({ error: "Not in your roster or trusted-adult list" });
    return;
  }

  const window = parseTimeWindow(req);

  // Load the student row with demographics. 404 if it doesn't exist.
  const [student] = await db
    .select()
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, studentId),
        eq(studentsTable.schoolId, schoolId),
      ),
    );
  if (!student) {
    res.status(404).json({ error: "Student not found in this school" });
    return;
  }

  // Retention indicator (R-in-circle on the Student Profile header).
  // Cheap query — at most a couple of rows per student.
  const retentionRows = await db
    .select({ gradeLevel: studentRetentionsTable.gradeLevel })
    .from(studentRetentionsTable)
    .where(
      and(
        eq(studentRetentionsTable.schoolId, schoolId),
        eq(studentRetentionsTable.studentId, studentId),
      ),
    );
  const retainedGradesList = retentionRows
    .map((r) => r.gradeLevel)
    .sort((a, b) => a - b);

  // ----- Pillar: Academics -----------------------------------------------
  const fastScores = await db
    .select()
    .from(studentFastScoresTable)
    .where(
      and(
        eq(studentFastScoresTable.schoolId, schoolId),
        eq(studentFastScoresTable.studentId, studentId),
        // FAST Phase 1: scope to current SY — student profile shows
        // current-year scores; prior-year Florida backfill rows live
        // on separate (school_year)-keyed rows.
        eq(
          studentFastScoresTable.schoolYear,
          schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ),
        ),
      ),
    );
  // Multi-year prior-year PM3 history (FL Florida historical importer).
  // Loaded for this single student so the FAST PM card can show prior
  // years alongside current PM1/PM2/PM3. Empty when no historical rows.
  const fastHistoryMap = await loadFastHistory({
    schoolId,
    studentIds: [studentId],
  });
  const assessments = await db
    .select({
      name: assessmentsTable.assessmentName,
      score: assessmentsTable.score,
      scoreLevel: assessmentsTable.scoreLevel,
      administeredAt: assessmentsTable.administeredAt,
      source: assessmentsTable.source,
    })
    .from(assessmentsTable)
    .where(
      and(
        eq(assessmentsTable.schoolId, schoolId),
        eq(assessmentsTable.studentId, studentId),
      ),
    )
    .orderBy(desc(assessmentsTable.administeredAt))
    .limit(50);

  // ----- Pillar: Behavior (windowed counts + recent items) ---------------
  const fromIso = window.from.toISOString();
  const toIso = window.to.toISOString();

  // pbis_entries / support_notes store createdAt as TEXT (ISO). String
  // compare on ISO is monotone so >= / <= works correctly.
  const pbisRows = await db
    .select({
      polarity: pbisEntriesTable.polarity,
      reason: pbisEntriesTable.reason,
      createdAt: pbisEntriesTable.createdAt,
      voidedAt: pbisEntriesTable.voidedAt,
      staffName: pbisEntriesTable.staffName,
      points: pbisEntriesTable.points,
    })
    .from(pbisEntriesTable)
    .where(
      and(
        eq(pbisEntriesTable.schoolId, schoolId),
        eq(pbisEntriesTable.studentId, studentId),
        gte(pbisEntriesTable.createdAt, fromIso),
        lte(pbisEntriesTable.createdAt, toIso),
      ),
    );
  let pbisPositive = 0;
  let pbisNegative = 0;
  for (const r of pbisRows) {
    if (r.voidedAt) continue;
    if (r.polarity === "negative") pbisNegative += 1;
    else pbisPositive += 1;
  }

  const supportNotes = await db
    .select({
      noteType: supportNotesTable.noteType,
      noteText: supportNotesTable.noteText,
      staffName: supportNotesTable.staffName,
      createdAt: supportNotesTable.createdAt,
    })
    .from(supportNotesTable)
    .where(
      and(
        eq(supportNotesTable.schoolId, schoolId),
        eq(supportNotesTable.studentId, studentId),
        gte(supportNotesTable.createdAt, fromIso),
        lte(supportNotesTable.createdAt, toIso),
      ),
    )
    .orderBy(desc(supportNotesTable.createdAt))
    .limit(20);

  // ----- Pillar: Attendance / Flow ---------------------------------------
  const tardyRows = await db
    .select({
      period: tardiesTable.period,
      reason: tardiesTable.reason,
      createdAt: tardiesTable.createdAt,
    })
    .from(tardiesTable)
    .where(
      and(
        eq(tardiesTable.schoolId, schoolId),
        eq(tardiesTable.studentId, studentId),
        gte(tardiesTable.createdAt, fromIso),
        lte(tardiesTable.createdAt, toIso),
      ),
    );

  const fromDateOnly = fromIso.slice(0, 10);
  const toDateOnly = toIso.slice(0, 10);
  const issRows = await db
    .select({
      day: issAttendanceDayTable.day,
      source: issAttendanceDayTable.source,
      notes: issAttendanceDayTable.notes,
    })
    .from(issAttendanceDayTable)
    .where(
      and(
        eq(issAttendanceDayTable.schoolId, schoolId),
        eq(issAttendanceDayTable.studentId, studentId),
        gte(issAttendanceDayTable.day, fromDateOnly),
        lte(issAttendanceDayTable.day, toDateOnly),
      ),
    );

  // Hall pass count vs school average for this grade. We compute the
  // average inline: total hall passes in window for the student's grade
  // ÷ distinct students with passes (avoids inflation when most kids
  // never use one).
  const studentHallPasses = await db
    .select({ id: hallPassesTable.id })
    .from(hallPassesTable)
    .where(
      and(
        eq(hallPassesTable.schoolId, schoolId),
        eq(hallPassesTable.studentId, studentId),
        gte(hallPassesTable.createdAt, fromIso),
        lte(hallPassesTable.createdAt, toIso),
      ),
    );
  const hallPassCount = studentHallPasses.length;
  const [hallPassAvgRow] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      students: sql<number>`COUNT(DISTINCT ${hallPassesTable.studentId})::int`,
    })
    .from(hallPassesTable)
    .innerJoin(
      studentsTable,
      and(
        eq(studentsTable.studentId, hallPassesTable.studentId),
        eq(studentsTable.schoolId, hallPassesTable.schoolId),
      ),
    )
    .where(
      and(
        eq(hallPassesTable.schoolId, schoolId),
        eq(studentsTable.grade, student.grade),
        gte(hallPassesTable.createdAt, fromIso),
        lte(hallPassesTable.createdAt, toIso),
      ),
    );
  const peerStudents = hallPassAvgRow?.students ?? 0;
  const hallPassSchoolAvg =
    peerStudents > 0 ? (hallPassAvgRow!.total ?? 0) / peerStudents : 0;

  const recentPullouts = await db
    .select({
      requestedAt: pulloutsTable.requestedAt,
      reason: pulloutsTable.reason,
      status: pulloutsTable.status,
      referringTeacherName: pulloutsTable.referringTeacherName,
    })
    .from(pulloutsTable)
    .where(
      and(
        eq(pulloutsTable.schoolId, schoolId),
        eq(pulloutsTable.studentId, studentId),
      ),
    )
    .orderBy(desc(pulloutsTable.requestedAt))
    .limit(10);

  // ----- Pillar: Supports ------------------------------------------------
  const accommodations = await db
    .select({
      id: studentAccommodationsTable.id,
      label: schoolAccommodationsTable.name,
      assignedAt: studentAccommodationsTable.assignedAt,
    })
    .from(studentAccommodationsTable)
    .leftJoin(
      schoolAccommodationsTable,
      eq(
        schoolAccommodationsTable.id,
        studentAccommodationsTable.accommodationId,
      ),
    )
    .where(
      and(
        eq(studentAccommodationsTable.schoolId, schoolId),
        eq(studentAccommodationsTable.studentId, studentId),
        isNull(studentAccommodationsTable.removedAt),
      ),
    );

  const interventionsAll = await db
    .select({
      interventionType: interventionEntriesTable.interventionType,
      note: interventionEntriesTable.note,
      staffName: interventionEntriesTable.staffName,
      createdAt: interventionEntriesTable.createdAt,
    })
    .from(interventionEntriesTable)
    .where(
      and(
        eq(interventionEntriesTable.schoolId, schoolId),
        eq(interventionEntriesTable.studentId, studentId),
      ),
    )
    .orderBy(desc(interventionEntriesTable.createdAt))
    .limit(15);

  const activeMtssPlans = await db
    .select({
      id: studentMtssPlansTable.id,
      title: studentMtssPlansTable.title,
      tier: studentMtssPlansTable.tier,
      openedAt: studentMtssPlansTable.openedAt,
      goals: studentMtssPlansTable.goals,
    })
    .from(studentMtssPlansTable)
    .where(
      and(
        eq(studentMtssPlansTable.schoolId, schoolId),
        eq(studentMtssPlansTable.studentId, studentId),
        isNull(studentMtssPlansTable.closedAt),
      ),
    )
    .orderBy(desc(studentMtssPlansTable.openedAt));
  // Highest active tier — drives the header chip and tier-derived risk
  // flags. Tier 1 = no active plan (default state).
  const mtssTier =
    activeMtssPlans.length === 0
      ? 1
      : activeMtssPlans.reduce((m, p) => Math.max(m, p.tier), 1);

  // ----- MTSS progress -----------------------------------------------------
  // For each *active* plan, compute "is this plan working?" signals that an
  // MTSS coordinator can read at a glance:
  //   * daysActive — how long the plan has been open (calendar days, not
  //     school days; honest about the plan's age regardless of holidays).
  //   * interventionCount — how many intervention entries were logged for
  //     this student since the plan opened. A plan with zero logged
  //     interventions in 30+ days is itself a finding.
  //   * pbisPositiveSinceOpen / pbisNegativeSinceOpen / pbisNetSinceOpen —
  //     PBIS movement scoped to the plan's lifetime, so a Tier 2 behavior
  //     plan can be evaluated by whether net trend turned positive after
  //     it opened.
  //
  // Implementation: fetch interventions and PBIS once from the earliest
  // active plan's openedAt forward, then partition per plan in JS. Avoids
  // N+1 queries when a student carries multiple concurrent plans (rare in
  // practice but cheap to handle correctly).
  type MtssProgressRow = {
    planId: number;
    daysActive: number;
    interventionCount: number;
    pbisPositiveSinceOpen: number;
    pbisNegativeSinceOpen: number;
    pbisNetSinceOpen: number;
  };
  let mtssProgress: MtssProgressRow[] = [];
  if (activeMtssPlans.length > 0) {
    const earliestOpenedAt = activeMtssPlans
      .map((p) => p.openedAt as Date)
      .reduce((min, d) => (d < min ? d : min));
    const earliestOpenedIso = earliestOpenedAt.toISOString();

    const interventionsSincePlan = await db
      .select({ createdAt: interventionEntriesTable.createdAt })
      .from(interventionEntriesTable)
      .where(
        and(
          eq(interventionEntriesTable.schoolId, schoolId),
          eq(interventionEntriesTable.studentId, studentId),
          gte(interventionEntriesTable.createdAt, earliestOpenedIso),
        ),
      );

    const pbisSincePlan = await db
      .select({
        polarity: pbisEntriesTable.polarity,
        points: pbisEntriesTable.points,
        createdAt: pbisEntriesTable.createdAt,
        voidedAt: pbisEntriesTable.voidedAt,
      })
      .from(pbisEntriesTable)
      .where(
        and(
          eq(pbisEntriesTable.schoolId, schoolId),
          eq(pbisEntriesTable.studentId, studentId),
          gte(pbisEntriesTable.createdAt, earliestOpenedIso),
        ),
      );

    const nowMs = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    mtssProgress = activeMtssPlans.map((p) => {
      const openedAtMs = +new Date(p.openedAt as Date);
      const daysActive = Math.max(0, Math.floor((nowMs - openedAtMs) / dayMs));
      const interventionCount = interventionsSincePlan.filter(
        (e) => +new Date(e.createdAt) >= openedAtMs,
      ).length;
      let pbisPositiveSinceOpen = 0;
      let pbisNegativeSinceOpen = 0;
      for (const e of pbisSincePlan) {
        if (e.voidedAt) continue;
        if (+new Date(e.createdAt) < openedAtMs) continue;
        if (e.polarity === "positive") {
          pbisPositiveSinceOpen += e.points ?? 0;
        } else if (e.polarity === "negative") {
          pbisNegativeSinceOpen += e.points ?? 0;
        }
      }
      return {
        planId: p.id,
        daysActive,
        interventionCount,
        pbisPositiveSinceOpen,
        pbisNegativeSinceOpen,
        pbisNetSinceOpen: pbisPositiveSinceOpen - pbisNegativeSinceOpen,
      };
    });
  }

  const trustedAdults = await db
    .select({
      id: studentTrustedAdultsTable.id,
      staffId: studentTrustedAdultsTable.staffId,
      staffName: staffTable.displayName,
    })
    .from(studentTrustedAdultsTable)
    .leftJoin(staffTable, eq(staffTable.id, studentTrustedAdultsTable.staffId))
    .where(
      and(
        eq(studentTrustedAdultsTable.schoolId, schoolId),
        eq(studentTrustedAdultsTable.studentId, studentId),
      ),
    );

  // ----- Pillar: Family --------------------------------------------------
  const linkedParents = await db
    .select({ id: parentStudentsTable.id })
    .from(parentStudentsTable)
    .where(eq(parentStudentsTable.studentId, student.id));

  // ----- Risk flags ------------------------------------------------------
  const elaScore = fastScores.find((s) => s.subject === "ela");
  const mathScore = fastScores.find((s) => s.subject === "math");

  const flags: RiskFlag[] = [];
  if (elaScore?.priorYearBq) {
    flags.push({
      code: "BQ_ELA",
      severity: "high",
      label: "Bottom quartile in ELA (prior year FAST)",
    });
  }
  if (mathScore?.priorYearBq) {
    flags.push({
      code: "BQ_MATH",
      severity: "high",
      label: "Bottom quartile in Math (prior year FAST)",
    });
  }
  const behaviorTotal = pbisNegative + supportNotes.length;
  if (behaviorTotal >= 3) {
    flags.push({
      code: "BEHAVIOR_TREND",
      severity: "high",
      label: `${behaviorTotal} behavior entries in ${window.label.toLowerCase()}`,
    });
  } else if (behaviorTotal > 0) {
    flags.push({
      code: "BEHAVIOR_NOTED",
      severity: "watch",
      label: `${behaviorTotal} behavior entries in ${window.label.toLowerCase()}`,
    });
  }
  if (issRows.length > 0) {
    flags.push({
      code: "ISS_RECENT",
      severity: "high",
      label: `${issRows.length} ISS day${issRows.length === 1 ? "" : "s"} in window`,
    });
  }
  if (
    hallPassCount > 0 &&
    hallPassSchoolAvg > 0 &&
    hallPassCount > hallPassSchoolAvg * 2
  ) {
    flags.push({
      code: "HALL_PASS_ANOMALY",
      severity: "watch",
      label: `Hall pass usage ${hallPassCount} vs grade avg ${hallPassSchoolAvg.toFixed(1)}`,
    });
  }
  if (mtssTier >= 2) {
    flags.push({
      code: `TIER_${mtssTier}`,
      severity: "watch",
      label: `Active MTSS Tier ${mtssTier} plan`,
    });
  }
  // Intervention gap: 2+ HIGH flags AND no active MTSS plan.
  const highCount = flags.filter((f) => f.severity === "high").length;
  if (highCount >= 2 && activeMtssPlans.length === 0) {
    flags.push({
      code: "INTERVENTION_GAP",
      severity: "high",
      label: "Multiple risk indicators with no active MTSS plan",
    });
  }
  // Positive momentum (info) — useful counterbalance.
  if (pbisPositive >= 3 && pbisNegative === 0) {
    flags.push({
      code: "POSITIVE_MOMENTUM",
      severity: "info",
      label: `${pbisPositive} positive entries with no concerns in window`,
    });
  }
  // CT designations are surfaced as info chips, not risks.
  if (student.ctEla) {
    flags.push({
      code: "CT_ELA",
      severity: "info",
      label: "Critical Thinking — ELA",
    });
  }
  if (student.ctMath) {
    flags.push({
      code: "CT_MATH",
      severity: "info",
      label: "Critical Thinking — Math",
    });
  }

  // ----- Whole-child radar -----------------------------------------------
  // Five-axis 0-100 score across the same pillars as the detail cards
  // below. Each axis includes a one-line rationale that the client
  // surfaces as a hover tooltip + sidebar list. Formulas are heuristic
  // and directional — they're meant to give a fast at-a-glance read,
  // not a precise measurement.
  function levelToScore(level: 1 | 2 | 3 | 4 | 5): number {
    return level === 1 ? 20 : level === 2 ? 40 : level === 3 ? 70 : level === 4 ? 85 : 95;
  }

  // Academics: per-subject FAST placement. PM3 uses placePm3 which prefers
  // the prior-grade chart and falls back to current-grade — so PM3 can
  // still be placed for grades where no current-grade chart exists (e.g.
  // 9th-grade math via the 8th-grade chart). PM2/PM1 must use the
  // current-grade chart, so they require hasChart() for the grade.
  // Maps L1..L5 to 20/40/70/85/95 and averages across subjects.
  const subjectScores: Array<{ subject: "ela" | "math"; level: number; score: number }> = [];
  for (const fs of fastScores) {
    const subj = fs.subject;
    if (subj !== "ela" && subj !== "math") continue;
    let placement: ReturnType<typeof placeOnChart> = null;
    if (fs.pm3 != null) {
      placement = placePm3(fs.pm3, subj, student.grade);
    } else if (fs.pm2 != null && hasChart(subj, student.grade)) {
      placement = placeOnChart(fs.pm2, subj, student.grade);
    } else if (fs.pm1 != null && hasChart(subj, student.grade)) {
      placement = placeOnChart(fs.pm1, subj, student.grade);
    }
    if (!placement) continue;
    subjectScores.push({ subject: subj, level: placement.level, score: levelToScore(placement.level) });
  }
  const academicsHasData = subjectScores.length > 0;
  const academicsScore = academicsHasData
    ? Math.round(subjectScores.reduce((a, b) => a + b.score, 0) / subjectScores.length)
    : 50;
  const academicsRationale = academicsHasData
    ? `${subjectScores
        .map((s) => `${s.subject.toUpperCase()} L${s.level}`)
        .join(", ")} (avg level ${(
        subjectScores.reduce((a, b) => a + b.level, 0) / subjectScores.length
      ).toFixed(1)})`
    : "No FAST data with a cut-score chart for this grade";

  // Separation-flag corroboration signal. Counts how many DISTINCT
  // teachers have an active separation flag on this student in the
  // current school year (the student appears as either side of the
  // pair). A single teacher's flag is a classroom-management request
  // about a specific pairing — not personal-behavior data — and we
  // intentionally do NOT let it move the score. But once two or more
  // independent teachers flag this student in different pairings, the
  // pattern becomes a behavior signal worth recording.
  //
  // School year is derived inline (Aug-Jul cutover) to mirror
  // separations.ts::currentSchoolYear without cross-importing a route.
  function _currentSchoolYear(now = new Date()): string {
    const y = now.getFullYear();
    const m = now.getMonth();
    return m >= 7 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
  }
  const separationDistinctTeachersRow = await db
    .select({
      n: sql<number>`count(distinct ${studentSeparationsTable.reporterStaffId})`,
    })
    .from(studentSeparationsTable)
    .where(
      and(
        eq(studentSeparationsTable.schoolId, schoolId),
        eq(studentSeparationsTable.schoolYear, _currentSchoolYear()),
        or(
          eq(studentSeparationsTable.studentAId, studentId),
          eq(studentSeparationsTable.studentBId, studentId),
        ),
      ),
    );
  const separationFlagTeacherCount = Number(
    separationDistinctTeachersRow[0]?.n ?? 0,
  );

  // Behavior: PBIS positives lift, PBIS negatives + support notes drag.
  // Caps prevent a single very-active student from saturating either end.
  // Corroborated separation flags (>=2 different teachers) apply a fixed
  // -10 drag — modest because it's a softer signal than a logged
  // negative PBIS or a support note, but real because two independent
  // teachers seeing the same student in different problematic pairings
  // is a pattern, not a one-off.
  let behaviorScore = 75;
  behaviorScore += Math.min(pbisPositive * 3, 25);
  behaviorScore -= Math.min(pbisNegative * 5, 50);
  behaviorScore -= Math.min(supportNotes.length * 8, 60);
  if (separationFlagTeacherCount >= 2) behaviorScore -= 10;
  behaviorScore = Math.max(0, Math.min(100, behaviorScore));
  const behaviorRationaleParts: string[] = [];
  if (pbisPositive + pbisNegative + supportNotes.length === 0) {
    behaviorRationaleParts.push(`No behavior entries (${window.label.toLowerCase()})`);
  } else {
    behaviorRationaleParts.push(
      `${pbisPositive} positive, ${pbisNegative} concerns, ${supportNotes.length} notes (${window.label.toLowerCase()})`,
    );
  }
  if (separationFlagTeacherCount >= 2) {
    behaviorRationaleParts.push(
      `flagged for separation in ${separationFlagTeacherCount} classrooms`,
    );
  }
  const behaviorRationale = behaviorRationaleParts.join(" · ");

  // Flow (attendance & transitions): tardies + ISS days + over-average
  // hall-pass usage drag from a 100 baseline. Hall-pass excess only
  // counts when the student is materially above their grade peers.
  let flowScore = 100;
  flowScore -= tardyRows.length * 5;
  flowScore -= issRows.length * 15;
  const hallPassExcess =
    hallPassSchoolAvg > 0 ? Math.max(0, hallPassCount - hallPassSchoolAvg * 2) : 0;
  flowScore -= Math.min(hallPassExcess * 5, 25);
  flowScore = Math.max(0, Math.min(100, flowScore));
  const flowRationale =
    tardyRows.length === 0 && issRows.length === 0
      ? `No tardies or ISS days (${window.label.toLowerCase()})`
      : `${tardyRows.length} tardies, ${issRows.length} ISS days, ${hallPassCount} hall passes`;

  // Supports in place: this axis is intentionally a "scaffolding meter"
  // rather than a wellness signal. A high score means the student is
  // actively receiving wraparound (accommodations, MTSS plan, recent
  // intervention notes, trusted-adult linkage). The client renders a
  // small footnote so viewers don't read it as "good = no help needed".
  let supportsScore = 30;
  if (accommodations.length > 0) supportsScore += 20;
  supportsScore += Math.min(activeMtssPlans.length * 25, 25);
  const recentInterventionThreshold = new Date();
  recentInterventionThreshold.setDate(recentInterventionThreshold.getDate() - 30);
  const recentInterventions30d = interventionsAll.filter(
    (i) => i.createdAt && new Date(i.createdAt) >= recentInterventionThreshold,
  );
  if (recentInterventions30d.length > 0) supportsScore += 15;
  if (trustedAdults.length > 0) supportsScore += 10;
  supportsScore = Math.max(0, Math.min(100, supportsScore));
  const supportsTotal =
    accommodations.length +
    activeMtssPlans.length +
    recentInterventions30d.length +
    trustedAdults.length;
  const supportsRationale =
    supportsTotal === 0
      ? "No active supports on record"
      : `${accommodations.length} accommodations, ${activeMtssPlans.length} active MTSS plans, ${recentInterventions30d.length} interventions in last 30d, ${trustedAdults.length} trusted adult${trustedAdults.length === 1 ? "" : "s"}`;

  // Family connection: comms channels + linked parent account.
  let familyScore = 0;
  if (student.parentEmail) familyScore += 30;
  if (student.parentPhone) familyScore += 20;
  if (linkedParents.length > 0) familyScore += 50;
  familyScore = Math.max(0, Math.min(100, familyScore));
  const familyParts: string[] = [];
  if (student.parentEmail) familyParts.push("email on file");
  if (student.parentPhone) familyParts.push("phone on file");
  if (linkedParents.length > 0) {
    familyParts.push(
      `${linkedParents.length} linked parent account${linkedParents.length === 1 ? "" : "s"}`,
    );
  }
  const familyRationale = familyParts.length === 0 ? "No family contact on file" : familyParts.join(" + ");

  // ----- Daily trends (sparklines) ---------------------------------------
  // Bucket the already-fetched pbis/tardy rows by UTC day. We use UTC
  // because the underlying ISO strings are stored as UTC; for sparkline
  // shape this is sufficient. (A school-tz refinement is a future hook.)
  // Always include zero days so the sparkline shape is honest about gaps.
  function utcDayString(iso: string): string {
    return iso.slice(0, 10); // 'YYYY-MM-DD'
  }
  function buildDayBuckets(from: Date, to: Date): string[] {
    const days: string[] = [];
    const startUtc = Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate(),
    );
    const endUtc = Date.UTC(
      to.getUTCFullYear(),
      to.getUTCMonth(),
      to.getUTCDate(),
    );
    for (let t = startUtc; t <= endUtc; t += 86_400_000) {
      days.push(new Date(t).toISOString().slice(0, 10));
    }
    return days;
  }
  const dayKeys = buildDayBuckets(window.from, window.to);

  const pbisDailyMap = new Map<string, { positive: number; negative: number }>();
  for (const k of dayKeys) pbisDailyMap.set(k, { positive: 0, negative: 0 });
  for (const r of pbisRows) {
    if (r.voidedAt) continue;
    const day = utcDayString(r.createdAt);
    const slot = pbisDailyMap.get(day);
    if (!slot) continue; // out of bucket range (defensive)
    if (r.polarity === "negative") slot.negative += 1;
    else slot.positive += 1;
  }
  const pbisDaily = dayKeys.map((day) => {
    const s = pbisDailyMap.get(day)!;
    return { day, positive: s.positive, negative: s.negative, net: s.positive - s.negative };
  });

  const tardiesDailyMap = new Map<string, number>();
  for (const k of dayKeys) tardiesDailyMap.set(k, 0);
  for (const r of tardyRows) {
    const day = utcDayString(r.createdAt);
    if (tardiesDailyMap.has(day)) {
      tardiesDailyMap.set(day, tardiesDailyMap.get(day)! + 1);
    }
  }
  const tardiesDaily = dayKeys.map((day) => ({
    day,
    count: tardiesDailyMap.get(day) ?? 0,
  }));

  // Intervention overlay: pull every intervention timestamp in the window
  // and bucket into UTC day keys. The client renders these as small
  // vertical markers on the PBIS sparkline so an MTSS coordinator can
  // visually correlate "did the trend change after we started logging
  // interventions?" — the eduCLIMBER intervention-overlay move.
  //
  // Separate query because `interventionsAll` is capped at 15 (most-
  // recent for the side-panel list); this needs every entry in the
  // window without a limit, but only the createdAt column.
  const interventionsInWindow = await db
    .select({ createdAt: interventionEntriesTable.createdAt })
    .from(interventionEntriesTable)
    .where(
      and(
        eq(interventionEntriesTable.schoolId, schoolId),
        eq(interventionEntriesTable.studentId, studentId),
        gte(interventionEntriesTable.createdAt, fromIso),
        lte(interventionEntriesTable.createdAt, toIso),
      ),
    );
  const interventionDaySet = new Set<string>();
  for (const r of interventionsInWindow) {
    const day = utcDayString(r.createdAt);
    if (dayKeys.length > 0 && day >= dayKeys[0]! && day <= dayKeys[dayKeys.length - 1]!) {
      interventionDaySet.add(day);
    }
  }
  const interventionDays = [...interventionDaySet].sort();

  res.json({
    header: {
      studentId: student.studentId,
      // Internal DB id — needed by the inline dismissal-mode editor on
      // the Student Profile, which calls PATCH /pickup/students/:id/
      // dismissal-mode (the pickup endpoint is keyed by db id, not by
      // the human-readable studentId).
      studentDbId: student.id,
      dismissalMode: student.dismissalMode,
      firstName: student.firstName,
      lastName: student.lastName,
      grade: student.grade,
      gender: student.gender,
      flags: {
        ell: student.ell,
        ese: student.ese,
        is504: student.is504,
        ctEla: student.ctEla,
        ctMath: student.ctMath,
      },
      mtssTier,
      activeMtssPlanCount: activeMtssPlans.length,
      visibilityPath,
      // Grades the student was retained in (ascending). Drives the R
      // indicator on the Student Profile header.
      retainedGrades: retainedGradesList,
      // PBIS house affiliation (null when unassigned). Drives the
      // colored house pill + admin "Change house" modal in the
      // Student Profile header. Loaded lazily here so the profile
      // route stays a single round-trip for the client.
      house: await (async () => {
        if (student.houseId == null) return null;
        const [h] = await db
          .select({
            id: housesTable.id,
            name: housesTable.name,
            color: housesTable.color,
          })
          .from(housesTable)
          .where(
            and(
              eq(housesTable.id, student.houseId),
              eq(housesTable.schoolId, schoolId),
            ),
          );
        return h ?? null;
      })(),
    },
    window: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      label: window.label,
      days: window.days,
    },
    pillars: {
      academics: {
        fastScores: fastScores.map((s) => ({
          subject: s.subject,
          pm1: s.pm1,
          pm2: s.pm2,
          pm3: s.pm3,
          priorYearScore: s.priorYearScore,
          priorYearBq: s.priorYearBq,
          // Multi-year PM3 history from the FL Florida historical
          // importer. Newest-first; empty when no historical rows.
          history: pickHistory(fastHistoryMap, studentId, s.subject),
          // LG "moving target" trajectory. Baseline sub-level comes
          // from prior-year PM3 placed on the PRIOR-grade chart
          // (via placePm3). Target is the next-sublevel min on the
          // CURRENT-grade chart. For each PM window we expose the
          // raw score, the live gap (target − score), and the delta
          // vs the previous populated window (positive = closing,
          // negative = widening). null when no chart / no prior PM3.
          bucket: buildBucketTrajectory(
            s.subject as Subject,
            student.grade,
            s.priorYearScore,
            s.pm1,
            s.pm2,
            s.pm3,
          ),
        })),
        // Structured iReady AP1/AP2/AP3 grouped by subject. We group from
        // the in-memory `assessments` list (already fetched, ordered desc)
        // rather than firing another SQL round-trip. Pattern matches the
        // names the importer accepts: "iReady Reading AP1", "iReady Math
        // AP2", etc. Only emit rows for subjects where at least one of
        // AP1/AP2/AP3 is populated, so the UI can hide the block cleanly
        // for HS students who don't take iReady.
        ireadyScores: (() => {
          const out: Array<{
            subject: "Reading" | "Math";
            ap1: number | null;
            ap2: number | null;
            ap3: number | null;
            ap1Level: string | null;
            ap2Level: string | null;
            ap3Level: string | null;
          }> = [];
          for (const subject of ["Reading", "Math"] as const) {
            const find = (period: "AP1" | "AP2" | "AP3") =>
              assessments.find(
                (a) => a.name === `iReady ${subject} ${period}`,
              ) ?? null;
            const ap1 = find("AP1");
            const ap2 = find("AP2");
            const ap3 = find("AP3");
            if (!ap1 && !ap2 && !ap3) continue;
            out.push({
              subject,
              ap1: ap1?.score ?? null,
              ap2: ap2?.score ?? null,
              ap3: ap3?.score ?? null,
              ap1Level: ap1?.scoreLevel ?? null,
              ap2Level: ap2?.scoreLevel ?? null,
              ap3Level: ap3?.scoreLevel ?? null,
            });
          }
          return out;
        })(),
        // SCI Benchmark 1/2/3 — single subject, so a single nullable
        // object rather than an array. Same pattern: pull from the
        // already-fetched assessments list. Returns null when the
        // student has no SCI data (e.g. K-5 students who don't take it).
        sciScores: (() => {
          const find = (period: 1 | 2 | 3) =>
            assessments.find((a) => a.name === `SCI Benchmark ${period}`) ??
            null;
          const b1 = find(1);
          const b2 = find(2);
          const b3 = find(3);
          if (!b1 && !b2 && !b3) return null;
          return {
            b1: b1?.score ?? null,
            b2: b2?.score ?? null,
            b3: b3?.score ?? null,
            b1Level: b1?.scoreLevel ?? null,
            b2Level: b2?.scoreLevel ?? null,
            b3Level: b3?.scoreLevel ?? null,
          };
        })(),
        assessments,
      },
      behavior: {
        pbisPositiveCount: pbisPositive,
        pbisNegativeCount: pbisNegative,
        supportNoteCount: supportNotes.length,
        // Privacy: a single teacher's separation flag is part of THAT
        // teacher's private seating workflow and must never surface on
        // a student's profile (network payload included — relying on
        // client-only hiding would leak the signal to anyone inspecting
        // the response). We coerce sub-threshold counts to 0 here so
        // the wire payload itself only carries the corroborated number.
        separationFlagTeacherCount:
          separationFlagTeacherCount >= 2 ? separationFlagTeacherCount : 0,
        recentSupportNotes: supportNotes,
        recentPbis: pbisRows
          .filter((r) => !r.voidedAt)
          .slice(0, 10)
          .map((r) => ({
            polarity: r.polarity,
            reason: r.reason,
            staffName: r.staffName,
            createdAt: r.createdAt,
            points: r.points,
          })),
      },
      flow: {
        tardyCount: tardyRows.length,
        recentTardies: tardyRows.slice(0, 10),
        issDayCount: issRows.length,
        recentIssDays: issRows.slice(0, 10),
        hallPassCount,
        hallPassSchoolAvg: Number(hallPassSchoolAvg.toFixed(2)),
        recentPullouts,
      },
      supports: {
        activeAccommodationCount: accommodations.length,
        accommodations,
        recentInterventions: interventionsAll,
        activeMtssPlans,
        trustedAdults,
      },
      family: {
        parentName: student.parentName,
        parentEmail: student.parentEmail,
        parentPhone: student.parentPhone,
        linkedParentAccountCount: linkedParents.length,
      },
    },
    riskFlags: flags,
    radar: {
      axes: [
        {
          key: "academics",
          label: "Academics",
          score: academicsScore,
          rationale: academicsRationale,
          hasData: academicsHasData,
        },
        {
          key: "behavior",
          label: "Behavior",
          score: behaviorScore,
          rationale: behaviorRationale,
          hasData: true,
        },
        {
          key: "flow",
          label: "Attendance",
          score: flowScore,
          rationale: flowRationale,
          hasData: true,
        },
        {
          key: "supports",
          label: "Supports",
          score: supportsScore,
          rationale: supportsRationale,
          hasData: true,
          // Higher = more wraparound active. NOT a wellness signal —
          // the client renders a footnote so this isn't misread.
          isResourceAxis: true,
        },
        {
          key: "family",
          label: "Family",
          score: familyScore,
          rationale: familyRationale,
          hasData: true,
        },
      ],
    },
    trends: {
      pbisDaily,
      tardiesDaily,
      interventionDays,
    },
    mtssProgress,
  });
});

// ---------------------------------------------------------------------------
// GET /api/insights/watchlist
//   Filters all optional. Without filters returns the visible set. Filters
//   are AND-combined.
//
//   ?grade=5             — exact grade
//   ?gender=Female       — exact gender match (case-insensitive)
//   ?ell=true            — boolean filter; true requires the flag set,
//                          false requires it unset, omitted = ignore
//   ?ese=true&is504=true — same convention
//   ?ctEla=true&ctMath=true
//   ?tier=2              — exact derived tier (1/2/3)
//   ?bqEla=true&bqMath=true — bottom quartile flags from FAST
//   ?window=30 etc       — affects behavior/tardy/ISS counts only
// ---------------------------------------------------------------------------

function parseBoolFilter(v: unknown): boolean | null {
  if (typeof v !== "string") return null;
  const s = v.toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return null;
}

router.get("/insights/watchlist", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req, res);
  if (!staff) return;

  const window = parseTimeWindow(req);
  const visibility = await getVisibleStudentIds(staff, schoolId);

  // Demographic filters.
  const gradeRaw = req.query.grade;
  const grade =
    typeof gradeRaw === "string" && gradeRaw.trim() !== ""
      ? parseInt(gradeRaw, 10)
      : null;
  const genderRaw =
    typeof req.query.gender === "string" ? req.query.gender.trim() : "";
  const ell = parseBoolFilter(req.query.ell);
  const ese = parseBoolFilter(req.query.ese);
  const is504 = parseBoolFilter(req.query.is504);
  const ctEla = parseBoolFilter(req.query.ctEla);
  const ctMath = parseBoolFilter(req.query.ctMath);
  const tierFilterRaw = req.query.tier;
  const tierFilter =
    typeof tierFilterRaw === "string" && tierFilterRaw.trim() !== ""
      ? parseInt(tierFilterRaw, 10)
      : null;
  const bqEla = parseBoolFilter(req.query.bqEla);
  const bqMath = parseBoolFilter(req.query.bqMath);

  // Build the students base query.
  const wheres = [eq(studentsTable.schoolId, schoolId)];
  if (grade != null && Number.isFinite(grade)) {
    wheres.push(eq(studentsTable.grade, grade));
  }
  if (genderRaw) {
    wheres.push(sql`lower(${studentsTable.gender}) = lower(${genderRaw})`);
  }
  if (ell !== null) wheres.push(eq(studentsTable.ell, ell));
  if (ese !== null) wheres.push(eq(studentsTable.ese, ese));
  if (is504 !== null) wheres.push(eq(studentsTable.is504, is504));
  if (ctEla !== null) wheres.push(eq(studentsTable.ctEla, ctEla));
  if (ctMath !== null) wheres.push(eq(studentsTable.ctMath, ctMath));
  if (!visibility.full) {
    if (visibility.ids.size === 0) {
      // Teacher with no roster + no trusted-adult assignments — empty
      // result, short-circuit before hitting the DB.
      res.json({ window: { ...window, from: window.from.toISOString(), to: window.to.toISOString() }, totalVisible: 0, rows: [] });
      return;
    }
    wheres.push(inArray(studentsTable.studentId, [...visibility.ids]));
  }

  const students = await db
    .select()
    .from(studentsTable)
    .where(and(...wheres))
    .orderBy(studentsTable.lastName, studentsTable.firstName)
    .limit(500); // hard cap to keep payloads sane

  if (students.length === 0) {
    res.json({
      window: {
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        label: window.label,
        days: window.days,
      },
      totalVisible: 0,
      rows: [],
    });
    return;
  }

  const studentIds = students.map((s) => s.studentId);
  const fromIso = window.from.toISOString();
  const toIso = window.to.toISOString();
  const fromDateOnly = fromIso.slice(0, 10);
  const toDateOnly = toIso.slice(0, 10);

  // Previous window of the same length, immediately preceding `from`.
  // Used for the "new this period" badge + behavior trend microcopy on
  // the card grid. We don't load every counter for the prev window —
  // only behavior (pbis negatives + support notes) and ISS days,
  // because those are the trigger flags that drive the badge.
  const windowMs = window.to.getTime() - window.from.getTime();
  const prevTo = window.from;
  const prevFrom = new Date(prevTo.getTime() - windowMs);
  const prevFromIso = prevFrom.toISOString();
  const prevToIso = prevTo.toISOString();
  const prevFromDateOnly = prevFromIso.slice(0, 10);
  const prevToDateOnly = prevToIso.slice(0, 10);

  // Bulk-load the per-student aggregates in a small number of round-trips.
  // Each query is school-scoped + studentId-IN-list; results are folded
  // into per-student maps below.

  // FAST scores (BQ flags)
  const fastRows = await db
    .select({
      studentId: studentFastScoresTable.studentId,
      subject: studentFastScoresTable.subject,
      priorYearBq: studentFastScoresTable.priorYearBq,
    })
    .from(studentFastScoresTable)
    .where(
      and(
        eq(studentFastScoresTable.schoolId, schoolId),
        inArray(studentFastScoresTable.studentId, studentIds),
        // FAST Phase 1: BQ flag lives on current-SY row.
        eq(
          studentFastScoresTable.schoolYear,
          schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ),
        ),
      ),
    );
  const bqByStudent = new Map<string, { ela: boolean; math: boolean }>();
  for (const r of fastRows) {
    const slot = bqByStudent.get(r.studentId) ?? { ela: false, math: false };
    if (r.subject === "ela") slot.ela = r.priorYearBq;
    if (r.subject === "math") slot.math = r.priorYearBq;
    bqByStudent.set(r.studentId, slot);
  }

  // Active MTSS plans → derived tier per student.
  const planRows = await db
    .select({
      studentId: studentMtssPlansTable.studentId,
      tier: studentMtssPlansTable.tier,
    })
    .from(studentMtssPlansTable)
    .where(
      and(
        eq(studentMtssPlansTable.schoolId, schoolId),
        inArray(studentMtssPlansTable.studentId, studentIds),
        isNull(studentMtssPlansTable.closedAt),
      ),
    );
  const tierByStudent = new Map<string, number>();
  for (const r of planRows) {
    tierByStudent.set(
      r.studentId,
      Math.max(tierByStudent.get(r.studentId) ?? 1, r.tier),
    );
  }

  // Behavior counts — pbis negatives (non-voided) + support notes in
  // window. Done as two grouped counts.
  const pbisCounts = await db
    .select({
      studentId: pbisEntriesTable.studentId,
      total: sql<number>`COUNT(*)::int`,
    })
    .from(pbisEntriesTable)
    .where(
      and(
        eq(pbisEntriesTable.schoolId, schoolId),
        inArray(pbisEntriesTable.studentId, studentIds),
        eq(pbisEntriesTable.polarity, "negative"),
        isNull(pbisEntriesTable.voidedAt),
        gte(pbisEntriesTable.createdAt, fromIso),
        lte(pbisEntriesTable.createdAt, toIso),
      ),
    )
    .groupBy(pbisEntriesTable.studentId);
  const pbisCountByStudent = new Map<string, number>();
  for (const r of pbisCounts) pbisCountByStudent.set(r.studentId, r.total);

  const supportCounts = await db
    .select({
      studentId: supportNotesTable.studentId,
      total: sql<number>`COUNT(*)::int`,
    })
    .from(supportNotesTable)
    .where(
      and(
        eq(supportNotesTable.schoolId, schoolId),
        inArray(supportNotesTable.studentId, studentIds),
        gte(supportNotesTable.createdAt, fromIso),
        lte(supportNotesTable.createdAt, toIso),
      ),
    )
    .groupBy(supportNotesTable.studentId);
  const supportCountByStudent = new Map<string, number>();
  for (const r of supportCounts) supportCountByStudent.set(r.studentId, r.total);

  // Tardies + ISS days in window.
  const tardyCounts = await db
    .select({
      studentId: tardiesTable.studentId,
      total: sql<number>`COUNT(*)::int`,
    })
    .from(tardiesTable)
    .where(
      and(
        eq(tardiesTable.schoolId, schoolId),
        inArray(tardiesTable.studentId, studentIds),
        gte(tardiesTable.createdAt, fromIso),
        lte(tardiesTable.createdAt, toIso),
      ),
    )
    .groupBy(tardiesTable.studentId);
  const tardyByStudent = new Map<string, number>();
  for (const r of tardyCounts) tardyByStudent.set(r.studentId, r.total);

  const issCounts = await db
    .select({
      studentId: issAttendanceDayTable.studentId,
      total: sql<number>`COUNT(*)::int`,
    })
    .from(issAttendanceDayTable)
    .where(
      and(
        eq(issAttendanceDayTable.schoolId, schoolId),
        inArray(issAttendanceDayTable.studentId, studentIds),
        gte(issAttendanceDayTable.day, fromDateOnly),
        lte(issAttendanceDayTable.day, toDateOnly),
      ),
    )
    .groupBy(issAttendanceDayTable.studentId);
  const issByStudent = new Map<string, number>();
  for (const r of issCounts) issByStudent.set(r.studentId, r.total);

  // ---- Prev-window aggregates (behavior + ISS only) -------------------
  // Three more grouped counts mirroring the queries above but bounded
  // to [prevFrom, prevTo). Behavior = pbis negatives + support notes,
  // same definition we use for the current window so the comparison
  // is apples-to-apples.
  const prevPbisCounts = await db
    .select({
      studentId: pbisEntriesTable.studentId,
      total: sql<number>`COUNT(*)::int`,
    })
    .from(pbisEntriesTable)
    .where(
      and(
        eq(pbisEntriesTable.schoolId, schoolId),
        inArray(pbisEntriesTable.studentId, studentIds),
        eq(pbisEntriesTable.polarity, "negative"),
        isNull(pbisEntriesTable.voidedAt),
        gte(pbisEntriesTable.createdAt, prevFromIso),
        lte(pbisEntriesTable.createdAt, prevToIso),
      ),
    )
    .groupBy(pbisEntriesTable.studentId);
  const prevPbisCountByStudent = new Map<string, number>();
  for (const r of prevPbisCounts) prevPbisCountByStudent.set(r.studentId, r.total);

  const prevSupportCounts = await db
    .select({
      studentId: supportNotesTable.studentId,
      total: sql<number>`COUNT(*)::int`,
    })
    .from(supportNotesTable)
    .where(
      and(
        eq(supportNotesTable.schoolId, schoolId),
        inArray(supportNotesTable.studentId, studentIds),
        gte(supportNotesTable.createdAt, prevFromIso),
        lte(supportNotesTable.createdAt, prevToIso),
      ),
    )
    .groupBy(supportNotesTable.studentId);
  const prevSupportCountByStudent = new Map<string, number>();
  for (const r of prevSupportCounts) prevSupportCountByStudent.set(r.studentId, r.total);

  const prevIssCounts = await db
    .select({
      studentId: issAttendanceDayTable.studentId,
      total: sql<number>`COUNT(*)::int`,
    })
    .from(issAttendanceDayTable)
    .where(
      and(
        eq(issAttendanceDayTable.schoolId, schoolId),
        inArray(issAttendanceDayTable.studentId, studentIds),
        gte(issAttendanceDayTable.day, prevFromDateOnly),
        lte(issAttendanceDayTable.day, prevToDateOnly),
      ),
    )
    .groupBy(issAttendanceDayTable.studentId);
  const prevIssByStudent = new Map<string, number>();
  for (const r of prevIssCounts) prevIssByStudent.set(r.studentId, r.total);

  // Build the rows.
  const rows = students
    .map((s) => {
      const tier = tierByStudent.get(s.studentId) ?? 1;
      const bq = bqByStudent.get(s.studentId) ?? { ela: false, math: false };
      const negCount = pbisCountByStudent.get(s.studentId) ?? 0;
      const noteCount = supportCountByStudent.get(s.studentId) ?? 0;
      const behaviorCount = negCount + noteCount;
      const tardyCount = tardyByStudent.get(s.studentId) ?? 0;
      const issDayCount = issByStudent.get(s.studentId) ?? 0;

      // Build per-row flags using the same rule set as the profile.
      const flags: RiskFlag[] = [];
      if (bq.ela) flags.push({ code: "BQ_ELA", severity: "high", label: "Bottom quartile ELA" });
      if (bq.math) flags.push({ code: "BQ_MATH", severity: "high", label: "Bottom quartile Math" });
      if (behaviorCount >= 3) flags.push({ code: "BEHAVIOR_TREND", severity: "high", label: `${behaviorCount} behavior entries` });
      else if (behaviorCount > 0) flags.push({ code: "BEHAVIOR_NOTED", severity: "watch", label: `${behaviorCount} behavior entries` });
      if (issDayCount > 0) flags.push({ code: "ISS_RECENT", severity: "high", label: `${issDayCount} ISS day${issDayCount === 1 ? "" : "s"}` });
      if (tier >= 2) flags.push({ code: `TIER_${tier}`, severity: "watch", label: `Tier ${tier} plan` });

      const previousBehaviorCount =
        (prevPbisCountByStudent.get(s.studentId) ?? 0) +
        (prevSupportCountByStudent.get(s.studentId) ?? 0);
      const previousIssDayCount = prevIssByStudent.get(s.studentId) ?? 0;
      // "New this period" = the student is currently on the watch list
      // (has at least one watch- or high-severity flag) AND was clean
      // last window (zero behavior + zero ISS). Bottom-quartile / tier
      // status doesn't change within a window so it isn't part of the
      // "new" signal — that's about behavior/ISS turning a corner.
      const hasWatchOrHighFlag = flags.some(
        (f) => f.severity === "watch" || f.severity === "high",
      );
      const isNewThisWindow =
        hasWatchOrHighFlag &&
        previousBehaviorCount === 0 &&
        previousIssDayCount === 0;

      return {
        studentId: s.studentId,
        firstName: s.firstName,
        lastName: s.lastName,
        grade: s.grade,
        gender: s.gender,
        flags: {
          ell: s.ell,
          ese: s.ese,
          is504: s.is504,
          ctEla: s.ctEla,
          ctMath: s.ctMath,
        },
        mtssTier: tier,
        bqEla: bq.ela,
        bqMath: bq.math,
        behaviorCount,
        tardyCount,
        issDayCount,
        previousBehaviorCount,
        previousIssDayCount,
        isNewThisWindow,
        topRiskFlag: topRisk(flags),
        riskFlagCount: flags.filter((f) => f.severity !== "info").length,
      };
    })
    .filter((r) => {
      // Apply the post-aggregate filters that depend on derived values.
      if (tierFilter != null && r.mtssTier !== tierFilter) return false;
      if (bqEla !== null && r.bqEla !== bqEla) return false;
      if (bqMath !== null && r.bqMath !== bqMath) return false;
      return true;
    });

  res.json({
    window: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      label: window.label,
      days: window.days,
    },
    totalVisible: rows.length,
    rows,
  });
});

// ---------------------------------------------------------------------------
// GET /api/insights/engagement
//
// School-level Engagement dashboard. Surfaces hall-pass / tardy / ISS /
// pullout patterns aggregated across an optional grade filter and a
// time window. Mirrors the eduCLIMBER "Engagement" domain — what's
// pulling kids out of instruction and where the friction is concentrated.
//
// Query params:
//   ?window=3|7|15|30|month|custom
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD  (when window=custom)
//   ?grade=K|1|...|12   (optional cohort filter)
//
// Auth: any signed-in core team member at the active school
// (Admin / SuperUser / Behavior Specialist / MTSS Coord / PBIS Coord).
// Engagement is a school-wide lens, not a per-student visibility check —
// the existing roster / trusted-adult plumbing for individual profiles
// stays in place. Non-core staff can still drill into individual student
// profiles via the watchlist (which honors the visibility check), so they
// don't lose access to anything they had before.
// ---------------------------------------------------------------------------

router.get("/insights/engagement", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!isCoreTeam(staff)) {
    res
      .status(403)
      .json({ error: "Engagement dashboard is core-team only" });
    return;
  }

  const window = parseTimeWindow(req);
  const fromIso = window.from.toISOString();
  const toIso = window.to.toISOString();
  const fromDateOnly = fromIso.slice(0, 10);
  const toDateOnly = toIso.slice(0, 10);

  // Optional grade cohort filter. Apply by joining on studentsTable so we
  // can scope tardies/passes/ISS/pullouts (none of which carry a grade
  // column themselves). Empty / "all" / unrecognized → no filter.
  //
  // students.grade is an INTEGER (K=0, 1=1, …, 12=12). The UI sends "K"
  // for kindergarten; everything else comes through as a numeric string.
  // We parse to int defensively — anything we can't map to 0-12 silently
  // becomes "no filter" rather than crashing the route on a type mismatch
  // or silently returning zero results.
  const { gradeInts, gradeLabel: gradeFilter } =
    parseInsightsGradesParam(req);

  // Pull the grade-cohort student id set up front so every per-source
  // query can use the same filter without re-joining studentsTable. When
  // no cohort filter is set (or input was unparseable), leave
  // studentIds = null (full school).
  let studentIds: string[] | null = null;
  if (gradeInts && gradeInts.length > 0) {
    const rows = await db
      .select({ studentId: studentsTable.studentId })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          inArray(studentsTable.grade, gradeInts),
        ),
      );
    studentIds = rows.map((r) => r.studentId);
    // Empty cohort → fast-path zero response so we don't have to special-
    // case every aggregation below for "0 ids would mean inArray ([]) and
    // Drizzle would generate an always-false predicate".
    if (studentIds.length === 0) {
      res.json({
        window: {
          from: fromIso,
          to: toIso,
          label: window.label,
          days: window.days,
        },
        grade: gradeFilter,
        totals: {
          hallPasses: 0,
          tardies: 0,
          issDays: 0,
          pullouts: 0,
          hallPassMinutesLost: 0,
        },
        trends: { hallPassesByDay: [], tardiesByDay: [], issDaysByDay: [] },
        topLists: {
          hallPassTakers: [],
          hallPassDestinations: [],
          tardyStudents: [],
          tardyPeriods: [],
          issStudents: [],
        },
      });
      return;
    }
  }

  // Cross-cutting filters (teacher / period / ESE / 504 / Tier / BQ).
  // Narrows the cohort further; if narrowing yields zero students, return
  // the same empty-cohort shape used by the grade fast-path above.
  const filters = parseInsightsFilters(req);
  const narrowed = await narrowCohort(schoolId, studentIds, filters);
  studentIds = narrowed.ids;
  if (narrowed.empty) {
    res.json({
      window: { from: fromIso, to: toIso, label: window.label, days: window.days },
      grade: gradeFilter,
      totals: {
        hallPasses: 0,
        tardies: 0,
        issDays: 0,
        pullouts: 0,
        hallPassMinutesLost: 0,
      },
      trends: { hallPassesByDay: [], tardiesByDay: [], issDaysByDay: [] },
      topLists: {
        hallPassTakers: [],
        hallPassDestinations: [],
        tardyStudents: [],
        tardyPeriods: [],
        issStudents: [],
      },
    });
    return;
  }

  // ----- Hall passes -----------------------------------------------------
  const hallPassRows = await db
    .select({
      studentId: hallPassesTable.studentId,
      destination: hallPassesTable.destination,
      createdAt: hallPassesTable.createdAt,
      endedAt: hallPassesTable.endedAt,
      maxDurationMinutes: hallPassesTable.maxDurationMinutes,
    })
    .from(hallPassesTable)
    .where(
      and(
        eq(hallPassesTable.schoolId, schoolId),
        gte(hallPassesTable.createdAt, fromIso),
        lte(hallPassesTable.createdAt, toIso),
        studentIds ? inArray(hallPassesTable.studentId, studentIds) : sql`true`,
      ),
    );

  // ----- Tardies ---------------------------------------------------------
  const tardyRows = await db
    .select({
      studentId: tardiesTable.studentId,
      period: tardiesTable.period,
      createdAt: tardiesTable.createdAt,
    })
    .from(tardiesTable)
    .where(
      and(
        eq(tardiesTable.schoolId, schoolId),
        gte(tardiesTable.createdAt, fromIso),
        lte(tardiesTable.createdAt, toIso),
        studentIds ? inArray(tardiesTable.studentId, studentIds) : sql`true`,
      ),
    );

  // ----- ISS days --------------------------------------------------------
  const issRows = await db
    .select({
      studentId: issAttendanceDayTable.studentId,
      day: issAttendanceDayTable.day,
    })
    .from(issAttendanceDayTable)
    .where(
      and(
        eq(issAttendanceDayTable.schoolId, schoolId),
        gte(issAttendanceDayTable.day, fromDateOnly),
        lte(issAttendanceDayTable.day, toDateOnly),
        studentIds
          ? inArray(issAttendanceDayTable.studentId, studentIds)
          : sql`true`,
      ),
    );

  // ----- Pullouts (count only — single number on the KPI strip) ----------
  const pulloutRows = await db
    .select({ id: pulloutsTable.id })
    .from(pulloutsTable)
    .where(
      and(
        eq(pulloutsTable.schoolId, schoolId),
        gte(pulloutsTable.requestedAt, fromIso),
        lte(pulloutsTable.requestedAt, toIso),
        studentIds ? inArray(pulloutsTable.studentId, studentIds) : sql`true`,
      ),
    );

  // ----- Aggregate in JS -------------------------------------------------
  // Match the 8h safety cap used by /reports/hall-passes so a forgotten
  // active pass doesn't poison the totals.
  const SAFETY_CAP_MIN = 480;
  const nowMs = Date.now();
  function passMinutes(p: {
    createdAt: string;
    endedAt: string | null;
    maxDurationMinutes: number | null;
  }): number {
    const start = Date.parse(p.createdAt);
    if (Number.isNaN(start)) return 0;
    const endRef = p.endedAt ? Date.parse(p.endedAt) : nowMs;
    if (Number.isNaN(endRef)) return 0;
    const mins = Math.max(0, (endRef - start) / 60000);
    return Math.min(mins, SAFETY_CAP_MIN);
  }

  let totalLost = 0;
  const hallPassTakerCount = new Map<string, number>();
  const hallPassDestCount = new Map<string, number>();
  const hallPassByDay = new Map<string, number>();
  for (const p of hallPassRows) {
    totalLost += passMinutes(p);
    hallPassTakerCount.set(
      p.studentId,
      (hallPassTakerCount.get(p.studentId) ?? 0) + 1,
    );
    hallPassDestCount.set(
      p.destination,
      (hallPassDestCount.get(p.destination) ?? 0) + 1,
    );
    const d = p.createdAt.slice(0, 10);
    hallPassByDay.set(d, (hallPassByDay.get(d) ?? 0) + 1);
  }

  const tardyStudentCount = new Map<string, number>();
  const tardyPeriodCount = new Map<string, number>();
  const tardyByDay = new Map<string, number>();
  for (const t of tardyRows) {
    tardyStudentCount.set(
      t.studentId,
      (tardyStudentCount.get(t.studentId) ?? 0) + 1,
    );
    tardyPeriodCount.set(
      t.period,
      (tardyPeriodCount.get(t.period) ?? 0) + 1,
    );
    const d = t.createdAt.slice(0, 10);
    tardyByDay.set(d, (tardyByDay.get(d) ?? 0) + 1);
  }

  const issStudentDayCount = new Map<string, number>();
  const issByDay = new Map<string, number>();
  for (const r of issRows) {
    issStudentDayCount.set(
      r.studentId,
      (issStudentDayCount.get(r.studentId) ?? 0) + 1,
    );
    // r.day is a YYYY-MM-DD string from the date column (drizzle returns
    // pg `date` as string by default).
    const d = String(r.day).slice(0, 10);
    issByDay.set(d, (issByDay.get(d) ?? 0) + 1);
  }

  // ----- Resolve student names for top lists (single batched query) ------
  const idsNeeded = Array.from(
    new Set<string>([
      ...hallPassTakerCount.keys(),
      ...tardyStudentCount.keys(),
      ...issStudentDayCount.keys(),
    ]),
  );
  const nameRows = idsNeeded.length
    ? await db
        .select({
          studentId: studentsTable.studentId,
          firstName: studentsTable.firstName,
          lastName: studentsTable.lastName,
        })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.schoolId, schoolId),
            inArray(studentsTable.studentId, idsNeeded),
          ),
        )
    : [];
  const nameById = new Map(
    nameRows.map((s) => [
      s.studentId,
      `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim() || s.studentId,
    ]),
  );

  function topN<K>(m: Map<K, number>, n = 10): Array<[K, number]> {
    return Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
  }

  // ----- Build dense day series ------------------------------------------
  // The raw maps only have entries for days with events. The chart needs a
  // dense series so the line reads "real zero" on quiet days instead of a
  // visual gap that implies missing data.
  function denseSeries(m: Map<string, number>): { date: string; count: number }[] {
    // Walk fromDateOnly → toDateOnly inclusive in 1-day steps.
    const out: { date: string; count: number }[] = [];
    const start = new Date(fromDateOnly + "T00:00:00Z");
    const end = new Date(toDateOnly + "T00:00:00Z");
    for (let cur = new Date(start); cur <= end; cur.setUTCDate(cur.getUTCDate() + 1)) {
      const d = cur.toISOString().slice(0, 10);
      out.push({ date: d, count: m.get(d) ?? 0 });
    }
    return out;
  }

  res.json({
    window: {
      from: fromIso,
      to: toIso,
      label: window.label,
      days: window.days,
    },
    grade: gradeFilter,
    totals: {
      hallPasses: hallPassRows.length,
      tardies: tardyRows.length,
      issDays: issRows.length,
      pullouts: pulloutRows.length,
      hallPassMinutesLost: Math.round(totalLost),
    },
    trends: {
      hallPassesByDay: denseSeries(hallPassByDay),
      tardiesByDay: denseSeries(tardyByDay),
      issDaysByDay: denseSeries(issByDay),
    },
    topLists: {
      hallPassTakers: topN(hallPassTakerCount).map(([id, count]) => ({
        studentId: id,
        studentName: nameById.get(id) ?? id,
        count,
      })),
      hallPassDestinations: topN(hallPassDestCount).map(([destination, count]) => ({
        destination,
        count,
      })),
      tardyStudents: topN(tardyStudentCount).map(([id, count]) => ({
        studentId: id,
        studentName: nameById.get(id) ?? id,
        count,
      })),
      tardyPeriods: topN(tardyPeriodCount).map(([period, count]) => ({
        period,
        count,
      })),
      issStudents: topN(issStudentDayCount).map(([id, dayCount]) => ({
        studentId: id,
        studentName: nameById.get(id) ?? id,
        dayCount,
      })),
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/insights/behavior
//
// School-wide PBIS analytics — positive vs negative awards, top recognized
// students, top concerning students, top reasons (split by polarity), and
// top recognizing/issuing staff. Mirrors the eduCLIMBER "Behavior" domain.
//
// Pulls everything from `pbis_entries` filtered to `voided_at IS NULL`. We
// don't have a separate "behavior incidents" table — negative-polarity
// pbis_entries serve that role.
//
// Query params + auth identical to /insights/engagement above (window,
// optional grade cohort, core-team only at the active school).
// ---------------------------------------------------------------------------

router.get("/insights/behavior", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!isCoreTeam(staff)) {
    res.status(403).json({ error: "Behavior dashboard is core-team only" });
    return;
  }

  const window = parseTimeWindow(req);
  const fromIso = window.from.toISOString();
  const toIso = window.to.toISOString();
  const fromDateOnly = fromIso.slice(0, 10);
  const toDateOnly = toIso.slice(0, 10);

  // Same defensive grade parsing as /insights/engagement — see that handler
  // for the rationale (students.grade is integer; UI sends "K" as text).
  const { gradeInts, gradeLabel: gradeFilter } =
    parseInsightsGradesParam(req);

  let studentIds: string[] | null = null;
  if (gradeInts && gradeInts.length > 0) {
    const rows = await db
      .select({ studentId: studentsTable.studentId })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          inArray(studentsTable.grade, gradeInts),
        ),
      );
    studentIds = rows.map((r) => r.studentId);
    if (studentIds.length === 0) {
      res.json({
        window: {
          from: fromIso,
          to: toIso,
          label: window.label,
          days: window.days,
        },
        grade: gradeFilter,
        totals: {
          positives: 0,
          negatives: 0,
          netPoints: 0,
          ratio: null,
          studentsRecognized: 0,
          studentsWithNegatives: 0,
        },
        trends: { positivesByDay: [], negativesByDay: [] },
        topLists: {
          recognizedStudents: [],
          concerningStudents: [],
          positiveReasons: [],
          negativeReasons: [],
          recognizingStaff: [],
          issuingStaff: [],
        },
      });
      return;
    }
  }

  // Cross-cutting filters (teacher / period / ESE / 504 / Tier / BQ).
  const filters = parseInsightsFilters(req);
  const narrowed = await narrowCohort(schoolId, studentIds, filters);
  studentIds = narrowed.ids;
  if (narrowed.empty) {
    res.json({
      window: { from: fromIso, to: toIso, label: window.label, days: window.days },
      grade: gradeFilter,
      totals: {
        positives: 0,
        negatives: 0,
        netPoints: 0,
        ratio: null,
        studentsRecognized: 0,
        studentsWithNegatives: 0,
      },
      trends: { positivesByDay: [], negativesByDay: [] },
      topLists: {
        recognizedStudents: [],
        concerningStudents: [],
        positiveReasons: [],
        negativeReasons: [],
        recognizingStaff: [],
        issuingStaff: [],
      },
    });
    return;
  }

  // ----- Pull all non-voided entries in the window ------------------------
  // Done in one query — JS-side splits handle positive/negative bookkeeping
  // because pbis_entries is one row per award and the polarity column is
  // already set correctly at write time.
  const entryRows = await db
    .select({
      studentId: pbisEntriesTable.studentId,
      reason: pbisEntriesTable.reason,
      points: pbisEntriesTable.points,
      polarity: pbisEntriesTable.polarity,
      staffId: pbisEntriesTable.staffId,
      staffName: pbisEntriesTable.staffName,
      createdAt: pbisEntriesTable.createdAt,
    })
    .from(pbisEntriesTable)
    .where(
      and(
        eq(pbisEntriesTable.schoolId, schoolId),
        gte(pbisEntriesTable.createdAt, fromIso),
        lte(pbisEntriesTable.createdAt, toIso),
        isNull(pbisEntriesTable.voidedAt),
        studentIds
          ? inArray(pbisEntriesTable.studentId, studentIds)
          : sql`true`,
      ),
    );

  // ----- Aggregate in JS --------------------------------------------------
  let positives = 0;
  let negatives = 0;
  let positivePoints = 0;
  let negativePoints = 0;
  const positivesByDay = new Map<string, number>();
  const negativesByDay = new Map<string, number>();
  const positiveStudentCount = new Map<string, number>();
  const negativeStudentCount = new Map<string, number>();
  const positiveReasonCount = new Map<string, number>();
  const negativeReasonCount = new Map<string, number>();
  const recognizingStaffCount = new Map<string, number>(); // positives by staff
  const issuingStaffCount = new Map<string, number>(); // negatives by staff
  const studentsWithPositive = new Set<string>();
  const studentsWithNegative = new Set<string>();

  for (const e of entryRows) {
    const day = e.createdAt.slice(0, 10);
    if (e.polarity === "negative") {
      negatives += 1;
      negativePoints += e.points ?? 0;
      negativesByDay.set(day, (negativesByDay.get(day) ?? 0) + 1);
      negativeStudentCount.set(
        e.studentId,
        (negativeStudentCount.get(e.studentId) ?? 0) + 1,
      );
      negativeReasonCount.set(
        e.reason,
        (negativeReasonCount.get(e.reason) ?? 0) + 1,
      );
      issuingStaffCount.set(
        e.staffName,
        (issuingStaffCount.get(e.staffName) ?? 0) + 1,
      );
      studentsWithNegative.add(e.studentId);
    } else {
      // Treat anything that isn't explicitly "negative" as positive — the
      // schema default is "positive" and we don't want a stray polarity
      // value to silently disappear from totals.
      positives += 1;
      positivePoints += e.points ?? 0;
      positivesByDay.set(day, (positivesByDay.get(day) ?? 0) + 1);
      positiveStudentCount.set(
        e.studentId,
        (positiveStudentCount.get(e.studentId) ?? 0) + 1,
      );
      positiveReasonCount.set(
        e.reason,
        (positiveReasonCount.get(e.reason) ?? 0) + 1,
      );
      recognizingStaffCount.set(
        e.staffName,
        (recognizingStaffCount.get(e.staffName) ?? 0) + 1,
      );
      studentsWithPositive.add(e.studentId);
    }
  }

  // ----- Resolve student names for top-N tables ---------------------------
  const idsNeeded = Array.from(
    new Set<string>([
      ...positiveStudentCount.keys(),
      ...negativeStudentCount.keys(),
    ]),
  );
  const nameRows = idsNeeded.length
    ? await db
        .select({
          studentId: studentsTable.studentId,
          firstName: studentsTable.firstName,
          lastName: studentsTable.lastName,
        })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.schoolId, schoolId),
            inArray(studentsTable.studentId, idsNeeded),
          ),
        )
    : [];
  const nameById = new Map(
    nameRows.map((s) => [
      s.studentId,
      `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim() || s.studentId,
    ]),
  );

  function topN<K>(m: Map<K, number>, n = 10): Array<[K, number]> {
    return Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
  }

  function denseSeries(m: Map<string, number>): {
    date: string;
    count: number;
  }[] {
    const out: { date: string; count: number }[] = [];
    const start = new Date(fromDateOnly + "T00:00:00Z");
    const end = new Date(toDateOnly + "T00:00:00Z");
    for (
      let cur = new Date(start);
      cur <= end;
      cur.setUTCDate(cur.getUTCDate() + 1)
    ) {
      const d = cur.toISOString().slice(0, 10);
      out.push({ date: d, count: m.get(d) ?? 0 });
    }
    return out;
  }

  // Positive : negative ratio. `null` when there are no negatives at all
  // (avoids divide-by-zero). UI renders null as "—".
  const ratio = negatives === 0 ? null : Number((positives / negatives).toFixed(2));

  res.json({
    window: {
      from: fromIso,
      to: toIso,
      label: window.label,
      days: window.days,
    },
    grade: gradeFilter,
    totals: {
      positives,
      negatives,
      netPoints: positivePoints - negativePoints,
      ratio,
      studentsRecognized: studentsWithPositive.size,
      studentsWithNegatives: studentsWithNegative.size,
    },
    trends: {
      positivesByDay: denseSeries(positivesByDay),
      negativesByDay: denseSeries(negativesByDay),
    },
    topLists: {
      recognizedStudents: topN(positiveStudentCount).map(([id, count]) => ({
        studentId: id,
        studentName: nameById.get(id) ?? id,
        count,
      })),
      concerningStudents: topN(negativeStudentCount).map(([id, count]) => ({
        studentId: id,
        studentName: nameById.get(id) ?? id,
        count,
      })),
      positiveReasons: topN(positiveReasonCount).map(([reason, count]) => ({
        reason,
        count,
      })),
      negativeReasons: topN(negativeReasonCount).map(([reason, count]) => ({
        reason,
        count,
      })),
      recognizingStaff: topN(recognizingStaffCount).map(([staffName, count]) => ({
        staffName,
        count,
      })),
      issuingStaff: topN(issuingStaffCount).map(([staffName, count]) => ({
        staffName,
        count,
      })),
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/insights/academics
//
// School-wide academic-achievement dashboard. Item #3 of the eduCLIMBER
// Phase Queue. Mirrors engagement + behavior in auth and grade-cohort
// shape, but **intentionally drops the time-window param** because
// academic data lives at fixed assessment-window dates (PM1/PM2/PM3,
// AP1/AP2/AP3) — a per-day trend would just be three spikes. The
// honest visualization for this domain is a cohort-average score
// across the three measurement windows, not a daily line.
//
// Reads two tables:
//   - student_fast_scores: PM1/PM2/PM3 + prior-year + BQ flag, with
//     placement charts in lib/fastCutScores.ts. Drives KPIs, top
//     lists, and the PM progression line.
//   - assessments: vendor-tagged time-series scores (iReady, District
//     SCI, etc.). Used to power the "data sources" panel and a
//     PM3-distribution stacked bar grouped by source.
//
// Auth: same as engagement/behavior — core team only at the active
// school. Returns 403 otherwise.
// ---------------------------------------------------------------------------

router.get("/insights/academics", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!isCoreTeam(staff)) {
    res.status(403).json({ error: "Academics dashboard is core-team only" });
    return;
  }

  // Same defensive grade parsing as /insights/engagement and /insights/behavior.
  // students.grade is INTEGER; the UI sends "K" for kindergarten and numeric
  // strings 1..12 otherwise. Anything we can't map silently becomes "no
  // filter" rather than crashing the route.
  const { gradeInts, gradeLabel: gradeFilter } =
    parseInsightsGradesParam(req);

  // Optional cross-cutting filters (teacher/period/ESE/504/tier/BQ).
  // Parsed once and applied right after the grade-narrowed cohort is
  // built so every downstream count, average, and top-N list inherits
  // the filter.
  const filters = parseInsightsFilters(req);

  // Build the cohort: every student at the school, optionally narrowed
  // to one grade. We need the grade per student at hand so we can run
  // grade-aware FAST placement (prior-grade chart for PM3 per the FAST
  // worked example).
  let studentRows = await db
    .select({
      studentId: studentsTable.studentId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        gradeFilterSql(gradeInts),
      ),
    );

  // Apply the cross-cutting filters to the cohort.
  if (hasAnyInsightsFilter(filters)) {
    const allowed = await applyInsightsFilters(
      schoolId,
      studentRows.map((r) => r.studentId),
      filters,
    );
    studentRows = studentRows.filter((r) => allowed.has(r.studentId));
  }

  // Empty-cohort fast-path (mirrors engagement/behavior). Don't hand
  // Drizzle an empty inArray below — return zeros instead.
  if (studentRows.length === 0) {
    res.json({
      grade: gradeFilter,
      totals: {
        studentsAssessed: 0,
        elaPm3Average: null,
        mathPm3Average: null,
        atOrAboveLevel3Pct: null,
        bottomQuartilePct: null,
        growersPct: null,
      },
      progression: { ela: [], math: [] },
      placementDistribution: { ela: [], math: [] },
      topLists: {
        topGrowersEla: [],
        topGrowersMath: [],
        lowestPm3Ela: [],
        lowestPm3Math: [],
      },
      sources: { fast: 0, iReady: 0, sci: 0 },
    });
    return;
  }

  const studentIds = studentRows.map((r) => r.studentId);
  const gradeById = new Map<string, number | null>(
    studentRows.map((r) => [r.studentId, r.grade ?? null]),
  );
  const nameById = new Map<string, string>(
    studentRows.map((r) => [
      r.studentId,
      `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() || r.studentId,
    ]),
  );

  // ----- Pull all FAST score rows for the cohort --------------------------
  const fastRows = await db
    .select({
      studentId: studentFastScoresTable.studentId,
      subject: studentFastScoresTable.subject,
      pm1: studentFastScoresTable.pm1,
      pm2: studentFastScoresTable.pm2,
      pm3: studentFastScoresTable.pm3,
      priorYearBq: studentFastScoresTable.priorYearBq,
    })
    .from(studentFastScoresTable)
    .where(
      and(
        eq(studentFastScoresTable.schoolId, schoolId),
        inArray(studentFastScoresTable.studentId, studentIds),
        // FAST Phase 1: aggregate current SY only.
        eq(
          studentFastScoresTable.schoolYear,
          schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ),
        ),
      ),
    );

  // ----- Aggregate FAST in JS --------------------------------------------
  // Per-subject sums for PM averages, per-subject placement histograms,
  // per-student deltas for "top growers", and a flat "lowest PM3" list.
  type Subj = "ela" | "math";
  const sums = {
    ela: { pm1: 0, pm1n: 0, pm2: 0, pm2n: 0, pm3: 0, pm3n: 0 },
    math: { pm1: 0, pm1n: 0, pm2: 0, pm2n: 0, pm3: 0, pm3n: 0 },
  };
  const placementCounts: Record<Subj, Record<1 | 2 | 3 | 4 | 5, number>> = {
    ela: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    math: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  };
  // Used to compute "students assessed" and the % growers / % at L3+
  // metrics. A student counts as "assessed" if they have ANY non-null
  // PM score in either subject.
  const studentsAssessed = new Set<string>();
  let pm3Placements = 0;
  let pm3AtL3Plus = 0;
  let pm3HasAny = 0; // count of (student, subject) pairs with pm3
  let growersCount = 0; // students whose PM3 > PM1 in at least one subject
  const grewBySubject = new Map<string, boolean>(); // studentId → grew?
  const bqStudents = new Set<string>();

  type Grower = {
    studentId: string;
    studentName: string;
    pm1: number;
    pm3: number;
    delta: number;
  };
  const elaGrowers: Grower[] = [];
  const mathGrowers: Grower[] = [];
  type LowPm3 = {
    studentId: string;
    studentName: string;
    pm3: number;
    level: 1 | 2 | 3 | 4 | 5;
  };
  const elaLow: LowPm3[] = [];
  const mathLow: LowPm3[] = [];

  for (const r of fastRows) {
    const subject = (r.subject === "math" ? "math" : "ela") as Subj;
    studentsAssessed.add(r.studentId);
    if (r.priorYearBq) bqStudents.add(r.studentId);

    if (r.pm1 != null) {
      sums[subject].pm1 += r.pm1;
      sums[subject].pm1n += 1;
    }
    if (r.pm2 != null) {
      sums[subject].pm2 += r.pm2;
      sums[subject].pm2n += 1;
    }
    if (r.pm3 != null) {
      sums[subject].pm3 += r.pm3;
      sums[subject].pm3n += 1;
      pm3HasAny += 1;

      // Placement: use the FAST worked-example rule (PM3 → prior-grade
      // chart for placement bookkeeping). Falls back to current grade
      // for 3rd graders. hasChart() guards against grades outside the
      // chart range (e.g., K-2, Algebra/Geometry).
      const grade = gradeById.get(r.studentId) ?? null;
      if (grade !== null) {
        const placement = placePm3(r.pm3, subject, grade);
        if (placement) {
          placementCounts[subject][placement.level] += 1;
          pm3Placements += 1;
          if (placement.level >= 3) pm3AtL3Plus += 1;

          // Lowest-PM3 list: include only L1 placements (the
          // "biggest gap" cohort the dashboard surfaces).
          if (placement.level === 1) {
            const entry: LowPm3 = {
              studentId: r.studentId,
              studentName: nameById.get(r.studentId) ?? r.studentId,
              pm3: r.pm3,
              level: 1,
            };
            if (subject === "ela") elaLow.push(entry);
            else mathLow.push(entry);
          }
        }
      }

      // Growers: PM3 - PM1 delta. Track per-student "grew at all" too.
      if (r.pm1 != null) {
        const delta = r.pm3 - r.pm1;
        const entry: Grower = {
          studentId: r.studentId,
          studentName: nameById.get(r.studentId) ?? r.studentId,
          pm1: r.pm1,
          pm3: r.pm3,
          delta,
        };
        if (subject === "ela") elaGrowers.push(entry);
        else mathGrowers.push(entry);

        if (delta > 0) {
          if (!grewBySubject.get(r.studentId)) {
            grewBySubject.set(r.studentId, true);
            growersCount += 1;
          }
        } else if (!grewBySubject.has(r.studentId)) {
          grewBySubject.set(r.studentId, false);
        }
      }
    }
  }

  function avg(s: { pm1: number; pm1n: number; pm2: number; pm2n: number; pm3: number; pm3n: number }): {
    pm1: number | null;
    pm2: number | null;
    pm3: number | null;
  } {
    return {
      pm1: s.pm1n ? Number((s.pm1 / s.pm1n).toFixed(1)) : null,
      pm2: s.pm2n ? Number((s.pm2 / s.pm2n).toFixed(1)) : null,
      pm3: s.pm3n ? Number((s.pm3 / s.pm3n).toFixed(1)) : null,
    };
  }
  const elaAvg = avg(sums.ela);
  const mathAvg = avg(sums.math);

  // Sort top-N lists in JS. 10 each.
  const TOP_N = 10;
  const elaGrowersTop = elaGrowers
    .sort((a, b) => b.delta - a.delta)
    .slice(0, TOP_N);
  const mathGrowersTop = mathGrowers
    .sort((a, b) => b.delta - a.delta)
    .slice(0, TOP_N);
  const elaLowTop = elaLow.sort((a, b) => a.pm3 - b.pm3).slice(0, TOP_N);
  const mathLowTop = mathLow.sort((a, b) => a.pm3 - b.pm3).slice(0, TOP_N);

  // ----- Pull assessment-source counts (data-availability panel) ---------
  // Three short COUNT(*) queries — schoolId-scoped, optionally narrowed
  // by cohort. Used to power the "data sources" panel that shows what
  // additional vendors have data, hinting at future overlay potential.
  async function sourceCount(source: string): Promise<number> {
    const [{ c }] = (
      await db.execute(
        studentIds !== null
          ? sql`SELECT COUNT(*)::int AS c FROM assessments
                WHERE school_id = ${schoolId}
                  AND source = ${source}
                  AND student_id IN (${sql.join(studentIds.map((x) => sql`${x}`), sql`, `)})`
          : sql`SELECT COUNT(*)::int AS c FROM assessments
                WHERE school_id = ${schoolId} AND source = ${source}`,
      )
    ).rows as { c: number }[];
    return c;
  }
  const [iReadyCount, sciCount] = await Promise.all([
    sourceCount("iReady"),
    sourceCount("District SCI"),
  ]);

  // ----- Build response --------------------------------------------------
  const cohortSize = studentRows.length;
  const studentsWithBothPmsForGrowth = grewBySubject.size;

  res.json({
    grade: gradeFilter,
    totals: {
      studentsAssessed: studentsAssessed.size,
      // PM3 averages by subject (rounded to 1 dp). null when nothing seen.
      elaPm3Average: elaAvg.pm3,
      mathPm3Average: mathAvg.pm3,
      // % of all PM3 placements landing at L3 or above. null if no
      // placements were possible (e.g., all-K-2 cohort).
      atOrAboveLevel3Pct:
        pm3Placements > 0
          ? Number(((100 * pm3AtL3Plus) / pm3Placements).toFixed(1))
          : null,
      // % of cohort flagged as Bottom Quartile from prior-year final.
      bottomQuartilePct:
        cohortSize > 0
          ? Number(((100 * bqStudents.size) / cohortSize).toFixed(1))
          : null,
      // % of students with PM1 + PM3 in at least one subject who grew.
      growersPct:
        studentsWithBothPmsForGrowth > 0
          ? Number(
              ((100 * growersCount) / studentsWithBothPmsForGrowth).toFixed(1),
            )
          : null,
    },
    // PM1 → PM2 → PM3 cohort-average progression. Two lines (ELA, Math)
    // shaped as { window, score } for direct chart consumption. null
    // entries are dropped; the chart can render gaps as "no data".
    progression: {
      ela: [
        elaAvg.pm1 != null ? { window: "PM1", score: elaAvg.pm1 } : null,
        elaAvg.pm2 != null ? { window: "PM2", score: elaAvg.pm2 } : null,
        elaAvg.pm3 != null ? { window: "PM3", score: elaAvg.pm3 } : null,
      ].filter(Boolean),
      math: [
        mathAvg.pm1 != null ? { window: "PM1", score: mathAvg.pm1 } : null,
        mathAvg.pm2 != null ? { window: "PM2", score: mathAvg.pm2 } : null,
        mathAvg.pm3 != null ? { window: "PM3", score: mathAvg.pm3 } : null,
      ].filter(Boolean),
    },
    // PM3 placement distribution per subject — feeds the "are kids
    // landing in proficient bands?" stacked-bar visual.
    placementDistribution: {
      ela: [1, 2, 3, 4, 5].map((lvl) => ({
        level: lvl,
        count: placementCounts.ela[lvl as 1 | 2 | 3 | 4 | 5],
      })),
      math: [1, 2, 3, 4, 5].map((lvl) => ({
        level: lvl,
        count: placementCounts.math[lvl as 1 | 2 | 3 | 4 | 5],
      })),
    },
    topLists: {
      topGrowersEla: elaGrowersTop,
      topGrowersMath: mathGrowersTop,
      lowestPm3Ela: elaLowTop,
      lowestPm3Math: mathLowTop,
    },
    sources: {
      fast: fastRows.length,
      iReady: iReadyCount,
      sci: sciCount,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /insights/academics/band — drill-in for the placement chart.
//
// Returns the list of students placed at a given (subject, level) cell of
// the PM3 placement distribution, honoring the same grade + cross-cutting
// filters as the parent academics route. Used by the Academics dashboard
// when the user clicks an L1..L5 bar.
//
// Query params:
//   subject  required — "ela" or "math"
//   level    required — 1..5
//   grade    optional — same parsing as /insights/academics
//   teacher_id, period, ese, is_504, tier, bq_ela, bq_math — same as parent
//
// Caps the result at 200 students with a `truncated` flag so the UI can
// say "+X more" without dragging the network.
// ---------------------------------------------------------------------------
router.get("/insights/academics/band", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!isCoreTeam(staff)) {
    res.status(403).json({ error: "Academics dashboard is core-team only" });
    return;
  }

  const subjectRaw =
    typeof req.query.subject === "string" ? req.query.subject.toLowerCase() : "";
  const subject: "ela" | "math" | null =
    subjectRaw === "ela" ? "ela" : subjectRaw === "math" ? "math" : null;
  const levelRaw =
    typeof req.query.level === "string" ? Number.parseInt(req.query.level, 10) : NaN;
  const level: 1 | 2 | 3 | 4 | 5 | null =
    levelRaw === 1 || levelRaw === 2 || levelRaw === 3 || levelRaw === 4 || levelRaw === 5
      ? (levelRaw as 1 | 2 | 3 | 4 | 5)
      : null;
  if (!subject || !level) {
    res.status(400).json({ error: "subject (ela|math) and level (1-5) required" });
    return;
  }

  // Same grade parsing as the parent route.
  const { gradeInts, gradeLabel: gradeFilter } =
    parseInsightsGradesParam(req);

  const filters = parseInsightsFilters(req);

  let studentRows = await db
    .select({
      studentId: studentsTable.studentId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        gradeFilterSql(gradeInts),
      ),
    );

  if (hasAnyInsightsFilter(filters)) {
    const allowed = await applyInsightsFilters(
      schoolId,
      studentRows.map((r) => r.studentId),
      filters,
    );
    studentRows = studentRows.filter((r) => allowed.has(r.studentId));
  }

  if (studentRows.length === 0) {
    res.json({ subject, level, students: [], truncated: false, total: 0 });
    return;
  }

  const studentIds = studentRows.map((r) => r.studentId);
  const gradeById = new Map<string, number | null>(
    studentRows.map((r) => [r.studentId, r.grade ?? null]),
  );
  const nameById = new Map<string, string>(
    studentRows.map((r) => [
      r.studentId,
      `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() || r.studentId,
    ]),
  );

  // Pull this subject's FAST rows and place each PM3 score on the
  // appropriate chart (prior-grade per the FAST worked example).
  const fastRows = await db
    .select({
      studentId: studentFastScoresTable.studentId,
      pm1: studentFastScoresTable.pm1,
      pm3: studentFastScoresTable.pm3,
    })
    .from(studentFastScoresTable)
    .where(
      and(
        eq(studentFastScoresTable.schoolId, schoolId),
        eq(studentFastScoresTable.subject, subject),
        inArray(studentFastScoresTable.studentId, studentIds),
        // FAST Phase 1: current SY only.
        eq(
          studentFastScoresTable.schoolYear,
          schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ),
        ),
      ),
    );

  type Hit = {
    studentId: string;
    studentName: string;
    grade: number | null;
    pm1: number | null;
    pm3: number;
  };
  const hits: Hit[] = [];
  for (const r of fastRows) {
    if (r.pm3 == null) continue;
    const grade = gradeById.get(r.studentId) ?? null;
    if (grade === null) continue;
    const placement = placePm3(r.pm3, subject, grade);
    if (!placement || placement.level !== level) continue;
    hits.push({
      studentId: r.studentId,
      studentName: nameById.get(r.studentId) ?? r.studentId,
      grade,
      pm1: r.pm1 ?? null,
      pm3: r.pm3,
    });
  }
  hits.sort((a, b) => a.pm3 - b.pm3);

  const CAP = 200;
  const truncated = hits.length > CAP;
  res.json({
    subject,
    level,
    students: truncated ? hits.slice(0, CAP) : hits,
    truncated,
    total: hits.length,
  });
});

// ---------------------------------------------------------------------------
// GET /insights/academics/trajectory
//
// Bucket every assessed student into a PM1 -> PM3 "trajectory archetype"
// for one subject (ELA or Math). Mirrors the Trajectory Archetypes
// design from the canvas mockup. The 6 archetypes are exhaustive and
// disjoint -- every (PM1 band, PM3 band) cell of the 4x4 matrix maps to
// exactly one archetype, so the parent counts sum to the cohort total.
//
// Bands (mapped from FAST levels using the existing placement helpers):
//   well  = L1
//   below = L2
//   above = L3 / L4 / L5
//   na    = no score on file
//
// Archetypes:
//   climbed   - PM3 band strictly above PM1 band (excluding NA)
//   stayedHi  - above -> above
//   slipped   - PM3 band strictly below PM1 band (excluding NA)
//   stuck     - well -> well
//   stayedLo  - below -> below
//   untested  - any student missing PM1 or PM3 (or both)
//
// Sub-archetypes (also disjoint within each parent -- sub-counts sum
// to the parent count):
//   climbed:  bigLeap (well->above) / firstStep (well->below) /
//             crossedToProf (below->above)
//   stayedHi: l3 / l4 / l5  (split by PM3 sub-level)
//   slipped:  slippedToL1 (below->well) / bigDrop (above->well) /
//             slippedOneBand (above->below)
//   stuck:    closestToEscape (1.3) / midStuck (1.2) / deeplyStuck (1.1)
//   stayedLo: wobbled (PM2 placement differs from PM1+PM3) /
//             edgeOfClimb (PM3 sub "2.2" and not wobbled) /
//             edgeOfSlip (PM3 sub "2.1" and not wobbled). The wobble
//             rule is checked first so the splits stay disjoint.
//   untested: noPm1 / noPm3 / bothMissing
//
// Auth: same core-team-only gate as the rest of /insights/academics.
// ---------------------------------------------------------------------------

type TrajectoryBand = "well" | "below" | "above" | "na";
type TrajectoryArchetype =
  | "climbed"
  | "stayedHi"
  | "slipped"
  | "stuck"
  | "stayedLo"
  | "untested";

const TRAJ_BAND_ORDER: TrajectoryBand[] = ["above", "below", "well", "na"];

function levelToBand(
  placement: ReturnType<typeof placeOnChart>,
): TrajectoryBand {
  if (!placement) return "na";
  if (placement.level >= 3) return "above";
  if (placement.level === 2) return "below";
  return "well"; // L1
}

interface TrajectoryStudentRec {
  studentId: string;
  studentName: string;
  grade: number;
  pm1: number | null;
  pm2: number | null;
  pm3: number | null;
  pm1Band: TrajectoryBand;
  pm2Band: TrajectoryBand;
  pm3Band: TrajectoryBand;
  pm3SubLevel: string | null;
}

function classifyArchetype(rec: TrajectoryStudentRec): TrajectoryArchetype {
  const a = rec.pm1Band;
  const b = rec.pm3Band;
  if (a === "na" || b === "na") return "untested";
  if (a === "above" && b === "above") return "stayedHi";
  if (a === "below" && b === "below") return "stayedLo";
  if (a === "well" && b === "well") return "stuck";
  const rank: Record<Exclude<TrajectoryBand, "na">, number> = {
    above: 2,
    below: 1,
    well: 0,
  };
  return rank[b] > rank[a] ? "climbed" : "slipped";
}

function classifySubArchetype(rec: TrajectoryStudentRec): string {
  const a = classifyArchetype(rec);
  switch (a) {
    case "climbed": {
      if (rec.pm1Band === "well" && rec.pm3Band === "above") return "bigLeap";
      if (rec.pm1Band === "well" && rec.pm3Band === "below")
        return "firstStep";
      return "crossedToProf";
    }
    case "stayedHi": {
      if (rec.pm3SubLevel === "5") return "l5";
      if (rec.pm3SubLevel === "4") return "l4";
      return "l3";
    }
    case "slipped": {
      if (rec.pm1Band === "below" && rec.pm3Band === "well")
        return "slippedToL1";
      if (rec.pm1Band === "above" && rec.pm3Band === "well") return "bigDrop";
      return "slippedOneBand";
    }
    case "stuck": {
      if (rec.pm3SubLevel === "1.3") return "closestToEscape";
      if (rec.pm3SubLevel === "1.2") return "midStuck";
      return "deeplyStuck";
    }
    case "stayedLo": {
      const wobbled =
        rec.pm2Band !== "na" &&
        rec.pm2Band !== rec.pm1Band &&
        rec.pm2Band !== rec.pm3Band;
      if (wobbled) return "wobbled";
      if (rec.pm3SubLevel === "2.2") return "edgeOfClimb";
      return "edgeOfSlip";
    }
    case "untested": {
      const hasPm1 = rec.pm1Band !== "na";
      const hasPm3 = rec.pm3Band !== "na";
      if (!hasPm1 && hasPm3) return "noPm1";
      if (hasPm1 && !hasPm3) return "noPm3";
      return "bothMissing";
    }
  }
}

// Build the per-cohort trajectory record set. Shared between the summary
// endpoint and the drill-in endpoint so the two stay in sync.
// Parse the trajectory subject filter. Accepts either:
//   ?subjects=ela,math   (preferred, multi-select)
//   ?subject=ela         (legacy single-select)
// Returns at least one valid subject; defaults to ["ela"] if none parsed.
function parseTrajectorySubjects(req: {
  query: Record<string, unknown>;
}): ("ela" | "math")[] {
  const out = new Set<"ela" | "math">();
  const add = (raw: string) => {
    const s = raw.trim().toLowerCase();
    if (s === "ela" || s === "math") out.add(s);
  };
  const subjectsRaw =
    typeof req.query.subjects === "string" ? req.query.subjects : "";
  if (subjectsRaw) {
    for (const p of subjectsRaw.split(",")) add(p);
  } else if (typeof req.query.subject === "string") {
    add(req.query.subject);
  }
  if (out.size === 0) out.add("ela");
  // Preserve a stable order (ela first, then math) for consistent labels.
  const ordered: ("ela" | "math")[] = [];
  if (out.has("ela")) ordered.push("ela");
  if (out.has("math")) ordered.push("math");
  return ordered;
}

// Parse a grade filter from query. Accepts either:
//   ?grades=3,4,5   (preferred, multi-select)
//   ?grade=5        (legacy single-select)
//   ?grade=all      (no filter)
// Returns null for "no filter" or an array of valid grade ints (K=0, 1..12).
//
// Used by every insights route. Trajectory has its own alias kept for
// readability at call sites.
export function parseInsightsGradesParam(req: {
  query: Record<string, unknown>;
}): { gradeInts: number[] | null; gradeLabel: string | null } {
  const toInt = (raw: string): number | null => {
    const s = raw.trim();
    if (!s) return null;
    if (s.toUpperCase() === "K") return 0;
    const n = Number.parseInt(s, 10);
    if (Number.isInteger(n) && n >= 0 && n <= 12) return n;
    return null;
  };
  const gradesRaw =
    typeof req.query.grades === "string" ? req.query.grades : "";
  if (gradesRaw) {
    const ints: number[] = [];
    for (const part of gradesRaw.split(",")) {
      const v = toInt(part);
      if (v !== null && !ints.includes(v)) ints.push(v);
    }
    if (ints.length === 0) return { gradeInts: null, gradeLabel: null };
    const label =
      ints.length === 1
        ? ints[0] === 0
          ? "K"
          : String(ints[0])
        : `${ints.length} grades`;
    return { gradeInts: ints, gradeLabel: label };
  }
  const gradeRaw =
    typeof req.query.grade === "string" ? req.query.grade.trim() : "";
  if (!gradeRaw || gradeRaw.toLowerCase() === "all") {
    return { gradeInts: null, gradeLabel: null };
  }
  const v = toInt(gradeRaw);
  if (v === null) return { gradeInts: null, gradeLabel: null };
  return { gradeInts: [v], gradeLabel: gradeRaw };
}

// Back-compat alias: trajectory callers used this name. Keeping it
// keeps the diff at those sites quiet.
const parseTrajectoryGradeFilter = parseInsightsGradesParam;

// Build a Drizzle SQL clause that filters students.grade to a (possibly
// multi-select) cohort. Returns `sql\`true\`` when no grade filter is
// active so it can be dropped straight into an `and(...)` block.
function gradeFilterSql(gradeInts: number[] | null) {
  return gradeInts && gradeInts.length > 0
    ? inArray(studentsTable.grade, gradeInts)
    : sql`true`;
}

async function loadTrajectoryRecs(
  schoolId: number,
  subject: "ela" | "math",
  gradeInts: number[] | null,
  filters: ReturnType<typeof parseInsightsFilters>,
): Promise<TrajectoryStudentRec[]> {
  // gradeInts === null  → "all grades"
  // gradeInts.length === 0 → caller passed grades but none parsed → also all
  // gradeInts.length >= 1 → restrict to that set
  const gradeFilterSql =
    gradeInts && gradeInts.length > 0
      ? inArray(studentsTable.grade, gradeInts)
      : sql`true`;
  let studentRows = await db
    .select({
      studentId: studentsTable.studentId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        gradeFilterSql,
      ),
    );

  if (hasAnyInsightsFilter(filters)) {
    const allowed = await applyInsightsFilters(
      schoolId,
      studentRows.map((r) => r.studentId),
      filters,
    );
    studentRows = studentRows.filter((r) => allowed.has(r.studentId));
  }

  // Drop students whose grade has no FAST chart (K-2, Algebra/Geometry).
  // Without a chart we cannot place PM scores onto a level -- they cannot
  // honestly appear in any band, including "untested".
  studentRows = studentRows.filter(
    (r) => r.grade != null && hasChart(subject, r.grade),
  );

  if (studentRows.length === 0) return [];

  const studentIds = studentRows.map((r) => r.studentId);
  const gradeById = new Map<string, number>(
    studentRows.map((r) => [r.studentId, r.grade as number]),
  );
  const nameById = new Map<string, string>(
    studentRows.map((r) => [
      r.studentId,
      `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() || r.studentId,
    ]),
  );

  const fastRows = await db
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
        eq(studentFastScoresTable.subject, subject),
        inArray(studentFastScoresTable.studentId, studentIds),
        // FAST Phase 1: current SY only.
        eq(
          studentFastScoresTable.schoolYear,
          schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ),
        ),
      ),
    );
  // Explicit Map<K, V> typing -- fastRows flows from a Drizzle .select()
  // chain that the local TS server resolves to any[] until lib/db is
  // pre-built, and without this annotation .get() returns unknown and
  // fr?.pm1 reports "Property pm1 does not exist on type {}".
  type TrajFastRow = {
    studentId: string;
    pm1: number | null;
    pm2: number | null;
    pm3: number | null;
  };
  const fastByStudent = new Map<string, TrajFastRow>();
  for (const r of fastRows as TrajFastRow[]) fastByStudent.set(r.studentId, r);

  const recs: TrajectoryStudentRec[] = [];
  for (const sr of studentRows) {
    const grade = gradeById.get(sr.studentId)!;
    const fr = fastByStudent.get(sr.studentId);
    const pm1 = fr?.pm1 ?? null;
    const pm2 = fr?.pm2 ?? null;
    const pm3 = fr?.pm3 ?? null;

    const pm1Placement =
      pm1 != null ? placeOnChart(pm1, subject, grade) : null;
    const pm2Placement =
      pm2 != null ? placeOnChart(pm2, subject, grade) : null;
    const pm3Placement = pm3 != null ? placePm3(pm3, subject, grade) : null;

    recs.push({
      studentId: sr.studentId,
      studentName: nameById.get(sr.studentId) ?? sr.studentId,
      grade,
      pm1,
      pm2,
      pm3,
      pm1Band: levelToBand(pm1Placement),
      pm2Band: levelToBand(pm2Placement),
      pm3Band: levelToBand(pm3Placement),
      pm3SubLevel: pm3Placement?.subLevel ?? null,
    });
  }
  return recs;
}

router.get("/insights/academics/trajectory", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!isCoreTeam(staff)) {
    res
      .status(403)
      .json({ error: "Academics trajectory is core-team only" });
    return;
  }

  const subjects = parseTrajectorySubjects(req);
  const { gradeInts, gradeLabel } = parseTrajectoryGradeFilter(req);
  const filters = parseInsightsFilters(req);

  // Multi-subject: concat per-subject record sets so a student tested in
  // both ELA and Math contributes two rows (one trajectory per subject),
  // which is the honest unit-of-analysis here.
  const recsArrays = await Promise.all(
    subjects.map((s) =>
      loadTrajectoryRecs(schoolId, s, gradeInts, filters),
    ),
  );
  const recs = recsArrays.flat();

  const matrix: Record<TrajectoryBand, Record<TrajectoryBand, number>> = {
    above: { above: 0, below: 0, well: 0, na: 0 },
    below: { above: 0, below: 0, well: 0, na: 0 },
    well: { above: 0, below: 0, well: 0, na: 0 },
    na: { above: 0, below: 0, well: 0, na: 0 },
  };
  const counts: Record<TrajectoryArchetype, number> = {
    climbed: 0,
    stayedHi: 0,
    slipped: 0,
    stuck: 0,
    stayedLo: 0,
    untested: 0,
  };
  const subCounts: Record<TrajectoryArchetype, Record<string, number>> = {
    climbed: {},
    stayedHi: {},
    slipped: {},
    stuck: {},
    stayedLo: {},
    untested: {},
  };

  for (const r of recs) {
    matrix[r.pm1Band][r.pm3Band] += 1;
    const a = classifyArchetype(r);
    counts[a] += 1;
    const sub = classifySubArchetype(r);
    subCounts[a][sub] = (subCounts[a][sub] ?? 0) + 1;
  }

  res.json({
    subject: subjects[0],
    subjects,
    grade: gradeLabel,
    grades: gradeInts,
    total: recs.length,
    bandOrder: TRAJ_BAND_ORDER,
    matrix,
    counts,
    subCounts,
  });
});

// ---------------------------------------------------------------------------
// GET /insights/academics/trajectory/students
//
// Drill-in for the trajectory dashboard. Returns the student list for one
// (archetype) or (archetype, subKey) bucket. Reuses the BandStudentsDrawer
// shape so the client can reuse the same drawer component.
// ---------------------------------------------------------------------------
router.get("/insights/academics/trajectory/students", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!isCoreTeam(staff)) {
    res
      .status(403)
      .json({ error: "Academics trajectory is core-team only" });
    return;
  }

  const subjects = parseTrajectorySubjects(req);
  const ARCHETYPE_KEYS: TrajectoryArchetype[] = [
    "climbed",
    "stayedHi",
    "slipped",
    "stuck",
    "stayedLo",
    "untested",
  ];
  const archetype = req.query.archetype;
  if (
    typeof archetype !== "string" ||
    !ARCHETYPE_KEYS.includes(archetype as TrajectoryArchetype)
  ) {
    res.status(400).json({ error: "valid archetype required" });
    return;
  }
  const wantArchetype = archetype as TrajectoryArchetype;
  const subKey =
    typeof req.query.subKey === "string" && req.query.subKey.trim()
      ? req.query.subKey.trim()
      : null;

  const { gradeInts } = parseTrajectoryGradeFilter(req);
  const filters = parseInsightsFilters(req);

  // Tag each rec with its subject so the multi-subject drill-in can
  // tell the user *which* subject a row came from when both are on.
  const tagged: { subject: "ela" | "math"; rec: TrajectoryStudentRec }[] = [];
  for (const subj of subjects) {
    const sRecs = await loadTrajectoryRecs(schoolId, subj, gradeInts, filters);
    for (const r of sRecs) tagged.push({ subject: subj, rec: r });
  }

  type Hit = {
    studentId: string;
    studentName: string;
    grade: number | null;
    pm1: number | null;
    pm3: number | null;
    subject?: "ela" | "math";
    programPill?: "ESE" | "504" | null;
    mtssPill?: "Tier 2+" | "Tier 3" | null;
    bqEla?: boolean;
    bqMath?: boolean;
  };
  const hits: Hit[] = [];
  for (const { subject: subj, rec: r } of tagged) {
    if (classifyArchetype(r) !== wantArchetype) continue;
    if (subKey && classifySubArchetype(r) !== subKey) continue;
    hits.push({
      studentId: r.studentId,
      studentName:
        subjects.length > 1
          ? `${r.studentName} (${subj.toUpperCase()})`
          : r.studentName,
      grade: r.grade,
      pm1: r.pm1,
      pm3: r.pm3,
      subject: subj,
    });
  }
  hits.sort((a, b) => a.studentName.localeCompare(b.studentName));

  const CAP = 200;
  const truncated = hits.length > CAP;
  const visible = truncated ? hits.slice(0, CAP) : hits;

  // Decorate with the four pill flags (only for the visible slice — we
  // never show pills for rows we don't render). Two cheap queries scoped
  // to the trimmed studentId set.
  const visibleIds = Array.from(new Set(visible.map((h) => h.studentId)));
  if (visibleIds.length > 0) {
    type FlagRow = { student_id: string; ese: boolean; is_504: boolean };
    const flagRes = await db.execute<FlagRow>(sql`
      SELECT student_id, ese, is_504
      FROM students
      WHERE school_id = ${schoolId} AND student_id = ANY(${visibleIds})
    `);
    const flagMap = new Map<string, FlagRow>();
    for (const r of flagRes.rows) flagMap.set(r.student_id, r);

    type TierRow = { student_id: string; tier: number };
    const tierRes = await db.execute<TierRow>(sql`
      SELECT student_id, MAX(tier)::int AS tier
      FROM student_mtss_plans
      WHERE school_id = ${schoolId}
        AND closed_at IS NULL
        AND student_id = ANY(${visibleIds})
      GROUP BY student_id
    `);
    const tierMap = new Map<string, number>();
    for (const r of tierRes.rows) tierMap.set(r.student_id, Number(r.tier));

    type BqRow = { student_id: string; subject: string; prior_year_bq: boolean };
    const bqRes = await db.execute<BqRow>(sql`
      SELECT student_id, subject, prior_year_bq
      FROM student_fast_scores
      WHERE school_id = ${schoolId}
        AND subject IN ('ela','math')
        AND prior_year_bq = true
        AND student_id = ANY(${visibleIds})
    `);
    const bqEla = new Set<string>();
    const bqMath = new Set<string>();
    for (const r of bqRes.rows) {
      if (r.subject === "ela") bqEla.add(r.student_id);
      else if (r.subject === "math") bqMath.add(r.student_id);
    }

    for (const h of visible) {
      const f = flagMap.get(h.studentId);
      h.programPill = f?.ese ? "ESE" : f?.is_504 ? "504" : null;
      const t = tierMap.get(h.studentId);
      h.mtssPill = t === 3 ? "Tier 3" : t === 2 ? "Tier 2+" : null;
      h.bqEla = bqEla.has(h.studentId);
      h.bqMath = bqMath.has(h.studentId);
    }
  }

  res.json({
    subject: subjects[0],
    subjects,
    archetype: wantArchetype,
    subKey,
    students: visible,
    truncated,
    total: hits.length,
  });
});

// ---------------------------------------------------------------------------
// GET /insights/academics/trajectory/export.csv
//
// Per-student CSV export of the trajectory dataset honoring the same
// filters (subject, grades, insights filters) as the summary endpoint.
// One row per student with their FAST PMs, bands, archetype, and
// sub-archetype so coordinators can pull the data into Excel/Sheets.
// ---------------------------------------------------------------------------
router.get(
  "/insights/academics/trajectory/export.csv",
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const staff = await loadStaff(req, res);
    if (!staff) return;
    if (!isCoreTeam(staff)) {
      res
        .status(403)
        .json({ error: "Academics trajectory is core-team only" });
      return;
    }

    const subjects = parseTrajectorySubjects(req);
    const { gradeInts, gradeLabel } = parseTrajectoryGradeFilter(req);
    const filters = parseInsightsFilters(req);
    const tagged: { subject: "ela" | "math"; rec: TrajectoryStudentRec }[] = [];
    for (const subj of subjects) {
      const sRecs = await loadTrajectoryRecs(
        schoolId,
        subj,
        gradeInts,
        filters,
      );
      for (const r of sRecs) tagged.push({ subject: subj, rec: r });
    }

    const ARCHETYPE_LABEL: Record<TrajectoryArchetype, string> = {
      climbed: "Climbing",
      stayedHi: "Soaring",
      slipped: "Sliding",
      stuck: "Plateauing",
      stayedLo: "Stuck-Low",
      untested: "New Data",
    };
    const BAND_LABEL: Record<TrajectoryBand, string> = {
      above: "Above",
      below: "Below",
      well: "Well Below",
      na: "N/A",
    };

    // Escape per RFC 4180: wrap in quotes if value contains ", , or \n.
    const esc = (v: string | number | null | undefined): string => {
      if (v == null) return "";
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = [
      "student_id",
      "student_name",
      "grade",
      "subject",
      "pm1",
      "pm2",
      "pm3",
      "pm1_band",
      "pm3_band",
      "archetype",
      "sub_archetype",
    ];
    const sorted = [...tagged].sort((a, b) =>
      a.rec.studentName.localeCompare(b.rec.studentName),
    );
    const lines: string[] = [header.join(",")];
    for (const { subject: subj, rec: r } of sorted) {
      lines.push(
        [
          esc(r.studentId),
          esc(r.studentName),
          esc(r.grade === 0 ? "K" : r.grade),
          esc(subj),
          esc(r.pm1),
          esc(r.pm2),
          esc(r.pm3),
          esc(BAND_LABEL[r.pm1Band]),
          esc(BAND_LABEL[r.pm3Band]),
          esc(ARCHETYPE_LABEL[classifyArchetype(r)]),
          esc(classifySubArchetype(r)),
        ].join(","),
      );
    }
    const csv = lines.join("\r\n") + "\r\n";

    const today = new Date().toISOString().slice(0, 10);
    const gradeSlug = gradeLabel
      ? gradeLabel.replace(/\s+/g, "")
      : "all-grades";
    const subjectSlug = subjects.join("-");
    const filename = `trajectory_${subjectSlug}_${gradeSlug}_${today}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    res.send(csv);
  },
);

// ---------------------------------------------------------------------------
// GET /insights/sebsel — Social-Emotional / Behavioral whole-school view.
//
// Item #4 in the eduCLIMBER Phase Queue. Mirrors the engagement / behavior /
// academics pattern: same auth (core team only), same defensive grade
// parsing, same KPI strip + viz + top-N envelope shape.
//
// Data this endpoint pulls together (all seeded in dev):
//   * student_mtss_plans   — active when closed_at IS NULL. Title text is
//                            bucketed into 5 plan-area categories so the UI
//                            can show "what kind of support is going out".
//   * students.ese / .is504 / .ell — demographic SEL flags.
//   * pbis_entries (negative, last 30d) — "active concern" behavioral signal.
//   * student_fast_scores.priorYearBq — academic-risk SEL signal.
//   * student_accommodations (active = removed_at IS NULL) — support footprint.
//
// Time window is fixed at 30 days for the negative-PBIS signal — every other
// signal is stateful, so a window param would be misleading.
// ---------------------------------------------------------------------------
router.get("/insights/sebsel", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!isCoreTeam(staff)) {
    res.status(403).json({ error: "SEB/SEL dashboard is core-team only" });
    return;
  }

  // Same defensive grade parsing as the prior three dashboards. students.grade
  // is INTEGER; UI sends "K" for kindergarten and numeric strings 1..12.
  // Anything we can't map silently becomes "no filter" rather than crashing.
  const { gradeInts, gradeLabel: gradeFilter } =
    parseInsightsGradesParam(req);

  // Build the cohort: every student at the school, optionally narrowed
  // to one grade.
  let studentRows = await db
    .select({
      studentId: studentsTable.studentId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
      ell: studentsTable.ell,
      ese: studentsTable.ese,
      is504: studentsTable.is504,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        gradeFilterSql(gradeInts),
      ),
    );

  // Apply cross-cutting filters (teacher / period / ESE / 504 / Tier / BQ).
  // Done before the empty-cohort fast-path so filter-narrowed-to-zero takes
  // the same code path as grade-narrowed-to-zero.
  const filters = parseInsightsFilters(req);
  if (hasAnyInsightsFilter(filters) && studentRows.length > 0) {
    const baseIds = studentRows.map((r) => r.studentId);
    const allowed = await applyInsightsFilters(schoolId, baseIds, filters);
    studentRows = studentRows.filter((r) => allowed.has(r.studentId));
  }

  // Empty-cohort fast-path. Don't hand Drizzle an empty inArray below.
  if (studentRows.length === 0) {
    res.json({
      grade: gradeFilter,
      windowDays: 30,
      totals: {
        cohortStudents: 0,
        activeMtssPlans: 0,
        selFlaggedPlans: 0,
        iepStudents: 0,
        students504: 0,
        ellStudents: 0,
        multiRiskStudents: 0,
      },
      planAreaMix: [],
      riskOverlap: [
        { flagCount: 1, students: 0 },
        { flagCount: 2, students: 0 },
        { flagCount: 3, students: 0 },
        { flagCount: 4, students: 0 },
      ],
      topLists: {
        highestNeed: [],
        atRiskWithoutPlan: [],
        selPlanRoster: [],
        mostAccommodated: [],
      },
      sources: {
        plans: 0,
        accommodations: 0,
        negativePbisLast30d: 0,
        fastBq: 0,
      },
    });
    return;
  }

  const studentIds = studentRows.map((r) => r.studentId);
  const nameById = new Map<string, string>(
    studentRows.map((r) => [
      r.studentId,
      `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() || r.studentId,
    ]),
  );
  const gradeById = new Map<string, number | null>(
    studentRows.map((r) => [r.studentId, r.grade ?? null]),
  );
  // Per-student demographic SEL flags for the chip display + risk math.
  const iep = new Set<string>();
  const sec504 = new Set<string>();
  const ell = new Set<string>();
  for (const r of studentRows) {
    if (r.ese) iep.add(r.studentId);
    if (r.is504) sec504.add(r.studentId);
    if (r.ell) ell.add(r.studentId);
  }
  const iep504 = new Set<string>([...iep, ...sec504]);

  // ----- Pull active MTSS plans for the cohort ----------------------------
  // Active = closed_at IS NULL. We fetch title so we can bucket into
  // plan-area categories below.
  const planRows = await db
    .select({
      studentId: studentMtssPlansTable.studentId,
      title: studentMtssPlansTable.title,
      tier: studentMtssPlansTable.tier,
      openedAt: studentMtssPlansTable.openedAt,
    })
    .from(studentMtssPlansTable)
    .where(
      and(
        eq(studentMtssPlansTable.schoolId, schoolId),
        isNull(studentMtssPlansTable.closedAt),
        inArray(studentMtssPlansTable.studentId, studentIds),
      ),
    );

  // Bucket plan titles into 5 plan-area categories. The seed currently uses
  // the six titles in MTSS_SEED_TITLES (see seed.ts ~line 373); real-world
  // plan titles are free-text, so we use case-insensitive substring matching
  // and fall back to "Other" to stay robust.
  type PlanArea = "Behavior" | "SEL" | "Academic" | "Attendance" | "Other";
  const PLAN_AREA_ORDER: PlanArea[] = [
    "Behavior",
    "SEL",
    "Academic",
    "Attendance",
    "Other",
  ];
  function bucketPlanTitle(title: string): PlanArea {
    const t = title.toLowerCase();
    if (t.includes("behavior")) return "Behavior";
    if (
      t.includes("social") ||
      t.includes("emotional") ||
      t.includes("check-in") ||
      t.includes("check in") ||
      t.includes("engagement") ||
      t.includes("sel")
    ) {
      return "SEL";
    }
    if (
      t.includes("reading") ||
      t.includes("math") ||
      t.includes("academic") ||
      t.includes("ela") ||
      t.includes("literacy") ||
      t.includes("intervention")
    ) {
      return "Academic";
    }
    if (t.includes("attendance") || t.includes("tardy")) return "Attendance";
    return "Other";
  }
  const planAreaCounts: Record<PlanArea, number> = {
    Behavior: 0,
    SEL: 0,
    Academic: 0,
    Attendance: 0,
    Other: 0,
  };
  // active-plan-having students, plus their first SEL-bucket plan title for
  // the SEL roster top-N.
  const studentsWithActivePlan = new Set<string>();
  const selPlanByStudent = new Map<string, string>();
  let selFlaggedPlans = 0;
  for (const p of planRows) {
    studentsWithActivePlan.add(p.studentId);
    const area = bucketPlanTitle(p.title);
    planAreaCounts[area] += 1;
    if (area === "Behavior" || area === "SEL") {
      selFlaggedPlans += 1;
      if (!selPlanByStudent.has(p.studentId)) {
        selPlanByStudent.set(p.studentId, p.title);
      }
    }
  }

  // ----- Recent negative PBIS (last 30d) — "active concern" signal -------
  // pbis_entries.created_at is stored as an ISO text column; lexicographic
  // gte works correctly. We only need negatives — count per student.
  const now = Date.now();
  const windowDays = 30;
  const fromIso = new Date(now - windowDays * 86_400_000).toISOString();
  const negPbisRows = await db
    .select({
      studentId: pbisEntriesTable.studentId,
    })
    .from(pbisEntriesTable)
    .where(
      and(
        eq(pbisEntriesTable.schoolId, schoolId),
        eq(pbisEntriesTable.polarity, "negative"),
        gte(pbisEntriesTable.createdAt, fromIso),
        inArray(pbisEntriesTable.studentId, studentIds),
      ),
    );
  const negPbisByStudent = new Map<string, number>();
  for (const r of negPbisRows) {
    negPbisByStudent.set(
      r.studentId,
      (negPbisByStudent.get(r.studentId) ?? 0) + 1,
    );
  }
  // "Recent negatives" risk flag fires at >= 3 negatives in the window.
  const recentNegatives = new Set<string>();
  for (const [sid, n] of negPbisByStudent) {
    if (n >= 3) recentNegatives.add(sid);
  }

  // ----- FAST priorYearBq (academic-risk SEL signal) ---------------------
  const bqRows = await db
    .select({
      studentId: studentFastScoresTable.studentId,
    })
    .from(studentFastScoresTable)
    .where(
      and(
        eq(studentFastScoresTable.schoolId, schoolId),
        eq(studentFastScoresTable.priorYearBq, true),
        inArray(studentFastScoresTable.studentId, studentIds),
      ),
    );
  const bqStudents = new Set<string>();
  for (const r of bqRows) bqStudents.add(r.studentId);

  // ----- Accommodations (active = removed_at IS NULL) --------------------
  // We need per-student counts for the most-accommodated top-N. Category
  // is on school_accommodations, but for the v1 dashboard we just need the
  // count per student.
  const accomRows = await db
    .select({
      studentId: studentAccommodationsTable.studentId,
    })
    .from(studentAccommodationsTable)
    .where(
      and(
        eq(studentAccommodationsTable.schoolId, schoolId),
        isNull(studentAccommodationsTable.removedAt),
        inArray(studentAccommodationsTable.studentId, studentIds),
      ),
    );
  const accomByStudent = new Map<string, number>();
  for (const r of accomRows) {
    accomByStudent.set(
      r.studentId,
      (accomByStudent.get(r.studentId) ?? 0) + 1,
    );
  }

  // ----- Per-student risk-flag computation -------------------------------
  // Four binary flags. multiRisk = >= 2 flags fired.
  type FlagKey = "plan" | "bq" | "negatives" | "iep504";
  type StudentRisk = {
    studentId: string;
    studentName: string;
    grade: number | null;
    flags: FlagKey[];
  };
  const perStudentRisk: StudentRisk[] = [];
  let multiRiskStudents = 0;
  // Histogram of risk-flag counts (0/1/2/3/4) for the riskOverlap chart.
  // We expose 1..4 in the response — flagCount=0 students are not "at risk"
  // at all and would dwarf every other bar.
  const riskHist: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const sid of studentIds) {
    const flags: FlagKey[] = [];
    if (studentsWithActivePlan.has(sid)) flags.push("plan");
    if (bqStudents.has(sid)) flags.push("bq");
    if (recentNegatives.has(sid)) flags.push("negatives");
    if (iep504.has(sid)) flags.push("iep504");
    riskHist[flags.length] += 1;
    if (flags.length >= 2) multiRiskStudents += 1;
    if (flags.length > 0) {
      perStudentRisk.push({
        studentId: sid,
        studentName: nameById.get(sid) ?? sid,
        grade: gradeById.get(sid) ?? null,
        flags,
      });
    }
  }

  // ----- Top-N lists ------------------------------------------------------
  // 1) Highest need — sort by flag count desc, then by name asc as a stable
  //    deterministic tiebreaker. Cap at 15.
  const highestNeed = [...perStudentRisk]
    .sort((a, b) => {
      if (b.flags.length !== a.flags.length) {
        return b.flags.length - a.flags.length;
      }
      return a.studentName.localeCompare(b.studentName);
    })
    .slice(0, 15);

  // 2) At-risk WITHOUT a plan — has BQ or recent negatives, but no active
  //    MTSS plan. The "kids who are slipping that nobody's tracking" list.
  //    Sort by (negatives desc, bq desc, name asc) for stable ordering.
  const atRiskWithoutPlan = perStudentRisk
    .filter(
      (s) =>
        !s.flags.includes("plan") &&
        (s.flags.includes("bq") || s.flags.includes("negatives")),
    )
    .map((s) => ({
      studentId: s.studentId,
      studentName: s.studentName,
      grade: s.grade,
      bq: s.flags.includes("bq"),
      negatives: negPbisByStudent.get(s.studentId) ?? 0,
    }))
    .sort((a, b) => {
      if (b.negatives !== a.negatives) return b.negatives - a.negatives;
      if (a.bq !== b.bq) return a.bq ? -1 : 1;
      return a.studentName.localeCompare(b.studentName);
    })
    .slice(0, 15);

  // 3) SEL plan roster — every student with an active SEL- or Behavior-
  //    bucketed plan. Sort by name. Cap at 15.
  const selPlanRoster = [...selPlanByStudent.entries()]
    .map(([sid, planTitle]) => ({
      studentId: sid,
      studentName: nameById.get(sid) ?? sid,
      grade: gradeById.get(sid) ?? null,
      planTitle,
    }))
    .sort((a, b) => a.studentName.localeCompare(b.studentName))
    .slice(0, 15);

  // 4) Most accommodated — heaviest support footprint, useful for case
  //    conferencing. Sort by count desc, name asc. Cap at 15.
  const mostAccommodated = [...accomByStudent.entries()]
    .map(([sid, n]) => ({
      studentId: sid,
      studentName: nameById.get(sid) ?? sid,
      grade: gradeById.get(sid) ?? null,
      accommodationCount: n,
    }))
    .sort((a, b) => {
      if (b.accommodationCount !== a.accommodationCount) {
        return b.accommodationCount - a.accommodationCount;
      }
      return a.studentName.localeCompare(b.studentName);
    })
    .slice(0, 15);

  res.json({
    grade: gradeFilter,
    windowDays,
    totals: {
      cohortStudents: studentRows.length,
      activeMtssPlans: planRows.length,
      selFlaggedPlans,
      iepStudents: iep.size,
      students504: sec504.size,
      ellStudents: ell.size,
      multiRiskStudents,
    },
    // Plan-area mix in a stable, fixed order so the UI doesn't have to sort.
    planAreaMix: PLAN_AREA_ORDER.map((area) => ({
      area,
      count: planAreaCounts[area],
    })),
    // Risk-overlap histogram (1..4 flags). flagCount=0 is intentionally
    // excluded — see comment above.
    riskOverlap: [1, 2, 3, 4].map((k) => ({
      flagCount: k,
      students: riskHist[k],
    })),
    topLists: {
      highestNeed,
      atRiskWithoutPlan,
      selPlanRoster,
      mostAccommodated,
    },
    sources: {
      plans: planRows.length,
      accommodations: accomRows.length,
      negativePbisLast30d: negPbisRows.length,
      fastBq: bqRows.length,
    },
  });
});

// ============================================================================
// GET /api/insights/equity — Phase 5 of the eduCLIMBER Insights ledger.
//
// Disaggregates the four pillars (Engagement / Behavior / Academics / SEB) by
// demographic subgroups and surfaces **risk ratios** as the headline metric.
// "Risk ratio" = inGroupRate / outGroupRate. The dashboard uses the out-group
// (everyone NOT in the subgroup) as the denominator rather than school-wide
// average so the ratio cleanly answers "how does this subgroup compare to its
// peers?" — which is the question district staff actually ask.
//
// Subgroups (5): ELL, IEP (ese), 504, Female, Male. Race + FRL are NOT yet
// modeled on the students table; they're a known followup tied to the SIS
// import work.
//
// Metrics (5):
//   1. % on active MTSS plan
//   2. Avg negative PBIS / student (last 30d)
//   3. Pos:neg PBIS ratio
//   4. % flagged BQ (any subject)
//   5. Avg out-of-class events / student (passes + tardies, 30d)
//
// Each metric carries a `worseDirection` ("higher" | "lower") so the UI can
// color disparities red vs green correctly — e.g., a higher-than-peers
// pos:neg ratio is GOOD news, while a higher-than-peers neg-PBIS average is a
// concern.
//
// High-disparity threshold: |risk ratio| outside [0.77, 1.30] (i.e., a 30%+
// gap in either direction), AND in-group size >= 10 (small-n noise guard).
// Concerning = the disparity is in the worse direction for the metric.
// ============================================================================
router.get("/insights/equity", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!isCoreTeam(staff)) {
    res.status(403).json({ error: "Equity dashboard is core-team only" });
    return;
  }

  // Same defensive grade parsing pattern as the prior four dashboards.
  const { gradeInts, gradeLabel: gradeFilter } =
    parseInsightsGradesParam(req);

  // Cohort + demographic flags.
  let studentRows = await db
    .select({
      studentId: studentsTable.studentId,
      grade: studentsTable.grade,
      ell: studentsTable.ell,
      ese: studentsTable.ese,
      is504: studentsTable.is504,
      gender: studentsTable.gender,
      race: studentsTable.race,
      ethnicity: studentsTable.ethnicity,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        gradeFilterSql(gradeInts),
      ),
    );

  // Apply cross-cutting filters (teacher / period / ESE / 504 / Tier / BQ).
  // Equity disparity math is computed across this narrowed cohort.
  const filters = parseInsightsFilters(req);
  if (hasAnyInsightsFilter(filters) && studentRows.length > 0) {
    const baseIds = studentRows.map((r) => r.studentId);
    const allowed = await applyInsightsFilters(schoolId, baseIds, filters);
    studentRows = studentRows.filter((r) => allowed.has(r.studentId));
  }

  // Subgroup membership sets — built whether or not the cohort is empty so
  // the response shape is stable.
  const ell = new Set<string>();
  const ese = new Set<string>(); // IEP
  const sec504 = new Set<string>();
  const female = new Set<string>();
  const male = new Set<string>();
  let unknownGenderCount = 0;
  // Race membership sets (7 buckets matching the seeder's federal-style
  // categorization). The dashboard's MIN_GROUP_SIZE=10 guard naturally
  // suppresses any race subgroup whose in-group is too small to make a
  // meaningful disparity claim.
  const raceWhite = new Set<string>();
  const raceHispanic = new Set<string>();
  const raceBlack = new Set<string>();
  const raceAsian = new Set<string>();
  const raceMulti = new Set<string>();
  const raceNative = new Set<string>();
  const racePacific = new Set<string>();
  let unknownRaceCount = 0;
  // Ethnicity is a separate federal field (Hispanic origin Y/N) independent
  // of race per OMB Directive 15. Tracked as a single binary subgroup
  // ("Hispanic Ethnicity" in-group vs everyone else).
  const ethHispanic = new Set<string>();
  let unknownEthnicityCount = 0;
  for (const r of studentRows) {
    if (r.ell) ell.add(r.studentId);
    if (r.ese) ese.add(r.studentId);
    if (r.is504) sec504.add(r.studentId);
    if (r.gender === "F") female.add(r.studentId);
    else if (r.gender === "M") male.add(r.studentId);
    else unknownGenderCount += 1;
    switch (r.race) {
      case "white": raceWhite.add(r.studentId); break;
      case "hispanic": raceHispanic.add(r.studentId); break;
      case "black": raceBlack.add(r.studentId); break;
      case "asian": raceAsian.add(r.studentId); break;
      case "multi": raceMulti.add(r.studentId); break;
      case "native": raceNative.add(r.studentId); break;
      case "pacific": racePacific.add(r.studentId); break;
      default: unknownRaceCount += 1; break;
    }
    if (r.ethnicity === "hispanic") ethHispanic.add(r.studentId);
    else if (r.ethnicity == null) unknownEthnicityCount += 1;
  }

  // Subgroup definitions in stable display order. Demographic flags first
  // (most familiar to district staff), then race buckets, then ethnicity.
  type SubgroupKey =
    | "ELL"
    | "IEP"
    | "504"
    | "Female"
    | "Male"
    | "White"
    | "Hispanic"
    | "Black"
    | "Asian"
    | "Multi-Race"
    | "Native"
    | "Pacific"
    | "Hispanic Ethnicity";
  const SUBGROUPS: { key: SubgroupKey; members: Set<string> }[] = [
    { key: "ELL", members: ell },
    { key: "IEP", members: ese },
    { key: "504", members: sec504 },
    { key: "Female", members: female },
    { key: "Male", members: male },
    { key: "White", members: raceWhite },
    { key: "Hispanic", members: raceHispanic },
    { key: "Black", members: raceBlack },
    { key: "Asian", members: raceAsian },
    { key: "Multi-Race", members: raceMulti },
    { key: "Native", members: raceNative },
    { key: "Pacific", members: racePacific },
    { key: "Hispanic Ethnicity", members: ethHispanic },
  ];

  // Metric definitions. `worseDirection` drives the red/green coloring of
  // the risk ratio: "higher" means a higher-than-peers value is concerning,
  // "lower" means the opposite.
  type MetricKey =
    | "pctOnPlan"
    | "avgNegPbis"
    | "posNegRatio"
    | "pctBq"
    | "avgEngagementEvents";
  type MetricDef = {
    key: MetricKey;
    label: string;
    worseDirection: "higher" | "lower";
  };
  const METRICS: MetricDef[] = [
    { key: "pctOnPlan", label: "% on active MTSS plan", worseDirection: "higher" },
    { key: "avgNegPbis", label: "Avg neg PBIS / student (30d)", worseDirection: "higher" },
    { key: "posNegRatio", label: "Pos:neg PBIS ratio", worseDirection: "lower" },
    { key: "pctBq", label: "% flagged BQ (any subject)", worseDirection: "higher" },
    { key: "avgEngagementEvents", label: "Avg out-of-class events / student (30d)", worseDirection: "higher" },
  ];

  // Empty-cohort fast path. Same envelope shape, all zeros.
  if (studentRows.length === 0) {
    res.json({
      grade: gradeFilter,
      windowDays: 30,
      totals: {
        cohortStudents: 0,
        ellCount: 0,
        ellPct: 0,
        iepCount: 0,
        iepPct: 0,
        students504Count: 0,
        students504Pct: 0,
        femaleCount: 0,
        femalePct: 0,
        maleCount: 0,
        malePct: 0,
        unknownGenderCount: 0,
        unknownGenderPct: 0,
        raceMix: {
          white: { count: 0, pct: 0 },
          hispanic: { count: 0, pct: 0 },
          black: { count: 0, pct: 0 },
          asian: { count: 0, pct: 0 },
          multi: { count: 0, pct: 0 },
          native: { count: 0, pct: 0 },
          pacific: { count: 0, pct: 0 },
          unknown: { count: 0, pct: 0 },
        },
        ethnicityHispanicCount: 0,
        ethnicityHispanicPct: 0,
        ethnicityUnknownCount: 0,
        ethnicityUnknownPct: 0,
        highDisparityFlagCount: 0,
        maxRiskRatio: null,
      },
      disparityFlags: [],
      subgroupSnapshots: SUBGROUPS.map((sg) => ({
        subgroup: sg.key,
        inGroupSize: 0,
        outGroupSize: 0,
        // Schema must mirror the populated path's metrics exactly
        // (architect-flagged): include `key` so frontend type contracts
        // line up between empty-cohort and populated responses.
        metrics: METRICS.map((m) => ({
          key: m.key,
          name: m.label,
          worseDirection: m.worseDirection,
          inGroupValue: null,
          outGroupValue: null,
          riskRatio: null,
        })),
      })),
      sources: {
        plans: 0,
        accommodations: 0,
        negativePbisLast30d: 0,
        positivePbisLast30d: 0,
        fastBq: 0,
        engagementLast30d: 0,
      },
    });
    return;
  }

  const studentIds = studentRows.map((r) => r.studentId);

  // ----- Pull data sources -----------------------------------------------
  // Active MTSS plans.
  const planRows = await db
    .select({ studentId: studentMtssPlansTable.studentId })
    .from(studentMtssPlansTable)
    .where(
      and(
        eq(studentMtssPlansTable.schoolId, schoolId),
        isNull(studentMtssPlansTable.closedAt),
        inArray(studentMtssPlansTable.studentId, studentIds),
      ),
    );
  const studentsWithActivePlan = new Set<string>();
  for (const r of planRows) studentsWithActivePlan.add(r.studentId);

  const now = Date.now();
  const windowDays = 30;
  const fromIso = new Date(now - windowDays * 86_400_000).toISOString();

  // PBIS — pull both polarities so we can compute pos:neg ratios.
  // Excludes voided entries (voided_at IS NULL) to match the rest of the
  // codebase's behavior semantics — including voided rows would distort
  // the avgNegPbis / posNegRatio metrics and inflate disparity ratios.
  const pbisRows = await db
    .select({
      studentId: pbisEntriesTable.studentId,
      polarity: pbisEntriesTable.polarity,
    })
    .from(pbisEntriesTable)
    .where(
      and(
        eq(pbisEntriesTable.schoolId, schoolId),
        isNull(pbisEntriesTable.voidedAt),
        gte(pbisEntriesTable.createdAt, fromIso),
        inArray(pbisEntriesTable.studentId, studentIds),
      ),
    );
  const negCountByStudent = new Map<string, number>();
  const posCountByStudent = new Map<string, number>();
  let totalNeg = 0;
  let totalPos = 0;
  for (const r of pbisRows) {
    if (r.polarity === "negative") {
      negCountByStudent.set(
        r.studentId,
        (negCountByStudent.get(r.studentId) ?? 0) + 1,
      );
      totalNeg += 1;
    } else if (r.polarity === "positive") {
      posCountByStudent.set(
        r.studentId,
        (posCountByStudent.get(r.studentId) ?? 0) + 1,
      );
      totalPos += 1;
    }
  }

  // FAST priorYearBq.
  const bqRows = await db
    .select({ studentId: studentFastScoresTable.studentId })
    .from(studentFastScoresTable)
    .where(
      and(
        eq(studentFastScoresTable.schoolId, schoolId),
        eq(studentFastScoresTable.priorYearBq, true),
        inArray(studentFastScoresTable.studentId, studentIds),
      ),
    );
  const bqStudents = new Set<string>();
  for (const r of bqRows) bqStudents.add(r.studentId);

  // Engagement: hall passes + tardies in last 30d. Sum per student.
  const passRows = await db
    .select({ studentId: hallPassesTable.studentId })
    .from(hallPassesTable)
    .where(
      and(
        eq(hallPassesTable.schoolId, schoolId),
        gte(hallPassesTable.createdAt, fromIso),
        inArray(hallPassesTable.studentId, studentIds),
      ),
    );
  const tardyRows = await db
    .select({ studentId: tardiesTable.studentId })
    .from(tardiesTable)
    .where(
      and(
        eq(tardiesTable.schoolId, schoolId),
        gte(tardiesTable.createdAt, fromIso),
        inArray(tardiesTable.studentId, studentIds),
      ),
    );
  const engagementByStudent = new Map<string, number>();
  for (const r of passRows) {
    engagementByStudent.set(
      r.studentId,
      (engagementByStudent.get(r.studentId) ?? 0) + 1,
    );
  }
  for (const r of tardyRows) {
    engagementByStudent.set(
      r.studentId,
      (engagementByStudent.get(r.studentId) ?? 0) + 1,
    );
  }
  const engagementTotal = passRows.length + tardyRows.length;

  // Accommodations source count (for transparency in `sources`, no metric).
  const accomRows = await db
    .select({ studentId: studentAccommodationsTable.studentId })
    .from(studentAccommodationsTable)
    .where(
      and(
        eq(studentAccommodationsTable.schoolId, schoolId),
        isNull(studentAccommodationsTable.removedAt),
        inArray(studentAccommodationsTable.studentId, studentIds),
      ),
    );

  // ----- Per-subgroup metric computation ---------------------------------
  // For each subgroup, compute each metric on the in-group and the out-group
  // (everyone in the cohort NOT in the subgroup). Risk ratio = in/out with
  // safety fallbacks: denom 0 → null (UI shows em dash); both 0 → 1.0
  // (same rate, no disparity). Pos:neg ratio handles totalNeg=0 by treating
  // the in-group as having an "infinite" ratio when there are positives —
  // we cap at a sentinel and let the UI display it sanely.
  function safeRatio(numer: number, denom: number): number | null {
    if (denom === 0) {
      return numer === 0 ? 1.0 : null;
    }
    return numer / denom;
  }

  function computeMetricsForGroup(group: Set<string>, peers: Set<string>) {
    const groupArr = [...group];
    const peerArr = [...peers];
    const groupSize = groupArr.length;
    const peerSize = peerArr.length;

    function avgFromMap(arr: string[], m: Map<string, number>): number {
      if (arr.length === 0) return 0;
      let sum = 0;
      for (const sid of arr) sum += m.get(sid) ?? 0;
      return sum / arr.length;
    }
    function pctFromSet(arr: string[], s: Set<string>): number {
      if (arr.length === 0) return 0;
      let n = 0;
      for (const sid of arr) if (s.has(sid)) n += 1;
      return n / arr.length;
    }
    function totalFromMap(arr: string[], m: Map<string, number>): number {
      let sum = 0;
      for (const sid of arr) sum += m.get(sid) ?? 0;
      return sum;
    }

    const inPctOnPlan = pctFromSet(groupArr, studentsWithActivePlan);
    const outPctOnPlan = pctFromSet(peerArr, studentsWithActivePlan);

    const inAvgNeg = avgFromMap(groupArr, negCountByStudent);
    const outAvgNeg = avgFromMap(peerArr, negCountByStudent);

    const inPos = totalFromMap(groupArr, posCountByStudent);
    const inNeg = totalFromMap(groupArr, negCountByStudent);
    const outPos = totalFromMap(peerArr, posCountByStudent);
    const outNeg = totalFromMap(peerArr, negCountByStudent);
    // Pos:neg ratio per group. inNeg=0 → null (undefined ratio); the UI
    // renders an em dash. We intentionally don't synthesize a sentinel
    // "infinite" value because that would dominate the maxRiskRatio KPI
    // even when the underlying numerator is small.
    const inPosNegRatio = inNeg === 0 ? null : inPos / inNeg;
    const outPosNegRatio = outNeg === 0 ? null : outPos / outNeg;

    const inPctBq = pctFromSet(groupArr, bqStudents);
    const outPctBq = pctFromSet(peerArr, bqStudents);

    const inAvgEng = avgFromMap(groupArr, engagementByStudent);
    const outAvgEng = avgFromMap(peerArr, engagementByStudent);

    return {
      groupSize,
      peerSize,
      values: {
        pctOnPlan: { in: inPctOnPlan, out: outPctOnPlan, ratio: safeRatio(inPctOnPlan, outPctOnPlan) },
        avgNegPbis: { in: inAvgNeg, out: outAvgNeg, ratio: safeRatio(inAvgNeg, outAvgNeg) },
        posNegRatio: {
          in: inPosNegRatio,
          out: outPosNegRatio,
          ratio:
            inPosNegRatio == null || outPosNegRatio == null
              ? null
              : safeRatio(inPosNegRatio, outPosNegRatio),
        },
        pctBq: { in: inPctBq, out: outPctBq, ratio: safeRatio(inPctBq, outPctBq) },
        avgEngagementEvents: {
          in: inAvgEng,
          out: outAvgEng,
          ratio: safeRatio(inAvgEng, outAvgEng),
        },
      },
    };
  }

  // Threshold + sample size guard.
  const RATIO_HIGH = 1.3;
  const RATIO_LOW = 1 / RATIO_HIGH; // ~0.769
  const MIN_GROUP_SIZE = 10;

  function isConcerning(
    ratio: number | null,
    direction: "higher" | "lower",
  ): boolean {
    if (ratio == null) return false;
    if (direction === "higher") return ratio >= RATIO_HIGH;
    return ratio <= RATIO_LOW;
  }

  // Build per-subgroup snapshot + collect disparity flags.
  type DisparityFlag = {
    subgroup: SubgroupKey;
    subgroupSize: number;
    peerSize: number;
    metric: string;
    metricKey: MetricKey;
    worseDirection: "higher" | "lower";
    inGroupValue: number | null;
    outGroupValue: number | null;
    riskRatio: number | null;
    concerning: boolean;
  };

  const disparityFlags: DisparityFlag[] = [];
  const subgroupSnapshots: {
    subgroup: SubgroupKey;
    inGroupSize: number;
    outGroupSize: number;
    metrics: {
      key: MetricKey;
      name: string;
      worseDirection: "higher" | "lower";
      inGroupValue: number | null;
      outGroupValue: number | null;
      riskRatio: number | null;
    }[];
  }[] = [];

  let maxRiskRatioObserved: number | null = null;

  for (const sg of SUBGROUPS) {
    // Out-group = everyone in the cohort minus the in-group.
    const peers = new Set<string>();
    for (const sid of studentIds) {
      if (!sg.members.has(sid)) peers.add(sid);
    }
    const computed = computeMetricsForGroup(sg.members, peers);

    const metrics = METRICS.map((m) => {
      const v = computed.values[m.key];
      return {
        key: m.key,
        name: m.label,
        worseDirection: m.worseDirection,
        inGroupValue: v.in,
        outGroupValue: v.out,
        riskRatio: v.ratio,
      };
    });
    subgroupSnapshots.push({
      subgroup: sg.key,
      inGroupSize: computed.groupSize,
      outGroupSize: computed.peerSize,
      metrics,
    });

    // Disparity flags only fire when the in-group has at least MIN_GROUP_SIZE
    // students AND the ratio is concerning in the metric's worse direction.
    // Both-direction-thresholding (>=1.3 OR <=0.77) is folded into the
    // direction-aware check inside isConcerning().
    if (computed.groupSize >= MIN_GROUP_SIZE) {
      for (const m of METRICS) {
        const v = computed.values[m.key];
        if (v.ratio == null) continue;
        // Track max observed magnitude regardless of "concerning" so the
        // headline KPI shows even neutral-direction outliers.
        const magnitude = v.ratio >= 1 ? v.ratio : 1 / v.ratio;
        if (maxRiskRatioObserved == null || magnitude > maxRiskRatioObserved) {
          maxRiskRatioObserved = magnitude;
        }
        if (isConcerning(v.ratio, m.worseDirection)) {
          disparityFlags.push({
            subgroup: sg.key,
            subgroupSize: computed.groupSize,
            peerSize: computed.peerSize,
            metric: m.label,
            metricKey: m.key,
            worseDirection: m.worseDirection,
            inGroupValue: v.in,
            outGroupValue: v.out,
            riskRatio: v.ratio,
            concerning: true,
          });
        }
      }
    }
  }

  // Sort disparity flags by magnitude (most extreme first). |log(ratio)|
  // gives a symmetric magnitude that treats 1.5 and 1/1.5 equally.
  disparityFlags.sort((a, b) => {
    const am = Math.abs(Math.log(a.riskRatio ?? 1));
    const bm = Math.abs(Math.log(b.riskRatio ?? 1));
    return bm - am;
  });

  const cohort = studentRows.length;
  const pct = (n: number) => (cohort === 0 ? 0 : n / cohort);

  res.json({
    grade: gradeFilter,
    windowDays,
    totals: {
      cohortStudents: cohort,
      ellCount: ell.size,
      ellPct: pct(ell.size),
      iepCount: ese.size,
      iepPct: pct(ese.size),
      students504Count: sec504.size,
      students504Pct: pct(sec504.size),
      femaleCount: female.size,
      femalePct: pct(female.size),
      maleCount: male.size,
      malePct: pct(male.size),
      unknownGenderCount,
      unknownGenderPct: pct(unknownGenderCount),
      raceMix: {
        white: { count: raceWhite.size, pct: pct(raceWhite.size) },
        hispanic: { count: raceHispanic.size, pct: pct(raceHispanic.size) },
        black: { count: raceBlack.size, pct: pct(raceBlack.size) },
        asian: { count: raceAsian.size, pct: pct(raceAsian.size) },
        multi: { count: raceMulti.size, pct: pct(raceMulti.size) },
        native: { count: raceNative.size, pct: pct(raceNative.size) },
        pacific: { count: racePacific.size, pct: pct(racePacific.size) },
        unknown: { count: unknownRaceCount, pct: pct(unknownRaceCount) },
      },
      ethnicityHispanicCount: ethHispanic.size,
      ethnicityHispanicPct: pct(ethHispanic.size),
      ethnicityUnknownCount: unknownEthnicityCount,
      ethnicityUnknownPct: pct(unknownEthnicityCount),
      highDisparityFlagCount: disparityFlags.length,
      maxRiskRatio: maxRiskRatioObserved,
    },
    disparityFlags: disparityFlags.slice(0, 12),
    subgroupSnapshots,
    sources: {
      plans: planRows.length,
      accommodations: accomRows.length,
      negativePbisLast30d: totalNeg,
      positivePbisLast30d: totalPos,
      fastBq: bqRows.length,
      engagementLast30d: engagementTotal,
    },
  });
});

// ---------------------------------------------------------------------------
// Early Warning composite — eduCLIMBER-style single 0-100 risk score per
// student rolling up four pillars (academics / behavior / engagement /
// supports). The composite collapses noisy multi-domain signals into the
// one number an MTSS lead can sort on. Unlike the equity dashboard which
// surfaces *gaps between subgroups*, this one surfaces *individual at-risk
// students who need intervention now*.
//
// Pillars (each 0-25, summed to 0-100):
//   * Academics  — number of FAST priorYearBq subjects (0/1/2+)
//   * Behavior   — negative PBIS count in last 30d (excludes voided)
//   * Engagement — weighted count: hall pass + tardy = 1, pullout = 2,
//                  ISS day = 5 (a full day out of class is a much heavier
//                  signal than a single tardy)
//   * Supports   — active MTSS plan tier (no plan / T1 / T2 / T3)
//
// Why supports adds *score* rather than subtracts: a Tier-3 plan means a
// team has already identified this student as needing intensive support,
// which is itself a strong indicator that real risk exists. The
// "unsupportedHighRisk" flag handles the inverse case — high composite
// score with NO active plan, i.e. the student the team hasn't reached yet.
//
// Risk bands by composite:
//   0-19  Low      |  20-39 Watch     |  40-59 Moderate
//   60-79 High     |  80-100 Critical
//
// Same auth model as equity: requireSchool + isCoreTeam (Admin / SuperUser
// / MTSS / Behavior / PBIS Coord). Rosters that touch every kid in the
// school are sensitive enough to gate behind core team.
// ---------------------------------------------------------------------------

router.get("/insights/early-warning", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!isCoreTeam(staff)) {
    res.status(403).json({ error: "Early Warning is core-team only" });
    return;
  }

  // Defensive grade parsing — same pattern as equity / academics / behavior.
  const { gradeInts, gradeLabel: gradeFilter } =
    parseInsightsGradesParam(req);
  // Cross-cutting filter parsing (teacher/period/ELL/IEP/504/tier/BQ).
  // Applied via narrowCohort() once the grade cohort is built so every
  // downstream count and top-N list inherits the same denominator.
  const filters = parseInsightsFilters(req);

  type Band = "low" | "watch" | "moderate" | "high" | "critical";
  const bandOf = (score: number): Band => {
    if (score >= 80) return "critical";
    if (score >= 60) return "high";
    if (score >= 40) return "moderate";
    if (score >= 20) return "watch";
    return "low";
  };

  // Empty-cohort fast path. Same envelope shape, all zeros — keeps the
  // frontend type contract stable whether the cohort has 0 or 5000 kids.
  const emptyEnvelope = (cohortStudents: number) => ({
    grade: gradeFilter,
    windowDays: 30,
    totals: {
      cohortStudents,
      avgScore: 0,
      maxScore: 0,
      lowCount: cohortStudents, // empty cohort: no signals → all "low"
      lowPct: cohortStudents > 0 ? 1 : 0,
      watchCount: 0,
      watchPct: 0,
      moderateCount: 0,
      moderatePct: 0,
      highCount: 0,
      highPct: 0,
      criticalCount: 0,
      criticalPct: 0,
      highOrCriticalCount: 0,
      highOrCriticalPct: 0,
      unsupportedHighRiskCount: 0,
    },
    topRisk: [] as Array<unknown>,
    sources: {
      fastBq: 0,
      negPbisLast30d: 0,
      hallPassesLast30d: 0,
      tardiesLast30d: 0,
      pulloutsLast30d: 0,
      issDaysLast30d: 0,
      activePlans: 0,
    },
  });

  // Cohort. Pull names/grade so the leaderboard can render rich rows
  // without a second query.
  let studentRows = await db
    .select({
      studentId: studentsTable.studentId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        gradeFilterSql(gradeInts),
      ),
    );

  if (studentRows.length === 0) {
    res.json(emptyEnvelope(0));
    return;
  }

  // Apply cross-cutting filters (teacher/period/ELL/IEP/504/tier/BQ) by
  // narrowing the grade cohort to the filter-matching subset, then
  // dropping any studentRows whose id no longer survives. Everything
  // downstream — counts, top-risk, source sums — keys off studentIds.
  const narrowed = await narrowCohort(
    schoolId,
    studentRows.map((r) => r.studentId),
    filters,
  );
  // baseIds was non-null, so narrowCohort always returns string[] here.
  const studentIds: string[] = narrowed.ids ?? [];
  if (studentIds.length === 0) {
    res.json(emptyEnvelope(0));
    return;
  }
  const allowed = new Set(studentIds);
  studentRows = studentRows.filter((r) => allowed.has(r.studentId));

  const now = Date.now();
  const windowDays = 30;
  const fromIso = new Date(now - windowDays * 86_400_000).toISOString();
  // ISS uses a date-only column, not timestamptz.
  const fromDateOnly = new Date(now - windowDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

  // ----- Pull data sources (school-scoped + cohort-bounded) ---------------
  // Active MTSS plans WITH tier — supports pillar.
  const planRows = await db
    .select({
      studentId: studentMtssPlansTable.studentId,
      tier: studentMtssPlansTable.tier,
    })
    .from(studentMtssPlansTable)
    .where(
      and(
        eq(studentMtssPlansTable.schoolId, schoolId),
        isNull(studentMtssPlansTable.closedAt),
        inArray(studentMtssPlansTable.studentId, studentIds),
      ),
    );
  // If a student has multiple active plans, take the highest tier — that
  // represents the most intensive level of support currently in place.
  const tierByStudent = new Map<string, number>();
  for (const r of planRows) {
    const prev = tierByStudent.get(r.studentId) ?? 0;
    if (r.tier > prev) tierByStudent.set(r.studentId, r.tier);
  }

  // Negative PBIS in last 30d — behavior pillar. Excludes voided rows
  // to match the rest of the codebase's behavior semantics.
  const pbisRows = await db
    .select({ studentId: pbisEntriesTable.studentId })
    .from(pbisEntriesTable)
    .where(
      and(
        eq(pbisEntriesTable.schoolId, schoolId),
        eq(pbisEntriesTable.polarity, "negative"),
        isNull(pbisEntriesTable.voidedAt),
        gte(pbisEntriesTable.createdAt, fromIso),
        inArray(pbisEntriesTable.studentId, studentIds),
      ),
    );
  const negCountByStudent = new Map<string, number>();
  for (const r of pbisRows) {
    negCountByStudent.set(
      r.studentId,
      (negCountByStudent.get(r.studentId) ?? 0) + 1,
    );
  }

  // FAST priorYearBq — academics pillar. Counts distinct subjects flagged
  // BQ (per (student, subject) unique key in the schema). 0 / 1 / 2+ → 3
  // tiers of academic risk.
  const bqRows = await db
    .select({ studentId: studentFastScoresTable.studentId })
    .from(studentFastScoresTable)
    .where(
      and(
        eq(studentFastScoresTable.schoolId, schoolId),
        eq(studentFastScoresTable.priorYearBq, true),
        inArray(studentFastScoresTable.studentId, studentIds),
      ),
    );
  const bqCountByStudent = new Map<string, number>();
  for (const r of bqRows) {
    bqCountByStudent.set(
      r.studentId,
      (bqCountByStudent.get(r.studentId) ?? 0) + 1,
    );
  }

  // Engagement pillar — four signals weighted by instructional disruption:
  //   tardy = 1, hall pass = 1, pullout = 2, ISS day = 5
  // ISS days dwarf the others because a full day out of class is a much
  // bigger signal than a single tardy.
  const passRows = await db
    .select({ studentId: hallPassesTable.studentId })
    .from(hallPassesTable)
    .where(
      and(
        eq(hallPassesTable.schoolId, schoolId),
        gte(hallPassesTable.createdAt, fromIso),
        inArray(hallPassesTable.studentId, studentIds),
      ),
    );
  const tardyRows = await db
    .select({ studentId: tardiesTable.studentId })
    .from(tardiesTable)
    .where(
      and(
        eq(tardiesTable.schoolId, schoolId),
        gte(tardiesTable.createdAt, fromIso),
        inArray(tardiesTable.studentId, studentIds),
      ),
    );
  // pullouts.requestedAt is a TEXT column holding ISO-like timestamps;
  // string >= comparison works because ISO 8601 is lexicographically
  // sortable. Same trick used elsewhere in this file.
  const pulloutRows = await db
    .select({ studentId: pulloutsTable.studentId })
    .from(pulloutsTable)
    .where(
      and(
        eq(pulloutsTable.schoolId, schoolId),
        gte(pulloutsTable.requestedAt, fromIso),
        inArray(pulloutsTable.studentId, studentIds),
      ),
    );
  const issRows = await db
    .select({ studentId: issAttendanceDayTable.studentId })
    .from(issAttendanceDayTable)
    .where(
      and(
        eq(issAttendanceDayTable.schoolId, schoolId),
        gte(issAttendanceDayTable.day, fromDateOnly),
        inArray(issAttendanceDayTable.studentId, studentIds),
      ),
    );

  const passCountByStudent = new Map<string, number>();
  for (const r of passRows) {
    passCountByStudent.set(
      r.studentId,
      (passCountByStudent.get(r.studentId) ?? 0) + 1,
    );
  }
  const tardyCountByStudent = new Map<string, number>();
  for (const r of tardyRows) {
    tardyCountByStudent.set(
      r.studentId,
      (tardyCountByStudent.get(r.studentId) ?? 0) + 1,
    );
  }
  const pulloutCountByStudent = new Map<string, number>();
  for (const r of pulloutRows) {
    pulloutCountByStudent.set(
      r.studentId,
      (pulloutCountByStudent.get(r.studentId) ?? 0) + 1,
    );
  }
  const issCountByStudent = new Map<string, number>();
  for (const r of issRows) {
    issCountByStudent.set(
      r.studentId,
      (issCountByStudent.get(r.studentId) ?? 0) + 1,
    );
  }

  // ----- Per-pillar scoring helpers --------------------------------------
  const scoreAcademics = (bqSubjects: number): number => {
    if (bqSubjects >= 2) return 25;
    if (bqSubjects === 1) return 14;
    return 0;
  };
  const scoreBehavior = (negCount: number): number => {
    if (negCount >= 10) return 25;
    if (negCount >= 6) return 20;
    if (negCount >= 3) return 15;
    if (negCount >= 1) return 8;
    return 0;
  };
  const scoreEngagement = (weighted: number): number => {
    if (weighted >= 26) return 25;
    if (weighted >= 13) return 20;
    if (weighted >= 6) return 15;
    if (weighted >= 3) return 8;
    return 0;
  };
  const scoreSupports = (tier: number): number => {
    if (tier >= 3) return 25;
    if (tier === 2) return 14;
    if (tier === 1) return 5;
    return 0;
  };

  // ----- Composite per student --------------------------------------------
  type Scored = {
    studentId: string;
    name: string;
    grade: number;
    score: number;
    band: Band;
    breakdown: {
      academics: number;
      behavior: number;
      engagement: number;
      supports: number;
    };
    signals: {
      bqSubjects: number;
      negPbis30d: number;
      hallPasses30d: number;
      tardies30d: number;
      pullouts30d: number;
      issDays30d: number;
      weightedEngagement30d: number;
      planTier: number | null;
    };
    hasActivePlan: boolean;
    isUnsupportedHighRisk: boolean;
  };

  const scored: Scored[] = [];
  let totalScore = 0;
  let maxScore = 0;
  const bandCounts: Record<Band, number> = {
    low: 0, watch: 0, moderate: 0, high: 0, critical: 0,
  };
  let unsupportedHighRisk = 0;

  for (const s of studentRows) {
    const bqSubjects = bqCountByStudent.get(s.studentId) ?? 0;
    const negPbis = negCountByStudent.get(s.studentId) ?? 0;
    const passes = passCountByStudent.get(s.studentId) ?? 0;
    const tardies = tardyCountByStudent.get(s.studentId) ?? 0;
    const pullouts = pulloutCountByStudent.get(s.studentId) ?? 0;
    const issDays = issCountByStudent.get(s.studentId) ?? 0;
    const weightedEng = passes + tardies + pullouts * 2 + issDays * 5;
    const tier = tierByStudent.get(s.studentId) ?? 0;

    const aca = scoreAcademics(bqSubjects);
    const beh = scoreBehavior(negPbis);
    const eng = scoreEngagement(weightedEng);
    const sup = scoreSupports(tier);
    const composite = aca + beh + eng + sup;
    const band = bandOf(composite);

    bandCounts[band] += 1;
    totalScore += composite;
    if (composite > maxScore) maxScore = composite;

    const hasPlan = tier > 0;
    const unsupportedFlag = composite >= 60 && !hasPlan;
    if (unsupportedFlag) unsupportedHighRisk += 1;

    scored.push({
      studentId: s.studentId,
      name: `${s.firstName} ${s.lastName}`.trim(),
      grade: s.grade,
      score: composite,
      band,
      breakdown: {
        academics: aca,
        behavior: beh,
        engagement: eng,
        supports: sup,
      },
      signals: {
        bqSubjects,
        negPbis30d: negPbis,
        hallPasses30d: passes,
        tardies30d: tardies,
        pullouts30d: pullouts,
        issDays30d: issDays,
        weightedEngagement30d: weightedEng,
        planTier: hasPlan ? tier : null,
      },
      hasActivePlan: hasPlan,
      isUnsupportedHighRisk: unsupportedFlag,
    });
  }

  const cohort = scored.length;
  // Sort: highest composite first; tiebreak unsupported flag (more urgent),
  // then name for stable display.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.isUnsupportedHighRisk !== b.isUnsupportedHighRisk) {
      return a.isUnsupportedHighRisk ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  const TOP_N = 25;
  const topRisk = scored.slice(0, TOP_N);

  const pct = (n: number) => (cohort > 0 ? n / cohort : 0);
  const highOrCritical = bandCounts.high + bandCounts.critical;

  res.json({
    grade: gradeFilter,
    windowDays,
    totals: {
      cohortStudents: cohort,
      avgScore: cohort > 0 ? totalScore / cohort : 0,
      maxScore,
      lowCount: bandCounts.low,
      lowPct: pct(bandCounts.low),
      watchCount: bandCounts.watch,
      watchPct: pct(bandCounts.watch),
      moderateCount: bandCounts.moderate,
      moderatePct: pct(bandCounts.moderate),
      highCount: bandCounts.high,
      highPct: pct(bandCounts.high),
      criticalCount: bandCounts.critical,
      criticalPct: pct(bandCounts.critical),
      highOrCriticalCount: highOrCritical,
      highOrCriticalPct: pct(highOrCritical),
      unsupportedHighRiskCount: unsupportedHighRisk,
    },
    topRisk,
    sources: {
      fastBq: bqRows.length,
      negPbisLast30d: pbisRows.length,
      hallPassesLast30d: passRows.length,
      tardiesLast30d: tardyRows.length,
      pulloutsLast30d: pulloutRows.length,
      issDaysLast30d: issRows.length,
      activePlans: planRows.length,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/insights/attendance
//
// School-level Attendance dashboard. Mirrors the eduCLIMBER "Attendance"
// domain — daily attendance rate, period absences, excused vs unexcused
// split, tardies, and chronic absenteeism (FL definition: > 10% absence
// rate over the window).
//
// Query params + auth identical to /insights/engagement above (window,
// optional grade cohort, full insights filter bar; core team only at the
// active school).
// ---------------------------------------------------------------------------

router.get("/insights/attendance", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!isCoreTeam(staff)) {
    res
      .status(403)
      .json({ error: "Attendance dashboard is core-team only" });
    return;
  }

  const window = parseTimeWindow(req);
  const fromIso = window.from.toISOString();
  const toIso = window.to.toISOString();
  const fromDateOnly = fromIso.slice(0, 10);
  const toDateOnly = toIso.slice(0, 10);

  // Same defensive grade parsing as /insights/engagement.
  const { gradeInts, gradeLabel: gradeFilter } =
    parseInsightsGradesParam(req);
  // Empty cohort response shape — used by both the grade fast-path and
  // the cross-cutting filter narrow.
  function emptyResponse() {
    res.json({
      window: {
        from: fromIso,
        to: toIso,
        label: window.label,
        days: window.days,
      },
      grade: gradeFilter,
      totals: {
        cohortStudents: 0,
        schoolDays: 0,
        ada: 1,
        totalAbsences: 0,
        excusedAbsences: 0,
        unexcusedAbsences: 0,
        tardies: 0,
        chronicAbsentStudents: 0,
        chronicAbsentPct: 0,
      },
      trends: { dailyAttendanceRate: [], dailyAbsencesByType: [] },
      periodAbsences: [],
      topLists: { mostAbsent: [], chronicAbsent: [] },
      weather: [],
      recentAbsences: [],
    });
  }

  let studentIds: string[] | null = null;
  if (gradeInts && gradeInts.length > 0) {
    const rows = await db
      .select({ studentId: studentsTable.studentId })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          inArray(studentsTable.grade, gradeInts),
        ),
      );
    studentIds = rows.map((r) => r.studentId);
    if (studentIds.length === 0) {
      emptyResponse();
      return;
    }
  }

  const filters = parseInsightsFilters(req);
  const narrowed = await narrowCohort(schoolId, studentIds, filters);
  studentIds = narrowed.ids;
  if (narrowed.empty) {
    emptyResponse();
    return;
  }

  // ----- Pull every attendance row in the window for the cohort ----------
  const attRows = await db
    .select({
      studentId: studentAttendanceDayTable.studentId,
      day: studentAttendanceDayTable.day,
      status: studentAttendanceDayTable.status,
      absentPeriods: studentAttendanceDayTable.absentPeriods,
    })
    .from(studentAttendanceDayTable)
    .where(
      and(
        eq(studentAttendanceDayTable.schoolId, schoolId),
        gte(studentAttendanceDayTable.day, fromDateOnly),
        lte(studentAttendanceDayTable.day, toDateOnly),
        studentIds
          ? inArray(studentAttendanceDayTable.studentId, studentIds)
          : sql`true`,
      ),
    );

  if (attRows.length === 0) {
    emptyResponse();
    return;
  }

  // ----- Aggregate -------------------------------------------------------
  // Per-day totals so we can build the dense trend series.
  // Per-student totals so we can compute personal absence rate (chronic).
  type Counts = { present: number; tardy: number; excused: number; unexcused: number };
  const blank = (): Counts => ({ present: 0, tardy: 0, excused: 0, unexcused: 0 });

  const byDay = new Map<string, Counts>();
  const byStudent = new Map<string, Counts>();
  const periodCount = new Map<number, number>();
  const daySet = new Set<string>();
  const studentSet = new Set<string>();

  let totalAbsences = 0;
  let excusedAbsences = 0;
  let unexcusedAbsences = 0;
  let tardies = 0;
  let presentDays = 0; // includes tardies (FL definition for ADA)

  for (const r of attRows) {
    const dayStr = String(r.day).slice(0, 10);
    daySet.add(dayStr);
    studentSet.add(r.studentId);

    const status = r.status as keyof Counts;
    const dayCounts = byDay.get(dayStr) ?? blank();
    const studentCounts = byStudent.get(r.studentId) ?? blank();
    if (status in dayCounts) {
      dayCounts[status]++;
      studentCounts[status]++;
    }
    byDay.set(dayStr, dayCounts);
    byStudent.set(r.studentId, studentCounts);

    if (status === "excused") {
      excusedAbsences++;
      totalAbsences++;
    } else if (status === "unexcused") {
      unexcusedAbsences++;
      totalAbsences++;
    } else if (status === "tardy") {
      tardies++;
      presentDays++; // tardy = present for ADA
    } else if (status === "present") {
      presentDays++;
    }

    // Period absences: every period in the absentPeriods[] column.
    const periods = Array.isArray(r.absentPeriods) ? r.absentPeriods : [];
    for (const p of periods) {
      if (typeof p === "number" && p > 0) {
        periodCount.set(p, (periodCount.get(p) ?? 0) + 1);
      }
    }
  }

  const cohortStudents = studentSet.size;
  const schoolDays = daySet.size;
  const studentDays = attRows.length;
  const ada = studentDays > 0 ? presentDays / studentDays : 1;

  // ----- Chronic cohort (>10% personal absence rate) ---------------------
  // Tardies don't count as absent here (FL chronic-absence accounting).
  type StudentRollup = {
    studentId: string;
    days: number;
    absences: number;
    rate: number;
  };
  const studentRollups: StudentRollup[] = [];
  for (const [sid, c] of byStudent.entries()) {
    const days = c.present + c.tardy + c.excused + c.unexcused;
    const absences = c.excused + c.unexcused;
    studentRollups.push({
      studentId: sid,
      days,
      absences,
      rate: days > 0 ? absences / days : 0,
    });
  }
  const chronicRollups = studentRollups.filter((s) => s.rate > 0.1);
  const chronicAbsentStudents = chronicRollups.length;
  const chronicAbsentPct =
    cohortStudents > 0 ? chronicAbsentStudents / cohortStudents : 0;

  // ----- Resolve student names for top lists -----------------------------
  const idsForTop = new Set<string>();
  studentRollups
    .filter((s) => s.absences > 0)
    .sort((a, b) => b.absences - a.absences)
    .slice(0, 10)
    .forEach((s) => idsForTop.add(s.studentId));
  chronicRollups
    .slice()
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 10)
    .forEach((s) => idsForTop.add(s.studentId));

  const idsArr = Array.from(idsForTop);
  const nameRows = idsArr.length
    ? await db
        .select({
          studentId: studentsTable.studentId,
          firstName: studentsTable.firstName,
          lastName: studentsTable.lastName,
        })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.schoolId, schoolId),
            inArray(studentsTable.studentId, idsArr),
          ),
        )
    : [];
  const nameById = new Map(
    nameRows.map((s) => [
      s.studentId,
      `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim() || s.studentId,
    ]),
  );

  function rollupRow(s: StudentRollup) {
    return {
      studentId: s.studentId,
      studentName: nameById.get(s.studentId) ?? s.studentId,
      absences: s.absences,
      rate: s.rate,
    };
  }

  const mostAbsent = studentRollups
    .filter((s) => s.absences > 0)
    .sort((a, b) => b.absences - a.absences || b.rate - a.rate)
    .slice(0, 10)
    .map(rollupRow);

  const chronicAbsent = chronicRollups
    .slice()
    .sort((a, b) => b.rate - a.rate || b.absences - a.absences)
    .slice(0, 10)
    .map(rollupRow);

  // ----- Build dense day series ------------------------------------------
  const dailyAttendanceRate: { date: string; rate: number }[] = [];
  const dailyAbsencesByType: {
    date: string;
    excused: number;
    unexcused: number;
    tardy: number;
  }[] = [];
  const start = new Date(fromDateOnly + "T00:00:00Z");
  const end = new Date(toDateOnly + "T00:00:00Z");
  for (
    let cur = new Date(start);
    cur <= end;
    cur.setUTCDate(cur.getUTCDate() + 1)
  ) {
    const d = cur.toISOString().slice(0, 10);
    const c = byDay.get(d);
    if (!c) {
      // Skip days with zero rows entirely (typically weekends / non-school
      // days); leaving them in would drag the visual rate to "0% on
      // Saturday".
      continue;
    }
    const total = c.present + c.tardy + c.excused + c.unexcused;
    const present = c.present + c.tardy;
    dailyAttendanceRate.push({
      date: d,
      rate: total > 0 ? present / total : 1,
    });
    dailyAbsencesByType.push({
      date: d,
      excused: c.excused,
      unexcused: c.unexcused,
      tardy: c.tardy,
    });
  }

  // ----- Period absences as sorted array ---------------------------------
  const periodAbsences = Array.from(periodCount.entries())
    .map(([period, absences]) => ({ period, absences }))
    .sort((a, b) => a.period - b.period);

  // ----- Weather (window-scoped) -----------------------------------------
  // Joined client-side with the daily attendance trend for the Weather card.
  // School-wide (no cohort narrowing) — weather is the same for everyone.
  const weatherRows = await db
    .select({
      day: weatherDayTable.day,
      tempHighF: weatherDayTable.tempHighF,
      tempLowF: weatherDayTable.tempLowF,
      precipInches: weatherDayTable.precipInches,
      weatherCode: weatherDayTable.weatherCode,
      summary: weatherDayTable.summary,
    })
    .from(weatherDayTable)
    .where(
      and(
        eq(weatherDayTable.schoolId, schoolId),
        gte(weatherDayTable.day, fromDateOnly),
        lte(weatherDayTable.day, toDateOnly),
      ),
    );
  const weather = weatherRows
    .map((w) => ({
      date: String(w.day).slice(0, 10),
      tempHighF: w.tempHighF,
      tempLowF: w.tempLowF,
      precipInches: w.precipInches,
      weatherCode: w.weatherCode,
      summary: w.summary,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // ----- Recent absences (PBIS-style "Recent events" list) ---------------
  // Last 25 absence/tardy entries in the window, newest first, with the
  // student name resolved. Uses the same cohort narrowing as the rest of
  // the dashboard so filters don't lie.
  const recentRows = await db
    .select({
      studentId: studentAttendanceDayTable.studentId,
      day: studentAttendanceDayTable.day,
      status: studentAttendanceDayTable.status,
      absentPeriods: studentAttendanceDayTable.absentPeriods,
      createdAt: studentAttendanceDayTable.createdAt,
    })
    .from(studentAttendanceDayTable)
    .where(
      and(
        eq(studentAttendanceDayTable.schoolId, schoolId),
        gte(studentAttendanceDayTable.day, fromDateOnly),
        lte(studentAttendanceDayTable.day, toDateOnly),
        inArray(studentAttendanceDayTable.status, [
          "excused",
          "unexcused",
          "tardy",
        ]),
        studentIds
          ? inArray(studentAttendanceDayTable.studentId, studentIds)
          : sql`true`,
      ),
    )
    .orderBy(desc(studentAttendanceDayTable.day))
    .limit(25);

  const recentNameIds = Array.from(new Set(recentRows.map((r) => r.studentId)));
  const missingNameIds = recentNameIds.filter((id) => !nameById.has(id));
  if (missingNameIds.length > 0) {
    const moreNames = await db
      .select({
        studentId: studentsTable.studentId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          inArray(studentsTable.studentId, missingNameIds),
        ),
      );
    for (const s of moreNames) {
      nameById.set(
        s.studentId,
        `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim() || s.studentId,
      );
    }
  }

  const recentAbsences = recentRows.map((r) => ({
    studentId: r.studentId,
    studentName: nameById.get(r.studentId) ?? r.studentId,
    date: String(r.day).slice(0, 10),
    status: r.status,
    periods: Array.isArray(r.absentPeriods) ? r.absentPeriods : [],
  }));

  res.json({
    window: {
      from: fromIso,
      to: toIso,
      label: window.label,
      days: window.days,
    },
    grade: gradeFilter,
    totals: {
      cohortStudents,
      schoolDays,
      ada,
      totalAbsences,
      excusedAbsences,
      unexcusedAbsences,
      tardies,
      chronicAbsentStudents,
      chronicAbsentPct,
    },
    trends: { dailyAttendanceRate, dailyAbsencesByType },
    periodAbsences,
    topLists: { mostAbsent, chronicAbsent },
    weather,
    recentAbsences,
  });
});

export default router;
