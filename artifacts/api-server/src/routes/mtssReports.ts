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

interface PlanRow {
  id: number;
  schoolId: number;
  studentId: string;
  tier: number;
  interventionSubType: string | null;
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
  };
  planMeta: {
    id: number;
    studentId: string;
    studentName: string;
    grade: string | null;
    tier: number;
    subType: string | null;
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
    t2Completed: number;
    t2Expected: number;
    t2CompletionPct: number | null;
    t3ScoredCount: number;
    t3AvgScore: number | null;
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

  // ---- build lookup keyed maps ----
  // T2 entry presence keyed by (studentId, teacherId, subType, date).
  const t2Has = new Set<string>();
  for (const e of t2Entries) {
    t2Has.add(
      `${e.studentId}::${e.teacherStaffId}::${e.subType ?? ""}::${e.entryDate}`,
    );
  }

  // ---- compute schoolDayCount ----
  const schoolDays = weekdayRange(rangeStart, rangeEnd);
  const schoolDayCount = schoolDays.length;

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

  // T2 expected/completed by week.
  for (const day of schoolDays) {
    const wk = mondayOf(day);
    for (const p of tier2Plans) {
      // Plans contribute to expected only on/after openedAt and
      // before closedAt (or forever, if still active).
      const openedDay = isoDate(p.openedAt);
      if (day < openedDay) continue;
      if (p.closedAt && day > isoDate(p.closedAt)) continue;
      const tids = effectivePlanTeachers.get(p.id) ?? [];
      const filteredTids = teacherStaffId
        ? tids.filter((id) => id === teacherStaffId)
        : tids;
      for (const tid of filteredTids) {
        const slot = bumpWeek(wk);
        slot.t2Expected += 1;
        const key = `${p.studentId}::${tid}::${p.interventionSubType ?? ""}::${day}`;
        if (t2Has.has(key)) slot.t2Completed += 1;
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
  // T2.
  for (const day of schoolDays) {
    for (const p of tier2Plans) {
      const openedDay = isoDate(p.openedAt);
      if (day < openedDay) continue;
      if (p.closedAt && day > isoDate(p.closedAt)) continue;
      const tids = effectivePlanTeachers.get(p.id) ?? [];
      for (const tid of tids) {
        if (teacherStaffId && tid !== teacherStaffId) continue;
        const slot = teacherSlot(tid);
        slot.t2Expected += 1;
        const key = `${p.studentId}::${tid}::${p.interventionSubType ?? ""}::${day}`;
        if (t2Has.has(key)) slot.t2Completed += 1;
      }
    }
  }
  // T3.
  for (const r of t3Records) {
    if (teacherStaffId && r.teacherStaffId !== teacherStaffId) continue;
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
  const perTeacher = Array.from(perTeacherMap.entries())
    .map(([id, v]) => ({
      teacherStaffId: id,
      teacherName: teacherNameMap.get(id) ?? `Staff #${id}`,
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
    }))
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
  for (const day of schoolDays) {
    for (const p of tier2Plans) {
      const openedDay = isoDate(p.openedAt);
      if (day < openedDay) continue;
      if (p.closedAt && day > isoDate(p.closedAt)) continue;
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
        const key = `${p.studentId}::${tid}::${p.interventionSubType ?? ""}::${day}`;
        if (t2Has.has(key)) slot.t2Completed += 1;
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
  const dowMap = new Map<
    number,
    { t2Completed: number; t2Expected: number }
  >();
  for (let i = 1; i <= 5; i += 1) {
    dowMap.set(i, { t2Completed: 0, t2Expected: 0 });
  }
  for (const day of schoolDays) {
    const dow = dayOfWeek(day);
    if (dow < 1 || dow > 5) continue;
    for (const p of tier2Plans) {
      const openedDay = isoDate(p.openedAt);
      if (day < openedDay) continue;
      if (p.closedAt && day > isoDate(p.closedAt)) continue;
      const tids = effectivePlanTeachers.get(p.id) ?? [];
      for (const tid of tids) {
        if (teacherStaffId && tid !== teacherStaffId) continue;
        const slot = dowMap.get(dow)!;
        slot.t2Expected += 1;
        const key = `${p.studentId}::${tid}::${p.interventionSubType ?? ""}::${day}`;
        if (t2Has.has(key)) slot.t2Completed += 1;
      }
    }
  }
  const dowLabels = ["", "Mon", "Tue", "Wed", "Thu", "Fri"];
  const dayOfWeekOut = Array.from(dowMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([dow, v]) => ({
      dow,
      label: dowLabels[dow] ?? String(dow),
      t2Completed: v.t2Completed,
      t2Expected: v.t2Expected,
      t2CompletionPct:
        v.t2Expected > 0
          ? Math.round((v.t2Completed / v.t2Expected) * 1000) / 10
          : null,
    }));

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
    },
    planMeta,
    weeklyTrend,
    perTeacher,
    perSubject,
    dayOfWeek: dayOfWeekOut,
    t3GoalTrend,
  };
  res.json(out);
});

export default router;
