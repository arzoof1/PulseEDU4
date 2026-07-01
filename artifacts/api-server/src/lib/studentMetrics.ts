// =============================================================================
// Student metrics engine — SINGLE SOURCE OF TRUTH for per-student aggregates
// =============================================================================
// Powers BOTH the bulk "Student Summary" export dataset and the visual Student
// Snapshot report, so the CSV and the on-screen report can never disagree.
//
// Design:
//   * `loadStudentMetrics(schoolId, studentIds, range)` batches a handful of
//     queries and returns one flat record per student, keyed by studentId.
//   * Event metrics (tardies, hall passes, lost instruction, OSS/ISS served,
//     behavior pullouts, PBIS) RESPECT the date range. Point-in-time facts
//     (attendance semester snapshot, active MTSS tier, FAST PM windows) do not
//     — the range can't meaningfully slice them; this is documented per field.
//   * Cohort comparison (mean + percentile, suppressed below a min size) lives
//     here too via METRIC_DESCRIPTORS + computeCohortComparison.
//
// GUARDRAILS: every query is forced to schoolId. This module returns NUMBERS,
// never the FLEID — the studentId key is the canonical join id, never emitted
// to users. Surfaces (export dataset / snapshot route) attach localSisId
// separately and apply visibility scoping before calling in.
// =============================================================================

import {
  db,
  tardiesTable,
  hallPassesTable,
  ossLogDaysTable,
  issAttendanceDayTable,
  pulloutsTable,
  pbisEntriesTable,
  studentMtssPlansTable,
  studentFastScoresTable,
  studentCourseGradesTable,
  importJobsTable,
  schoolSettingsTable,
} from "@workspace/db";
import { and, eq, inArray, gte, lte, ne, isNull, desc } from "drizzle-orm";
import {
  loadAttendanceMetrics,
  type AttendanceMetric,
} from "./attendanceMetrics.js";
import {
  loadDefaultPeriodWindows,
  tardyLostMinutes,
  hallPassLostMinutes,
  type PeriodWindow,
} from "./lostInstruction.js";
import { getSchoolTimezone } from "./schoolYear.js";

export type MetricRange = { from: string | null; to: string | null };

export interface StudentMetrics {
  studentId: string;
  // --- Shows up (attendance is the LATEST semester upload; range not applied) ---
  daysAbsent: number | null;
  attendancePct: number | null; // approximate, see attendanceMetrics.ts
  tardies: number; // range-aware (tardies table)
  // --- Stays in the room (range-aware) ---
  hallPassCount: number;
  hallPassMinutes: number;
  lostInstructionMinutes: number; // tardy-late + hall-pass time
  pulloutCount: number; // behavior "Request pullout" (non-rejected)
  pulloutMinutes: number;
  // --- Engages / discipline (range-aware) ---
  ossServedDays: number;
  issServedDays: number;
  pbisPositivePoints: number;
  pbisNegativePoints: number;
  pbisNetPoints: number;
  // --- Is supported (point-in-time: active plans now) ---
  mtssT2Active: boolean;
  mtssT3AcademicActive: boolean;
  mtssT3BehaviorActive: boolean;
  // --- Achieves (FAST PM windows are fixed; range not applied) ---
  fastElaPm1: number | null;
  fastElaPm2: number | null;
  fastElaPm3: number | null;
  fastMathPm1: number | null;
  fastMathPm2: number | null;
  fastMathPm3: number | null;
  // --- Current grades (gradebook import; point-in-time, range not applied) ---
  // One entry per course, current grade = effective-quarter value with a
  // fallback to the latest populated quarter.
  currentGrades: CurrentGrade[];
  // Unweighted 4.0-scale GPA over the current semester's graded courses, or
  // null when the school has GPA disabled or the student has no grades.
  gpa: number | null;
  // Mirror of the school-wide GPA toggle so surfaces can decide whether to
  // render a GPA at all (the metric is null either way when disabled).
  gpaEnabled: boolean;
}

export interface CurrentGrade {
  courseCode: string;
  courseDesc: string | null;
  teacherName: string | null;
  gradeLevel: string | null;
  // The numeric current grade (0-100) and which quarter it came from.
  grade: number | null;
  quarter: string;
}

function emptyMetrics(studentId: string, att?: AttendanceMetric): StudentMetrics {
  return {
    studentId,
    daysAbsent: att ? att.daysAbsent : null,
    attendancePct: att ? att.attendancePct : null,
    tardies: 0,
    hallPassCount: 0,
    hallPassMinutes: 0,
    lostInstructionMinutes: 0,
    pulloutCount: 0,
    pulloutMinutes: 0,
    ossServedDays: 0,
    issServedDays: 0,
    pbisPositivePoints: 0,
    pbisNegativePoints: 0,
    pbisNetPoints: 0,
    mtssT2Active: false,
    mtssT3AcademicActive: false,
    mtssT3BehaviorActive: false,
    fastElaPm1: null,
    fastElaPm2: null,
    fastElaPm3: null,
    fastMathPm1: null,
    fastMathPm2: null,
    fastMathPm3: null,
    currentGrades: [],
    gpa: null,
    gpaEnabled: false,
  };
}

// 4.0-scale grade points for a 0-100 grade.
function gradePoints(grade: number): number {
  if (grade >= 90) return 4;
  if (grade >= 80) return 3;
  if (grade >= 70) return 2;
  if (grade >= 60) return 1;
  return 0;
}

// Default range = "year to date" from the Aug-1 school-year start (the shared
// YTD window used by the tardy / lost-instruction / PBIS totals). `to` stays
// open (through today). Callers may override either bound.
export async function resolveMetricRange(
  schoolId: number,
  raw: MetricRange,
): Promise<MetricRange> {
  let from = raw.from;
  if (!from && !raw.to) {
    const tz = await getSchoolTimezone(schoolId);
    const ymd = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const [y, m] = ymd.split("-").map((n) => Number(n));
    const startYear = m >= 8 ? y : y - 1;
    from = `${startYear}-08-01`;
  }
  return { from: from ?? null, to: raw.to ?? null };
}

// ISO-text createdAt columns sort lexicographically, so string bounds work:
// inclusive of the whole start day and the whole end day.
function isoLo(from: string | null): string | null {
  return from ? `${from}T00:00:00` : null;
}
function isoHi(to: string | null): string | null {
  return to ? `${to}T23:59:59.999` : null;
}

export async function loadStudentMetrics(
  schoolId: number,
  studentIds: string[],
  range: MetricRange,
): Promise<Map<string, StudentMetrics>> {
  const out = new Map<string, StudentMetrics>();
  if (studentIds.length === 0) return out;

  const loIso = isoLo(range.from);
  const hiIso = isoHi(range.to);
  // date-typed columns (oss/iss day) compare against plain YYYY-MM-DD.
  const loDay = range.from;
  const hiDay = range.to;

  const [windows, tz, attendance, gpaEnabled] = await Promise.all([
    loadDefaultPeriodWindows(schoolId),
    getSchoolTimezone(schoolId),
    loadAttendanceMetrics(schoolId, studentIds),
    loadGpaEnabled(schoolId),
  ]);

  // Seed every requested student so the map always has a complete row.
  for (const sid of studentIds) {
    const m = emptyMetrics(sid, attendance.get(sid));
    m.gpaEnabled = gpaEnabled;
    out.set(sid, m);
  }

  await Promise.all([
    loadTardies(out, schoolId, studentIds, loIso, hiIso, windows, tz),
    loadHallPasses(out, schoolId, studentIds, loIso, hiIso),
    loadOssDays(out, schoolId, studentIds, loDay, hiDay),
    loadIssDays(out, schoolId, studentIds, loDay, hiDay),
    loadPullouts(out, schoolId, studentIds, loIso, hiIso),
    loadPbis(out, schoolId, studentIds, loIso, hiIso),
    loadMtss(out, schoolId, studentIds),
    loadFast(out, schoolId, studentIds),
    loadCurrentGrades(out, schoolId, studentIds, gpaEnabled),
  ]);

  return out;
}

// School-wide GPA toggle (default false). Controls whether the GPA metric is
// computed at all — when off, every student's `gpa` stays null.
async function loadGpaEnabled(schoolId: number): Promise<boolean> {
  const [row] = await db
    .select({ gpaEnabled: schoolSettingsTable.gpaEnabled })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId))
    .limit(1);
  return row?.gpaEnabled ?? false;
}

// Current grades per course + the unweighted 4.0 GPA. Current grade for a
// course = its effective-quarter value, falling back to the latest populated
// quarter (Q4→Q1). GPA averages grade points across the current semester's
// graded courses (Fall = Q1/Q2 effective, Spring = Q3/Q4 effective); GPA is
// suppressed entirely when the school has the toggle off.
async function loadCurrentGrades(
  out: Map<string, StudentMetrics>,
  schoolId: number,
  ids: string[],
  gpaEnabled: boolean,
) {
  // Gradebook uses JOB-CHAINING for restorable rollback: every upload's rows
  // are kept (tagged with their import_job_id); the "current" snapshot is the
  // rows of the LATEST committed gradebook job. Rolling that job back flips it
  // to rolled_back, so the prior job becomes latest and its grades are
  // restored automatically — no destructive full-replace. Find that job first;
  // if there is none the school simply has no current grades.
  const [latestJob] = await db
    .select({ id: importJobsTable.id })
    .from(importJobsTable)
    .where(
      and(
        eq(importJobsTable.schoolId, schoolId),
        eq(importJobsTable.kind, "gradebook"),
        eq(importJobsTable.status, "committed"),
      ),
    )
    .orderBy(desc(importJobsTable.id))
    .limit(1);
  if (!latestJob) return;

  const rows = await db
    .select({
      studentId: studentCourseGradesTable.studentId,
      courseCode: studentCourseGradesTable.courseCode,
      courseDesc: studentCourseGradesTable.courseDesc,
      teacherName: studentCourseGradesTable.teacherName,
      gradeLevel: studentCourseGradesTable.gradeLevel,
      q1: studentCourseGradesTable.q1,
      q2: studentCourseGradesTable.q2,
      q3: studentCourseGradesTable.q3,
      q4: studentCourseGradesTable.q4,
      effectiveQuarter: studentCourseGradesTable.effectiveQuarter,
    })
    .from(studentCourseGradesTable)
    .where(
      and(
        eq(studentCourseGradesTable.schoolId, schoolId),
        eq(studentCourseGradesTable.importJobId, latestJob.id),
        inArray(studentCourseGradesTable.studentId, ids),
      ),
    );

  // Per-student semester-scoped grades for GPA. Keyed separately from the
  // displayed `currentGrades` because GPA only counts the CURRENT SEMESTER's
  // courses (Fall = Q1/Q2, Spring = Q3/Q4) using that semester's grade — the
  // displayed current grade can fall back across the whole year.
  const semesterGrades = new Map<string, number[]>();

  for (const r of rows) {
    const m = out.get(r.studentId);
    if (!m) continue;
    const byQuarter: Record<string, number | null> = {
      Q1: r.q1,
      Q2: r.q2,
      Q3: r.q3,
      Q4: r.q4,
    };
    const effective = (r.effectiveQuarter ?? "").toUpperCase();
    // Displayed current grade: effective quarter, else latest populated (Q4→Q1).
    let grade: number | null = null;
    let quarter = effective || "Q1";
    if (byQuarter[effective] != null) {
      grade = byQuarter[effective];
      quarter = effective;
    } else {
      for (const q of ["Q4", "Q3", "Q2", "Q1"]) {
        if (byQuarter[q] != null) {
          grade = byQuarter[q];
          quarter = q;
          break;
        }
      }
    }
    m.currentGrades.push({
      courseCode: r.courseCode,
      courseDesc: r.courseDesc,
      teacherName: r.teacherName,
      gradeLevel: r.gradeLevel,
      grade,
      quarter,
    });

    // GPA contribution: only this course's CURRENT-SEMESTER grade. The
    // semester is derived from the effective quarter (Q3/Q4 = Spring, else
    // Fall). Prefer the effective quarter's value when it's in-semester,
    // otherwise fall back to the latest populated quarter WITHIN the semester
    // only. Courses with no in-semester grade are excluded.
    if (gpaEnabled) {
      const semester =
        effective === "Q3" || effective === "Q4"
          ? ["Q3", "Q4"]
          : ["Q1", "Q2"];
      let semGrade: number | null = null;
      if (semester.includes(effective) && byQuarter[effective] != null) {
        semGrade = byQuarter[effective];
      } else {
        for (const q of [...semester].reverse()) {
          if (byQuarter[q] != null) {
            semGrade = byQuarter[q];
            break;
          }
        }
      }
      if (semGrade != null) {
        const list = semesterGrades.get(r.studentId) ?? [];
        list.push(semGrade);
        semesterGrades.set(r.studentId, list);
      }
    }
  }

  // Stable display order + GPA. Sort courses by code so every surface lists
  // them the same way.
  for (const [sid, m] of out) {
    m.currentGrades.sort((a, b) => a.courseCode.localeCompare(b.courseCode));
    if (!gpaEnabled) continue;
    const graded = semesterGrades.get(sid) ?? [];
    if (graded.length === 0) continue;
    const sum = graded.reduce((acc, g) => acc + gradePoints(g), 0);
    m.gpa = Math.round((sum / graded.length) * 100) / 100;
  }
}

// Focused loader for the Student Profile / per-student surfaces that only need
// the current-grade list + GPA (not the full whole-child engine). Reuses the
// exact same effective-quarter + GPA logic as `loadStudentMetrics` so every
// surface agrees on each student's current grade and GPA.
export async function loadStudentGrades(
  schoolId: number,
  studentIds: string[],
): Promise<
  Map<
    string,
    { currentGrades: CurrentGrade[]; gpa: number | null; gpaEnabled: boolean }
  >
> {
  const result = new Map<
    string,
    { currentGrades: CurrentGrade[]; gpa: number | null; gpaEnabled: boolean }
  >();
  if (studentIds.length === 0) return result;
  const gpaEnabled = await loadGpaEnabled(schoolId);
  const tmp = new Map<string, StudentMetrics>();
  for (const sid of studentIds) {
    const m = emptyMetrics(sid);
    m.gpaEnabled = gpaEnabled;
    tmp.set(sid, m);
  }
  await loadCurrentGrades(tmp, schoolId, studentIds, gpaEnabled);
  for (const [sid, m] of tmp) {
    result.set(sid, {
      currentGrades: m.currentGrades,
      gpa: m.gpa,
      gpaEnabled,
    });
  }
  return result;
}

async function loadTardies(
  out: Map<string, StudentMetrics>,
  schoolId: number,
  ids: string[],
  loIso: string | null,
  hiIso: string | null,
  windows: Map<number, PeriodWindow>,
  tz: string,
) {
  const where = [
    eq(tardiesTable.schoolId, schoolId),
    inArray(tardiesTable.studentId, ids),
  ];
  if (loIso) where.push(gte(tardiesTable.createdAt, loIso));
  if (hiIso) where.push(lte(tardiesTable.createdAt, hiIso));
  const rows = await db
    .select({
      studentId: tardiesTable.studentId,
      period: tardiesTable.period,
      createdAt: tardiesTable.createdAt,
    })
    .from(tardiesTable)
    .where(and(...where));
  for (const r of rows) {
    const m = out.get(r.studentId);
    if (!m) continue;
    m.tardies += 1;
    const lost = tardyLostMinutes(windows, r.period, r.createdAt, tz);
    if (lost != null) m.lostInstructionMinutes += lost;
  }
}

async function loadHallPasses(
  out: Map<string, StudentMetrics>,
  schoolId: number,
  ids: string[],
  loIso: string | null,
  hiIso: string | null,
) {
  const where = [
    eq(hallPassesTable.schoolId, schoolId),
    inArray(hallPassesTable.studentId, ids),
  ];
  if (loIso) where.push(gte(hallPassesTable.createdAt, loIso));
  if (hiIso) where.push(lte(hallPassesTable.createdAt, hiIso));
  const rows = await db
    .select({
      studentId: hallPassesTable.studentId,
      createdAt: hallPassesTable.createdAt,
      endedAt: hallPassesTable.endedAt,
    })
    .from(hallPassesTable)
    .where(and(...where));
  for (const r of rows) {
    const m = out.get(r.studentId);
    if (!m) continue;
    m.hallPassCount += 1;
    const mins = hallPassLostMinutes(r.createdAt, r.endedAt);
    if (mins != null) {
      m.hallPassMinutes += mins;
      m.lostInstructionMinutes += mins;
    }
  }
}

async function loadOssDays(
  out: Map<string, StudentMetrics>,
  schoolId: number,
  ids: string[],
  loDay: string | null,
  hiDay: string | null,
) {
  const where = [
    eq(ossLogDaysTable.schoolId, schoolId),
    inArray(ossLogDaysTable.studentId, ids),
    eq(ossLogDaysTable.cancelled, false),
  ];
  if (loDay) where.push(gte(ossLogDaysTable.day, loDay));
  if (hiDay) where.push(lte(ossLogDaysTable.day, hiDay));
  const rows = await db
    .select({ studentId: ossLogDaysTable.studentId, day: ossLogDaysTable.day })
    .from(ossLogDaysTable)
    .where(and(...where));
  // count distinct (student, day)
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.studentId}|${r.day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const m = out.get(r.studentId);
    if (m) m.ossServedDays += 1;
  }
}

async function loadIssDays(
  out: Map<string, StudentMetrics>,
  schoolId: number,
  ids: string[],
  loDay: string | null,
  hiDay: string | null,
) {
  const where = [
    eq(issAttendanceDayTable.schoolId, schoolId),
    inArray(issAttendanceDayTable.studentId, ids),
  ];
  if (loDay) where.push(gte(issAttendanceDayTable.day, loDay));
  if (hiDay) where.push(lte(issAttendanceDayTable.day, hiDay));
  const rows = await db
    .select({
      studentId: issAttendanceDayTable.studentId,
      day: issAttendanceDayTable.day,
    })
    .from(issAttendanceDayTable)
    .where(and(...where));
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.studentId}|${r.day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const m = out.get(r.studentId);
    if (m) m.issServedDays += 1;
  }
}

async function loadPullouts(
  out: Map<string, StudentMetrics>,
  schoolId: number,
  ids: string[],
  loIso: string | null,
  hiIso: string | null,
) {
  // Every row in `pullouts` is a behavior "Request pullout". Rejected requests
  // never became an actual pullout, so they don't count.
  const where = [
    eq(pulloutsTable.schoolId, schoolId),
    inArray(pulloutsTable.studentId, ids),
    ne(pulloutsTable.status, "rejected"),
  ];
  if (loIso) where.push(gte(pulloutsTable.requestedAt, loIso));
  if (hiIso) where.push(lte(pulloutsTable.requestedAt, hiIso));
  const rows = await db
    .select({
      studentId: pulloutsTable.studentId,
      arrivedAt: pulloutsTable.arrivedAt,
      returnedAt: pulloutsTable.returnedAt,
      closedAt: pulloutsTable.closedAt,
    })
    .from(pulloutsTable)
    .where(and(...where));
  for (const r of rows) {
    const m = out.get(r.studentId);
    if (!m) continue;
    m.pulloutCount += 1;
    const end = r.returnedAt ?? r.closedAt;
    if (r.arrivedAt && end) {
      const a = new Date(r.arrivedAt).getTime();
      const b = new Date(end).getTime();
      if (!Number.isNaN(a) && !Number.isNaN(b) && b > a) {
        m.pulloutMinutes += Math.round((b - a) / 60000);
      }
    }
  }
}

async function loadPbis(
  out: Map<string, StudentMetrics>,
  schoolId: number,
  ids: string[],
  loIso: string | null,
  hiIso: string | null,
) {
  const where = [
    eq(pbisEntriesTable.schoolId, schoolId),
    inArray(pbisEntriesTable.studentId, ids),
    isNull(pbisEntriesTable.voidedAt),
  ];
  if (loIso) where.push(gte(pbisEntriesTable.createdAt, loIso));
  if (hiIso) where.push(lte(pbisEntriesTable.createdAt, hiIso));
  const rows = await db
    .select({
      studentId: pbisEntriesTable.studentId,
      points: pbisEntriesTable.points,
      polarity: pbisEntriesTable.polarity,
    })
    .from(pbisEntriesTable)
    .where(and(...where));
  for (const r of rows) {
    const m = out.get(r.studentId);
    if (!m) continue;
    const pts = Math.abs(r.points ?? 0);
    if (r.polarity === "negative") m.pbisNegativePoints += pts;
    else m.pbisPositivePoints += pts;
  }
  for (const m of out.values()) {
    m.pbisNetPoints = m.pbisPositivePoints - m.pbisNegativePoints;
  }
}

async function loadMtss(
  out: Map<string, StudentMetrics>,
  schoolId: number,
  ids: string[],
) {
  const rows = await db
    .select({
      studentId: studentMtssPlansTable.studentId,
      tier: studentMtssPlansTable.tier,
      fastSubject: studentMtssPlansTable.fastSubject,
    })
    .from(studentMtssPlansTable)
    .where(
      and(
        eq(studentMtssPlansTable.schoolId, schoolId),
        inArray(studentMtssPlansTable.studentId, ids),
        isNull(studentMtssPlansTable.closedAt),
      ),
    );
  for (const r of rows) {
    const m = out.get(r.studentId);
    if (!m) continue;
    const isAcademic = r.fastSubject === "ela" || r.fastSubject === "math";
    if (r.tier === 2) m.mtssT2Active = true;
    if (r.tier === 3) {
      if (isAcademic) m.mtssT3AcademicActive = true;
      else m.mtssT3BehaviorActive = true;
    }
  }
}

async function loadFast(
  out: Map<string, StudentMetrics>,
  schoolId: number,
  ids: string[],
) {
  const rows = await db
    .select({
      studentId: studentFastScoresTable.studentId,
      subject: studentFastScoresTable.subject,
      pm1: studentFastScoresTable.pm1,
      pm2: studentFastScoresTable.pm2,
      pm3: studentFastScoresTable.pm3,
    })
    .from(studentFastScoresTable)
    .where(
      and(
        eq(studentFastScoresTable.schoolId, schoolId),
        inArray(studentFastScoresTable.studentId, ids),
        inArray(studentFastScoresTable.subject, ["ela", "math"]),
        eq(studentFastScoresTable.isHistorical, false),
      ),
    );
  for (const r of rows) {
    const m = out.get(r.studentId);
    if (!m) continue;
    if (r.subject === "ela") {
      m.fastElaPm1 = r.pm1;
      m.fastElaPm2 = r.pm2;
      m.fastElaPm3 = r.pm3;
    } else if (r.subject === "math") {
      m.fastMathPm1 = r.pm1;
      m.fastMathPm2 = r.pm2;
      m.fastMathPm3 = r.pm3;
    }
  }
}

// ---------------------------------------------------------------------------
// Cohort comparison
// ---------------------------------------------------------------------------
// The numeric metrics that get a peer comparison + radar axis, in the
// "mindset for learning" order. `direction` drives coloring: higher_better =
// green when above peers, higher_worse = red when above peers.
export type MetricDirection = "higher_better" | "higher_worse";

export interface MetricDescriptor {
  key: keyof StudentMetrics;
  label: string;
  direction: MetricDirection;
  // Radar grouping pillar (for the at-a-glance shape).
  pillar: "shows_up" | "stays" | "engages" | "achieves";
}

export const METRIC_DESCRIPTORS: MetricDescriptor[] = [
  { key: "attendancePct", label: "Attendance %", direction: "higher_better", pillar: "shows_up" },
  { key: "daysAbsent", label: "Days Absent", direction: "higher_worse", pillar: "shows_up" },
  { key: "tardies", label: "Tardies", direction: "higher_worse", pillar: "shows_up" },
  { key: "lostInstructionMinutes", label: "Lost Instruction (min)", direction: "higher_worse", pillar: "stays" },
  { key: "hallPassCount", label: "Hall Passes", direction: "higher_worse", pillar: "stays" },
  { key: "pulloutCount", label: "Behavior Pullouts", direction: "higher_worse", pillar: "stays" },
  { key: "ossServedDays", label: "OSS Days Served", direction: "higher_worse", pillar: "engages" },
  { key: "issServedDays", label: "ISS Days Served", direction: "higher_worse", pillar: "engages" },
  { key: "pbisNetPoints", label: "PBIS Net Points", direction: "higher_better", pillar: "engages" },
  { key: "fastElaPm3", label: "FAST ELA (PM3)", direction: "higher_better", pillar: "achieves" },
  { key: "fastMathPm3", label: "FAST Math (PM3)", direction: "higher_better", pillar: "achieves" },
];

export interface CohortComparison {
  value: number | null; // the target student's value
  mean: number | null; // cohort mean over non-null values
  percentile: number | null; // 0..100, "higher than X% of peers"
  n: number; // cohort size used (students with a value)
  suppressed: boolean; // true when below the min cohort size
}

const MIN_COHORT = 10;

// Compare one student's value against a cohort's values (raw, may include
// null/undefined). Suppressed (no mean/percentile) when fewer than MIN_COHORT
// peers have a value — small cohorts are noisy and can de-anonymize.
export function computeCohortComparison(
  value: number | null,
  cohortValues: (number | null | undefined)[],
  minCohort: number = MIN_COHORT,
): CohortComparison {
  const vals = cohortValues.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  const n = vals.length;
  if (n < minCohort) {
    return { value, mean: null, percentile: null, n, suppressed: true };
  }
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  let percentile: number | null = null;
  if (value != null && Number.isFinite(value)) {
    const below = vals.filter((v) => v < value).length;
    percentile = Math.round((below / n) * 100);
  }
  return {
    value,
    mean: Math.round(mean * 10) / 10,
    percentile,
    n,
    suppressed: false,
  };
}
