import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  hallPassesTable,
  staffTable,
  studentsTable,
  classSectionsTable,
  sectionRosterTable,
  tardiesTable,
  schoolSettingsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { getVisibleStudentIds } from "./insights.js";
import {
  loadDefaultPeriodWindows,
  hallPassLostMinutes,
  tzMinutesOfDay,
  type PeriodWindow,
} from "../lib/lostInstruction.js";
import { getSchoolTimezone } from "../lib/schoolYear.js";

// Hall Pass Research — roster-scoped student pass research for teachers.
//
// Unlike GET /hall-passes (whole-school list consumed by the admin Research
// tab), every endpoint here is visibility-scoped via getVisibleStudentIds:
// a teacher can only search / summarize students on their own roster (or
// trusted-adult assignments). Out-of-scope and non-existent students both
// return an indistinguishable 404 so a teacher can't probe existence.

type Staff = typeof staffTable.$inferSelect;

const router: IRouter = Router();

async function loadStaff(req: Request, res: Response): Promise<Staff | null> {
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
  // Tenant guard: a non-SuperUser actor must belong to the active school.
  if (
    !staff.isSuperUser &&
    req.schoolId != null &&
    staff.schoolId !== req.schoolId
  ) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return staff;
}

function requireStaff(req: Request, res: Response, next: NextFunction) {
  loadStaff(req, res).then((staff) => {
    if (!staff) return;
    (req as Request & { staff: Staff }).staff = staff;
    next();
  }, next);
}

// ---------------------------------------------------------------------------
// Date helpers (school-local)
// ---------------------------------------------------------------------------

const dayFmtCache = new Map<string, Intl.DateTimeFormat>();

// YYYY-MM-DD of an instant in the school's timezone.
function tzDay(iso: string | Date, tz: string): string | null {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return null;
  let fmt = dayFmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFmtCache.set(tz, fmt);
  }
  return fmt.format(d);
}

// School-year start year for a local YYYY-MM-DD (year flips Aug 1 — the
// same convention as the YTD tardy / lost-instruction metrics).
function schoolYearStartYear(localDay: string): number {
  const y = Number(localDay.slice(0, 4));
  const m = Number(localDay.slice(5, 7));
  return m >= 8 ? y : y - 1;
}

// Frozen-demo guard: the wall clock flips the school year on Aug 1, but a
// frozen demo dataset may hold no passes in the new year yet — which would
// zero out every total. Anchor on the wall-clock year when it has any
// passes, otherwise fall back to the school year of the newest pass.
function effectiveStartYear(passDays: string[], today: string): number {
  const wallYear = schoolYearStartYear(today);
  if (passDays.length === 0) return wallYear;
  const wallStart = `${wallYear}-08-01`;
  if (passDays.some((d) => d >= wallStart)) return wallYear;
  const latest = passDays.reduce((a, b) => (b > a ? b : a));
  return schoolYearStartYear(latest);
}

export type QuarterKey = "all" | "Q1" | "Q2" | "Q3" | "Q4";

// Admin-set first student day of the school year (school_settings). Null
// when unset — callers fall back to the Aug-1 convention.
export async function loadFirstDayOfSchool(
  schoolId: number,
): Promise<string | null> {
  const [row] = await db
    .select({ firstDay: schoolSettingsTable.firstDayOfSchool })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId))
    .limit(1);
  const v = row?.firstDay?.trim();
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

// The school year's opening day: the admin-set first day of school when it
// belongs to this school year, otherwise the Aug-1 convention.
function yearOpenDay(startYear: number, firstDay: string | null): string {
  return firstDay && schoolYearStartYear(firstDay) === startYear
    ? firstDay
    : `${startYear}-08-01`;
}

// Approximate quarter windows for a school year starting in `startYear`.
// Quarter calendar dates are not configured anywhere in school settings
// today, so these are fixed, documented approximations (Q2 Oct 16–Dec 31,
// Q3 Jan 1–Mar 15, Q4 Mar 16–Jul 31). The year/Q1 start honors the
// admin-set first day of school when present.
export function quarterWindow(
  startYear: number,
  q: QuarterKey,
  firstDay: string | null = null,
): { from: string; to: string } {
  const y = startYear;
  const n = startYear + 1;
  const open = yearOpenDay(startYear, firstDay);
  switch (q) {
    case "Q1":
      return { from: open, to: `${y}-10-15` };
    case "Q2":
      return { from: `${y}-10-16`, to: `${y}-12-31` };
    case "Q3":
      return { from: `${n}-01-01`, to: `${n}-03-15` };
    case "Q4":
      return { from: `${n}-03-16`, to: `${n}-07-31` };
    default:
      return { from: open, to: `${n}-07-31` };
  }
}

// Multi-select quarters: ?quarters=Q1,Q2 (SEM 1 = Q1+Q2, SEM 2 = Q3+Q4 are
// client-side shortcuts for the same thing). Empty / invalid / all-four
// collapses to the whole school year. Legacy ?quarter=Q1 still accepted.
function parseQuarters(v: unknown, legacy: unknown): QuarterKey[] {
  const raw = typeof v === "string" && v ? v : String(legacy ?? "");
  const qs = Array.from(
    new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is "Q1" | "Q2" | "Q3" | "Q4" =>
          ["Q1", "Q2", "Q3", "Q4"].includes(s),
        ),
    ),
  );
  return qs.length === 0 || qs.length === 4 ? [] : qs;
}

// Bell-schedule period a pass started in, from its checkout instant.
function periodForIso(
  windows: Map<number, PeriodWindow>,
  iso: string,
  tz: string,
): number | null {
  const mod = tzMinutesOfDay(iso, tz);
  if (mod == null) return null;
  for (const [period, w] of windows) {
    const len = w.lengthMin ?? 90;
    if (mod >= w.startMin && mod < w.startMin + len) return period;
  }
  return null;
}

// Average period length of the default schedule — the "one day of
// instruction" unit for the minutes → days conversion. Null when the
// school has no usable default schedule.
function avgPeriodLength(windows: Map<number, PeriodWindow>): number | null {
  const lens = Array.from(windows.values())
    .map((w) => w.lengthMin)
    .filter((v): v is number => v != null && v > 0);
  if (lens.length === 0) return null;
  return Math.round(lens.reduce((a, b) => a + b, 0) / lens.length);
}

function daysFromMinutes(lostMin: number, periodLen: number | null) {
  if (!periodLen || periodLen <= 0) return null;
  return Math.round((lostMin / periodLen) * 10) / 10;
}

// ---------------------------------------------------------------------------
// GET /hall-passes/research/students — searchable list scoped to the actor
// ---------------------------------------------------------------------------

router.get(
  "/hall-passes/research/students",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: Staff }).staff;
    const visibility = await getVisibleStudentIds(staff, schoolId);
    const base = db
      .select({
        studentId: studentsTable.studentId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
        localSisId: studentsTable.localSisId,
      })
      .from(studentsTable);
    const rows = visibility.full
      ? await base.where(eq(studentsTable.schoolId, schoolId))
      : visibility.ids.size === 0
        ? []
        : await base.where(
            and(
              eq(studentsTable.schoolId, schoolId),
              inArray(studentsTable.studentId, Array.from(visibility.ids)),
            ),
          );
    rows.sort((a, b) =>
      `${a.lastName} ${a.firstName}`.localeCompare(
        `${b.lastName} ${b.firstName}`,
      ),
    );
    res.json({ students: rows });
  },
);

// ---------------------------------------------------------------------------
// GET /hall-passes/research/roster-total — pre-search header stat: total
// lost instruction (school-year-to-date) across every student the actor
// can see.
// ---------------------------------------------------------------------------

router.get(
  "/hall-passes/research/roster-total",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: Staff }).staff;
    const visibility = await getVisibleStudentIds(staff, schoolId);
    const tz = await getSchoolTimezone(schoolId);
    const today = tzDay(new Date(), tz)!;

    let studentIds: string[] | null = null; // null = all (full visibility)
    if (!visibility.full) {
      studentIds = Array.from(visibility.ids);
      if (studentIds.length === 0) {
        res.json({ lostMin: 0, days: 0, periodLen: null, studentCount: 0 });
        return;
      }
    }
    const passes = await db
      .select({
        studentId: hallPassesTable.studentId,
        createdAt: hallPassesTable.createdAt,
        endedAt: hallPassesTable.endedAt,
      })
      .from(hallPassesTable)
      .where(
        studentIds
          ? and(
              eq(hallPassesTable.schoolId, schoolId),
              inArray(hallPassesTable.studentId, studentIds),
            )
          : eq(hallPassesTable.schoolId, schoolId),
      );
    const passDays = passes
      .map((p) => tzDay(p.createdAt, tz))
      .filter((d): d is string => d != null);
    const startYear = effectiveStartYear(passDays, today);
    const firstDay = await loadFirstDayOfSchool(schoolId);
    const win = quarterWindow(startYear, "all", firstDay);
    let lostMin = 0;
    const counted = new Set<string>();
    for (const p of passes) {
      const day = tzDay(p.createdAt, tz);
      if (!day || day < win.from || day > win.to) continue;
      const m = hallPassLostMinutes(p.createdAt, p.endedAt);
      if (m == null) continue;
      lostMin += m;
      counted.add(p.studentId);
    }
    const windows = await loadDefaultPeriodWindows(schoolId);
    const periodLen = avgPeriodLength(windows);
    res.json({
      lostMin,
      days: daysFromMinutes(lostMin, periodLen),
      periodLen,
      studentCount: counted.size,
    });
  },
);

// ---------------------------------------------------------------------------
// GET /hall-passes/research/report-feed — school-year pass feed for the
// Overview + YTD report charts. Visibility-scoped: teachers get ONLY their
// own students' passes (core team / admins get the whole school via full
// visibility). The window starts on the admin-set first day of school
// (fallback Aug 1). `scoped: true` tells the client to label the charts
// "your students".
// ---------------------------------------------------------------------------

router.get(
  "/hall-passes/research/report-feed",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: Staff }).staff;
    const visibility = await getVisibleStudentIds(staff, schoolId);
    const tz = await getSchoolTimezone(schoolId);
    const today = tzDay(new Date(), tz)!;

    let studentIds: string[] | null = null; // null = all (full visibility)
    if (!visibility.full) {
      studentIds = Array.from(visibility.ids);
      if (studentIds.length === 0) {
        // Shape-stable empty response with a deterministic window start so
        // the client's YTD axis still begins on the right day.
        const firstDayEmpty = await loadFirstDayOfSchool(schoolId);
        const winEmpty = quarterWindow(
          effectiveStartYear([], today),
          "all",
          firstDayEmpty,
        );
        res.json({
          firstDay: winEmpty.from,
          scoped: true,
          passes: [],
          students: [],
        });
        return;
      }
    }
    const passes = await db
      .select({
        id: hallPassesTable.id,
        studentId: hallPassesTable.studentId,
        destination: hallPassesTable.destination,
        teacherName: hallPassesTable.teacherName,
        status: hallPassesTable.status,
        maxDurationMinutes: hallPassesTable.maxDurationMinutes,
        createdAt: hallPassesTable.createdAt,
        endedAt: hallPassesTable.endedAt,
      })
      .from(hallPassesTable)
      .where(
        studentIds
          ? and(
              eq(hallPassesTable.schoolId, schoolId),
              inArray(hallPassesTable.studentId, studentIds),
            )
          : eq(hallPassesTable.schoolId, schoolId),
      );
    const passDays = passes
      .map((p) => tzDay(p.createdAt, tz))
      .filter((d): d is string => d != null);
    const startYear = effectiveStartYear(passDays, today);
    const firstDay = await loadFirstDayOfSchool(schoolId);
    const win = quarterWindow(startYear, "all", firstDay);

    // Grades for the YTD by-grade chart — resolved server-side so the
    // client never needs a school-wide roster for this.
    const sids = Array.from(new Set(passes.map((p) => p.studentId)));
    const gradeById = new Map<string, number>();
    let feedStudents: {
      studentId: string;
      firstName: string;
      lastName: string;
      grade: number;
      localSisId: string | null;
    }[] = [];
    if (sids.length) {
      feedStudents = await db
        .select({
          studentId: studentsTable.studentId,
          firstName: studentsTable.firstName,
          lastName: studentsTable.lastName,
          grade: studentsTable.grade,
          localSisId: studentsTable.localSisId,
        })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.schoolId, schoolId),
            inArray(studentsTable.studentId, sids),
          ),
        );
      for (const s of feedStudents) gradeById.set(s.studentId, s.grade);
    }

    const out = [];
    for (const p of passes) {
      const day = tzDay(p.createdAt, tz);
      if (!day || day < win.from || day > win.to) continue;
      out.push({
        id: p.id,
        studentId: p.studentId,
        grade: gradeById.get(p.studentId) ?? null,
        destination: p.destination,
        teacherName: p.teacherName,
        status: p.status,
        maxDurationMinutes: p.maxDurationMinutes,
        createdAt: p.createdAt,
        endedAt: p.endedAt,
        day,
      });
    }
    res.json({
      firstDay: win.from,
      scoped: !visibility.full,
      passes: out,
      students: feedStudents,
    });
  },
);

// ---------------------------------------------------------------------------
// GET /hall-passes/research/summary?studentId=&quarter=all|Q1..Q4
// One searched student: pass history + per-period dot graph + the acting
// teacher's teacher-of-record cells (lost minutes vs class average).
// ---------------------------------------------------------------------------

router.get(
  "/hall-passes/research/summary",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: Staff }).staff;
    const studentIdRaw = String(req.query.studentId ?? "").trim();
    if (!studentIdRaw) {
      res.status(400).json({ error: "studentId is required" });
      return;
    }
    const quarters = parseQuarters(req.query.quarters, req.query.quarter);

    const visibility = await getVisibleStudentIds(staff, schoolId);
    const [student] = await db
      .select({
        studentId: studentsTable.studentId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
        localSisId: studentsTable.localSisId,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          eq(studentsTable.studentId, studentIdRaw),
        ),
      )
      .limit(1);
    // Out-of-scope and non-existent collapse to ONE 404 (no probing).
    if (
      !student ||
      (!visibility.full && !visibility.ids.has(student.studentId))
    ) {
      res.status(404).json({ error: "No matching student" });
      return;
    }

    const tz = await getSchoolTimezone(schoolId);
    const windows = await loadDefaultPeriodWindows(schoolId);
    const periodLen = avgPeriodLength(windows);
    const today = tzDay(new Date(), tz)!;
    // Every pass this student has taken at this school.
    const passes = await db
      .select()
      .from(hallPassesTable)
      .where(
        and(
          eq(hallPassesTable.schoolId, schoolId),
          eq(hallPassesTable.studentId, student.studentId),
        ),
      );
    passes.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const startYear = effectiveStartYear(
      passes
        .map((p) => tzDay(p.createdAt, tz))
        .filter((d): d is string => d != null),
      today,
    );
    const firstDay = await loadFirstDayOfSchool(schoolId);
    const yearWin = quarterWindow(startYear, "all", firstDay);
    // Selected window(s): whole year when no quarters chosen, otherwise the
    // union of the chosen quarters (possibly disjoint, e.g. Q1+Q3).
    const wins =
      quarters.length === 0
        ? [yearWin]
        : quarters.map((q) => quarterWindow(startYear, q, firstDay));
    const inSelected = (day: string) =>
      wins.some((w) => day >= w.from && day <= w.to);

    // The acting teacher's own sections that contain this student:
    // (owner = me, non-planning) ⨝ section_roster(student).
    const mySections = await db
      .select({
        sectionId: classSectionsTable.id,
        period: classSectionsTable.period,
        courseName: classSectionsTable.courseName,
      })
      .from(classSectionsTable)
      .innerJoin(
        sectionRosterTable,
        eq(sectionRosterTable.sectionId, classSectionsTable.id),
      )
      .where(
        and(
          eq(classSectionsTable.schoolId, schoolId),
          eq(classSectionsTable.teacherStaffId, staff.id),
          eq(classSectionsTable.isPlanning, false),
          eq(sectionRosterTable.schoolId, schoolId),
          eq(sectionRosterTable.studentId, student.studentId),
        ),
      );
    const myByPeriod = new Map<
      number,
      { sectionId: number; courseName: string | null }
    >();
    for (const s of mySections) {
      if (s.period != null && !myByPeriod.has(s.period))
        myByPeriod.set(s.period, {
          sectionId: s.sectionId,
          courseName: s.courseName,
        });
    }

    // Tardies for the searched student — recorded directly against a
    // period at logging time, so no bell-schedule attribution is needed.
    const tardies = await db
      .select()
      .from(tardiesTable)
      .where(
        and(
          eq(tardiesTable.schoolId, schoolId),
          eq(tardiesTable.studentId, student.studentId),
        ),
      );

    // Per-period aggregation for the searched student.
    type Agg = {
      todayCount: number;
      historicCount: number;
      myLostMin: number;
      myQuarterCount: number;
      tardyYearCount: number;
      myTardyCount: number;
    };
    const agg = new Map<number, Agg>();
    const ensure = (p: number): Agg => {
      let a = agg.get(p);
      if (!a) {
        a = {
          todayCount: 0,
          historicCount: 0,
          myLostMin: 0,
          myQuarterCount: 0,
          tardyYearCount: 0,
          myTardyCount: 0,
        };
        agg.set(p, a);
      }
      return a;
    };
    let totalLostMin = 0;
    for (const p of passes) {
      const day = tzDay(p.createdAt, tz);
      if (!day) continue;
      const inYear = day >= yearWin.from && day <= yearWin.to;
      const period = periodForIso(windows, p.createdAt, tz);
      const lost = hallPassLostMinutes(p.createdAt, p.endedAt);
      if (inYear && lost != null) totalLostMin += lost;
      if (period == null) continue;
      const a = ensure(period);
      if (day === today) a.todayCount += 1;
      if (inYear && day !== today) a.historicCount += 1;
      if (myByPeriod.has(period) && inSelected(day)) {
        a.myQuarterCount += 1;
        if (lost != null) a.myLostMin += lost;
      }
    }

    // Fold tardies into the same per-period cells. Year total for every
    // cell; the teacher-of-record cells additionally get "tardies to MY
    // class" scoped to the selected quarter window(s).
    type TardyOut = {
      id: number;
      period: number | null;
      day: string | null;
      createdAt: string;
      reason: string;
      entryType: string;
    };
    const tardyRows: TardyOut[] = [];
    for (const t of tardies) {
      const day = tzDay(t.createdAt, tz);
      const period = /^\d+$/.test(t.period.trim())
        ? Number(t.period.trim())
        : null;
      const inYear = day != null && day >= yearWin.from && day <= yearWin.to;
      if (inYear)
        tardyRows.push({
          id: t.id,
          period,
          day,
          createdAt: t.createdAt,
          reason: t.reason,
          entryType: t.entryType,
        });
      if (period == null || day == null) continue;
      const a = ensure(period);
      if (inYear) a.tardyYearCount += 1;
      if (myByPeriod.has(period) && inSelected(day)) a.myTardyCount += 1;
    }

    // Class average lost minutes for each of my periods (quarter window):
    // mean per rostered student in that same section, zeros included.
    const classAvgByPeriod = new Map<number, number>();
    for (const [period, sec] of myByPeriod) {
      const roster = await db
        .select({ studentId: sectionRosterTable.studentId })
        .from(sectionRosterTable)
        .where(
          and(
            eq(sectionRosterTable.schoolId, schoolId),
            eq(sectionRosterTable.sectionId, sec.sectionId),
          ),
        );
      const ids = Array.from(new Set(roster.map((r) => r.studentId)));
      if (ids.length === 0) continue;
      const rows = await db
        .select({
          studentId: hallPassesTable.studentId,
          createdAt: hallPassesTable.createdAt,
          endedAt: hallPassesTable.endedAt,
        })
        .from(hallPassesTable)
        .where(
          and(
            eq(hallPassesTable.schoolId, schoolId),
            inArray(hallPassesTable.studentId, ids),
          ),
        );
      let total = 0;
      for (const r of rows) {
        const day = tzDay(r.createdAt, tz);
        if (!day || !inSelected(day)) continue;
        if (periodForIso(windows, r.createdAt, tz) !== period) continue;
        const m = hallPassLostMinutes(r.createdAt, r.endedAt);
        if (m != null) total += m;
      }
      classAvgByPeriod.set(period, Math.round((total / ids.length) * 10) / 10);
    }

    // Build the period cells from the default schedule (sorted). When the
    // school has no default schedule there is nothing to attribute to, so
    // periods comes back empty and the client explains why.
    const periods = Array.from(windows.keys())
      .sort((a, b) => a - b)
      .map((p) => {
        const w = windows.get(p)!;
        const a = agg.get(p);
        const mine = myByPeriod.get(p);
        return {
          period: p,
          lengthMin: w.lengthMin,
          todayCount: a?.todayCount ?? 0,
          historicCount: a?.historicCount ?? 0,
          isMine: !!mine,
          courseName: mine?.courseName ?? null,
          myLostMin: mine ? (a?.myLostMin ?? 0) : null,
          myQuarterPassCount: mine ? (a?.myQuarterCount ?? 0) : null,
          classAvgLostMin: mine ? (classAvgByPeriod.get(p) ?? 0) : null,
          tardyYearCount: a?.tardyYearCount ?? 0,
          myTardyCount: mine ? (a?.myTardyCount ?? 0) : null,
        };
      });

    res.json({
      student,
      quarters,
      windows: wins,
      periods,
      tardies: tardyRows,
      totals: {
        lostMin: totalLostMin,
        days: daysFromMinutes(totalLostMin, periodLen),
        periodLen,
      },
      passes: passes.map((p) => ({
        id: p.id,
        originRoom: p.originRoom,
        destination: p.destination,
        status: p.status,
        isTardyReturn: p.isTardyReturn,
        maxDurationMinutes: p.maxDurationMinutes,
        createdAt: p.createdAt,
        endedAt: p.endedAt,
        // School-local day, so client-side window filters agree with the
        // server's quarter attribution (no UTC-midnight drift).
        day: tzDay(p.createdAt, tz),
        period: periodForIso(windows, p.createdAt, tz),
        lostMin: hallPassLostMinutes(p.createdAt, p.endedAt),
      })),
    });
  },
);

export default router;
