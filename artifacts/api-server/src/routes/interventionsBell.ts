// "What interventions do I owe today?" + completion report.
//
// Routes:
//   GET /api/interventions/owed-today
//      Returns the per-student rows the *current teacher* still has to
//      submit today (Tier 2 daily) and this week (Tier 3 weekly). Empty
//      array when there's nothing owed; the bell hides itself in that
//      state. Core Team callers always get an empty list — they do not
//      see the bell.
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

const router: IRouter = Router();

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

// Monday-of-the-week containing `today`, in school-local terms. Treat the
// server clock as authoritative — the platform runs in UTC and PulseEDU
// is single-state (FL) so the offset is small enough not to shift the
// week boundary in practice.
function mondayOf(today: Date): string {
  const d = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  const dow = d.getUTCDay(); // 0 Sun..6 Sat
  // Monday = 1. If today is Sunday(0), Monday is +1 day forward (next
  // week). If Monday(1), shift 0. Otherwise back (dow - 1) days.
  const shift = dow === 0 ? 1 : -(dow - 1);
  d.setUTCDate(d.getUTCDate() + shift);
  return d.toISOString().slice(0, 10);
}

function isWeekend(today: Date): boolean {
  const dow = today.getUTCDay();
  return dow === 0 || dow === 6;
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

// =================================================================
// OWED-TODAY
// =================================================================
router.get("/interventions/owed-today", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  // Core Team and SuperUser do not see the bell.
  if (isCoreTeam(staff)) {
    res.json({
      tier2: [],
      tier3: [],
      todayDate: todayStr(),
      weekStartDate: mondayOf(new Date()),
      visible: false,
    });
    return;
  }

  const today = new Date();
  const todayDate = todayStr();
  const weekStartDate = mondayOf(today);

  // Pull every active plan that names this teacher in
  // assignedTeacherIds. The csv is small enough to filter in JS.
  const allPlans = await db
    .select()
    .from(studentMtssPlansTable)
    .where(
      and(
        eq(studentMtssPlansTable.schoolId, schoolId),
        sql`${studentMtssPlansTable.closedAt} IS NULL`,
      ),
    );
  const myPlans = allPlans.filter((p) =>
    parseTeacherCsv(p.assignedTeacherIds).includes(staff.id),
  );

  const tier2Plans = myPlans.filter((p) => p.tier === 2);
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

  // ----- Tier 2 (daily) -----
  // Skip on weekends — Tier 2 is school-day-only.
  let tier2Owed: Array<{
    studentId: string;
    studentName: string;
    grade: string | null;
    subType: string | null;
    planId: number;
  }> = [];
  if (!isWeekend(today) && tier2Plans.length > 0) {
    const studentIdsT2 = tier2Plans.map((p) => p.studentId);
    const submitted = await db
      .select({ studentId: tier2InterventionEntriesTable.studentId })
      .from(tier2InterventionEntriesTable)
      .where(
        and(
          eq(tier2InterventionEntriesTable.schoolId, schoolId),
          eq(tier2InterventionEntriesTable.teacherStaffId, staff.id),
          eq(tier2InterventionEntriesTable.entryDate, todayDate),
          inArray(tier2InterventionEntriesTable.studentId, studentIdsT2),
        ),
      );
    const doneIds = new Set(submitted.map((r) => r.studentId));
    tier2Owed = tier2Plans
      .filter((p) => !doneIds.has(p.studentId))
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
  // Owed when the teacher hasn't created the row for this week yet OR
  // has the row but a score is missing for today's day-of-week. We surface
  // a single "todo" per student-week regardless of how many days remain
  // unscored — the form lets them fill in any/all.
  let tier3Owed: Array<{
    studentId: string;
    studentName: string;
    grade: string | null;
    planId: number;
    weekStartDate: string;
    missingDayCount: number;
  }> = [];
  if (tier3Plans.length > 0) {
    const studentIdsT3 = tier3Plans.map((p) => p.studentId);
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
    // Use America/New_York day-of-week so the bell doesn't roll over
    // at midnight UTC (~7-8pm EST) and surface tomorrow's row early.
    const dow = todayDowLocal();
    const reachedIdx = dow === 0 ? 4 : dow >= 6 ? 4 : Math.max(0, dow - 1);

    for (const p of tier3Plans) {
      const rec = recordByStudent.get(p.studentId);
      const dayScores = rec
        ? [rec.monScore, rec.tueScore, rec.wedScore, rec.thuScore, rec.friScore]
        : [null, null, null, null, null];
      // Days the teacher explicitly marked the student absent for
      // shouldn't count as "missing" — there's nothing to score.
      const absent = (rec?.absentDays ?? {}) as Record<string, boolean>;
      const dayKeys = ["mon", "tue", "wed", "thu", "fri"] as const;
      let missing = 0;
      for (let i = 0; i <= reachedIdx; i++) {
        if (absent[dayKeys[i]]) continue;
        if (dayScores[i] === null || dayScores[i] === undefined) missing++;
      }
      if (missing > 0) {
        const s = studentMap.get(p.studentId);
        tier3Owed.push({
          studentId: p.studentId,
          studentName: s ? `${s.firstName} ${s.lastName}` : p.studentId,
          grade: s ? String(s.grade) : null,
          planId: p.id,
          weekStartDate,
          missingDayCount: missing,
        });
      }
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
      : mondayOf(new Date());

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

  // staff lookup (id -> name)
  const teacherIdSet = new Set<number>();
  for (const p of plans) {
    for (const t of parseTeacherCsv(p.assignedTeacherIds)) teacherIdSet.add(t);
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

  // Group entries/records by (studentId, teacherId).
  type T2Key = string; // `${studentId}::${teacherId}`
  const t2Counts = new Map<T2Key, Set<string>>();
  for (const e of tier2Entries) {
    const key = `${e.studentId}::${e.teacherStaffId}`;
    const set = t2Counts.get(key) ?? new Set<string>();
    set.add(e.entryDate);
    t2Counts.set(key, set);
  }
  const t3ByKey = new Map<
    T2Key,
    typeof tier3WeeklyRecordsTable.$inferSelect
  >();
  for (const r of tier3Records) {
    t3ByKey.set(`${r.studentId}::${r.teacherStaffId}`, r);
  }

  const out = plans.map((p) => {
    const s = studentMap.get(p.studentId);
    const teacherIds = parseTeacherCsv(p.assignedTeacherIds);
    const teachers = teacherIds.map((tid) => {
      const key = `${p.studentId}::${tid}`;
      let completed = 0;
      let expected = 0;
      let scoreAvg: number | null = null;
      if (p.tier === 2) {
        expected = 5; // Mon-Fri
        completed = t2Counts.get(key)?.size ?? 0;
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
        const valid: number[] = [];
        let absentCount = 0;
        for (let i = 0; i < dayKeys.length; i++) {
          if (absent[dayKeys[i]]) {
            absentCount++;
            continue;
          }
          const v = scores[i];
          if (typeof v === "number") valid.push(v);
        }
        completed = valid.length + absentCount;
        expected = 5;
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
