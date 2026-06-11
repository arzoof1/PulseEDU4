// MTSS Reports — aggregated trend data for the Reports page.
//
// Two modes, same endpoint shape:
//   1. Per-plan: pass `planId`. Returns metrics for that single plan.
//      The `range=sinceOpened` preset is per-plan-only; it walks
//      back to the plan's openedAt.
//   2. Standalone: omit `planId`; pass any combination of filters
//      (`tier`, `subType`, `grade`, `teacherStaffId`). Aggregates
//      across every active plan in the school that matches.
//
// Auth: same gate as the rest of the MTSS admin surface (admins,
// Behavior Specialists, MTSS Coords, PBIS Coords, SuperUsers).
//
// Charts produced:
//   - weeklyTrend         (line: T2 % completion + T3 % avg score)
//   - perTeacher          (bar: completion + avg score per teacher)
//   - perSubject          (bar: completion grouped by class subject)
//   - dayOfWeek           (heatmap source: Mon-Fri completion)
//   - t3GoalTrend         (line: weekly avg score for T3 plans)
//
// Performance: every query is filtered by `schoolId` and
// `studentId IN (...)` first, so even at the demo-school scale
// (~135K T2 entries / ~5K T3 records) the worst case still pulls
// well under a second's worth of rows.
import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  studentMtssPlansTable,
  staffTable,
  studentsTable,
  tier2InterventionEntriesTable,
  tier3WeeklyRecordsTable,
  classSectionsTable,
  sectionRosterTable,
} from "@workspace/db";
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import {
  effectiveTeacherIdsForPlan,
  loadScheduleTeacherIdsForStudents,
} from "../lib/effectiveTeachers.js";

const router: IRouter = Router();

// ---------------- helpers ----------------

function isoDate(d: Date): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

// Monday-of-week, given a YYYY-MM-DD string. Mirrors the same
// helper that `interventionsBell.ts` uses so weekStartDate values
// align between this report and the existing weekly view.
function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  const dow = d.getDay(); // 0=Sun..6=Sat
  const shift = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + shift);
  return isoDate(d);
}

function dayOfWeek(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00`).getDay();
}

function isWeekday(dateStr: string): boolean {
  const dow = dayOfWeek(dateStr);
  return dow >= 1 && dow <= 5;
}

// Enumerate every weekday (Mon-Fri) between startDate and endDate
// inclusive, as YYYY-MM-DD strings.
function weekdayRange(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  let cur = startDate;
  while (cur <= endDate) {
    if (isWeekday(cur)) out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

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

function requireCoreTeam(
  staff: typeof staffTable.$inferSelect,
  res: Response,
): boolean {
  const allowed =
    staff.isSuperUser ||
    staff.isAdmin ||
    staff.isBehaviorSpecialist ||
    staff.isMtssCoordinator ||
    staff.isPbisCoordinator;
  if (!allowed) {
    res.status(403).json({
      error:
        "Only admins, Behavior Specialists, MTSS Coordinators, and PBIS Coordinators can view MTSS reports",
    });
    return false;
  }
  return true;
}

// ---------------- types ----------------

// "Behavior" vs academic ("ELA"/"Math") segment label for a plan,
// derived from fastSubject (ela|math; null/"" = behavior).
function subjectLabel(fastSubject: string | null): "Behavior" | "ELA" | "Math" {
  if (fastSubject === "ela") return "ELA";
  if (fastSubject === "math") return "Math";
  return "Behavior";
}

// Per-day academic-minutes map (e.g. { mon: 15, wed: 20 }) → total minutes.
function sumMinutes(m: unknown): number {
  if (!m || typeof m !== "object") return 0;
  let total = 0;
  for (const v of Object.values(m as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) total += v;
  }
  return total;
}

// Academic minutes day-key → weekday number (1=Mon .. 5=Fri).
const ACADEMIC_DAY_DOW: Record<string, number> = {
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
};

interface PlanRow {
  id: number;
  schoolId: number;
  studentId: string;
  tier: number;
  interventionSubType: string | null;
  fastSubject: string | null;
  academicMinutesTarget: number;
  title: string;
  goals: string | null;
  openedAt: Date;
  closedAt: Date | null;
  autoAssignScheduleTeachers: boolean;
  assignedTeacherIds: string;
  excludedTeacherIds: string;
  additionalInterventionistIds: string;
}

interface SummaryResponse {
  rangeStart: string;
  rangeEnd: string;
  schoolDayCount: number;
  plansIncluded: number;
  filters: {
    range: string;
    planId: number | null;
    tier: number | null;
    subType: string | null;
    grade: string | null;
    teacherStaffId: number | null;
    planType: "behavior" | "academic" | null;
    academicSubject: "ela" | "math" | null;
  };
  planMeta: {
    id: number;
    studentId: string;
    studentName: string;
    grade: string | null;
    tier: number;
    subType: string | null;
    fastSubject: string | null;
    subjectLabel: string;
    academicMinutesTarget: number | null;
    title: string;
    goals: string | null;
    openedAt: string;
    closedAt: string | null;
    autoAssignScheduleTeachers: boolean;
    effectiveTeachers: { id: number; displayName: string }[];
  } | null;
  weeklyTrend: Array<{
    weekStartDate: string;
    t2Completed: number;
    t2Expected: number;
    t2CompletionPct: number | null;
    t3Scored: number;
    t3ScoreSum: number;
    t3AvgScorePct: number | null;
  }>;
  perTeacher: Array<{
    teacherStaffId: number;
    teacherName: string;
    subjects: string[];
    t2Completed: number;
    t2Expected: number;
    t2CompletionPct: number | null;
    t3ScoredCount: number;
    t3AvgScore: number | null;
    // Academic (minutes) columns — 0/null for behavior-only teachers.
    acadMet: number;
    acadOwed: number;
    acadExcused: number;
    acadMinutes: number;
    acadAvgMinutes: number | null;
  }>;
  perSubject: Array<{
    courseName: string;
    t2Completed: number;
    t2Expected: number;
    t2CompletionPct: number | null;
  }>;
  dayOfWeek: Array<{
    dow: number; // 1=Mon .. 5=Fri
    label: string;
    t2Completed: number;
    t2Expected: number;
    t2CompletionPct: number | null;
  }>;
  t3GoalTrend: Array<{
    weekStartDate: string;
    avgScore: number | null;
    scoredCount: number;
  }>;
  // Tier 3 best/worst weekday: avg daily score (1..5) grouped by weekday.
  t3DayOfWeek: Array<{
    dow: number; // 1=Mon .. 5=Fri
    label: string;
    avgScore: number | null;
    scoredCount: number;
  }>;
  // Academic (minutes-based) Tier 3 reporting. Populated from academic
  // plans (fastSubject set); empty when there are no academic plans in
  // scope. A week is met (>= target), owed (0 < mins < target) or
  // excused ("no group provided").
  t3Academic: {
    target: number | null;
    completion: {
      met: number;
      owed: number;
      excused: number;
      total: number;
    };
    trend: Array<{
      weekStartDate: string;
      minutesSum: number;
      recordCount: number;
      avgMinutes: number | null;
      met: number;
      owed: number;
      excused: number;
    }>;
    dayOfWeek: Array<{ dow: number; label: string; minutes: number }>;
  };
  // Per-plan mode only: every plan for this student, so the client can
  // enable/grey the Tier 2 / Tier 3 tabs and swap which plan it loads
  // when the user switches tier. Null in aggregate mode.
  studentPlans: Array<{
    id: number;
    tier: number;
    title: string;
    subType: string | null;
    fastSubject: string | null;
    subjectLabel: string;
    openedAt: string;
    closedAt: string | null;
  }> | null;
}

// ---------------- endpoint ----------------

router.get("/mtss-reports/summary", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requireCoreTeam(staff, res)) return;

  // ---- parse filters ----
  const rawRange = String(req.query.range ?? "30");
  const rangePresets = new Set(["7", "30", "60", "90", "sinceOpened"]);
  const range = rangePresets.has(rawRange) ? rawRange : "30";
  const planIdRaw = req.query.planId ? Number(req.query.planId) : null;
  const planId =
    planIdRaw != null && Number.isInteger(planIdRaw) && planIdRaw > 0
      ? planIdRaw
      : null;
  const tierRaw = req.query.tier ? Number(req.query.tier) : null;
  const tier =
    tierRaw === 1 || tierRaw === 2 || tierRaw === 3 ? tierRaw : null;
  const subType = req.query.subType ? String(req.query.subType) : null;
  const grade = req.query.grade ? String(req.query.grade) : null;
  const teacherStaffIdRaw = req.query.teacherStaffId
    ? Number(req.query.teacherStaffId)
    : null;
  const teacherStaffId =
    teacherStaffIdRaw != null &&
    Number.isInteger(teacherStaffIdRaw) &&
    teacherStaffIdRaw > 0
      ? teacherStaffIdRaw
      : null;
  // Academic/Behavior segment (aggregate mode only). `planType`
  // splits behavior plans (fastSubject null/"") from academic plans
  // (fastSubject set); `academicSubject` further narrows academic to
  // ELA or Math. Ignored in per-plan mode so the single plan never
  // gets filtered away.
  const planTypeRaw = req.query.planType ? String(req.query.planType) : null;
  const planType: "behavior" | "academic" | null =
    planTypeRaw === "behavior" || planTypeRaw === "academic"
      ? planTypeRaw
      : null;
  const academicSubjectRaw = req.query.academicSubject
    ? String(req.query.academicSubject)
    : null;
  const academicSubject: "ela" | "math" | null =
    academicSubjectRaw === "ela" || academicSubjectRaw === "math"
      ? academicSubjectRaw
      : null;

  // ---- load plans ----
  const baseWhere = [eq(studentMtssPlansTable.schoolId, schoolId)];
  if (planId != null) {
    baseWhere.push(eq(studentMtssPlansTable.id, planId));
  } else {
    baseWhere.push(isNull(studentMtssPlansTable.closedAt));
    if (tier != null) baseWhere.push(eq(studentMtssPlansTable.tier, tier));
    if (subType)
      baseWhere.push(
        eq(studentMtssPlansTable.interventionSubType, subType),
      );
  }

  const planRows: PlanRow[] = await db
    .select({
      id: studentMtssPlansTable.id,
      schoolId: studentMtssPlansTable.schoolId,
      studentId: studentMtssPlansTable.studentId,
      tier: studentMtssPlansTable.tier,
      interventionSubType: studentMtssPlansTable.interventionSubType,
      fastSubject: studentMtssPlansTable.fastSubject,
      academicMinutesTarget: studentMtssPlansTable.academicMinutesTarget,
      title: studentMtssPlansTable.title,
      goals: studentMtssPlansTable.goals,
      openedAt: studentMtssPlansTable.openedAt,
      closedAt: studentMtssPlansTable.closedAt,
      autoAssignScheduleTeachers:
        studentMtssPlansTable.autoAssignScheduleTeachers,
      assignedTeacherIds: studentMtssPlansTable.assignedTeacherIds,
      excludedTeacherIds: studentMtssPlansTable.excludedTeacherIds,
      additionalInterventionistIds:
        studentMtssPlansTable.additionalInterventionistIds,
    })
    .from(studentMtssPlansTable)
    .where(and(...baseWhere));

  // Per-plan view requires the plan to actually belong to this school.
  if (planId != null && planRows.length === 0) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }

  // ---- resolve range window ----
  const todayStr = isoDate(new Date());
  let rangeStart: string;
  let rangeEnd = todayStr;

  if (range === "sinceOpened") {
    if (planId == null || planRows.length === 0) {
      res
        .status(400)
        .json({ error: "range=sinceOpened requires planId" });
      return;
    }
    rangeStart = isoDate(planRows[0]!.openedAt);
  } else {
    const days = Number(range);
    rangeStart = addDays(todayStr, -(days - 1));
  }

  // ---- pull schedule teacher map (for effective list + perSubject) ----
  const studentIds = Array.from(new Set(planRows.map((p) => p.studentId)));
  const scheduleMap = await loadScheduleTeacherIdsForStudents(
    schoolId,
    studentIds,
  );

  // Compute effective teacher list per plan.
  const effectivePlanTeachers = new Map<number, number[]>();
  for (const p of planRows) {
    effectivePlanTeachers.set(
      p.id,
      effectiveTeacherIdsForPlan(p, scheduleMap.get(p.studentId) ?? []),
    );
  }

  // Optional grade filter — load students up front, then drop plans
  // whose student doesn't match.
  const studentRows =
    studentIds.length === 0
      ? []
      : await db
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
              inArray(studentsTable.studentId, studentIds),
            ),
          );
  const studentMap = new Map(studentRows.map((s) => [s.studentId, s]));

  let plans = planRows;
  if (grade) {
    plans = plans.filter(
      (p) => String(studentMap.get(p.studentId)?.grade ?? "") === grade,
    );
  }
  // Optional teacher filter — keep plans where effective list contains it.
  if (teacherStaffId != null) {
    plans = plans.filter((p) =>
      (effectivePlanTeachers.get(p.id) ?? []).includes(teacherStaffId),
    );
  }
  // Academic/Behavior segment — aggregate mode only (per-plan mode
  // pins a single planId we must not drop). Behavior = fastSubject
  // null/""; academic = fastSubject set, optionally narrowed to a
  // single subject.
  if (planId == null && planType === "behavior") {
    plans = plans.filter((p) => !p.fastSubject);
  } else if (planId == null && planType === "academic") {
    plans = plans.filter((p) => !!p.fastSubject);
    if (academicSubject) {
      plans = plans.filter((p) => p.fastSubject === academicSubject);
    }
  }

  // ---- pull entries / records in range ----
  const planStudentIds = Array.from(new Set(plans.map((p) => p.studentId)));
  const tier2Plans = plans.filter((p) => p.tier === 2);
  const tier3Plans = plans.filter((p) => p.tier === 3);
  const tier2StudentIds = Array.from(
    new Set(tier2Plans.map((p) => p.studentId)),
  );
  const tier3StudentIds = Array.from(
    new Set(tier3Plans.map((p) => p.studentId)),
  );

  const t2Entries =
    tier2StudentIds.length === 0
      ? []
      : await db
          .select({
            studentId: tier2InterventionEntriesTable.studentId,
            teacherStaffId: tier2InterventionEntriesTable.teacherStaffId,
            entryDate: tier2InterventionEntriesTable.entryDate,
            subType: tier2InterventionEntriesTable.subType,
          })
          .from(tier2InterventionEntriesTable)
          .where(
            and(
              eq(tier2InterventionEntriesTable.schoolId, schoolId),
              inArray(
                tier2InterventionEntriesTable.studentId,
                tier2StudentIds,
              ),
              gte(tier2InterventionEntriesTable.entryDate, rangeStart),
              lte(tier2InterventionEntriesTable.entryDate, rangeEnd),
            ),
          );

  // Tier 3 weekStartDate is a Monday — pull anything from the week
  // containing rangeStart through the week containing rangeEnd.
  const t3WeekStart = mondayOf(rangeStart);
  const t3WeekEnd = mondayOf(rangeEnd);
  const t3Records =
    tier3StudentIds.length === 0
      ? []
      : await db
          .select()
          .from(tier3WeeklyRecordsTable)
          .where(
            and(
              eq(tier3WeeklyRecordsTable.schoolId, schoolId),
              inArray(
                tier3WeeklyRecordsTable.studentId,
                tier3StudentIds,
              ),
              gte(tier3WeeklyRecordsTable.weekStartDate, t3WeekStart),
              lte(tier3WeeklyRecordsTable.weekStartDate, t3WeekEnd),
            ),
          );

  // Tier 3 weekly records are keyed by (student, teacher, week) and are
  // NOT plan-tagged. A student with BOTH a behavior and an academic
  // Tier 3 plan would otherwise have every teacher's records credited to
  // each per-plan report — e.g. an academic plan (single named
  // interventionist) would wrongly show the behavior plan's whole-
  // schedule teachers. Restrict every T3 panel to the teachers
  // responsible for the filtered plan(s): their effective teacher list.
  // Auto-assign plans also keep any teacher who actually logged a record
  // in range (a past contributor whose schedule has since changed —
  // preserves historical credit); manual-mode plans (e.g. an academic
  // plan with a single named interventionist) stay strict to their
  // assigned list, so the academic report shows only that interventionist.
  const allowedT3Pairs = new Set<string>();
  for (const p of tier3Plans) {
    for (const tid of effectivePlanTeachers.get(p.id) ?? []) {
      allowedT3Pairs.add(`${p.studentId}::${tid}`);
    }
    if (p.autoAssignScheduleTeachers) {
      for (const r of t3Records) {
        if (r.studentId === p.studentId) {
          allowedT3Pairs.add(`${p.studentId}::${r.teacherStaffId}`);
        }
      }
    }
  }

  // ---- build lookup keyed maps ----
  // T2 cadence is WEEKLY: one entry per (student, teacher) per Mon-Fri
  // week. Index entry presence by (studentId, teacherId, subType,
  // weekStart) so a single entry on Wednesday counts as that whole
  // week's obligation. Also keep a per-(studentId, teacherId,
  // subType, dow) tally for the day-of-week chart so we can show
  // which weekday teachers actually log on.
  const t2HasByWeek = new Set<string>();
  const t2DowCount = new Map<number, number>();
  for (const e of t2Entries) {
    const wk = mondayOf(e.entryDate);
    t2HasByWeek.add(
      `${e.studentId}::${e.teacherStaffId}::${e.subType ?? ""}::${wk}`,
    );
    const dow = dayOfWeek(e.entryDate);
    if (dow >= 1 && dow <= 5) {
      t2DowCount.set(dow, (t2DowCount.get(dow) ?? 0) + 1);
    }
  }

  // ---- compute schoolDayCount + week list ----
  const schoolDays = weekdayRange(rangeStart, rangeEnd);
  const schoolDayCount = schoolDays.length;
  // De-duped, ordered list of week-start (Monday) strings that have at
  // least one in-range school day. T2 expected/completed math iterates
  // over THIS list (not schoolDays) since each plan only owes one
  // entry per week now.
  const schoolWeeks = Array.from(
    new Set(schoolDays.map((d) => mondayOf(d))),
  ).sort();

  // ---- weeklyTrend (T2 + T3) ----
  const weeklyMap = new Map<
    string,
    {
      t2Completed: number;
      t2Expected: number;
      t3Scored: number;
      t3ScoreSum: number;
    }
  >();
  function bumpWeek(week: string): {
    t2Completed: number;
    t2Expected: number;
    t3Scored: number;
    t3ScoreSum: number;
  } {
    let v = weeklyMap.get(week);
    if (!v) {
      v = { t2Completed: 0, t2Expected: 0, t3Scored: 0, t3ScoreSum: 0 };
      weeklyMap.set(week, v);
    }
    return v;
  }

  // T2 expected/completed by week. Each (week, plan, teacher) is one
  // obligation; completed if at least one entry exists in that week
  // for that (student, teacher, subType). A plan contributes to a
  // given week only if its openedAt falls on or before the week's
  // Friday and (if closed) its closedAt falls on or after the week's
  // Monday — i.e. the plan was open for some portion of the week.
  for (const wk of schoolWeeks) {
    const wkEnd = addDays(wk, 4); // Friday
    for (const p of tier2Plans) {
      const openedDay = isoDate(p.openedAt);
      if (openedDay > wkEnd) continue;
      if (p.closedAt && isoDate(p.closedAt) < wk) continue;
      const tids = effectivePlanTeachers.get(p.id) ?? [];
      const filteredTids = teacherStaffId
        ? tids.filter((id) => id === teacherStaffId)
        : tids;
      for (const tid of filteredTids) {
        const slot = bumpWeek(wk);
        slot.t2Expected += 1;
        const key = `${p.studentId}::${tid}::${p.interventionSubType ?? ""}::${wk}`;
        if (t2HasByWeek.has(key)) slot.t2Completed += 1;
      }
    }
  }

  // T3 scores by week. Each record contributes its non-null mon..fri
  // scores into the bucket at its weekStartDate. When a teacher
  // filter is in play we honor it here too so the weekly trend
  // line stays consistent with the per-teacher and dayOfWeek
  // panels (else picking one teacher would still show the school's
  // full T3 score line).
  for (const r of t3Records) {
    if (teacherStaffId && r.teacherStaffId !== teacherStaffId) continue;
    if (!allowedT3Pairs.has(`${r.studentId}::${r.teacherStaffId}`)) continue;
    const slot = bumpWeek(r.weekStartDate);
    const days: Array<number | null> = [
      r.monScore,
      r.tueScore,
      r.wedScore,
      r.thuScore,
      r.friScore,
    ];
    for (const s of days) {
      if (s != null) {
        slot.t3Scored += 1;
        slot.t3ScoreSum += s;
      }
    }
  }

  const weeklyTrend = Array.from(weeklyMap.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([weekStartDate, v]) => ({
      weekStartDate,
      t2Completed: v.t2Completed,
      t2Expected: v.t2Expected,
      t2CompletionPct:
        v.t2Expected > 0
          ? Math.round((v.t2Completed / v.t2Expected) * 1000) / 10
          : null,
      t3Scored: v.t3Scored,
      t3ScoreSum: v.t3ScoreSum,
      t3AvgScorePct:
        v.t3Scored > 0
          ? Math.round(((v.t3ScoreSum / v.t3Scored) / 5) * 1000) / 10
          : null,
    }));

  // ---- perTeacher ----
  const perTeacherMap = new Map<
    number,
    {
      t2Completed: number;
      t2Expected: number;
      t3ScoredCount: number;
      t3ScoreSum: number;
    }
  >();
  function teacherSlot(id: number): {
    t2Completed: number;
    t2Expected: number;
    t3ScoredCount: number;
    t3ScoreSum: number;
  } {
    let v = perTeacherMap.get(id);
    if (!v) {
      v = {
        t2Completed: 0,
        t2Expected: 0,
        t3ScoredCount: 0,
        t3ScoreSum: 0,
      };
      perTeacherMap.set(id, v);
    }
    return v;
  }
  // T2 — per-teacher, per-week (one obligation per week).
  for (const wk of schoolWeeks) {
    const wkEnd = addDays(wk, 4);
    for (const p of tier2Plans) {
      const openedDay = isoDate(p.openedAt);
      if (openedDay > wkEnd) continue;
      if (p.closedAt && isoDate(p.closedAt) < wk) continue;
      const tids = effectivePlanTeachers.get(p.id) ?? [];
      for (const tid of tids) {
        if (teacherStaffId && tid !== teacherStaffId) continue;
        const slot = teacherSlot(tid);
        slot.t2Expected += 1;
        const key = `${p.studentId}::${tid}::${p.interventionSubType ?? ""}::${wk}`;
        if (t2HasByWeek.has(key)) slot.t2Completed += 1;
      }
    }
  }
  // T3.
  for (const r of t3Records) {
    if (teacherStaffId && r.teacherStaffId !== teacherStaffId) continue;
    if (!allowedT3Pairs.has(`${r.studentId}::${r.teacherStaffId}`)) continue;
    const slot = teacherSlot(r.teacherStaffId);
    const days: Array<number | null> = [
      r.monScore,
      r.tueScore,
      r.wedScore,
      r.thuScore,
      r.friScore,
    ];
    for (const s of days) {
      if (s != null) {
        slot.t3ScoredCount += 1;
        slot.t3ScoreSum += s;
      }
    }
  }

  // ---- t3Academic (minutes-based academic Tier 3) ----
  // Academic plans store per-day minutes in `academicMinutes` (not the
  // 1..5 behavior scores) with a per-plan weekly target. A week is
  // EXCUSED when released, MET when sum(minutes) >= target, otherwise
  // OWED (this includes a week with zero minutes logged — matching the
  // bell, which treats sum(minutes) < target as unresolved).
  //
  // De-contamination: a student can hold BOTH a behavior and an academic
  // Tier 3 plan at once. We therefore (a) restrict the academic tally to
  // (student, teacher) pairs that belong to an ACADEMIC plan, and
  // (b) skip any record that carries 1..5 day scores — those are behavior
  // records and must never be counted as academic "owed".
  const academicPlanByStudent = new Map<
    string,
    { target: number; subject: string }
  >();
  const academicAllowedPairs = new Set<string>();
  for (const p of tier3Plans) {
    if (!p.fastSubject) continue;
    academicPlanByStudent.set(p.studentId, {
      target: p.academicMinutesTarget,
      subject: p.fastSubject,
    });
    for (const tid of effectivePlanTeachers.get(p.id) ?? []) {
      academicAllowedPairs.add(`${p.studentId}::${tid}`);
    }
    if (p.autoAssignScheduleTeachers) {
      // Auto-assign academic plans also keep any teacher who actually logged
      // an academic-looking record (minutes or a release) — never a
      // behavior-only contributor on the same student's schedule.
      for (const r of t3Records) {
        if (
          r.studentId === p.studentId &&
          (sumMinutes(r.academicMinutes) > 0 || r.releasedNoIntervention)
        ) {
          academicAllowedPairs.add(`${p.studentId}::${r.teacherStaffId}`);
        }
      }
    }
  }
  const acadDowLabels = ["", "Mon", "Tue", "Wed", "Thu", "Fri"];
  const acadWeekMap = new Map<
    string,
    {
      minutesSum: number;
      recordCount: number;
      met: number;
      owed: number;
      excused: number;
    }
  >();
  const acadDow = new Map<number, number>();
  const acadTeacherMap = new Map<
    number,
    { met: number; owed: number; excused: number; minutes: number }
  >();
  let acadMet = 0;
  let acadOwed = 0;
  let acadExcused = 0;
  for (const r of t3Records) {
    if (teacherStaffId && r.teacherStaffId !== teacherStaffId) continue;
    if (!academicAllowedPairs.has(`${r.studentId}::${r.teacherStaffId}`))
      continue;
    // Behavior records carry 1..5 day scores; academic records never do.
    if (
      r.monScore != null ||
      r.tueScore != null ||
      r.wedScore != null ||
      r.thuScore != null ||
      r.friScore != null
    )
      continue;
    const acad = academicPlanByStudent.get(r.studentId);
    if (!acad) continue;
    let wk = acadWeekMap.get(r.weekStartDate);
    if (!wk) {
      wk = { minutesSum: 0, recordCount: 0, met: 0, owed: 0, excused: 0 };
      acadWeekMap.set(r.weekStartDate, wk);
    }
    let tslot = acadTeacherMap.get(r.teacherStaffId);
    if (!tslot) {
      tslot = { met: 0, owed: 0, excused: 0, minutes: 0 };
      acadTeacherMap.set(r.teacherStaffId, tslot);
    }
    if (r.releasedNoIntervention) {
      wk.excused += 1;
      tslot.excused += 1;
      acadExcused += 1;
      continue;
    }
    const mins = sumMinutes(r.academicMinutes);
    wk.minutesSum += mins;
    wk.recordCount += 1;
    tslot.minutes += mins;
    if (mins >= acad.target) {
      wk.met += 1;
      tslot.met += 1;
      acadMet += 1;
    } else {
      wk.owed += 1;
      tslot.owed += 1;
      acadOwed += 1;
    }
    const minutesMap = (r.academicMinutes ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(minutesMap)) {
      const dow = ACADEMIC_DAY_DOW[k.toLowerCase()];
      if (dow && typeof v === "number" && Number.isFinite(v)) {
        acadDow.set(dow, (acadDow.get(dow) ?? 0) + v);
      }
    }
  }
  const t3AcademicTrend = Array.from(acadWeekMap.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([weekStartDate, v]) => ({
      weekStartDate,
      minutesSum: v.minutesSum,
      recordCount: v.recordCount,
      avgMinutes:
        v.recordCount > 0
          ? Math.round((v.minutesSum / v.recordCount) * 10) / 10
          : null,
      met: v.met,
      owed: v.owed,
      excused: v.excused,
    }));
  const t3AcademicDayOfWeek = Array.from({ length: 5 }, (_, i) => i + 1).map(
    (dow) => ({
      dow,
      label: acadDowLabels[dow] ?? String(dow),
      minutes: acadDow.get(dow) ?? 0,
    }),
  );
  let academicTarget: number | null = null;
  {
    const freq = new Map<number, number>();
    for (const a of academicPlanByStudent.values()) {
      freq.set(a.target, (freq.get(a.target) ?? 0) + 1);
    }
    const top = Array.from(freq.entries()).sort((a, b) => b[1] - a[1])[0];
    academicTarget = top ? top[0] : null;
  }
  const t3Academic = {
    target: academicTarget,
    completion: {
      met: acadMet,
      owed: acadOwed,
      excused: acadExcused,
      total: acadMet + acadOwed + acadExcused,
    },
    trend: t3AcademicTrend,
    dayOfWeek: t3AcademicDayOfWeek,
  };

  // Resolve display names.
  const teacherIds = Array.from(perTeacherMap.keys());
  const teacherNameRows =
    teacherIds.length === 0
      ? []
      : await db
          .select({ id: staffTable.id, displayName: staffTable.displayName })
          .from(staffTable)
          .where(inArray(staffTable.id, teacherIds));
  const teacherNameMap = new Map(
    teacherNameRows.map((t) => [t.id, t.displayName]),
  );
  // Which subject segments each teacher's filtered plans cover, so the
  // per-teacher rows can carry "Behavior"/"ELA"/"Math" chips. A teacher
  // running mixed plans (e.g. behavior + math) shows multiple chips.
  const teacherSubjects = new Map<number, Set<string>>();
  for (const p of plans) {
    const label = subjectLabel(p.fastSubject);
    for (const tid of effectivePlanTeachers.get(p.id) ?? []) {
      if (teacherStaffId && tid !== teacherStaffId) continue;
      let set = teacherSubjects.get(tid);
      if (!set) {
        set = new Set();
        teacherSubjects.set(tid, set);
      }
      set.add(label);
    }
  }
  const perTeacher = Array.from(perTeacherMap.entries())
    .map(([id, v]) => {
      const a = acadTeacherMap.get(id);
      return {
        teacherStaffId: id,
        teacherName: teacherNameMap.get(id) ?? `Staff #${id}`,
        subjects: Array.from(teacherSubjects.get(id) ?? []).sort(),
        t2Completed: v.t2Completed,
        t2Expected: v.t2Expected,
        t2CompletionPct:
          v.t2Expected > 0
            ? Math.round((v.t2Completed / v.t2Expected) * 1000) / 10
            : null,
        t3ScoredCount: v.t3ScoredCount,
        t3AvgScore:
          v.t3ScoredCount > 0
            ? Math.round((v.t3ScoreSum / v.t3ScoredCount) * 100) / 100
            : null,
        acadMet: a?.met ?? 0,
        acadOwed: a?.owed ?? 0,
        acadExcused: a?.excused ?? 0,
        acadMinutes: a?.minutes ?? 0,
        acadAvgMinutes:
          a && a.met + a.owed > 0
            ? Math.round((a.minutes / (a.met + a.owed)) * 10) / 10
            : null,
      };
    })
    .sort((a, b) => a.teacherName.localeCompare(b.teacherName));

  // ---- perSubject (T2 only — uses class section join) ----
  // Build (studentId, teacherStaffId) → courseName from current
  // schedule. If a teacher teaches multiple sections to the same
  // student, pick first deterministic.
  const subjectByStudentTeacher = new Map<string, string>();
  if (planStudentIds.length > 0) {
    const sectionRows = await db
      .selectDistinct({
        studentId: sectionRosterTable.studentId,
        teacherStaffId: classSectionsTable.teacherStaffId,
        courseName: classSectionsTable.courseName,
      })
      .from(sectionRosterTable)
      .innerJoin(
        classSectionsTable,
        eq(classSectionsTable.id, sectionRosterTable.sectionId),
      )
      // Filter on BOTH sides of the join — the planStudentIds array
      // is school-scoped already, but adding sectionRosterTable.schoolId
      // lets the planner use the (school_id, student_id) index when
      // it's available and prevents any cross-school leak in the
      // (extremely unlikely) case of a student id collision across
      // tenants.
      .where(
        and(
          eq(sectionRosterTable.schoolId, schoolId),
          eq(classSectionsTable.schoolId, schoolId),
          inArray(sectionRosterTable.studentId, planStudentIds),
        ),
      );
    for (const r of sectionRows) {
      const key = `${r.studentId}::${r.teacherStaffId}`;
      if (!subjectByStudentTeacher.has(key)) {
        subjectByStudentTeacher.set(key, r.courseName);
      }
    }
  }
  const perSubjectMap = new Map<
    string,
    { t2Completed: number; t2Expected: number }
  >();
  // Per-subject — per-week obligation.
  for (const wk of schoolWeeks) {
    const wkEnd = addDays(wk, 4);
    for (const p of tier2Plans) {
      const openedDay = isoDate(p.openedAt);
      if (openedDay > wkEnd) continue;
      if (p.closedAt && isoDate(p.closedAt) < wk) continue;
      const tids = effectivePlanTeachers.get(p.id) ?? [];
      for (const tid of tids) {
        if (teacherStaffId && tid !== teacherStaffId) continue;
        const subj =
          subjectByStudentTeacher.get(`${p.studentId}::${tid}`) ??
          "(non-classroom support)";
        let slot = perSubjectMap.get(subj);
        if (!slot) {
          slot = { t2Completed: 0, t2Expected: 0 };
          perSubjectMap.set(subj, slot);
        }
        slot.t2Expected += 1;
        const key = `${p.studentId}::${tid}::${p.interventionSubType ?? ""}::${wk}`;
        if (t2HasByWeek.has(key)) slot.t2Completed += 1;
      }
    }
  }
  const perSubject = Array.from(perSubjectMap.entries())
    .map(([courseName, v]) => ({
      courseName,
      t2Completed: v.t2Completed,
      t2Expected: v.t2Expected,
      t2CompletionPct:
        v.t2Expected > 0
          ? Math.round((v.t2Completed / v.t2Expected) * 1000) / 10
          : null,
    }))
    .sort((a, b) => a.courseName.localeCompare(b.courseName));

  // ---- dayOfWeek (T2 only) ----
  // Under weekly cadence, the per-day "expected" denominator no longer
  // makes sense (each plan owes one entry per week, not per day). So
  // this panel now shows the DISTRIBUTION of which weekday teachers
  // actually logged their weekly check-in on. Total across all 5 days
  // = number of completed weekly entries. Apply the teacher filter
  // by re-deriving from the entry list when one is set.
  let dowFilteredCount = t2DowCount;
  if (teacherStaffId) {
    dowFilteredCount = new Map();
    for (const e of t2Entries) {
      if (e.teacherStaffId !== teacherStaffId) continue;
      const dow = dayOfWeek(e.entryDate);
      if (dow >= 1 && dow <= 5) {
        dowFilteredCount.set(dow, (dowFilteredCount.get(dow) ?? 0) + 1);
      }
    }
  }
  const dowLabels = ["", "Mon", "Tue", "Wed", "Thu", "Fri"];
  const dowTotal = Array.from({ length: 5 }, (_, i) => i + 1).reduce(
    (sum, d) => sum + (dowFilteredCount.get(d) ?? 0),
    0,
  );
  const dayOfWeekOut = Array.from({ length: 5 }, (_, i) => i + 1).map(
    (dow) => {
      const completed = dowFilteredCount.get(dow) ?? 0;
      return {
        dow,
        label: dowLabels[dow] ?? String(dow),
        t2Completed: completed,
        // Kept for client wire compat; under weekly cadence we now
        // expose a "% of weekly entries logged on this day" via
        // t2CompletionPct so the bar chart can stay the same shape.
        t2Expected: dowTotal,
        t2CompletionPct:
          dowTotal > 0 ? Math.round((completed / dowTotal) * 1000) / 10 : null,
      };
    },
  );

  // ---- t3GoalTrend (weekly avg score for T3 plans) ----
  // Same teacher-filter behavior as the weekly trend above so the
  // two T3 lines tell the same story when the user picks one
  // teacher.
  const t3WeekMap = new Map<
    string,
    { sum: number; count: number }
  >();
  for (const r of t3Records) {
    if (teacherStaffId && r.teacherStaffId !== teacherStaffId) continue;
    if (!allowedT3Pairs.has(`${r.studentId}::${r.teacherStaffId}`)) continue;
    let slot = t3WeekMap.get(r.weekStartDate);
    if (!slot) {
      slot = { sum: 0, count: 0 };
      t3WeekMap.set(r.weekStartDate, slot);
    }
    const days: Array<number | null> = [
      r.monScore,
      r.tueScore,
      r.wedScore,
      r.thuScore,
      r.friScore,
    ];
    for (const s of days) {
      if (s != null) {
        slot.sum += s;
        slot.count += 1;
      }
    }
  }
  const t3GoalTrend = Array.from(t3WeekMap.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([weekStartDate, v]) => ({
      weekStartDate,
      avgScore:
        v.count > 0 ? Math.round((v.sum / v.count) * 100) / 100 : null,
      scoredCount: v.count,
    }));

  // ---- t3DayOfWeek (best/worst weekday by avg score) ----
  // Average daily score (1..5) grouped by weekday across every T3
  // record. Mirrors the Tier-2 day-of-week card but measures the
  // outcome score rather than whether a teacher logged. Honors the
  // same single-teacher filter as the trends above.
  const t3DowAgg = new Map<number, { sum: number; count: number }>();
  for (const r of t3Records) {
    if (teacherStaffId && r.teacherStaffId !== teacherStaffId) continue;
    if (!allowedT3Pairs.has(`${r.studentId}::${r.teacherStaffId}`)) continue;
    const days: Array<number | null> = [
      r.monScore,
      r.tueScore,
      r.wedScore,
      r.thuScore,
      r.friScore,
    ];
    days.forEach((s, i) => {
      if (s == null) return;
      const dow = i + 1;
      let slot = t3DowAgg.get(dow);
      if (!slot) {
        slot = { sum: 0, count: 0 };
        t3DowAgg.set(dow, slot);
      }
      slot.sum += s;
      slot.count += 1;
    });
  }
  const t3DayOfWeek = Array.from({ length: 5 }, (_, i) => i + 1).map((dow) => {
    const slot = t3DowAgg.get(dow);
    return {
      dow,
      label: dowLabels[dow] ?? String(dow),
      avgScore:
        slot && slot.count > 0
          ? Math.round((slot.sum / slot.count) * 100) / 100
          : null,
      scoredCount: slot?.count ?? 0,
    };
  });

  // ---- planMeta (per-plan view) ----
  let planMeta: SummaryResponse["planMeta"] = null;
  if (planId != null && plans.length === 1) {
    const p = plans[0]!;
    const s = studentMap.get(p.studentId);
    const effIds = effectivePlanTeachers.get(p.id) ?? [];
    const effNameRows =
      effIds.length === 0
        ? []
        : await db
            .select({
              id: staffTable.id,
              displayName: staffTable.displayName,
            })
            .from(staffTable)
            .where(inArray(staffTable.id, effIds));
    planMeta = {
      id: p.id,
      studentId: p.studentId,
      studentName: s ? `${s.firstName} ${s.lastName}` : p.studentId,
      grade: s ? String(s.grade) : null,
      tier: p.tier,
      subType: p.interventionSubType,
      fastSubject: p.fastSubject,
      subjectLabel: subjectLabel(p.fastSubject),
      academicMinutesTarget: p.fastSubject ? p.academicMinutesTarget : null,
      title: p.title,
      goals: p.goals,
      openedAt: p.openedAt.toISOString(),
      closedAt: p.closedAt ? p.closedAt.toISOString() : null,
      autoAssignScheduleTeachers: p.autoAssignScheduleTeachers,
      effectiveTeachers: effNameRows.map((t) => ({
        id: t.id,
        displayName: t.displayName,
      })),
    };
  }

  // ---- studentPlans (per-plan view: drives the Tier 2 / Tier 3 tabs) ----
  // Hand back every plan for this student so the client can enable/grey
  // each tier tab and swap which plan it loads when the user switches
  // tier. Sorted most-recent-first.
  let studentPlans: SummaryResponse["studentPlans"] = null;
  if (planId != null && planMeta) {
    const planRows = await db
      .select({
        id: studentMtssPlansTable.id,
        tier: studentMtssPlansTable.tier,
        title: studentMtssPlansTable.title,
        subType: studentMtssPlansTable.interventionSubType,
        fastSubject: studentMtssPlansTable.fastSubject,
        openedAt: studentMtssPlansTable.openedAt,
        closedAt: studentMtssPlansTable.closedAt,
      })
      .from(studentMtssPlansTable)
      .where(
        and(
          eq(studentMtssPlansTable.schoolId, schoolId),
          eq(studentMtssPlansTable.studentId, planMeta.studentId),
        ),
      );
    studentPlans = planRows
      .map((r) => ({
        id: r.id,
        tier: r.tier,
        title: r.title,
        subType: r.subType,
        fastSubject: r.fastSubject,
        subjectLabel: subjectLabel(r.fastSubject),
        openedAt: r.openedAt.toISOString(),
        closedAt: r.closedAt ? r.closedAt.toISOString() : null,
      }))
      .sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1));
  }

  const out: SummaryResponse = {
    rangeStart,
    rangeEnd,
    schoolDayCount,
    plansIncluded: plans.length,
    filters: {
      range,
      planId,
      tier,
      subType,
      grade,
      teacherStaffId,
      planType,
      academicSubject,
    },
    planMeta,
    weeklyTrend,
    perTeacher,
    perSubject,
    dayOfWeek: dayOfWeekOut,
    t3GoalTrend,
    t3DayOfWeek,
    t3Academic,
    studentPlans,
  };
  res.json(out);
});

export default router;
