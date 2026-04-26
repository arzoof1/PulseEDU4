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
  hallPassesTable,
  pulloutsTable,
  studentAccommodationsTable,
  schoolAccommodationsTable,
  interventionEntriesTable,
  parentStudentsTable,
} from "@workspace/db";
import { and, eq, inArray, isNull, gte, lte, sql, desc } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { placePm3, placeOnChart, hasChart } from "../lib/fastCutScores.js";

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

  // ----- Pillar: Academics -----------------------------------------------
  const fastScores = await db
    .select()
    .from(studentFastScoresTable)
    .where(
      and(
        eq(studentFastScoresTable.schoolId, schoolId),
        eq(studentFastScoresTable.studentId, studentId),
      ),
    );
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

  // Behavior: PBIS positives lift, PBIS negatives + support notes drag.
  // Caps prevent a single very-active student from saturating either end.
  let behaviorScore = 75;
  behaviorScore += Math.min(pbisPositive * 3, 25);
  behaviorScore -= Math.min(pbisNegative * 5, 50);
  behaviorScore -= Math.min(supportNotes.length * 8, 60);
  behaviorScore = Math.max(0, Math.min(100, behaviorScore));
  const behaviorRationale =
    pbisPositive + pbisNegative + supportNotes.length === 0
      ? `No behavior entries (${window.label.toLowerCase()})`
      : `${pbisPositive} positive, ${pbisNegative} concerns, ${supportNotes.length} notes (${window.label.toLowerCase()})`;

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

  res.json({
    header: {
      studentId: student.studentId,
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
        })),
        assessments,
      },
      behavior: {
        pbisPositiveCount: pbisPositive,
        pbisNegativeCount: pbisNegative,
        supportNoteCount: supportNotes.length,
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
    },
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

export default router;
