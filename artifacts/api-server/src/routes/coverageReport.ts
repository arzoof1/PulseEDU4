// Coverage Report — teacher-effectiveness surface.
//
//   GET /coverage-report
//     ?teacherId=&subject=&window=&schoolYear=
//     → Layer 1 benchmark table: coverage count · teacher mastery% ·
//       peer mastery% · delta · PM1→2→3 growth. Also powers the Layer 2
//       charts (coverage-vs-mastery scatter + teacher-minus-peer bar),
//       which the client derives from the same benchmarks[] payload.
//
//   GET /coverage-report/benchmark
//     ?teacherId=&subject=&window=&schoolYear=&benchmarkCode=
//     → Layer 3 drill-down: by period, by subgroup (ESE/504/ELL/race/
//       gender, NO cell suppression — small groups are labeled), and an
//       admin-only per-student roster.
//
//   GET /coverage-report/send-outs
//     ?teacherId=
//     → Equity panel: discretionary (non-restroom) hall-pass send-outs
//       expressed as subgroup DISPROPORTIONALITY (each subgroup's share
//       of send-outs vs its share of the teacher's roster), not raw
//       counts. Attribution is by the student's period WITH this teacher
//       (roster membership), never bell-schedule timestamp math.
//
// Authorization mirrors fastBenchmarks.ts: any signed-in staff sees their
// OWN report; only Core Team may pass ?teacherId= for another teacher.
// Mastery engine (sum earned/possible per student|benchmark ≥ threshold),
// grade matching, and code sorting are the same conventions as the FAST
// Benchmarks heatmap so the numbers reconcile.

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import {
  db,
  staffTable,
  studentsTable,
  classSectionsTable,
  sectionRosterTable,
  studentFastItemResponsesTable,
  benchmarkDeliveriesTable,
  hallPassesTable,
  schoolSettingsTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam as isCoreTeamShared } from "../lib/coreTeam.js";
import { inferDepartment } from "../lib/teacherDepartments.js";
import { loadRestroomDestinationNames } from "../lib/oneWayPass.js";
import { schoolYearStartDate, DEFAULT_SCHOOL_TZ } from "../lib/schoolYear.js";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

const VALID_SUBJECTS = new Set(["ela", "math", "algebra1", "geometry"]);
const VALID_WINDOWS = ["pm1", "pm2", "pm3"] as const;
type Window = (typeof VALID_WINDOWS)[number];

async function resolveStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function isCoreTeam(s: StaffRow): boolean {
  return isCoreTeamShared(s);
}

// The grade lives in the 2nd dotted segment of a Florida benchmark code
// ("ELA.6.R.1.1", "MA.7.AR.1.1"). Used to drop cross-grade contamination
// so a benchmark column only counts students at that grade.
function codeMatchesStudentGrade(
  code: string,
  studentGrade: number | null | undefined,
): boolean {
  const codeGrade = Number(code.split(".")[1]);
  if (!Number.isFinite(codeGrade)) return false;
  const sg = Number(studentGrade);
  if (!Number.isFinite(sg)) return false;
  return codeGrade === sg;
}

// Natural sort for benchmark codes (numeric segments numerically).
function compareBenchmarkCodes(a: string, b: string): number {
  const ap = a.split(".");
  const bp = b.split(".");
  const n = Math.min(ap.length, bp.length);
  for (let i = 0; i < n; i += 1) {
    const an = Number(ap[i]);
    const bn = Number(bp[i]);
    if (Number.isFinite(an) && Number.isFinite(bn)) {
      if (an !== bn) return an - bn;
    } else {
      const cmp = ap[i].localeCompare(bp[i]);
      if (cmp !== 0) return cmp;
    }
  }
  return ap.length - bp.length;
}

interface TeacherContext {
  schoolId: number;
  actor: StaffRow;
  target: StaffRow;
  isCore: boolean;
  subject: string;
  thresholdPct: number;
}

// Shared auth + param front-half: resolve actor, validate subject, gate
// ?teacherId= to Core Team, load the target teacher + mastery threshold.
async function resolveTeacherContext(
  req: Request,
  res: Response,
): Promise<TeacherContext | null> {
  const actor = await resolveStaff(req);
  if (!actor) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return null;

  const rawSubject = req.query.subject;
  const subject = typeof rawSubject === "string" ? rawSubject : "ela";
  if (!VALID_SUBJECTS.has(subject)) {
    res.status(400).json({ error: "Invalid subject" });
    return null;
  }

  const rawTeacherId = req.query.teacherId;
  let targetTeacherId = actor.id;
  if (typeof rawTeacherId === "string" && rawTeacherId.length > 0) {
    const parsed = Number(rawTeacherId);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      res.status(400).json({ error: "Invalid teacherId" });
      return null;
    }
    if (parsed !== actor.id && !isCoreTeam(actor)) {
      res.status(403).json({
        error: "Only core team can view another teacher's report",
      });
      return null;
    }
    targetTeacherId = parsed;
  }

  const [target] = await db
    .select()
    .from(staffTable)
    .where(
      and(eq(staffTable.id, targetTeacherId), eq(staffTable.schoolId, schoolId)),
    );
  if (!target) {
    res.status(404).json({ error: "Teacher not found" });
    return null;
  }

  const [settings] = await db
    .select()
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  const thresholdPct = settings?.fastBenchmarkMasteryThreshold ?? 80;

  return {
    schoolId,
    actor,
    target,
    isCore: isCoreTeam(actor),
    subject,
    thresholdPct,
  };
}

// Load the target teacher's non-planning sections + roster. Returns the
// roster studentIds and a studentId → period[] map (a student can sit in
// more than one of the teacher's periods — rare, but we keep every one so
// send-out attribution and by-period splits stay honest).
async function loadTeacherRoster(
  schoolId: number,
  teacherId: number,
): Promise<{
  studentIds: string[];
  periodsByStudent: Map<string, number[]>;
}> {
  const sections = await db
    .select({ id: classSectionsTable.id, period: classSectionsTable.period })
    .from(classSectionsTable)
    .where(
      and(
        eq(classSectionsTable.schoolId, schoolId),
        eq(classSectionsTable.teacherStaffId, teacherId),
        eq(classSectionsTable.isPlanning, false),
      ),
    );
  const periodBySection = new Map<number, number>();
  for (const s of sections) periodBySection.set(s.id, s.period);
  const sectionIds = sections.map((s) => s.id);
  const periodsByStudent = new Map<string, number[]>();
  if (sectionIds.length === 0) {
    return { studentIds: [], periodsByStudent };
  }
  const rosterRows = await db
    .select({
      studentId: sectionRosterTable.studentId,
      sectionId: sectionRosterTable.sectionId,
    })
    .from(sectionRosterTable)
    .where(
      and(
        eq(sectionRosterTable.schoolId, schoolId),
        inArray(sectionRosterTable.sectionId, sectionIds),
      ),
    );
  for (const r of rosterRows) {
    const period = periodBySection.get(r.sectionId);
    if (period == null) continue;
    const list = periodsByStudent.get(r.studentId) ?? [];
    if (!list.includes(period)) list.push(period);
    periodsByStudent.set(r.studentId, list);
  }
  return {
    studentIds: Array.from(periodsByStudent.keys()),
    periodsByStudent,
  };
}

// Per (studentId, window, benchmarkCode) summed points, aggregated in SQL
// so we ship one row per assessed benchmark rather than per item.
interface MasteryRow {
  studentId: string;
  window: string;
  benchmarkCode: string;
  earned: number;
  possible: number;
}

async function loadMasteryRows(
  schoolId: number,
  subject: string,
  schoolYear: string,
  opts: { window?: string; studentIds?: string[] },
): Promise<MasteryRow[]> {
  const conds = [
    eq(studentFastItemResponsesTable.schoolId, schoolId),
    eq(studentFastItemResponsesTable.subject, subject),
    eq(studentFastItemResponsesTable.schoolYear, schoolYear),
  ];
  if (opts.window) {
    conds.push(eq(studentFastItemResponsesTable.window, opts.window));
  }
  if (opts.studentIds) {
    if (opts.studentIds.length === 0) return [];
    conds.push(inArray(studentFastItemResponsesTable.studentId, opts.studentIds));
  }
  const rows = await db
    .select({
      studentId: studentFastItemResponsesTable.studentId,
      window: studentFastItemResponsesTable.window,
      benchmarkCode: studentFastItemResponsesTable.benchmarkCode,
      earned: sql<number>`coalesce(sum(${studentFastItemResponsesTable.pointsEarned}), 0)::int`,
      possible: sql<number>`coalesce(sum(${studentFastItemResponsesTable.pointsPossible}), 0)::int`,
    })
    .from(studentFastItemResponsesTable)
    .where(and(...conds))
    .groupBy(
      studentFastItemResponsesTable.studentId,
      studentFastItemResponsesTable.window,
      studentFastItemResponsesTable.benchmarkCode,
    );
  return rows;
}

// Fold mastery rows into per-benchmark { withData, mastered } tallies for a
// single window. `keep(studentId)` restricts the population (e.g. teacher
// roster vs peers); grade matching drops cross-grade columns.
function tallyByBenchmark(
  rows: MasteryRow[],
  window: string,
  thresholdPct: number,
  gradeOf: Map<string, number | null>,
  keep: (studentId: string) => boolean,
): Map<string, { withData: number; mastered: number }> {
  const out = new Map<string, { withData: number; mastered: number }>();
  for (const r of rows) {
    if (r.window !== window) continue;
    if (!keep(r.studentId)) continue;
    if (r.possible <= 0) continue;
    if (!codeMatchesStudentGrade(r.benchmarkCode, gradeOf.get(r.studentId)))
      continue;
    const pct = (r.earned / r.possible) * 100;
    const cur = out.get(r.benchmarkCode) ?? { withData: 0, mastered: 0 };
    cur.withData += 1;
    if (pct >= thresholdPct) cur.mastered += 1;
    out.set(r.benchmarkCode, cur);
  }
  return out;
}

function pct(mastered: number, withData: number): number | null {
  if (withData <= 0) return null;
  return Math.round((mastered / withData) * 1000) / 10;
}

// Load grade for a set of studentIds.
async function loadGrades(
  schoolId: number,
  studentIds: string[],
): Promise<Map<string, number | null>> {
  const map = new Map<string, number | null>();
  if (studentIds.length === 0) return map;
  const rows = await db
    .select({ studentId: studentsTable.studentId, grade: studentsTable.grade })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        inArray(studentsTable.studentId, studentIds),
      ),
    );
  for (const r of rows) map.set(r.studentId, r.grade);
  return map;
}

// ---------------------------------------------------------------------------
// GET /coverage-report — Layer 1 + Layer 2 payload.
// ---------------------------------------------------------------------------
router.get("/coverage-report", async (req, res) => {
  const ctx = await resolveTeacherContext(req, res);
  if (!ctx) return;
  const { schoolId, target, subject, thresholdPct } = ctx;

  const { studentIds: rosterIds } = await loadTeacherRoster(schoolId, target.id);

  // Which (schoolYear, window) tuples have any data for this subject at
  // the school — drives the picker and the schoolYear default.
  const availRows = await db
    .select({
      schoolYear: studentFastItemResponsesTable.schoolYear,
      window: studentFastItemResponsesTable.window,
    })
    .from(studentFastItemResponsesTable)
    .where(
      and(
        eq(studentFastItemResponsesTable.schoolId, schoolId),
        eq(studentFastItemResponsesTable.subject, subject),
      ),
    )
    .groupBy(
      studentFastItemResponsesTable.schoolYear,
      studentFastItemResponsesTable.window,
    );
  const windowRank: Record<string, number> = { pm3: 0, pm2: 1, pm1: 2 };
  const availableWindows = availRows
    .filter((r) => VALID_WINDOWS.includes(r.window as Window))
    .sort((a, b) => {
      if (a.schoolYear !== b.schoolYear)
        return b.schoolYear.localeCompare(a.schoolYear);
      return (windowRank[a.window] ?? 9) - (windowRank[b.window] ?? 9);
    })
    .map((r) => ({
      schoolYear: r.schoolYear,
      window: r.window,
      label: `${r.schoolYear} ${r.window.toUpperCase()}`,
    }));

  const rawSchoolYear = req.query.schoolYear;
  const schoolYear =
    typeof rawSchoolYear === "string" && rawSchoolYear.length > 0
      ? rawSchoolYear
      : (availableWindows[0]?.schoolYear ?? "");
  const rawWindow = req.query.window;
  const window =
    typeof rawWindow === "string" && VALID_WINDOWS.includes(rawWindow as Window)
      ? rawWindow
      : (availableWindows.find((w) => w.schoolYear === schoolYear)?.window ??
        "pm3");

  if (!schoolYear) {
    res.json({
      teacher: {
        id: target.id,
        displayName: target.displayName,
        department: target.department ?? null,
      },
      subject,
      window,
      schoolYear: "",
      thresholdPct,
      availableWindows,
      peerTeacherCount: 0,
      benchmarks: [],
    });
    return;
  }

  // Teacher rows: all windows (for growth) restricted to the roster.
  const teacherRows = await loadMasteryRows(schoolId, subject, schoolYear, {
    studentIds: rosterIds,
  });
  // Peer rows: selected window, school-wide (we exclude the roster below).
  const schoolWindowRows = await loadMasteryRows(schoolId, subject, schoolYear, {
    window,
  });

  // Grades for everyone who appears (roster + school-wide contributors).
  const allIds = Array.from(
    new Set([
      ...rosterIds,
      ...schoolWindowRows.map((r) => r.studentId),
      ...teacherRows.map((r) => r.studentId),
    ]),
  );
  const gradeOf = await loadGrades(schoolId, allIds);
  const rosterSet = new Set(rosterIds);

  // Coverage counts (deliveries) per benchmark for this teacher + subject.
  const deliveries = await db
    .select({
      benchmarkCode: benchmarkDeliveriesTable.benchmarkCode,
      count: sql<number>`count(*)::int`,
    })
    .from(benchmarkDeliveriesTable)
    .where(
      and(
        eq(benchmarkDeliveriesTable.schoolId, schoolId),
        eq(benchmarkDeliveriesTable.teacherStaffId, target.id),
        eq(benchmarkDeliveriesTable.subject, subject),
      ),
    )
    .groupBy(benchmarkDeliveriesTable.benchmarkCode);
  const coverageOf = new Map<string, number>();
  for (const d of deliveries) coverageOf.set(d.benchmarkCode, d.count);

  // Teacher tallies per window (selected window + growth windows).
  const teacherByWindow: Record<
    string,
    Map<string, { withData: number; mastered: number }>
  > = {};
  for (const w of VALID_WINDOWS) {
    teacherByWindow[w] = tallyByBenchmark(
      teacherRows,
      w,
      thresholdPct,
      gradeOf,
      (sid) => rosterSet.has(sid),
    );
  }
  // Peer tally (selected window, non-roster, grade-matched).
  const peerTally = tallyByBenchmark(
    schoolWindowRows,
    window,
    thresholdPct,
    gradeOf,
    (sid) => !rosterSet.has(sid),
  );

  // Peer teacher count: distinct OTHER teachers who roster any non-roster
  // student that contributed a grade-matched, selected-window response.
  const peerContributors = new Set<string>();
  for (const r of schoolWindowRows) {
    if (r.window !== window) continue;
    if (rosterSet.has(r.studentId)) continue;
    if (r.possible <= 0) continue;
    if (!codeMatchesStudentGrade(r.benchmarkCode, gradeOf.get(r.studentId)))
      continue;
    peerContributors.add(r.studentId);
  }
  let peerTeacherCount = 0;
  if (peerContributors.size > 0) {
    const peerTeacherRows = await db
      .selectDistinct({ teacherStaffId: classSectionsTable.teacherStaffId })
      .from(sectionRosterTable)
      .innerJoin(
        classSectionsTable,
        eq(classSectionsTable.id, sectionRosterTable.sectionId),
      )
      .where(
        and(
          eq(sectionRosterTable.schoolId, schoolId),
          eq(classSectionsTable.isPlanning, false),
          inArray(sectionRosterTable.studentId, Array.from(peerContributors)),
        ),
      );
    peerTeacherCount = peerTeacherRows.filter(
      (t) => t.teacherStaffId !== target.id,
    ).length;
  }

  // Union of every benchmark that shows up anywhere so the table is complete.
  const codes = new Set<string>();
  for (const c of coverageOf.keys()) codes.add(c);
  for (const w of VALID_WINDOWS)
    for (const c of teacherByWindow[w].keys()) codes.add(c);
  for (const c of peerTally.keys()) codes.add(c);

  const benchmarks = Array.from(codes)
    .sort(compareBenchmarkCodes)
    .map((code) => {
      const t = teacherByWindow[window].get(code);
      const p = peerTally.get(code);
      const teacherMasteryPct = t ? pct(t.mastered, t.withData) : null;
      const peerMasteryPct = p ? pct(p.mastered, p.withData) : null;
      const delta =
        teacherMasteryPct != null && peerMasteryPct != null
          ? Math.round((teacherMasteryPct - peerMasteryPct) * 10) / 10
          : null;
      const growth: Record<string, number | null> = {};
      for (const w of VALID_WINDOWS) {
        const g = teacherByWindow[w].get(code);
        growth[w] = g ? pct(g.mastered, g.withData) : null;
      }
      return {
        code,
        coverageCount: coverageOf.get(code) ?? 0,
        teacherMasteryPct,
        teacherStudents: t?.withData ?? 0,
        peerMasteryPct,
        peerStudents: p?.withData ?? 0,
        delta,
        growth,
      };
    });

  res.json({
    teacher: {
      id: target.id,
      displayName: target.displayName,
      department: target.department ?? null,
    },
    subject,
    window,
    schoolYear,
    thresholdPct,
    availableWindows,
    peerTeacherCount,
    benchmarks,
  });
});

// ---------------------------------------------------------------------------
// GET /coverage-report/benchmark — Layer 3 drill-down for one benchmark.
// ---------------------------------------------------------------------------
interface DemoRow {
  studentId: string;
  firstName: string;
  lastName: string;
  localSisId: string | null;
  grade: number | null;
  gender: string | null;
  ell: boolean;
  ese: boolean;
  is504: boolean;
  race: string | null;
}

const SUBGROUP_DIMENSIONS: Array<{
  key: string;
  label: string;
  groupsFor: (d: DemoRow) => string[];
}> = [
  { key: "ese", label: "ESE", groupsFor: (d) => [d.ese ? "ESE" : "Non-ESE"] },
  { key: "is504", label: "504", groupsFor: (d) => [d.is504 ? "504" : "Non-504"] },
  { key: "ell", label: "ELL", groupsFor: (d) => [d.ell ? "ELL" : "Non-ELL"] },
  {
    key: "race",
    label: "Race / ethnicity",
    groupsFor: (d) => [d.race && d.race.trim() ? d.race.trim() : "Unspecified"],
  },
  {
    key: "gender",
    label: "Gender",
    groupsFor: (d) => [
      d.gender && d.gender.trim() ? d.gender.trim() : "Unspecified",
    ],
  },
];

router.get("/coverage-report/benchmark", async (req, res) => {
  const ctx = await resolveTeacherContext(req, res);
  if (!ctx) return;
  const { schoolId, target, subject, thresholdPct, isCore } = ctx;

  const rawWindow = req.query.window;
  const window =
    typeof rawWindow === "string" && VALID_WINDOWS.includes(rawWindow as Window)
      ? rawWindow
      : "pm3";
  const rawSchoolYear = req.query.schoolYear;
  const schoolYear =
    typeof rawSchoolYear === "string" ? rawSchoolYear : "";
  const rawCode = req.query.benchmarkCode;
  const benchmarkCode = typeof rawCode === "string" ? rawCode : "";
  if (!schoolYear || !benchmarkCode) {
    res.status(400).json({ error: "schoolYear and benchmarkCode are required" });
    return;
  }
  const benchGrade = Number(benchmarkCode.split(".")[1]);

  const { studentIds: rosterIds, periodsByStudent } = await loadTeacherRoster(
    schoolId,
    target.id,
  );
  const rosterSet = new Set(rosterIds);

  // Per-student summed points for THIS benchmark + window (roster + school).
  const rows = await db
    .select({
      studentId: studentFastItemResponsesTable.studentId,
      earned: sql<number>`coalesce(sum(${studentFastItemResponsesTable.pointsEarned}), 0)::int`,
      possible: sql<number>`coalesce(sum(${studentFastItemResponsesTable.pointsPossible}), 0)::int`,
    })
    .from(studentFastItemResponsesTable)
    .where(
      and(
        eq(studentFastItemResponsesTable.schoolId, schoolId),
        eq(studentFastItemResponsesTable.subject, subject),
        eq(studentFastItemResponsesTable.schoolYear, schoolYear),
        eq(studentFastItemResponsesTable.window, window),
        eq(studentFastItemResponsesTable.benchmarkCode, benchmarkCode),
      ),
    )
    .groupBy(studentFastItemResponsesTable.studentId);

  const masteryByStudent = new Map<
    string,
    { earned: number; possible: number; mastered: boolean }
  >();
  for (const r of rows) {
    if (r.possible <= 0) continue;
    masteryByStudent.set(r.studentId, {
      earned: r.earned,
      possible: r.possible,
      mastered: (r.earned / r.possible) * 100 >= thresholdPct,
    });
  }

  // Demographics for everyone contributing, plus grade to filter to the
  // benchmark's grade (peers = same-grade non-roster students).
  const contributorIds = Array.from(masteryByStudent.keys());
  const demoIds = Array.from(new Set([...rosterIds, ...contributorIds]));
  const demoRows: DemoRow[] = demoIds.length
    ? await db
        .select({
          studentId: studentsTable.studentId,
          firstName: studentsTable.firstName,
          lastName: studentsTable.lastName,
          localSisId: studentsTable.localSisId,
          grade: studentsTable.grade,
          gender: studentsTable.gender,
          ell: studentsTable.ell,
          ese: studentsTable.ese,
          is504: studentsTable.is504,
          race: studentsTable.race,
        })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.schoolId, schoolId),
            inArray(studentsTable.studentId, demoIds),
          ),
        )
    : [];
  const demoOf = new Map<string, DemoRow>();
  for (const d of demoRows) demoOf.set(d.studentId, d);

  const gradeMatches = (sid: string) =>
    Number(demoOf.get(sid)?.grade) === benchGrade;

  // By period (teacher roster only).
  const periodTally = new Map<number, { withData: number; mastered: number }>();
  for (const sid of rosterIds) {
    if (!gradeMatches(sid)) continue;
    const m = masteryByStudent.get(sid);
    if (!m) continue;
    for (const p of periodsByStudent.get(sid) ?? []) {
      const cur = periodTally.get(p) ?? { withData: 0, mastered: 0 };
      cur.withData += 1;
      if (m.mastered) cur.mastered += 1;
      periodTally.set(p, cur);
    }
  }
  const byPeriod = Array.from(periodTally.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([period, t]) => ({
      period,
      students: t.withData,
      masteryPct: pct(t.mastered, t.withData),
    }));

  // By subgroup — teacher roster vs same-grade peers, NO suppression.
  const bySubgroup = SUBGROUP_DIMENSIONS.map((dim) => {
    const groups = new Map<
      string,
      {
        tWith: number;
        tMast: number;
        pWith: number;
        pMast: number;
      }
    >();
    const ensure = (g: string) => {
      let cur = groups.get(g);
      if (!cur) {
        cur = { tWith: 0, tMast: 0, pWith: 0, pMast: 0 };
        groups.set(g, cur);
      }
      return cur;
    };
    for (const [sid, m] of masteryByStudent) {
      const d = demoOf.get(sid);
      if (!d || Number(d.grade) !== benchGrade) continue;
      const isRoster = rosterSet.has(sid);
      for (const g of dim.groupsFor(d)) {
        const cur = ensure(g);
        if (isRoster) {
          cur.tWith += 1;
          if (m.mastered) cur.tMast += 1;
        } else {
          cur.pWith += 1;
          if (m.mastered) cur.pMast += 1;
        }
      }
    }
    return {
      key: dim.key,
      label: dim.label,
      groups: Array.from(groups.entries())
        .filter(([, v]) => v.tWith > 0)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([group, v]) => ({
          group,
          teacherStudents: v.tWith,
          teacherMasteryPct: pct(v.tMast, v.tWith),
          peerStudents: v.pWith,
          peerMasteryPct: pct(v.pMast, v.pWith),
          small: v.tWith < 10,
        })),
    };
  });

  // Admin-only per-student roster for this benchmark.
  let roster:
    | Array<{
        name: string;
        localSisId: string | null;
        periods: number[];
        earned: number;
        possible: number;
        masteryPct: number | null;
        mastered: boolean;
      }>
    | null = null;
  if (isCore) {
    roster = rosterIds
      .filter((sid) => gradeMatches(sid) && masteryByStudent.has(sid))
      .map((sid) => {
        const m = masteryByStudent.get(sid)!;
        const d = demoOf.get(sid);
        return {
          name: d ? `${d.lastName}, ${d.firstName}` : (d ?? sid).toString(),
          localSisId: d?.localSisId ?? null,
          periods: (periodsByStudent.get(sid) ?? []).sort((a, b) => a - b),
          earned: m.earned,
          possible: m.possible,
          masteryPct: Math.round((m.earned / m.possible) * 1000) / 10,
          mastered: m.mastered,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  res.json({
    benchmarkCode,
    window,
    schoolYear,
    thresholdPct,
    byPeriod,
    bySubgroup,
    roster,
    adminOnly: isCore,
  });
});

// ---------------------------------------------------------------------------
// GET /coverage-report/send-outs — Equity panel (disproportionality).
// ---------------------------------------------------------------------------
router.get("/coverage-report/send-outs", async (req, res) => {
  const ctx = await resolveTeacherContext(req, res);
  if (!ctx) return;
  const { schoolId, target } = ctx;

  const { studentIds: rosterIds, periodsByStudent } = await loadTeacherRoster(
    schoolId,
    target.id,
  );
  const rosterSet = new Set(rosterIds);
  const periods = Array.from(
    new Set(Array.from(periodsByStudent.values()).flat()),
  ).sort((a, b) => a - b);

  // Demographics for the roster.
  const demoRows: DemoRow[] = rosterIds.length
    ? await db
        .select({
          studentId: studentsTable.studentId,
          firstName: studentsTable.firstName,
          lastName: studentsTable.lastName,
          localSisId: studentsTable.localSisId,
          grade: studentsTable.grade,
          gender: studentsTable.gender,
          ell: studentsTable.ell,
          ese: studentsTable.ese,
          is504: studentsTable.is504,
          race: studentsTable.race,
        })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.schoolId, schoolId),
            inArray(studentsTable.studentId, rosterIds),
          ),
        )
    : [];
  const demoOf = new Map<string, DemoRow>();
  for (const d of demoRows) demoOf.set(d.studentId, d);

  // Discretionary (non-restroom) send-outs attributed to this teacher.
  const restroomNames = await loadRestroomDestinationNames(schoolId);
  const startIso = schoolYearStartDate(new Date(), DEFAULT_SCHOOL_TZ)
    .toISOString();
  const passRows = target.displayName
    ? await db
        .select({
          studentId: hallPassesTable.studentId,
          destination: hallPassesTable.destination,
          createdAt: hallPassesTable.createdAt,
        })
        .from(hallPassesTable)
        .where(
          and(
            eq(hallPassesTable.schoolId, schoolId),
            eq(hallPassesTable.teacherName, target.displayName),
          ),
        )
    : [];

  // Count send-outs per student (roster-scoped, non-restroom, this SY).
  const sendOutsByStudent = new Map<string, number>();
  let totalSendOuts = 0;
  for (const p of passRows) {
    if (p.createdAt < startIso) continue;
    if (restroomNames.has(p.destination)) continue;
    if (!rosterSet.has(p.studentId)) continue;
    sendOutsByStudent.set(
      p.studentId,
      (sendOutsByStudent.get(p.studentId) ?? 0) + 1,
    );
    totalSendOuts += 1;
  }

  // For each dimension: per group, roster count + send-out count, both
  // overall and per period (a student is attributed to each of their
  // periods with this teacher). Client turns this into shares + a
  // disproportionality index (send-out share ÷ roster share).
  const dimensions = SUBGROUP_DIMENSIONS.map((dim) => {
    const groups = new Map<
      string,
      {
        rosterCount: number;
        sendOuts: number;
        byPeriod: Map<number, { rosterCount: number; sendOuts: number }>;
      }
    >();
    const ensure = (g: string) => {
      let cur = groups.get(g);
      if (!cur) {
        cur = { rosterCount: 0, sendOuts: 0, byPeriod: new Map() };
        groups.set(g, cur);
      }
      return cur;
    };
    for (const sid of rosterIds) {
      const d = demoOf.get(sid);
      if (!d) continue;
      const so = sendOutsByStudent.get(sid) ?? 0;
      const studentPeriods = periodsByStudent.get(sid) ?? [];
      for (const g of dim.groupsFor(d)) {
        const cur = ensure(g);
        cur.rosterCount += 1;
        cur.sendOuts += so;
        for (const p of studentPeriods) {
          const pc = cur.byPeriod.get(p) ?? { rosterCount: 0, sendOuts: 0 };
          pc.rosterCount += 1;
          pc.sendOuts += so; // per-period roster attribution
          cur.byPeriod.set(p, pc);
        }
      }
    }
    return {
      key: dim.key,
      label: dim.label,
      groups: Array.from(groups.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([group, v]) => ({
          group,
          rosterCount: v.rosterCount,
          sendOuts: v.sendOuts,
          byPeriod: Array.from(v.byPeriod.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([period, pc]) => ({
              period,
              rosterCount: pc.rosterCount,
              sendOuts: pc.sendOuts,
            })),
        })),
    };
  });

  res.json({
    teacher: {
      id: target.id,
      displayName: target.displayName,
      department: target.department ?? inferDepartment([]),
    },
    rosterSize: rosterIds.length,
    totalSendOuts,
    periods,
    dimensions,
  });
});

export default router;
