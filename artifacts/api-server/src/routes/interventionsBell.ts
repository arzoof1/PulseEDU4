// "What interventions do I owe today?" + completion report.
//
// NOTE: Tier 2 cadence is now WEEKLY (one entry per student-teacher per
// Mon-Fri week). The endpoint name is kept for backward compatibility
// but "owed today" really means "still owed by end of this week".
//
// Routes:
//   GET /api/interventions/owed-today
//      Returns the per-student rows the *current teacher* still has to
//      submit this week (Tier 2 weekly + Tier 3 weekly). Empty array
//      when there's nothing owed; the bell hides itself in that state.
//      Core Team callers always get an empty list — they do not see
//      the bell.
//
//   GET /api/interventions/completion-report?weekStartDate=YYYY-MM-DD
//      Core-Team-only. Returns roster of all students with active Tier 2
//      or Tier 3 plans plus a per-teacher completion grid for the given
//      week (defaults to the current week's Monday). Used by the new
//      "Intervention Reports" tile in the MTSS hub.
//
// School-local time: we compute today + Monday-of-this-week from the
// server's current Date but format as plain "YYYY-MM-DD" strings so the
// comparisons line up with the text columns on tier2 / tier3 tables.
import { Router, type IRouter } from "express";
import {
  db,
  staffTable,
  studentsTable,
  studentMtssPlansTable,
  tier2InterventionEntriesTable,
  tier3WeeklyRecordsTable,
} from "@workspace/db";
import { and, eq, sql, inArray } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam } from "../lib/coreTeam.js";
import { loadScheduleTeacherIdsForStudents } from "../lib/effectiveTeachers.js";
import {
  isAcademicTier3,
  sumAcademicMinutes,
  academicWeekState,
  academicStartMonday,
  enumerateWeeks,
  type AcademicWeekState,
} from "../lib/academicMinutes.js";

const router: IRouter = Router();

// Status of one academic Tier 3 plan, for one teacher, for one week.
export interface AcademicWeekStatus {
  weekStartDate: string;
  minutes: number;
  target: number;
  released: boolean;
  releaseReason: string | null;
  releasedAt: string | null;
  state: AcademicWeekState;
}

// Compute the academic-minutes status for one teacher on one academic
// Tier 3 plan, for every week from the plan's start (floored at the rework
// ship date) through `currentMonday`. Shared by the bell (/owed-today),
// the weekly form's week selector, and the roster pill so all three agree
// on met / owed / excused. One DB round-trip per call.
export async function computeAcademicWeeksForTeacher(
  schoolId: number,
  staffId: number,
  plan: {
    studentId: string;
    openedAt: Date | null;
    academicMinutesTarget: number;
  },
  currentMonday: string,
): Promise<AcademicWeekStatus[]> {
  const openedLocal = plan.openedAt
    ? plan.openedAt.toLocaleDateString("en-CA", { timeZone: SCHOOL_TZ })
    : currentMonday;
  const startMonday = academicStartMonday(mondayOf(openedLocal));
  const weeks = enumerateWeeks(startMonday, currentMonday);
  if (weeks.length === 0) return [];
  const records = await db
    .select()
    .from(tier3WeeklyRecordsTable)
    .where(
      and(
        eq(tier3WeeklyRecordsTable.schoolId, schoolId),
        eq(tier3WeeklyRecordsTable.teacherStaffId, staffId),
        eq(tier3WeeklyRecordsTable.studentId, plan.studentId),
        inArray(tier3WeeklyRecordsTable.weekStartDate, weeks),
      ),
    );
  const byWeek = new Map(records.map((r) => [r.weekStartDate, r]));
  const target = plan.academicMinutesTarget;
  return weeks.map((wk) => {
    const rec = byWeek.get(wk);
    const minutes = sumAcademicMinutes(rec?.academicMinutes);
    const released = Boolean(rec?.releasedNoIntervention);
    return {
      weekStartDate: wk,
      minutes,
      target,
      released,
      releaseReason: rec?.releaseReason ?? null,
      releasedAt: rec?.releasedAt ? rec.releasedAt.toISOString() : null,
      state: academicWeekState(minutes, target, released),
    };
  });
}

async function loadStaff(
  req: import("express").Request,
  res: import("express").Response,
) {
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

// Today, in school-local terms (America/New_York). Using `toISOString()`
// would shift the date forward by one once the server clock crosses
// midnight UTC (~7-8pm EST), so a teacher logging at 8pm would see
// tomorrow's bell rows. PulseEDU is single-state Florida for now, so
// the en-CA locale gives a reliable yyyy-mm-dd string in NY time.
const SCHOOL_TZ = "America/New_York";
function todayStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: SCHOOL_TZ });
}

// Day-of-week in school-local terms — used for "Tier 3 — Mon" etc.
// Returns 0=Sun..6=Sat to match getUTCDay()/getDay().
function todayDowLocal(): number {
  const wd = new Date().toLocaleDateString("en-US", {
    timeZone: SCHOOL_TZ,
    weekday: "short",
  });
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
}

// Monday-of-the-week containing `localDateStr` (YYYY-MM-DD already in
// school-local terms — pass `todayStr()`). Sunday is treated as part
// of the PRIOR Mon-Sun week (shift = -6) so weekend visits to the
// bell or completion-report still show the week the user just lived
// through. This matches the convention in `mtssReports.ts`.
//
// Crucially we do NOT use UTC `new Date()` here — that would roll the
// effective day forward one between ~7pm ET (UTC midnight) and
// midnight ET, shifting the week boundary on Friday/Saturday/Sunday
// evenings.
function mondayOf(localDateStr: string): string {
  const d = new Date(`${localDateStr}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0 Sun..6 Sat
  const shift = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + shift);
  return d.toISOString().slice(0, 10);
}

function parseTeacherCsv(csv: string): number[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}

// Resolve "who is responsible for this plan today?" using the new toggle
// model: schedule teachers (live) ∪ additional interventionists, minus
// excluded teachers. Falls back to the legacy assignedTeacherIds CSV
// when the plan is in manual mode (autoAssignScheduleTeachers=false).
function resolveEffectiveTeachers(
  plan: {
    autoAssignScheduleTeachers: boolean;
    assignedTeacherIds: string;
    excludedTeacherIds: string;
    additionalInterventionistIds: string;
  },
  scheduleIds: number[],
): number[] {
  if (!plan.autoAssignScheduleTeachers) {
    return parseTeacherCsv(plan.assignedTeacherIds);
  }
  const excluded = new Set(parseTeacherCsv(plan.excludedTeacherIds));
  const additional = parseTeacherCsv(plan.additionalInterventionistIds);
  const out = new Set<number>();
  for (const t of scheduleIds) if (!excluded.has(t)) out.add(t);
  for (const t of additional) if (!excluded.has(t)) out.add(t);
  return Array.from(out);
}

// ---- shared Tier 3 "behind this week" math ----
// Both the bell (/owed-today) and the Teacher Roster pill status
// (/my-tier3-status) measure "how many scheduled check-ins is this
// teacher missing so far this week?" the SAME way, so the two surfaces
// never disagree. The day-scoring rule lives in ONE place here.
const T3_DAY_KEYS = ["mon", "tue", "wed", "thu", "fri"] as const;

// How far into the Mon-Fri week we've reached, as a 0..4 index. On
// weekends the full week (idx 4) is owed.
function reachedDayIdx(): number {
  const dow = todayDowLocal();
  return dow === 0 ? 4 : dow >= 6 ? 4 : Math.max(0, dow - 1);
}

// Count the scheduled-but-unscored days for a Tier 3 plan up to today.
// Academic Tier 3 plans only meet on configured days; behavior plans
// (meetingDays null) require all 5 weekdays. Days the teacher marked
// the student absent don't count as missing.
function tier3MissingDayCount(
  plan: { meetingDays: string | null },
  rec:
    | {
        monScore: number | null;
        tueScore: number | null;
        wedScore: number | null;
        thuScore: number | null;
        friScore: number | null;
        absentDays?: unknown;
      }
    | undefined,
  reachedIdx: number,
): number {
  const dayScores = rec
    ? [rec.monScore, rec.tueScore, rec.wedScore, rec.thuScore, rec.friScore]
    : [null, null, null, null, null];
  const absent = (rec?.absentDays ?? {}) as Record<string, boolean>;
  const meetingSet = plan.meetingDays
    ? new Set(
        plan.meetingDays
          .split(",")
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean),
      )
    : null;
  let missing = 0;
  for (let i = 0; i <= reachedIdx; i++) {
    if (meetingSet && !meetingSet.has(T3_DAY_KEYS[i])) continue;
    if (absent[T3_DAY_KEYS[i]]) continue;
    if (dayScores[i] === null || dayScores[i] === undefined) missing++;
  }
  return missing;
}

interface Tier3StatusRow {
  studentId: string;
  studentName: string;
  grade: string | null;
  // The student's most-recent active Tier 3 plan id (for callers that
  // want to deep-link). When a student has more than one active Tier 3
  // plan (shouldn't, but defended for), this is the highest id.
  planId: number;
  weekStartDate: string;
  // Missing scheduled meeting days this week. The weekly record is keyed
  // by (student, teacher, week) — NOT by plan — so when a student
  // carries multiple active Tier 3 plans we take the MAX owed across
  // them rather than summing (summing would double-count the shared
  // record's already-scored days).
  missingDayCount: number;
}

// Resolve EVERY active Tier 3 plan the given teacher is an
// interventionist on this week, with each plan's missing-day count
// (which may be 0 when caught up). The Teacher Roster pill uses this:
// membership tells it the teacher is an interventionist (so the pill is
// actionable), and missingDayCount > 0 drives the "behind" badge.
async function computeTier3StatusForTeacher(
  schoolId: number,
  staffId: number,
): Promise<{ weekStartDate: string; rows: Tier3StatusRow[] }> {
  const weekStartDate = mondayOf(todayStr());

  const allPlans = await db
    .select()
    .from(studentMtssPlansTable)
    .where(
      and(
        eq(studentMtssPlansTable.schoolId, schoolId),
        sql`${studentMtssPlansTable.closedAt} IS NULL`,
      ),
    );
  const planStudentIds = Array.from(
    new Set(allPlans.map((p) => p.studentId)),
  );
  const scheduleByStudent = await loadScheduleTeacherIdsForStudents(
    schoolId,
    planStudentIds,
  );
  const tier3Plans = allPlans.filter(
    (p) =>
      p.tier === 3 &&
      resolveEffectiveTeachers(
        p,
        scheduleByStudent.get(p.studentId) ?? [],
      ).includes(staffId),
  );
  if (tier3Plans.length === 0) return { weekStartDate, rows: [] };

  const studentIdsT3 = Array.from(
    new Set(tier3Plans.map((p) => p.studentId)),
  );
  const studentRows = await db
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
        inArray(studentsTable.studentId, studentIdsT3),
      ),
    );
  const studentMap = new Map(studentRows.map((s) => [s.studentId, s]));

  const records = await db
    .select()
    .from(tier3WeeklyRecordsTable)
    .where(
      and(
        eq(tier3WeeklyRecordsTable.schoolId, schoolId),
        eq(tier3WeeklyRecordsTable.teacherStaffId, staffId),
        eq(tier3WeeklyRecordsTable.weekStartDate, weekStartDate),
        inArray(tier3WeeklyRecordsTable.studentId, studentIdsT3),
      ),
    );
  const recordByStudent = new Map(records.map((r) => [r.studentId, r]));

  const reachedIdx = reachedDayIdx();
  // Collapse to one row per student. A student normally has a single
  // active Tier 3 plan, but if they carry more than one we keep the MAX
  // owed days (the weekly record is per student/teacher/week, so summing
  // would double-count) and the highest plan id.
  const byStudent = new Map<string, Tier3StatusRow>();
  for (const p of tier3Plans) {
    const rec = recordByStudent.get(p.studentId);
    // Academic Tier 3 is minutes-based: the pill is "behind" when this
    // week's logged minutes are under target and the week isn't released.
    // (The bell carries any prior-week backlog; the roster pill mirrors
    // behavior plans and stays scoped to the current week.)
    const missing = isAcademicTier3(p)
      ? Boolean(rec?.releasedNoIntervention) ||
        sumAcademicMinutes(rec?.academicMinutes) >= p.academicMinutesTarget
        ? 0
        : 1
      : tier3MissingDayCount(p, rec, reachedIdx);
    const existing = byStudent.get(p.studentId);
    if (existing) {
      existing.missingDayCount = Math.max(existing.missingDayCount, missing);
      existing.planId = Math.max(existing.planId, p.id);
      continue;
    }
    const s = studentMap.get(p.studentId);
    byStudent.set(p.studentId, {
      studentId: p.studentId,
      studentName: s ? `${s.firstName} ${s.lastName}` : p.studentId,
      grade: s ? String(s.grade) : null,
      planId: p.id,
      weekStartDate,
      missingDayCount: missing,
    });
  }
  return { weekStartDate, rows: Array.from(byStudent.values()) };
}

// =================================================================
// OWED-TODAY
// =================================================================
router.get("/interventions/owed-today", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const todayDate = todayStr();
  // Core Team and SuperUser do not see the bell.
  if (isCoreTeam(staff)) {
    res.json({
      tier2: [],
      tier3: [],
      todayDate,
      weekStartDate: mondayOf(todayDate),
      visible: false,
    });
    return;
  }

  const weekStartDate = mondayOf(todayDate);

  // Pull every active plan in this school, then resolve each to its
  // effective teacher list (live schedule ∪ additional interventionists,
  // minus excluded). Filter to plans that name THIS teacher in the
  // effective list. We batch the schedule lookup to one query.
  const allPlans = await db
    .select()
    .from(studentMtssPlansTable)
    .where(
      and(
        eq(studentMtssPlansTable.schoolId, schoolId),
        sql`${studentMtssPlansTable.closedAt} IS NULL`,
      ),
    );
  const planStudentIds = Array.from(
    new Set(allPlans.map((p) => p.studentId)),
  );
  const scheduleByStudent = await loadScheduleTeacherIdsForStudents(
    schoolId,
    planStudentIds,
  );
  const myPlans = allPlans.filter((p) =>
    resolveEffectiveTeachers(
      p,
      scheduleByStudent.get(p.studentId) ?? [],
    ).includes(staff.id),
  );

  // Academic plans (fastSubject set) are driven by the student's
  // intensive class, not by teacher check-ins. A LIGHT Tier 2 academic
  // plan therefore never owes a weekly bell entry; only academic Tier 3
  // (with configured meeting days) generates per-meeting-day check-ins.
  const tier2Plans = myPlans.filter((p) => p.tier === 2 && !p.fastSubject);
  const tier3Plans = myPlans.filter((p) => p.tier === 3);

  // Lookup student names for any owed rows in one round-trip.
  const allStudentIds = Array.from(
    new Set([
      ...tier2Plans.map((p) => p.studentId),
      ...tier3Plans.map((p) => p.studentId),
    ]),
  );
  const studentRows =
    allStudentIds.length === 0
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
              inArray(studentsTable.studentId, allStudentIds),
            ),
          );
  const studentMap = new Map(studentRows.map((s) => [s.studentId, s]));

  // ----- Tier 2 (weekly) -----
  // One entry per (student, teacher) per Mon-Fri week. Show "owed"
  // until the teacher logs at least one matching entry anywhere in the
  // current week (we keep the bell visible on the weekend too — the
  // teacher might still be wrapping up the week's documentation).
  const weekDayDates: string[] = [];
  {
    const ws = new Date(`${weekStartDate}T00:00:00.000Z`);
    for (let i = 0; i < 5; i++) {
      const d = new Date(ws);
      d.setUTCDate(d.getUTCDate() + i);
      weekDayDates.push(d.toISOString().slice(0, 10));
    }
  }
  let tier2Owed: Array<{
    studentId: string;
    studentName: string;
    grade: string | null;
    subType: string | null;
    planId: number;
  }> = [];
  if (tier2Plans.length > 0) {
    const studentIdsT2 = tier2Plans.map((p) => p.studentId);
    const submitted = await db
      .select({
        studentId: tier2InterventionEntriesTable.studentId,
        subType: tier2InterventionEntriesTable.subType,
      })
      .from(tier2InterventionEntriesTable)
      .where(
        and(
          eq(tier2InterventionEntriesTable.schoolId, schoolId),
          eq(tier2InterventionEntriesTable.teacherStaffId, staff.id),
          inArray(tier2InterventionEntriesTable.entryDate, weekDayDates),
          inArray(tier2InterventionEntriesTable.studentId, studentIdsT2),
        ),
      );
    // Key by (studentId, subType) so a teacher who logged a CICO
    // entry for a student doesn't accidentally clear that same
    // student's check-and-connect (or other-subtype) owed row.
    const doneIds = new Set(
      submitted.map((r) => `${r.studentId}::${r.subType ?? ""}`),
    );
    tier2Owed = tier2Plans
      .filter(
        (p) => !doneIds.has(`${p.studentId}::${p.interventionSubType ?? ""}`),
      )
      .map((p) => {
        const s = studentMap.get(p.studentId);
        return {
          studentId: p.studentId,
          studentName: s ? `${s.firstName} ${s.lastName}` : p.studentId,
          grade: s ? String(s.grade) : null,
          subType: p.interventionSubType,
          planId: p.id,
        };
      });
  }

  // ----- Tier 3 (weekly) -----
  // Behavior Tier 3 is owed when the teacher hasn't scored today's
  // day-of-week yet (one "todo" per student-week). Academic Tier 3 is a
  // minutes-based small group: it's owed when the week's logged minutes
  // are below target AND the week hasn't been released — surfaced for the
  // current week AND every still-unresolved prior week (floored at the
  // rework ship date), each deep-linking to its own week.
  const behaviorT3Plans = tier3Plans.filter((p) => !isAcademicTier3(p));
  const academicT3Plans = tier3Plans.filter((p) => isAcademicTier3(p));
  let tier3Owed: Array<{
    studentId: string;
    studentName: string;
    grade: string | null;
    planId: number;
    weekStartDate: string;
    missingDayCount: number;
    kind: "behavior" | "academic";
    minutesLogged?: number;
    minutesTarget?: number;
  }> = [];

  // Behavior Tier 3 — current week per-day scoring.
  if (behaviorT3Plans.length > 0) {
    const studentIdsT3 = behaviorT3Plans.map((p) => p.studentId);
    const records = await db
      .select()
      .from(tier3WeeklyRecordsTable)
      .where(
        and(
          eq(tier3WeeklyRecordsTable.schoolId, schoolId),
          eq(tier3WeeklyRecordsTable.teacherStaffId, staff.id),
          eq(tier3WeeklyRecordsTable.weekStartDate, weekStartDate),
          inArray(tier3WeeklyRecordsTable.studentId, studentIdsT3),
        ),
      );
    const recordByStudent = new Map(records.map((r) => [r.studentId, r]));

    // Day-of-week we've reached so far this week. Mon=0..Fri=4. On
    // weekends we still surface Tier 3 because the full week is owed.
    // The per-plan missing-day math lives in the shared
    // `tier3MissingDayCount` helper so the bell and the Teacher Roster
    // pill status never disagree about what "behind this week" means.
    const reachedIdx = reachedDayIdx();

    for (const p of behaviorT3Plans) {
      const rec = recordByStudent.get(p.studentId);
      const missing = tier3MissingDayCount(p, rec, reachedIdx);
      if (missing > 0) {
        const s = studentMap.get(p.studentId);
        tier3Owed.push({
          studentId: p.studentId,
          studentName: s ? `${s.firstName} ${s.lastName}` : p.studentId,
          grade: s ? String(s.grade) : null,
          planId: p.id,
          weekStartDate,
          missingDayCount: missing,
          kind: "behavior",
        });
      }
    }
  }

  // Academic Tier 3 — minutes per week, with prior-week backlog.
  for (const p of academicT3Plans) {
    const weeks = await computeAcademicWeeksForTeacher(
      schoolId,
      staff.id,
      p,
      weekStartDate,
    );
    const s = studentMap.get(p.studentId);
    for (const wk of weeks) {
      if (wk.state !== "owed") continue;
      tier3Owed.push({
        studentId: p.studentId,
        studentName: s ? `${s.firstName} ${s.lastName}` : p.studentId,
        grade: s ? String(s.grade) : null,
        planId: p.id,
        weekStartDate: wk.weekStartDate,
        missingDayCount: 0,
        kind: "academic",
        minutesLogged: wk.minutes,
        minutesTarget: wk.target,
      });
    }
  }

  res.json({
    tier2: tier2Owed,
    tier3: tier3Owed,
    todayDate,
    weekStartDate,
    visible: tier2Owed.length + tier3Owed.length > 0,
  });
});

// =================================================================
// MY TIER 3 STATUS
// =================================================================
// Powers the Teacher Roster Tier 3 pill shortcut. Returns EVERY active
// Tier 3 plan the signed-in teacher is an interventionist on (including
// caught-up ones, missingDayCount 0) so the roster can decide which
// pills are actionable and which show a "behind this week" badge.
// Core Team callers get an empty list — like the bell, this is a
// personal-obligation surface, so when Core Team views another
// teacher's roster the pills stay informational.
router.get("/interventions/my-tier3-status", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (isCoreTeam(staff)) {
    res.json({ weekStartDate: mondayOf(todayStr()), students: [] });
    return;
  }
  const { weekStartDate, rows } = await computeTier3StatusForTeacher(
    schoolId,
    staff.id,
  );
  res.json({ weekStartDate, students: rows });
});

// =================================================================
// COMPLETION REPORT
// =================================================================
router.get("/interventions/completion-report", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  if (!isCoreTeam(staff)) {
    res.status(403).json({ error: "Core Team only" });
    return;
  }

  const week =
    typeof req.query.weekStartDate === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(req.query.weekStartDate)
      ? req.query.weekStartDate
      : mondayOf(todayStr());

  // Active plans this school for any tier >= 2.
  const plans = await db
    .select()
    .from(studentMtssPlansTable)
    .where(
      and(
        eq(studentMtssPlansTable.schoolId, schoolId),
        sql`${studentMtssPlansTable.closedAt} IS NULL`,
        sql`${studentMtssPlansTable.tier} >= 2`,
      ),
    );

  // Hydrate students.
  const studentIds = Array.from(new Set(plans.map((p) => p.studentId)));
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

  // Pull all entries / records that touch this week so we can compute
  // per-(student, teacher) completion in one pass.
  // For Tier 2 we count how many *school-day dates* M-F of `week` each
  // (student, teacher) submitted — 5 max.
  const weekStart = new Date(week + "T00:00:00.000Z");
  const dayDates: string[] = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(weekStart);
    d.setUTCDate(d.getUTCDate() + i);
    dayDates.push(d.toISOString().slice(0, 10));
  }
  const tier2Entries =
    studentIds.length === 0
      ? []
      : await db
          .select()
          .from(tier2InterventionEntriesTable)
          .where(
            and(
              eq(tier2InterventionEntriesTable.schoolId, schoolId),
              inArray(
                tier2InterventionEntriesTable.studentId,
                studentIds,
              ),
              inArray(
                tier2InterventionEntriesTable.entryDate,
                dayDates,
              ),
            ),
          );
  const tier3Records =
    studentIds.length === 0
      ? []
      : await db
          .select()
          .from(tier3WeeklyRecordsTable)
          .where(
            and(
              eq(tier3WeeklyRecordsTable.schoolId, schoolId),
              inArray(tier3WeeklyRecordsTable.studentId, studentIds),
              eq(tier3WeeklyRecordsTable.weekStartDate, week),
            ),
          );

  // Resolve the EFFECTIVE teacher list per plan (live schedule ∪
  // additional interventionists − excluded). Then UNION-in any teacher
  // who has actually logged a Tier 2 entry or Tier 3 record for this
  // student in the report week so historical contributions still show
  // up even if the staffer is no longer on the schedule.
  const planScheduleByStudent = await loadScheduleTeacherIdsForStudents(
    schoolId,
    studentIds,
  );
  // Plan-scope the historic UNION as much as the schema allows. T2
  // entries carry their own `sub_type`, so we key by
  // (studentId, subType) — that disambiguates two T2 plans for the
  // same student that happen to use different subtypes (e.g. CICO vs
  // check-and-connect). T3 has no such discriminator on the entry
  // row; concurrent T3 plans for one student are rare in practice
  // (T3 is intensive 1:1) so we accept the over-inclusion risk and
  // key by (studentId, tier=3) only.
  const t2HistoricByStudentSubType = new Map<string, Set<number>>();
  for (const e of tier2Entries) {
    const key = `${e.studentId}::${e.subType ?? ""}`;
    const set = t2HistoricByStudentSubType.get(key) ?? new Set<number>();
    set.add(e.teacherStaffId);
    t2HistoricByStudentSubType.set(key, set);
  }
  const t3HistoricByStudent = new Map<string, Set<number>>();
  for (const r of tier3Records) {
    const set = t3HistoricByStudent.get(r.studentId) ?? new Set<number>();
    set.add(r.teacherStaffId);
    t3HistoricByStudent.set(r.studentId, set);
  }
  const effectivePlanTeachers = new Map<number, number[]>();
  for (const p of plans) {
    const sched = planScheduleByStudent.get(p.studentId) ?? [];
    const merged = new Set<number>(resolveEffectiveTeachers(p, sched));
    const histSet =
      p.tier === 2
        ? t2HistoricByStudentSubType.get(
            `${p.studentId}::${p.interventionSubType ?? ""}`,
          )
        : t3HistoricByStudent.get(p.studentId);
    if (histSet) for (const id of histSet) merged.add(id);
    effectivePlanTeachers.set(p.id, Array.from(merged).sort((a, b) => a - b));
  }
  // staff lookup (id -> name)
  const teacherIdSet = new Set<number>();
  for (const ids of effectivePlanTeachers.values()) {
    for (const t of ids) teacherIdSet.add(t);
  }
  const teacherList =
    teacherIdSet.size === 0
      ? []
      : await db
          .select({ id: staffTable.id, displayName: staffTable.displayName })
          .from(staffTable)
          .where(
            and(
              inArray(staffTable.id, Array.from(teacherIdSet)),
              eq(staffTable.schoolId, schoolId),
            ),
          );
  const teacherMap = new Map(teacherList.map((t) => [t.id, t.displayName]));

  // Group entries/records by (studentId, teacherId, subType-or-tier3).
  // Including the discriminator on the COUNT key matches the
  // discriminator we used on the historic-contributors UNION above
  // and prevents same-student / same-teacher / different-subtype T2
  // plans from inflating each other's per-plan completion numbers.
  type CountKey = string; // `${studentId}::${teacherId}::${disc}`
  const t2Counts = new Map<CountKey, Set<string>>();
  for (const e of tier2Entries) {
    const key = `${e.studentId}::${e.teacherStaffId}::${e.subType ?? ""}`;
    const set = t2Counts.get(key) ?? new Set<string>();
    set.add(e.entryDate);
    t2Counts.set(key, set);
  }
  // T3 has no per-entry discriminator; use a fixed sentinel so the
  // key shape stays parallel.
  const t3ByKey = new Map<
    CountKey,
    typeof tier3WeeklyRecordsTable.$inferSelect
  >();
  for (const r of tier3Records) {
    t3ByKey.set(`${r.studentId}::${r.teacherStaffId}::tier3`, r);
  }

  const out = plans.map((p) => {
    const s = studentMap.get(p.studentId);
    const teacherIds = effectivePlanTeachers.get(p.id) ?? [];
    const teachers = teacherIds.map((tid) => {
      const key =
        p.tier === 2
          ? `${p.studentId}::${tid}::${p.interventionSubType ?? ""}`
          : `${p.studentId}::${tid}::tier3`;
      let completed = 0;
      let expected = 0;
      let scoreAvg: number | null = null;
      let academic = false;
      let released = false;
      let academicState: AcademicWeekState | null = null;
      if (p.tier === 2) {
        // Tier 2 is one-per-week-per-(student, teacher). Either the
        // teacher has at least one entry this week (1/1) or they don't
        // (0/1). The actual count of distinct dates submitted is left
        // for the per-day report.
        expected = 1;
        completed = (t2Counts.get(key)?.size ?? 0) > 0 ? 1 : 0;
      } else if (isAcademicTier3(p)) {
        // Academic Tier 3 is a minutes-based small group. Completion =
        // minutes logged this week vs the plan's weekly target. A
        // released week ("no group provided") reads as excused, not owed.
        academic = true;
        const rec = t3ByKey.get(key);
        const minutes = sumAcademicMinutes(rec?.academicMinutes);
        released = Boolean(rec?.releasedNoIntervention);
        expected = p.academicMinutesTarget;
        completed = minutes;
        academicState = academicWeekState(
          minutes,
          p.academicMinutesTarget,
          released,
        );
      } else {
        const rec = t3ByKey.get(key);
        const scores = rec
          ? [
              rec.monScore,
              rec.tueScore,
              rec.wedScore,
              rec.thuScore,
              rec.friScore,
            ]
          : [];
        // Days the teacher explicitly marked the student absent are
        // counted as fulfilled obligations: they don't need a score
        // and they don't lower the expected denominator either, since
        // we still want admins to see "5/5 — 2 absent" not "3/5".
        const absent = (rec?.absentDays ?? {}) as Record<string, boolean>;
        const dayKeys = ["mon", "tue", "wed", "thu", "fri"] as const;
        // Academic Tier 3 plans are only obligated on their configured
        // meeting days, so the denominator is meetingDays.length (not 5).
        // Off days are skipped entirely — never counted as missing or
        // fulfilled. Behavior Tier 3 (meetingDays null) keeps all 5 days.
        const meetingSet = p.meetingDays
          ? new Set(
              p.meetingDays
                .split(",")
                .map((d) => d.trim().toLowerCase())
                .filter(Boolean),
            )
          : null;
        const valid: number[] = [];
        let absentCount = 0;
        let scheduledDays = 0;
        for (let i = 0; i < dayKeys.length; i++) {
          if (meetingSet && !meetingSet.has(dayKeys[i])) continue;
          scheduledDays++;
          if (absent[dayKeys[i]]) {
            absentCount++;
            continue;
          }
          const v = scores[i];
          if (typeof v === "number") valid.push(v);
        }
        completed = valid.length + absentCount;
        expected = meetingSet ? scheduledDays : 5;
        scoreAvg =
          valid.length > 0
            ? valid.reduce((a, b) => a + b, 0) / valid.length
            : null;
      }
      return {
        teacherStaffId: tid,
        teacherName: teacherMap.get(tid) ?? `#${tid}`,
        completed,
        expected,
        scoreAvg,
        academic,
        released,
        academicState,
      };
    });
    return {
      planId: p.id,
      studentId: p.studentId,
      studentName: s ? `${s.firstName} ${s.lastName}` : p.studentId,
      grade: s ? String(s.grade) : null,
      tier: p.tier,
      subType: p.interventionSubType,
      title: p.title,
      assignedTeacherCount: teacherIds.length,
      teachers,
    };
  });

  res.json({
    weekStartDate: week,
    schoolDayDates: dayDates,
    rows: out,
  });
});

export default router;
