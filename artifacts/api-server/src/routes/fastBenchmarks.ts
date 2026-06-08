// FAST Phase 2 — Teacher Roster → Benchmarks tab.
//
// Routes:
//   GET /api/teacher-roster/benchmarks
//          ?teacherId=&subject=&window=&schoolYear=
//        → roster × benchmark matrix + bottom-3 + window picker.
//
//   GET /api/teacher-roster/benchmarks/drill
//          ?teacherId=&subject=&window=&schoolYear=&benchmarkCode=
//        → per-student drilldown for a single benchmark (the modal).
//
//   GET /api/teacher-roster/benchmarks/pdf
//          ?teacherId=&subject=&window=&schoolYear=
//        → printable heatmap (one PDF per teacher × window).
//
//   GET /api/teacher-roster/benchmarks/progress-report
//          ?teacherId=&subject=&schoolYear=
//        → per-student × per-benchmark × per-window item responses
//          for the printable Benchmark Progress Report. One fetch
//          covers PM1+PM2+PM3 so the client can render every student
//          page without round-trips.
//
// Auth model: same gate as /api/teacher-roster — own roster always
// allowed; another teacher's roster only for core team (admin /
// superuser / ESE / behavior / MTSS coordinator).
//
// Backing data: `student_fast_item_responses` (FAST Phase 1 import).
// We aggregate at read time (`SUM(points_earned) / SUM(points_possible)`
// per (student, benchmark_code)) so duplicated item rows for the same
// benchmark in one administration collapse to a single mastery percent.
//
// Mastery threshold comes from `school_settings.fast_benchmark_mastery_threshold`
// (default 80%). Heatmap color buckets on the client are derived from
// this single number.
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
  studentTrustedAdultsTable,
  studentMtssPlansTable,
  schoolBenchmarksTable,
  benchmarkReteachLogTable,
} from "@workspace/db";
import { and, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { requireSchool } from "../lib/scope.js";
import {
  placeOnChart,
  bucketTarget,
  SUB_LEVEL_LABEL,
  type Subject as FastSubject,
} from "../lib/fastCutScores.js";
import { isCoreTeam as isCoreTeamShared } from "../lib/coreTeam.js";
import { schoolYearLabelFor, DEFAULT_SCHOOL_TZ } from "../lib/schoolYear.js";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

const VALID_SUBJECTS = new Set(["ela", "math", "algebra1", "geometry"]);
const VALID_WINDOWS = new Set(["pm1", "pm2", "pm3"]);

async function resolveStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

// Reuse the canonical Core Team predicate from lib/coreTeam.ts so
// Insights authorization is a single source of truth (no role drift
// between this file and the rest of the server). Membership: SuperUser,
// District Admin, school Admin, Behavior Specialist, MTSS Coordinator,
// School Psychologist. ESE Coordinator is intentionally NOT a member
// per the canonical definition.
function isCoreTeam(s: StaffRow): boolean {
  return isCoreTeamShared(s);
}

// Natural sort for Florida benchmark codes like "ELA.6.R.1.10" vs
// "ELA.6.R.1.2" — split on '.', compare numeric segments numerically,
// string segments lexically. Without this "ELA.6.R.1.10" sorts ahead
// of "ELA.6.R.1.2" alphabetically, which is wrong.
// True when a Florida benchmark code's grade segment matches the
// student's roster grade. The grade lives in the 2nd dotted segment
// for both ELA/MA codes ("ELA.6.R.1.1", "MA.7.AR.1.1"). We use this
// to filter out cross-grade contamination (e.g. a 7th-grader who has
// both 7th- and 8th-grade FAST responses in the same import) so the
// teacher's heatmap only shows the columns that belong to the
// student's current grade. Non-numeric / missing grade segments
// (e.g. "N/A" placeholder rows) are dropped entirely.
function codeMatchesStudentGrade(
  code: string,
  studentGrade: number | string | null | undefined,
): boolean {
  const seg = code.split(".")[1];
  const codeGrade = Number(seg);
  if (!Number.isFinite(codeGrade)) return false;
  const sg = Number(studentGrade);
  if (!Number.isFinite(sg)) return false;
  return codeGrade === sg;
}

function compareBenchmarkCodes(a: string, b: string): number {
  const ap = a.split(".");
  const bp = b.split(".");
  const n = Math.min(ap.length, bp.length);
  for (let i = 0; i < n; i += 1) {
    const av = ap[i];
    const bv = bp[i];
    const an = Number(av);
    const bn = Number(bv);
    if (Number.isFinite(an) && Number.isFinite(bn)) {
      if (an !== bn) return an - bn;
    } else {
      const cmp = av.localeCompare(bv);
      if (cmp !== 0) return cmp;
    }
  }
  return ap.length - bp.length;
}

interface ResolvedContext {
  schoolId: number;
  staff: StaffRow;
  targetTeacher: StaffRow;
  studentIds: string[];
  thresholdPct: number;
  subject: string;
  // When a `period` query param is supplied, the studentIds list is
  // narrowed to that period's section roster and `period` is the
  // numeric period filter that was applied. Null = no filter (union
  // across all periods, the legacy default).
  period: number | null;
}

// Shared front-half of every endpoint here: parse + validate
// teacher/subject params, do the auth gate, load the teacher's roster
// (union across all periods), and look up the school's mastery
// threshold. Returns null after sending a response on error.
async function resolveContext(
  req: Request,
  res: Response,
): Promise<ResolvedContext | null> {
  const staff = await resolveStaff(req);
  if (!staff) {
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
  let targetTeacherId = staff.id;
  if (typeof rawTeacherId === "string" && rawTeacherId.length > 0) {
    const parsed = Number(rawTeacherId);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      res.status(400).json({ error: "Invalid teacherId" });
      return null;
    }
    if (parsed !== staff.id && !isCoreTeam(staff)) {
      res.status(403).json({
        error: "Only core team can view another teacher's roster",
      });
      return null;
    }
    targetTeacherId = parsed;
  }

  const [targetTeacher] = await db
    .select()
    .from(staffTable)
    .where(
      and(
        eq(staffTable.id, targetTeacherId),
        eq(staffTable.schoolId, schoolId),
      ),
    );
  if (!targetTeacher) {
    res.status(404).json({ error: "Teacher not found" });
    return null;
  }

  // Optional period filter — when present, narrow the roster to the
  // section(s) for that period. Mirrors the Teacher Roster page's
  // period selector so the Benchmarks heatmap + Print PDF respect
  // whatever the teacher had selected.
  const rawPeriod = req.query.period;
  let period: number | null = null;
  if (typeof rawPeriod === "string" && rawPeriod.length > 0) {
    const parsed = Number(rawPeriod);
    if (Number.isInteger(parsed) && parsed > 0) {
      period = parsed;
    }
  }

  // Roster (default: union of periods). When `period` is supplied,
  // narrow to that period's section roster only.
  const sectionsQuery = db
    .select({ id: classSectionsTable.id })
    .from(classSectionsTable)
    .where(
      period == null
        ? and(
            eq(classSectionsTable.schoolId, schoolId),
            eq(classSectionsTable.teacherStaffId, targetTeacherId),
          )
        : and(
            eq(classSectionsTable.schoolId, schoolId),
            eq(classSectionsTable.teacherStaffId, targetTeacherId),
            eq(classSectionsTable.period, period),
          ),
    );
  const sections = await sectionsQuery;
  const sectionIds = sections.map((s) => s.id);

  let studentIds: string[] = [];
  if (sectionIds.length > 0) {
    const rosterRows = await db
      .select({ studentId: sectionRosterTable.studentId })
      .from(sectionRosterTable)
      .where(
        and(
          eq(sectionRosterTable.schoolId, schoolId),
          inArray(sectionRosterTable.sectionId, sectionIds),
        ),
      );
    studentIds = Array.from(new Set(rosterRows.map((r) => r.studentId)));
  }

  const [settingsRow] = await db
    .select()
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  const thresholdPct = settingsRow?.fastBenchmarkMasteryThreshold ?? 80;

  return {
    schoolId,
    staff,
    targetTeacher,
    studentIds,
    thresholdPct,
    subject,
    period,
  };
}

// Resolve which (schoolYear, window) tuples have ANY data for this
// roster + subject. Used both to populate the picker and to default
// the selection sensibly when the caller doesn't pass params.
async function loadAvailableWindows(
  schoolId: number,
  subject: string,
  studentIds: string[],
): Promise<Array<{ schoolYear: string; window: string; label: string }>> {
  if (studentIds.length === 0) return [];
  const rows = await db
    .selectDistinct({
      schoolYear: studentFastItemResponsesTable.schoolYear,
      window: studentFastItemResponsesTable.window,
    })
    .from(studentFastItemResponsesTable)
    .where(
      and(
        eq(studentFastItemResponsesTable.schoolId, schoolId),
        eq(studentFastItemResponsesTable.subject, subject),
        inArray(studentFastItemResponsesTable.studentId, studentIds),
      ),
    );
  // Sort newest-SY first, then PM3 > PM2 > PM1 (most recent window
  // first within a year — that's what teachers want preselected).
  const windowRank: Record<string, number> = { pm3: 0, pm2: 1, pm1: 2 };
  rows.sort((a, b) => {
    if (a.schoolYear !== b.schoolYear) {
      return b.schoolYear.localeCompare(a.schoolYear);
    }
    return (windowRank[a.window] ?? 9) - (windowRank[b.window] ?? 9);
  });
  return rows.map((r) => ({
    schoolYear: r.schoolYear,
    window: r.window,
    label: `${r.schoolYear} ${r.window.toUpperCase()}`,
  }));
}

router.get(
  "/teacher-roster/benchmarks",
  async (req: Request, res: Response) => {
    const ctx = await resolveContext(req, res);
    if (!ctx) return;

    const available = await loadAvailableWindows(
      ctx.schoolId,
      ctx.subject,
      ctx.studentIds,
    );

    // Resolve window + schoolYear. Caller may pass either, both, or
    // neither. Defaults: most recent available; fall back to current
    // SY + PM3 even when nothing exists yet so the picker can render
    // a stable "no data" state.
    const rawWindow = req.query.window;
    const rawSY = req.query.schoolYear;
    let window: string;
    let schoolYear: string;
    if (
      typeof rawWindow === "string" &&
      VALID_WINDOWS.has(rawWindow) &&
      typeof rawSY === "string" &&
      rawSY.length > 0
    ) {
      window = rawWindow;
      schoolYear = rawSY;
    } else if (available.length > 0) {
      window = available[0].window;
      schoolYear = available[0].schoolYear;
    } else {
      window = "pm3";
      schoolYear = schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ);
    }

    const baseResponse = {
      teacher: {
        id: ctx.targetTeacher.id,
        displayName: ctx.targetTeacher.displayName,
      },
      subject: ctx.subject,
      window,
      schoolYear,
      availableWindows: available,
      thresholdPct: ctx.thresholdPct,
    };

    if (ctx.studentIds.length === 0) {
      res.json({
        ...baseResponse,
        students: [],
        benchmarks: [],
        cells: {},
        bottom3: [],
      });
      return;
    }

    // Pull students + item responses in parallel.
    const [students, itemsRaw] = await Promise.all([
      db
        .select({
          studentId: studentsTable.studentId,
          firstName: studentsTable.firstName,
          lastName: studentsTable.lastName,
          grade: studentsTable.grade,
        })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.schoolId, ctx.schoolId),
            inArray(studentsTable.studentId, ctx.studentIds),
          ),
        ),
      db
        .select({
          studentId: studentFastItemResponsesTable.studentId,
          category: studentFastItemResponsesTable.category,
          benchmarkCode: studentFastItemResponsesTable.benchmarkCode,
          pointsEarned: studentFastItemResponsesTable.pointsEarned,
          pointsPossible: studentFastItemResponsesTable.pointsPossible,
        })
        .from(studentFastItemResponsesTable)
        .where(
          and(
            eq(studentFastItemResponsesTable.schoolId, ctx.schoolId),
            eq(studentFastItemResponsesTable.subject, ctx.subject),
            eq(studentFastItemResponsesTable.schoolYear, schoolYear),
            eq(studentFastItemResponsesTable.window, window),
            inArray(
              studentFastItemResponsesTable.studentId,
              ctx.studentIds,
            ),
          ),
        ),
    ]);

    // Filter out cross-grade rows (e.g. a 7th-grader who has 8th-grade
    // FAST responses in the same import) and "N/A" benchmark codes —
    // both create phantom duplicate columns in the heatmap because
    // the display label only shows the last 2 segments of the code.
    const studentGradeById = new Map(
      students.map((s) => [s.studentId, s.grade]),
    );
    const items = itemsRaw.filter((r) =>
      codeMatchesStudentGrade(
        r.benchmarkCode,
        studentGradeById.get(r.studentId),
      ),
    );

    // Aggregate (student, benchmark) → {earned, possible, category}.
    // SUM here intentionally collapses duplicated item_seq rows for the
    // same benchmark in one administration. NULL points are skipped
    // (matches Florida's "absent" convention — no possible points).
    interface CellAgg {
      earned: number;
      possible: number;
    }
    const cellMap = new Map<string, CellAgg>(); // key = `${studentId}|${code}`
    const benchmarkMeta = new Map<string, { category: string | null }>();
    for (const r of items) {
      if (r.pointsPossible == null) continue;
      if (!benchmarkMeta.has(r.benchmarkCode)) {
        benchmarkMeta.set(r.benchmarkCode, { category: r.category });
      }
      const key = `${r.studentId}|${r.benchmarkCode}`;
      const prior = cellMap.get(key) ?? { earned: 0, possible: 0 };
      prior.earned += r.pointsEarned ?? 0;
      prior.possible += r.pointsPossible;
      cellMap.set(key, prior);
    }

    // Benchmarks list — sorted by (category, natural code order).
    const benchmarks = Array.from(benchmarkMeta.entries())
      .map(([code, meta]) => ({ code, category: meta.category }))
      .sort((a, b) => {
        const ca = a.category ?? "";
        const cb = b.category ?? "";
        if (ca !== cb) return ca.localeCompare(cb);
        return compareBenchmarkCodes(a.code, b.code);
      });

    // Reteach-log counts per (student, benchmark) for the current
    // school year — drives the 🔁 N badge on every cell. Year-scoped
    // (not window-scoped) so a PM1 reteach is still visible when the
    // teacher pivots to PM2/PM3.
    const reteachRows = await db
      .select({
        studentId: benchmarkReteachLogTable.studentId,
        benchmarkCode: benchmarkReteachLogTable.benchmarkCode,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(benchmarkReteachLogTable)
      .where(
        and(
          eq(benchmarkReteachLogTable.schoolId, ctx.schoolId),
          eq(benchmarkReteachLogTable.schoolYear, schoolYear),
          inArray(benchmarkReteachLogTable.studentId, ctx.studentIds),
          isNull(benchmarkReteachLogTable.deletedAt),
        ),
      )
      .groupBy(
        benchmarkReteachLogTable.studentId,
        benchmarkReteachLogTable.benchmarkCode,
      );
    const reteachByCell = new Map<string, number>();
    for (const r of reteachRows) {
      reteachByCell.set(`${r.studentId}|${r.benchmarkCode}`, r.count);
    }

    // Per-student row data. Cells are keyed by benchmark code; nulls
    // for benchmarks the student has no data on (rare but possible
    // — student absent or row dropped at import).
    interface OutCell {
      pct: number;
      earned: number;
      possible: number;
      reteachCount: number;
    }
    const studentOut = students
      .map((s) => {
        const cells: Record<string, OutCell | null> = {};
        for (const b of benchmarks) {
          const agg = cellMap.get(`${s.studentId}|${b.code}`);
          if (!agg || agg.possible === 0) {
            cells[b.code] = null;
          } else {
            cells[b.code] = {
              pct: Math.round((agg.earned / agg.possible) * 100),
              earned: agg.earned,
              possible: agg.possible,
              reteachCount: reteachByCell.get(`${s.studentId}|${b.code}`) ?? 0,
            };
          }
        }
        return {
          studentId: s.studentId,
          firstName: s.firstName,
          lastName: s.lastName,
          grade: s.grade,
          cells,
        };
      })
      .sort((a, b) => {
        const ln = (a.lastName ?? "").localeCompare(b.lastName ?? "");
        if (ln !== 0) return ln;
        return (a.firstName ?? "").localeCompare(b.firstName ?? "");
      });

    // Bottom-3 tile: rank benchmarks by class avg ascending (lowest
    // mastery first). Tie-break: more students below threshold first,
    // then code natural order. Only ranks benchmarks with ≥1 student
    // response so empty columns don't game the list.
    interface BotEntry {
      code: string;
      category: string | null;
      avgPct: number;
      studentsBelowThreshold: number;
      totalStudents: number;
    }
    const botCandidates: BotEntry[] = [];
    for (const b of benchmarks) {
      let sumPct = 0;
      let n = 0;
      let below = 0;
      for (const s of studentOut) {
        const cell = s.cells[b.code];
        if (cell == null) continue;
        n += 1;
        sumPct += cell.pct;
        if (cell.pct < ctx.thresholdPct) below += 1;
      }
      if (n > 0) {
        botCandidates.push({
          code: b.code,
          category: b.category,
          avgPct: Math.round(sumPct / n),
          studentsBelowThreshold: below,
          totalStudents: n,
        });
      }
    }
    botCandidates.sort((a, b) => {
      if (a.avgPct !== b.avgPct) return a.avgPct - b.avgPct;
      if (a.studentsBelowThreshold !== b.studentsBelowThreshold) {
        return b.studentsBelowThreshold - a.studentsBelowThreshold;
      }
      return compareBenchmarkCodes(a.code, b.code);
    });
    const bottom3 = botCandidates.slice(0, 3);

    res.json({
      ...baseResponse,
      students: studentOut,
      benchmarks,
      bottom3,
    });
  },
);

router.get(
  "/teacher-roster/benchmarks/drill",
  async (req: Request, res: Response) => {
    const ctx = await resolveContext(req, res);
    if (!ctx) return;

    const rawWindow = req.query.window;
    const rawSY = req.query.schoolYear;
    const rawCode = req.query.benchmarkCode;
    if (
      typeof rawWindow !== "string" ||
      !VALID_WINDOWS.has(rawWindow) ||
      typeof rawSY !== "string" ||
      rawSY.length === 0 ||
      typeof rawCode !== "string" ||
      rawCode.length === 0
    ) {
      res.status(400).json({
        error: "window, schoolYear, and benchmarkCode are required",
      });
      return;
    }
    const window = rawWindow;
    const schoolYear = rawSY;
    const benchmarkCode = rawCode;

    if (ctx.studentIds.length === 0) {
      res.json({
        benchmark: { code: benchmarkCode, category: null },
        thresholdPct: ctx.thresholdPct,
        students: [],
      });
      return;
    }

    const [students, items] = await Promise.all([
      db
        .select({
          studentId: studentsTable.studentId,
          firstName: studentsTable.firstName,
          lastName: studentsTable.lastName,
          grade: studentsTable.grade,
        })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.schoolId, ctx.schoolId),
            inArray(studentsTable.studentId, ctx.studentIds),
          ),
        ),
      db
        .select({
          studentId: studentFastItemResponsesTable.studentId,
          category: studentFastItemResponsesTable.category,
          itemSeq: studentFastItemResponsesTable.itemSeq,
          pointsEarned: studentFastItemResponsesTable.pointsEarned,
          pointsPossible: studentFastItemResponsesTable.pointsPossible,
        })
        .from(studentFastItemResponsesTable)
        .where(
          and(
            eq(studentFastItemResponsesTable.schoolId, ctx.schoolId),
            eq(studentFastItemResponsesTable.subject, ctx.subject),
            eq(studentFastItemResponsesTable.schoolYear, schoolYear),
            eq(studentFastItemResponsesTable.window, window),
            eq(studentFastItemResponsesTable.benchmarkCode, benchmarkCode),
            inArray(
              studentFastItemResponsesTable.studentId,
              ctx.studentIds,
            ),
          ),
        ),
    ]);

    // Per-student aggregation AND per-item raw rows. The Florida xlsx
    // typically repeats a benchmark code across 1–3 item_seq rows in
    // one PM (multi-item benchmark). The drill modal needs each item
    // visible so the teacher can see "missed item 1, got item 2" —
    // not just a rolled-up percent.
    interface ItemDetail {
      itemSeq: number;
      pointsEarned: number | null;
      pointsPossible: number | null;
    }
    let category: string | null = null;
    const agg = new Map<string, { earned: number; possible: number }>();
    const itemsByStudent = new Map<string, ItemDetail[]>();
    for (const r of items) {
      if (r.category && !category) category = r.category;
      const arr = itemsByStudent.get(r.studentId) ?? [];
      arr.push({
        itemSeq: r.itemSeq,
        pointsEarned: r.pointsEarned,
        pointsPossible: r.pointsPossible,
      });
      itemsByStudent.set(r.studentId, arr);
      if (r.pointsPossible == null) continue;
      const prior = agg.get(r.studentId) ?? { earned: 0, possible: 0 };
      prior.earned += r.pointsEarned ?? 0;
      prior.possible += r.pointsPossible;
      agg.set(r.studentId, prior);
    }

    const out = students
      .map((s) => {
        const a = agg.get(s.studentId);
        const rawItems = (itemsByStudent.get(s.studentId) ?? []).sort(
          (x, y) => x.itemSeq - y.itemSeq,
        );
        const base = {
          studentId: s.studentId,
          firstName: s.firstName,
          lastName: s.lastName,
          grade: s.grade,
          items: rawItems,
        };
        if (!a || a.possible === 0) {
          return {
            ...base,
            pct: null as number | null,
            earned: null as number | null,
            possible: null as number | null,
          };
        }
        return {
          ...base,
          pct: Math.round((a.earned / a.possible) * 100),
          earned: a.earned,
          possible: a.possible,
        };
      })
      // Only include students below threshold (or with no data — the
      // "absent" case the teacher still wants to see). Sort lowest
      // pct first; nulls go to the end.
      .filter((r) => r.pct === null || r.pct < ctx.thresholdPct)
      .sort((a, b) => {
        if (a.pct === null && b.pct === null) return 0;
        if (a.pct === null) return 1;
        if (b.pct === null) return -1;
        return a.pct - b.pct;
      });

    res.json({
      benchmark: { code: benchmarkCode, category },
      thresholdPct: ctx.thresholdPct,
      students: out,
    });
  },
);

// Benchmark Progress Report — per-student item-analysis sheet across
// PM1/PM2/PM3 for one teacher × subject × school year. One round-trip
// returns every student page so the client can print all at once.
router.get(
  "/teacher-roster/benchmarks/progress-report",
  async (req: Request, res: Response) => {
    const ctx = await resolveContext(req, res);
    if (!ctx) return;

    const rawSY = req.query.schoolYear;
    const schoolYear =
      typeof rawSY === "string" && rawSY.length > 0
        ? rawSY
        : schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ);

    if (ctx.studentIds.length === 0) {
      res.json({
        teacher: {
          id: ctx.targetTeacher.id,
          displayName: ctx.targetTeacher.displayName,
        },
        subject: ctx.subject,
        schoolYear,
        thresholdPct: ctx.thresholdPct,
        benchmarks: [],
        students: [],
      });
      return;
    }

    const [students, itemsRaw, periodRows, scaleRows, labelRows, reteachRows] =
      await Promise.all([
      db
        .select({
          studentId: studentsTable.studentId,
          firstName: studentsTable.firstName,
          lastName: studentsTable.lastName,
          grade: studentsTable.grade,
        })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.schoolId, ctx.schoolId),
            inArray(studentsTable.studentId, ctx.studentIds),
          ),
        ),
      db
        .select({
          studentId: studentFastItemResponsesTable.studentId,
          window: studentFastItemResponsesTable.window,
          category: studentFastItemResponsesTable.category,
          benchmarkCode: studentFastItemResponsesTable.benchmarkCode,
          itemSeq: studentFastItemResponsesTable.itemSeq,
          pointsEarned: studentFastItemResponsesTable.pointsEarned,
          pointsPossible: studentFastItemResponsesTable.pointsPossible,
        })
        .from(studentFastItemResponsesTable)
        .where(
          and(
            eq(studentFastItemResponsesTable.schoolId, ctx.schoolId),
            eq(studentFastItemResponsesTable.subject, ctx.subject),
            eq(studentFastItemResponsesTable.schoolYear, schoolYear),
            inArray(
              studentFastItemResponsesTable.studentId,
              ctx.studentIds,
            ),
          ),
        ),
      // Period per student for THIS teacher only (a student may be in
      // multiple periods with the same teacher — show all, sorted).
      db
        .select({
          studentId: sectionRosterTable.studentId,
          period: classSectionsTable.period,
        })
        .from(sectionRosterTable)
        .innerJoin(
          classSectionsTable,
          eq(classSectionsTable.id, sectionRosterTable.sectionId),
        )
        .where(
          and(
            eq(sectionRosterTable.schoolId, ctx.schoolId),
            eq(classSectionsTable.schoolId, ctx.schoolId),
            eq(classSectionsTable.teacherStaffId, ctx.targetTeacher.id),
            inArray(sectionRosterTable.studentId, ctx.studentIds),
          ),
        ),
      db
        .select({
          studentId: studentFastScoresTable.studentId,
          pm1: studentFastScoresTable.pm1,
          pm2: studentFastScoresTable.pm2,
          pm3: studentFastScoresTable.pm3,
        })
        .from(studentFastScoresTable)
        .where(
          and(
            eq(studentFastScoresTable.schoolId, ctx.schoolId),
            eq(studentFastScoresTable.subject, ctx.subject),
            eq(studentFastScoresTable.schoolYear, schoolYear),
            inArray(studentFastScoresTable.studentId, ctx.studentIds),
          ),
        ),
      db
        .select({
          code: schoolBenchmarksTable.code,
          label: schoolBenchmarksTable.label,
        })
        .from(schoolBenchmarksTable)
        .where(
          and(
            eq(schoolBenchmarksTable.schoolId, ctx.schoolId),
            eq(schoolBenchmarksTable.subject, ctx.subject),
          ),
        ),
      // Reteach sessions per (student, code, window, format) for this
      // school year. Split 1:1 vs small-group so the printable report
      // can show "🔁2 · 👥3" in the relevant PM column — tells the
      // before/after story (60% PM2 → 3 reteaches → 85% PM3). Logs with
      // a null pm_window_at_log are dropped (only legacy pre-field
      // rows; rare and unattributable to a window).
      db
        .select({
          studentId: benchmarkReteachLogTable.studentId,
          benchmarkCode: benchmarkReteachLogTable.benchmarkCode,
          window: benchmarkReteachLogTable.pmWindowAtLog,
          format: benchmarkReteachLogTable.format,
          count: sql<number>`COUNT(*)::int`,
        })
        .from(benchmarkReteachLogTable)
        .where(
          and(
            eq(benchmarkReteachLogTable.schoolId, ctx.schoolId),
            eq(benchmarkReteachLogTable.schoolYear, schoolYear),
            inArray(benchmarkReteachLogTable.studentId, ctx.studentIds),
            isNull(benchmarkReteachLogTable.deletedAt),
          ),
        )
        .groupBy(
          benchmarkReteachLogTable.studentId,
          benchmarkReteachLogTable.benchmarkCode,
          benchmarkReteachLogTable.pmWindowAtLog,
          benchmarkReteachLogTable.format,
        ),
    ]);
    const labelByCode = new Map<string, string | null>(
      labelRows.map((r) => [r.code, r.label]),
    );
    // Index: `${studentId}|${code}|${window}` → { oneOnOne, smallGroup }
    const reteachByCellWin = new Map<
      string,
      { oneOnOne: number; smallGroup: number }
    >();
    for (const r of reteachRows) {
      if (!r.window) continue; // drop legacy null-window logs
      const key = `${r.studentId}|${r.benchmarkCode}|${r.window}`;
      const cur = reteachByCellWin.get(key) ?? { oneOnOne: 0, smallGroup: 0 };
      if (r.format === "one_on_one") cur.oneOnOne += r.count;
      else if (r.format === "small_group") cur.smallGroup += r.count;
      reteachByCellWin.set(key, cur);
    }

    // Drop cross-grade rows + "N/A" codes — see helper comment.
    const studentGradeById = new Map(
      students.map((s) => [s.studentId, s.grade]),
    );
    const items = itemsRaw.filter((r) =>
      codeMatchesStudentGrade(
        r.benchmarkCode,
        studentGradeById.get(r.studentId),
      ),
    );

    const scoresByStudent = new Map<
      string,
      { pm1: number | null; pm2: number | null; pm3: number | null }
    >();
    for (const r of scaleRows) {
      scoresByStudent.set(r.studentId, {
        pm1: r.pm1,
        pm2: r.pm2,
        pm3: r.pm3,
      });
    }

    // periods[studentId] = sorted unique list
    const periodsByStudent = new Map<string, Set<number>>();
    for (const r of periodRows) {
      const set = periodsByStudent.get(r.studentId) ?? new Set<number>();
      set.add(r.period);
      periodsByStudent.set(r.studentId, set);
    }

    // Build global benchmark order: (category, natural code) across
    // every benchmark that has at least one item row in any window.
    const benchmarkMeta = new Map<string, { category: string | null }>();
    for (const r of items) {
      if (!benchmarkMeta.has(r.benchmarkCode)) {
        benchmarkMeta.set(r.benchmarkCode, { category: r.category });
      }
    }
    const benchmarks = Array.from(benchmarkMeta.entries())
      .map(([code, meta]) => ({
        code,
        category: meta.category,
        label: labelByCode.get(code) ?? null,
      }))
      .sort((a, b) => {
        const ca = a.category ?? "";
        const cb = b.category ?? "";
        if (ca !== cb) return ca.localeCompare(cb);
        return compareBenchmarkCodes(a.code, b.code);
      });

    // Group items: studentId → window → code → items[]
    interface ItemDetail {
      itemSeq: number;
      pointsEarned: number | null;
      pointsPossible: number | null;
    }
    const grouped = new Map<
      string,
      Map<string, Map<string, ItemDetail[]>>
    >();
    for (const r of items) {
      let byWin = grouped.get(r.studentId);
      if (!byWin) {
        byWin = new Map();
        grouped.set(r.studentId, byWin);
      }
      let byCode = byWin.get(r.window);
      if (!byCode) {
        byCode = new Map();
        byWin.set(r.window, byCode);
      }
      const arr = byCode.get(r.benchmarkCode) ?? [];
      arr.push({
        itemSeq: r.itemSeq,
        pointsEarned: r.pointsEarned,
        pointsPossible: r.pointsPossible,
      });
      byCode.set(r.benchmarkCode, arr);
    }

    const WINDOWS = ["pm1", "pm2", "pm3"] as const;
    interface OutCell {
      items: ItemDetail[];
      earned: number;
      possible: number;
      pct: number;
      reteachOneOnOne: number;
      reteachSmallGroup: number;
    }
    interface ScaleCell {
      score: number;
      level: 1 | 2 | 3 | 4 | 5;
      subLevel: string;
      subLevelLabel: string;
      nextStopScore: number | null;
      nextStopLabel: string | null;
      gap: number | null;
    }
    const fastSubject = ctx.subject as FastSubject;
    function computeScale(
      score: number | null,
      grade: number,
    ): ScaleCell | null {
      if (score == null || !Number.isFinite(grade)) return null;
      const placement = placeOnChart(score, fastSubject, grade);
      if (!placement) return null;
      const target = bucketTarget(fastSubject, grade, placement.subLevel);
      return {
        score,
        level: placement.level,
        subLevel: placement.subLevel,
        subLevelLabel: SUB_LEVEL_LABEL[placement.subLevel],
        nextStopScore: target ? target.score : null,
        nextStopLabel: target ? SUB_LEVEL_LABEL[target.nextStop] : null,
        gap: target ? target.score - score : null,
      };
    }

    const studentOut = students
      .map((s) => {
        const periods = Array.from(
          periodsByStudent.get(s.studentId) ?? new Set<number>(),
        ).sort((a, b) => a - b);
        const byWin = grouped.get(s.studentId);
        const windows: Record<string, Record<string, OutCell | null>> = {};
        for (const w of WINDOWS) {
          const byCode = byWin?.get(w);
          const row: Record<string, OutCell | null> = {};
          for (const b of benchmarks) {
            const arr = byCode?.get(b.code);
            const rt = reteachByCellWin.get(
              `${s.studentId}|${b.code}|${w}`,
            ) ?? { oneOnOne: 0, smallGroup: 0 };
            if (!arr || arr.length === 0) {
              // If there's no item-level data but the teacher logged
              // a reteach for this benchmark in this window, surface
              // an empty-data cell carrying just the reteach counts so
              // the print column still shows "🔁N · 👥N" — otherwise
              // PM1 reteaches done before any item upload would vanish.
              if (rt.oneOnOne === 0 && rt.smallGroup === 0) {
                row[b.code] = null;
              } else {
                row[b.code] = {
                  items: [],
                  earned: 0,
                  possible: 0,
                  pct: 0,
                  reteachOneOnOne: rt.oneOnOne,
                  reteachSmallGroup: rt.smallGroup,
                };
              }
              continue;
            }
            let earned = 0;
            let possible = 0;
            for (const it of arr) {
              if (it.pointsPossible == null) continue;
              earned += it.pointsEarned ?? 0;
              possible += it.pointsPossible;
            }
            row[b.code] = {
              items: arr.slice().sort((x, y) => x.itemSeq - y.itemSeq),
              earned,
              possible,
              pct:
                possible === 0
                  ? 0
                  : Math.round((earned / possible) * 100),
              reteachOneOnOne: rt.oneOnOne,
              reteachSmallGroup: rt.smallGroup,
            };
          }
          windows[w] = row;
        }
        const gradeNum = Number(s.grade);
        const sc = scoresByStudent.get(s.studentId);
        const scales = {
          pm1: computeScale(sc?.pm1 ?? null, gradeNum),
          pm2: computeScale(sc?.pm2 ?? null, gradeNum),
          pm3: computeScale(sc?.pm3 ?? null, gradeNum),
        };
        return {
          studentId: s.studentId,
          firstName: s.firstName,
          lastName: s.lastName,
          grade: s.grade,
          periods,
          windows,
          scales,
        };
      })
      .sort((a, b) => {
        const ln = (a.lastName ?? "").localeCompare(b.lastName ?? "");
        if (ln !== 0) return ln;
        return (a.firstName ?? "").localeCompare(b.firstName ?? "");
      });

    // Class median percent per (benchmark code, window) across the
    // teacher's roster — gives each student page a reference point
    // ("class typically scores X% on this standard") so parents and
    // students can read their own row in context.
    const classMedians: Record<
      string,
      { pm1: number | null; pm2: number | null; pm3: number | null }
    > = {};
    function median(nums: number[]): number | null {
      if (nums.length === 0) return null;
      const sorted = nums.slice().sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0
        ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
        : sorted[mid];
    }
    for (const b of benchmarks) {
      const buckets: Record<"pm1" | "pm2" | "pm3", number[]> = {
        pm1: [],
        pm2: [],
        pm3: [],
      };
      for (const s of studentOut) {
        for (const w of WINDOWS) {
          const cc = s.windows[w][b.code];
          if (cc) buckets[w].push(cc.pct);
        }
      }
      classMedians[b.code] = {
        pm1: median(buckets.pm1),
        pm2: median(buckets.pm2),
        pm3: median(buckets.pm3),
      };
    }

    // Roster-wide reteach summary — footer line on the printed report
    // so a teacher (or admin reading their teacher's report) can see at
    // a glance "this roster received N 1:1 + M small-group sessions
    // across K students and J benchmarks this year." Counts every
    // active log on the roster regardless of who logged it (a reading
    // coach pulling small groups across multiple teachers' classes
    // still shows up on those teachers' reports).
    let rosterTotal1on1 = 0;
    let rosterTotalGroup = 0;
    const rosterStudents = new Set<string>();
    const rosterBenchmarks = new Set<string>();
    for (const r of reteachRows) {
      if (r.format === "one_on_one") rosterTotal1on1 += r.count;
      else if (r.format === "small_group") rosterTotalGroup += r.count;
      rosterStudents.add(r.studentId);
      rosterBenchmarks.add(r.benchmarkCode);
    }
    const rosterReteachSummary = {
      oneOnOne: rosterTotal1on1,
      smallGroup: rosterTotalGroup,
      uniqueStudents: rosterStudents.size,
      uniqueBenchmarks: rosterBenchmarks.size,
    };

    req.log.info(
      {
        teacherId: ctx.targetTeacher.id,
        schoolYear,
        subject: ctx.subject,
        reteachRowsFetched: reteachRows.length,
        rosterReteachSummary,
      },
      "[progress-report] reteach summary",
    );

    res.json({
      teacher: {
        id: ctx.targetTeacher.id,
        displayName: ctx.targetTeacher.displayName,
      },
      subject: ctx.subject,
      schoolYear,
      thresholdPct: ctx.thresholdPct,
      benchmarks,
      classMedians,
      students: studentOut,
      rosterReteachSummary,
    });
  },
);

router.get(
  "/teacher-roster/benchmarks/pdf",
  async (req: Request, res: Response) => {
    const ctx = await resolveContext(req, res);
    if (!ctx) return;

    const rawWindow = req.query.window;
    const rawSY = req.query.schoolYear;
    if (
      typeof rawWindow !== "string" ||
      !VALID_WINDOWS.has(rawWindow) ||
      typeof rawSY !== "string" ||
      rawSY.length === 0
    ) {
      res.status(400).json({
        error: "window and schoolYear are required",
      });
      return;
    }
    const window = rawWindow;
    const schoolYear = rawSY;

    // Fetch school for the printable header (name appears above the
    // teacher line so printed copies have unambiguous provenance
    // when they sit on a desk).
    const [schoolRow] = await db
      .select({ name: schoolsTable.name })
      .from(schoolsTable)
      .where(eq(schoolsTable.id, ctx.schoolId));

    // Reuse the matrix-build path inline (kept here rather than
    // factored out to keep the route file self-contained — the
    // JSON-shape changes are unlikely to need to round-trip through
    // the PDF view).
    const [students, itemsRaw] = await Promise.all([
      ctx.studentIds.length === 0
        ? Promise.resolve([] as Array<{
            studentId: string;
            firstName: string;
            lastName: string;
            grade: number | string;
          }>)
        : db
            .select({
              studentId: studentsTable.studentId,
              firstName: studentsTable.firstName,
              lastName: studentsTable.lastName,
              grade: studentsTable.grade,
            })
            .from(studentsTable)
            .where(
              and(
                eq(studentsTable.schoolId, ctx.schoolId),
                inArray(studentsTable.studentId, ctx.studentIds),
              ),
            ),
      ctx.studentIds.length === 0
        ? Promise.resolve([] as Array<{
            studentId: string;
            category: string | null;
            benchmarkCode: string;
            pointsEarned: number | null;
            pointsPossible: number | null;
          }>)
        : db
            .select({
              studentId: studentFastItemResponsesTable.studentId,
              category: studentFastItemResponsesTable.category,
              benchmarkCode: studentFastItemResponsesTable.benchmarkCode,
              pointsEarned: studentFastItemResponsesTable.pointsEarned,
              pointsPossible: studentFastItemResponsesTable.pointsPossible,
            })
            .from(studentFastItemResponsesTable)
            .where(
              and(
                eq(studentFastItemResponsesTable.schoolId, ctx.schoolId),
                eq(studentFastItemResponsesTable.subject, ctx.subject),
                eq(studentFastItemResponsesTable.schoolYear, schoolYear),
                eq(studentFastItemResponsesTable.window, window),
                inArray(
                  studentFastItemResponsesTable.studentId,
                  ctx.studentIds,
                ),
              ),
            ),
    ]);

    // Drop cross-grade rows + "N/A" codes — see helper comment.
    const studentGradeById = new Map(
      students.map((s) => [s.studentId, s.grade]),
    );
    const items = itemsRaw.filter((r) =>
      codeMatchesStudentGrade(
        r.benchmarkCode,
        studentGradeById.get(r.studentId),
      ),
    );

    const cellMap = new Map<string, { earned: number; possible: number }>();
    const benchmarkMeta = new Map<string, { category: string | null }>();
    for (const r of items) {
      if (r.pointsPossible == null) continue;
      if (!benchmarkMeta.has(r.benchmarkCode)) {
        benchmarkMeta.set(r.benchmarkCode, { category: r.category });
      }
      const key = `${r.studentId}|${r.benchmarkCode}`;
      const prior = cellMap.get(key) ?? { earned: 0, possible: 0 };
      prior.earned += r.pointsEarned ?? 0;
      prior.possible += r.pointsPossible;
      cellMap.set(key, prior);
    }
    const benchmarks = Array.from(benchmarkMeta.entries())
      .map(([code, meta]) => ({ code, category: meta.category }))
      .sort((a, b) => {
        const ca = a.category ?? "";
        const cb = b.category ?? "";
        if (ca !== cb) return ca.localeCompare(cb);
        return compareBenchmarkCodes(a.code, b.code);
      });
    const sortedStudents = [...students].sort((a, b) => {
      const ln = (a.lastName ?? "").localeCompare(b.lastName ?? "");
      if (ln !== 0) return ln;
      return (a.firstName ?? "").localeCompare(b.firstName ?? "");
    });

    // Landscape Letter — wide tables compress better here than portrait.
    const doc = new PDFDocument({
      size: "LETTER",
      layout: "landscape",
      margins: { top: 40, bottom: 40, left: 36, right: 36 },
      info: {
        Title: `FAST Benchmarks — ${ctx.targetTeacher.displayName ?? "Teacher"} — ${schoolYear} ${window.toUpperCase()}`,
        Author: "PulseEDU",
      },
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="fast-benchmarks-${ctx.targetTeacher.id}-${schoolYear}-${window}.pdf"`,
    );
    doc.pipe(res);

    // Header band: school name (top), teacher + class context, then
    // subject/window/threshold/timestamp line. Printed copies often
    // get filed; this gives the reader full provenance at a glance.
    if (schoolRow?.name) {
      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor("#374151")
        .text(schoolRow.name)
        .fillColor("black");
    }
    doc
      .font("Helvetica-Bold")
      .fontSize(15)
      .text(
        `FAST Benchmarks — ${ctx.targetTeacher.displayName ?? `Staff #${ctx.targetTeacher.id}`}`,
      );
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#666")
      .text(
        `${ctx.subject.toUpperCase()} · ${schoolYear} ${window.toUpperCase()} · ` +
          (ctx.period == null
            ? `All class periods (union of roster) · `
            : `Period ${ctx.period} only · `) +
          `Mastery threshold ${ctx.thresholdPct}% · ` +
          `Generated ${new Date().toLocaleString()}`,
      )
      .fillColor("black")
      .moveDown(0.4);

    // Bottom-3 tile — printed above the heatmap so the reader gets
    // the "what should I act on" answer before the wall of cells.
    // Computed inline from the same cellMap used for the grid so the
    // PDF cannot drift from the on-screen view.
    interface BotEntry {
      code: string;
      category: string | null;
      avgPct: number;
      below: number;
      n: number;
    }
    const botCandidates: BotEntry[] = [];
    for (const b of benchmarks) {
      let sumPct = 0;
      let n = 0;
      let below = 0;
      for (const s of sortedStudents) {
        const agg = cellMap.get(`${s.studentId}|${b.code}`);
        if (!agg || agg.possible === 0) continue;
        const pct = Math.round((agg.earned / agg.possible) * 100);
        sumPct += pct;
        n += 1;
        if (pct < ctx.thresholdPct) below += 1;
      }
      if (n > 0) {
        botCandidates.push({
          code: b.code,
          category: b.category,
          avgPct: Math.round(sumPct / n),
          below,
          n,
        });
      }
    }
    botCandidates.sort((a, b) => {
      if (a.avgPct !== b.avgPct) return a.avgPct - b.avgPct;
      if (a.below !== b.below) return b.below - a.below;
      return compareBenchmarkCodes(a.code, b.code);
    });
    const bottom3 = botCandidates.slice(0, 3);
    if (bottom3.length > 0) {
      const tileTop = doc.y;
      const tileH = 12 + bottom3.length * 12 + 6;
      const tileW =
        doc.page.width - doc.page.margins.left - doc.page.margins.right;
      doc
        .save()
        .rect(doc.page.margins.left, tileTop, tileW, tileH)
        .fillColor("#fef2f2")
        .fill()
        .restore();
      doc
        .strokeColor("#fecaca")
        .lineWidth(1)
        .rect(doc.page.margins.left, tileTop, tileW, tileH)
        .stroke();
      doc
        .font("Helvetica-Bold")
        .fontSize(9)
        .fillColor("#991b1b")
        .text(
          `BOTTOM 3 BENCHMARKS — ${schoolYear} ${window.toUpperCase()}`,
          doc.page.margins.left + 6,
          tileTop + 4,
        );
      let lineY = tileTop + 16;
      bottom3.forEach((b) => {
        doc
          .font("Helvetica")
          .fontSize(9)
          .fillColor("#111")
          .text(
            `${b.code}${b.category ? ` · ${b.category}` : ""} — class avg ${b.avgPct}% · ${b.below}/${b.n} below ${ctx.thresholdPct}%`,
            doc.page.margins.left + 8,
            lineY,
          );
        lineY += 12;
      });
      doc.fillColor("black");
      doc.y = tileTop + tileH + 6;
    }

    if (sortedStudents.length === 0) {
      doc
        .fontSize(11)
        .fillColor("#666")
        .text("No students on this teacher's roster.")
        .fillColor("black");
      doc.end();
      return;
    }
    if (benchmarks.length === 0) {
      doc
        .fontSize(11)
        .fillColor("#666")
        .text(
          `No FAST item-level data for ${schoolYear} ${window.toUpperCase()} yet. ` +
            `Import a Florida per-student xlsx for this window from Data Importer.`,
        )
        .fillColor("black");
      doc.end();
      return;
    }

    // Layout: fixed 130pt name column, remaining width divided across
    // benchmark cols. We cap at ~24 benchmarks per page-table width;
    // if more, paginate by benchmark group.
    const pageWidth =
      doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const nameColW = 130;
    const avail = pageWidth - nameColW;
    const maxCellsPerPage = Math.max(6, Math.floor(avail / 28));
    const cellW = Math.max(20, avail / Math.min(maxCellsPerPage, benchmarks.length));

    const chunks: typeof benchmarks[] = [];
    for (let i = 0; i < benchmarks.length; i += maxCellsPerPage) {
      chunks.push(benchmarks.slice(i, i + maxCellsPerPage));
    }

    chunks.forEach((chunk, chunkIdx) => {
      if (chunkIdx > 0) {
        doc.addPage({
          size: "LETTER",
          layout: "landscape",
          margins: { top: 40, bottom: 40, left: 36, right: 36 },
        });
      }

      // Column headers — rotate -45° so codes sit over narrow columns.
      // Math benchmark codes are long "STRAND|BENCHMARK" composites (e.g.
      // "MA.7.NSO.1|MA.7.NSO.1.1", up to 49 chars for multi-standard items
      // like "MA.8.DP.2|MA.8.DP.2.3 and MA.8.DP.2.2|MA.8.DP.2.3"). Printing
      // the raw code overflowed upward into the Bottom-3 tile and clipped the
      // right margin. We display the BENCHMARK portion only (the part after
      // "|"), deduped across " and " composites — this keeps the full
      // standard identity (e.g. "MA.7.NSO.1.1") at ELA-like length. ELA codes
      // have no "|" and pass through unchanged.
      const shortCode = (code: string): string => {
        const benches = code.split(/\s+and\s+/).map((p) => {
          const i = p.lastIndexOf("|");
          return (i >= 0 ? p.slice(i + 1) : p).trim();
        });
        const uniq = Array.from(new Set(benches.filter(Boolean)));
        return uniq.join(" / ") || code;
      };

      // Size the header band to the tallest rotated label so nothing bleeds
      // into the tile above. At -45° the vertical extent ≈ textWidth * sin45.
      // Clamp to [46, 130]: 46 keeps ELA-length codes tight; 130 caps the
      // band for the longest math composites.
      doc.font("Helvetica").fontSize(7);
      let maxLabelW = 0;
      for (const b of chunk) {
        const w = doc.widthOfString(shortCode(b.code));
        if (w > maxLabelW) maxLabelW = w;
      }
      const headerHeight = Math.min(
        130,
        Math.max(46, Math.ceil(maxLabelW * 0.7071) + 10),
      );
      // Small buffer above the band so the rotated text never bleeds
      // into the bottom-3 tile above on chunk 0, or into the previous
      // row of cells on subsequent chunks.
      doc.y = doc.y + 4;
      const headerY = doc.y;
      doc
        .font("Helvetica-Bold")
        .fontSize(9)
        .text("Student", doc.page.margins.left, headerY + headerHeight - 14, {
          width: nameColW,
        });

      const rightLimit = doc.page.width - doc.page.margins.right;
      chunk.forEach((b, i) => {
        // Anchor each rotated code at the LEFT edge of its own column, sitting
        // on the grid rule, then let it rise up-and-to-the-right at 45°. With
        // translate()+rotate() the diagonal body sits over its own column and
        // the bottom tip points at the column. The previous approach anchored
        // the text's right edge at the column CENTER and let it sag up-LEFT,
        // which pushed the first column's label back over the "Student" name
        // column and left every code visually offset from its cells. Long
        // composites can still reach past the right margin, so shrink the font
        // (down to 5pt) just for labels whose diagonal reach would cross it.
        const colLeft = doc.page.margins.left + nameColW + i * cellW;
        const label = shortCode(b.code);
        let fs = 7;
        doc.font("Helvetica").fontSize(fs);
        while (
          fs > 5 &&
          colLeft + 2 + doc.widthOfString(label) * 0.7071 > rightLimit
        ) {
          fs -= 0.5;
          doc.fontSize(fs);
        }
        doc.save();
        doc.translate(colLeft + 2, headerY + headerHeight - 2);
        doc.rotate(-45);
        doc.fillColor("#111").text(label, 0, -3, { lineBreak: false });
        doc.restore();
      });

      // Top of body grid (a single horizontal rule under headers).
      doc
        .moveTo(doc.page.margins.left, headerY + headerHeight)
        .lineTo(
          doc.page.margins.left + nameColW + chunk.length * cellW,
          headerY + headerHeight,
        )
        .strokeColor("#d4d4d4")
        .stroke();

      let rowY = headerY + headerHeight + 2;
      const rowH = 14;
      sortedStudents.forEach((s) => {
        if (rowY + rowH > doc.page.height - doc.page.margins.bottom) {
          doc.addPage({
            size: "LETTER",
            layout: "landscape",
            margins: { top: 40, bottom: 40, left: 36, right: 36 },
          });
          rowY = doc.page.margins.top;
        }
        doc
          .font("Helvetica")
          .fontSize(9)
          .fillColor("black")
          .text(
            `${s.lastName ?? ""}, ${s.firstName ?? ""}`,
            doc.page.margins.left,
            rowY + 2,
            { width: nameColW - 4, ellipsis: true },
          );

        chunk.forEach((b, i) => {
          const x = doc.page.margins.left + nameColW + i * cellW;
          const agg = cellMap.get(`${s.studentId}|${b.code}`);
          if (!agg || agg.possible === 0) {
            doc
              .rect(x, rowY, cellW - 1, rowH - 1)
              .fillColor("#f3f4f6")
              .fill();
            doc
              .fillColor("#9ca3af")
              .fontSize(8)
              .text("—", x, rowY + 2, { width: cellW - 1, align: "center" });
          } else {
            const pct = Math.round((agg.earned / agg.possible) * 100);
            const color = colorForPct(pct, ctx.thresholdPct);
            doc.rect(x, rowY, cellW - 1, rowH - 1).fillColor(color).fill();
            doc
              .fillColor("#111")
              .font("Helvetica-Bold")
              .fontSize(8)
              .text(`${pct}`, x, rowY + 2, {
                width: cellW - 1,
                align: "center",
              });
          }
        });
        rowY += rowH;
      });

      doc.fillColor("black");
    });

    // Reset cursor to the left margin before drawing the footer.
    // After the heatmap, doc.x is still parked at the right edge of
    // the last cell column, so a centered text() call wraps inside
    // a narrow strip and renders the footer vertically. Anchor it
    // back to the page's left margin first.
    doc.x = doc.page.margins.left;
    doc
      .moveDown(0.8)
      .fontSize(8)
      .fillColor("#888")
      .text(
        "Confidential — for staff use only. Cells = percent of points earned on each benchmark.",
        doc.page.margins.left,
        doc.y,
        {
          width:
            doc.page.width - doc.page.margins.left - doc.page.margins.right,
          align: "center",
        },
      )
      .fillColor("black");

    doc.end();
  },
);

// Heatmap palette — five-bucket scale relative to the school's
// mastery threshold. Mirrors the client's CELL_COLOR so the printable
// PDF reads identically to the on-screen view.
function colorForPct(pct: number, threshold: number): string {
  if (pct >= threshold) return "#bbf7d0"; // green — mastery
  if (pct >= Math.max(0, threshold - 10)) return "#fef08a"; // yellow
  if (pct >= Math.max(0, threshold - 30)) return "#fed7aa"; // orange
  return "#fecaca"; // red
}

// ---------------------------------------------------------------------------
// FAST Phase 3 — Student profile benchmark history
// ---------------------------------------------------------------------------
//
// GET /api/student-benchmarks?studentId=&subject=&schoolYear=
//
// One call returns every window (pm1/pm2/pm3) the student has data
// for in the requested (subject, schoolYear), along with category
// rollups, so the panel can switch windows client-side without a
// round-trip. The MTSS-tagged flag is wired here but always returns
// false until Phase 5 starts persisting benchmark-tagged plans —
// the read path is in place so the pill turns on automatically the
// moment Phase 5 ships.
// Canonical student-profile visibility — must match the gate used by
// GET /api/insights/students/:studentId/profile EXACTLY so a teacher
// who can open the profile page can always read its benchmark panel,
// and vice versa. Three paths:
//   1) Insights-flavor "core team" — SuperUser / Admin / Behavior
//      Specialist / MTSS Coordinator / PBIS Coordinator. Intentionally
//      DIFFERENT from this file's roster-flavor isCoreTeam() — the
//      profile page deliberately excludes ESE coordinator from the
//      blanket all-student bucket and routes them through the roster
//      / trusted-adult paths instead, same as guidance counselor.
//   2) Roster — student appears in any section taught by this staff.
//   3) Trusted-adult — student has an explicit trusted-adult link to
//      this staff (counselor / mentor / ESE case manager assignment).
function isProfileCoreTeam(s: StaffRow): boolean {
  return Boolean(
    s.isSuperUser ||
      s.isAdmin ||
      s.isBehaviorSpecialist ||
      s.isMtssCoordinator ||
      s.isPbisCoordinator,
  );
}

async function resolveStudentVisibility(
  staff: StaffRow,
  schoolId: number,
  studentId: string,
): Promise<boolean> {
  if (isProfileCoreTeam(staff)) return true;
  // Roster path (any taught section).
  const [rosterHit] = await db
    .select({ id: sectionRosterTable.id })
    .from(sectionRosterTable)
    .innerJoin(
      classSectionsTable,
      eq(classSectionsTable.id, sectionRosterTable.sectionId),
    )
    .where(
      and(
        eq(sectionRosterTable.schoolId, schoolId),
        eq(sectionRosterTable.studentId, studentId),
        eq(classSectionsTable.schoolId, schoolId),
        eq(classSectionsTable.teacherStaffId, staff.id),
        eq(classSectionsTable.isPlanning, false),
      ),
    )
    .limit(1);
  if (rosterHit) return true;
  // Trusted-adult path (counselor / ESE case manager / mentor links).
  const [trustedHit] = await db
    .select({ id: studentTrustedAdultsTable.id })
    .from(studentTrustedAdultsTable)
    .where(
      and(
        eq(studentTrustedAdultsTable.schoolId, schoolId),
        eq(studentTrustedAdultsTable.staffId, staff.id),
        eq(studentTrustedAdultsTable.studentId, studentId),
      ),
    )
    .limit(1);
  return Boolean(trustedHit);
}

router.get(
  "/student-benchmarks",
  async (req: Request, res: Response) => {
    const staff = await resolveStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;

    const studentId =
      typeof req.query.studentId === "string"
        ? req.query.studentId.trim()
        : "";
    if (!studentId) {
      res.status(400).json({ error: "Missing studentId" });
      return;
    }
    const subject =
      typeof req.query.subject === "string" ? req.query.subject : "ela";
    if (!VALID_SUBJECTS.has(subject)) {
      res.status(400).json({ error: "Invalid subject" });
      return;
    }

    // Defense-in-depth: student must exist in this school AND caller
    // must be allowed to see them. Order matters — visibility check
    // first so we don't leak existence to non-authorized callers.
    const allowed = await resolveStudentVisibility(staff, schoolId, studentId);
    if (!allowed) {
      res.status(403).json({
        error: "Not in your roster or trusted-adult list",
      });
      return;
    }
    const [student] = await db
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
          eq(studentsTable.studentId, studentId),
        ),
      );
    if (!student) {
      res.status(404).json({ error: "Student not found in this school" });
      return;
    }

    // School threshold (same column as Phase 2 — single source of
    // truth so heatmap + profile color identically).
    const [settings] = await db
      .select({ thresholdPct: schoolSettingsTable.fastBenchmarkMasteryThreshold })
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId));
    const thresholdPct = settings?.thresholdPct ?? 80;

    // Available school years for the picker (newest first). Cheap
    // distinct over the per-(student, subject) slice.
    const yearRows = await db
      .selectDistinct({
        schoolYear: studentFastItemResponsesTable.schoolYear,
      })
      .from(studentFastItemResponsesTable)
      .where(
        and(
          eq(studentFastItemResponsesTable.schoolId, schoolId),
          eq(studentFastItemResponsesTable.studentId, studentId),
          eq(studentFastItemResponsesTable.subject, subject),
        ),
      );
    const availableSchoolYears = yearRows
      .map((r) => r.schoolYear)
      .sort((a, b) => b.localeCompare(a));

    // Resolve the school year — explicit param if valid; else most
    // recent with data; else current SY for an empty render. We
    // validate against a strict "YY-YY" shape AND against the
    // available-years set so a junk querystring can't ghost-render
    // an empty panel for a non-existent year.
    const rawSY = req.query.schoolYear;
    const SY_FORMAT = /^\d{2}-\d{2}$/;
    let schoolYear: string;
    if (
      typeof rawSY === "string" &&
      SY_FORMAT.test(rawSY) &&
      (availableSchoolYears.length === 0 ||
        availableSchoolYears.includes(rawSY))
    ) {
      schoolYear = rawSY;
    } else if (availableSchoolYears.length > 0) {
      schoolYear = availableSchoolYears[0]!;
    } else {
      schoolYear = schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ);
    }

    // One read for the whole year × subject — small (≤ 3 windows ×
    // ~40 benchmarks = ~120 rows per student per subject per year).
    const items = await db
      .select({
        window: studentFastItemResponsesTable.window,
        category: studentFastItemResponsesTable.category,
        benchmarkCode: studentFastItemResponsesTable.benchmarkCode,
        pointsEarned: studentFastItemResponsesTable.pointsEarned,
        pointsPossible: studentFastItemResponsesTable.pointsPossible,
      })
      .from(studentFastItemResponsesTable)
      .where(
        and(
          eq(studentFastItemResponsesTable.schoolId, schoolId),
          eq(studentFastItemResponsesTable.studentId, studentId),
          eq(studentFastItemResponsesTable.subject, subject),
          eq(studentFastItemResponsesTable.schoolYear, schoolYear),
        ),
      );

    // Status bucket — three-tier label aligned with the heatmap
    // palette: At/Above (green) ≥ threshold, Near (yellow) within
    // 10 points, Below (orange/red) otherwise.
    const statusFor = (pct: number): "below" | "near" | "at_above" => {
      if (pct >= thresholdPct) return "at_above";
      if (pct >= Math.max(0, thresholdPct - 10)) return "near";
      return "below";
    };

    interface BenchmarkRow {
      code: string;
      category: string | null;
      attempts: number;
      earned: number;
      possible: number;
      masteryPct: number;
      status: "below" | "near" | "at_above";
      mtssTagged: boolean;
    }
    interface CategoryRollup {
      category: string;
      earned: number;
      possible: number;
      masteryPct: number;
      benchmarkCount: number;
      status: "below" | "near" | "at_above";
    }
    interface WindowBlock {
      window: string; // "pm1"|"pm2"|"pm3"
      label: string;
      benchmarks: BenchmarkRow[];
      categoryRollups: CategoryRollup[];
      totalEarned: number;
      totalPossible: number;
      overallMasteryPct: number | null;
    }

    // Pivot: window → benchmarkCode → agg.
    const byWindow = new Map<
      string,
      Map<string, { category: string | null; earned: number; possible: number; attempts: number }>
    >();
    for (const r of items) {
      // pointsPossible <= 0 would corrupt the per-benchmark percent
      // (Infinity / NaN). Skip defensively even though the importer
      // shouldn't write zero-possible rows.
      if (r.pointsPossible == null || r.pointsPossible <= 0) continue;
      const w = byWindow.get(r.window) ?? new Map();
      const prior =
        w.get(r.benchmarkCode) ?? {
          category: r.category,
          earned: 0,
          possible: 0,
          attempts: 0,
        };
      prior.earned += r.pointsEarned ?? 0;
      prior.possible += r.pointsPossible;
      prior.attempts += 1;
      // Prefer first non-null category we see (Florida is consistent
      // within a code, but defensive).
      if (!prior.category && r.category) prior.category = r.category;
      w.set(r.benchmarkCode, prior);
      byWindow.set(r.window, w);
    }

    // MTSS-tagged set — real DB read against
    // student_mtss_plans.fast_benchmark_code. The column is nullable
    // and stays NULL on every row until Phase 5 surfaces a writer in
    // the plan editor; today this set is empty in every tenant but
    // the read path is live, so the pill auto-lights the moment a
    // Phase 5 write lands. No client / endpoint change needed then.
    const mtssRows = await db
      .select({ code: studentMtssPlansTable.fastBenchmarkCode })
      .from(studentMtssPlansTable)
      .where(
        and(
          eq(studentMtssPlansTable.schoolId, schoolId),
          eq(studentMtssPlansTable.studentId, studentId),
          isNull(studentMtssPlansTable.closedAt),
          isNotNull(studentMtssPlansTable.fastBenchmarkCode),
        ),
      );
    const mtssTaggedCodes = new Set<string>(
      mtssRows.map((r) => r.code).filter((c): c is string => c != null),
    );

    const WINDOW_RANK: Record<string, number> = { pm1: 0, pm2: 1, pm3: 2 };
    const windows: WindowBlock[] = Array.from(byWindow.entries())
      .sort((a, b) => (WINDOW_RANK[a[0]] ?? 9) - (WINDOW_RANK[b[0]] ?? 9))
      .map(([win, map]) => {
        const benchmarks: BenchmarkRow[] = Array.from(map.entries())
          .map(([code, agg]) => {
            const pct = Math.round((agg.earned / agg.possible) * 100);
            return {
              code,
              category: agg.category,
              attempts: agg.attempts,
              earned: agg.earned,
              possible: agg.possible,
              masteryPct: pct,
              status: statusFor(pct),
              mtssTagged: mtssTaggedCodes.has(code),
            };
          })
          .sort((a, b) => {
            const ca = a.category ?? "";
            const cb = b.category ?? "";
            if (ca !== cb) return ca.localeCompare(cb);
            return compareBenchmarkCodes(a.code, b.code);
          });

        // Category rollups — earned/possible summed across the
        // category's benchmarks (NOT a simple average of percents,
        // so a high-point-value benchmark weights correctly).
        const catAgg = new Map<
          string,
          { earned: number; possible: number; count: number }
        >();
        let totalEarned = 0;
        let totalPossible = 0;
        for (const b of benchmarks) {
          totalEarned += b.earned;
          totalPossible += b.possible;
          const key = b.category ?? "Uncategorized";
          const prior = catAgg.get(key) ?? { earned: 0, possible: 0, count: 0 };
          prior.earned += b.earned;
          prior.possible += b.possible;
          prior.count += 1;
          catAgg.set(key, prior);
        }
        const categoryRollups: CategoryRollup[] = Array.from(catAgg.entries())
          .map(([category, a]) => {
            const pct = Math.round((a.earned / a.possible) * 100);
            return {
              category,
              earned: a.earned,
              possible: a.possible,
              masteryPct: pct,
              benchmarkCount: a.count,
              status: statusFor(pct),
            };
          })
          .sort((a, b) => a.category.localeCompare(b.category));

        return {
          window: win,
          label: win.toUpperCase(),
          benchmarks,
          categoryRollups,
          totalEarned,
          totalPossible,
          overallMasteryPct:
            totalPossible > 0
              ? Math.round((totalEarned / totalPossible) * 100)
              : null,
        };
      });

    // Phase 4 — cross-year sparkline data. One extra read across ALL
    // years for this student × subject, pivoted to
    // historyByCode[code] = [{schoolYear, window, pct}, …] ordered
    // chronologically. Lets the profile sparkline span prior-year PM3
    // through this year's PM1→PM2→PM3 without a per-row round trip.
    // Bounded payload — typical student has ≤ 2 years × 3 windows ×
    // ~40 benchmarks = ~240 entries.
    const historyRows = await db
      .select({
        schoolYear: studentFastItemResponsesTable.schoolYear,
        window: studentFastItemResponsesTable.window,
        benchmarkCode: studentFastItemResponsesTable.benchmarkCode,
        pointsEarned: studentFastItemResponsesTable.pointsEarned,
        pointsPossible: studentFastItemResponsesTable.pointsPossible,
      })
      .from(studentFastItemResponsesTable)
      .where(
        and(
          eq(studentFastItemResponsesTable.schoolId, schoolId),
          eq(studentFastItemResponsesTable.studentId, studentId),
          eq(studentFastItemResponsesTable.subject, subject),
        ),
      );
    // Aggregate (schoolYear, window, code) → mastery%. NOTE: Florida
    // math benchmark codes can contain literal "|" characters
    // (e.g. "MA.7.DP.2|MA.7.DP.2.1"), so the composite key uses an
    // ASCII delimiter that can't appear in a code. Bug fixed 2026-05:
    // previously used "|" which truncated math codes on split and
    // caused the profile sparkline to never light up for Math.
    const SEP = "\u0001";
    interface HistAgg { earned: number; possible: number }
    const histAgg = new Map<string, HistAgg>();
    for (const r of historyRows) {
      if (r.pointsPossible == null || r.pointsPossible <= 0) continue;
      const key = `${r.schoolYear}${SEP}${r.window}${SEP}${r.benchmarkCode}`;
      const prior = histAgg.get(key) ?? { earned: 0, possible: 0 };
      prior.earned += r.pointsEarned ?? 0;
      prior.possible += r.pointsPossible;
      histAgg.set(key, prior);
    }
    const HISTORY_WINDOW_RANK: Record<string, number> = {
      pm1: 0, pm2: 1, pm3: 2,
    };
    const historyByCode: Record<
      string,
      Array<{ schoolYear: string; window: string; pct: number }>
    > = {};
    for (const [key, agg] of histAgg.entries()) {
      if (agg.possible === 0) continue;
      // Split into exactly 3 parts so a "|" or any other char in the
      // benchmark code survives intact.
      const firstSep = key.indexOf(SEP);
      const secondSep = key.indexOf(SEP, firstSep + 1);
      const sy = key.slice(0, firstSep);
      const win = key.slice(firstSep + 1, secondSep);
      const code = key.slice(secondSep + 1);
      const list = historyByCode[code] ?? [];
      list.push({
        schoolYear: sy,
        window: win,
        pct: Math.round((agg.earned / agg.possible) * 100),
      });
      historyByCode[code] = list;
    }
    // Chronological order — oldest school year first, then PM1→PM3
    // within a year, so the sparkline reads left-to-right.
    for (const code of Object.keys(historyByCode)) {
      historyByCode[code].sort((a, b) => {
        if (a.schoolYear !== b.schoolYear) {
          return a.schoolYear.localeCompare(b.schoolYear);
        }
        return (
          (HISTORY_WINDOW_RANK[a.window] ?? 9) -
          (HISTORY_WINDOW_RANK[b.window] ?? 9)
        );
      });
    }

    res.json({
      student: {
        studentId: student.studentId,
        firstName: student.firstName,
        lastName: student.lastName,
        grade: student.grade,
      },
      subject,
      schoolYear,
      availableSchoolYears,
      thresholdPct,
      windows,
      historyByCode,
    });
  },
);

// ---------------------------------------------------------------------
// FAST Phase 4 — Growth view + admin rollups.
// ---------------------------------------------------------------------

// Shared: load all rosters in the school keyed by teacher.
// Returns: Map<teacherStaffId, { studentIds: string[], displayName }>.
// Cached at request scope only (no module-level memo) — schools small
// enough that two queries per request is cheap.
async function loadAllSchoolRosters(
  schoolId: number,
): Promise<
  Map<number, { studentIds: string[]; displayName: string | null }>
> {
  const teachers = await db
    .select({ id: staffTable.id, displayName: staffTable.displayName })
    .from(staffTable)
    .where(and(eq(staffTable.schoolId, schoolId), eq(staffTable.active, true)));
  const sections = await db
    .select({
      sectionId: classSectionsTable.id,
      teacherStaffId: classSectionsTable.teacherStaffId,
    })
    .from(classSectionsTable)
    .where(
      and(
        eq(classSectionsTable.schoolId, schoolId),
        eq(classSectionsTable.isPlanning, false),
      ),
    );
  const sectionIds = sections.map((s) => s.sectionId);
  const sectionToTeacher = new Map<number, number>();
  for (const s of sections) sectionToTeacher.set(s.sectionId, s.teacherStaffId);

  const teacherToStudents = new Map<number, Set<string>>();
  if (sectionIds.length > 0) {
    const rosterRows = await db
      .select({
        sectionId: sectionRosterTable.sectionId,
        studentId: sectionRosterTable.studentId,
      })
      .from(sectionRosterTable)
      .where(
        and(
          eq(sectionRosterTable.schoolId, schoolId),
          inArray(sectionRosterTable.sectionId, sectionIds),
        ),
      );
    for (const r of rosterRows) {
      const tid = sectionToTeacher.get(r.sectionId);
      if (tid == null) continue;
      const set = teacherToStudents.get(tid) ?? new Set<string>();
      set.add(r.studentId);
      teacherToStudents.set(tid, set);
    }
  }
  const out = new Map<
    number,
    { studentIds: string[]; displayName: string | null }
  >();
  for (const t of teachers) {
    const set = teacherToStudents.get(t.id);
    if (!set || set.size === 0) continue;
    out.set(t.id, {
      studentIds: Array.from(set),
      displayName: t.displayName,
    });
  }
  return out;
}

// Growth view — per-benchmark + per-student delta between two windows
// on the same teacher's roster. Reuses resolveContext for the auth +
// roster pass (same gate as the absolute heatmap).
router.get(
  "/teacher-roster/benchmarks/growth",
  async (req: Request, res: Response) => {
    const ctx = await resolveContext(req, res);
    if (!ctx) return;

    const rawWinA = req.query.windowA;
    const rawSYA = req.query.schoolYearA;
    const rawWinB = req.query.windowB;
    const rawSYB = req.query.schoolYearB;
    if (
      typeof rawWinA !== "string" ||
      !VALID_WINDOWS.has(rawWinA) ||
      typeof rawSYA !== "string" ||
      rawSYA.length === 0 ||
      typeof rawWinB !== "string" ||
      !VALID_WINDOWS.has(rawWinB) ||
      typeof rawSYB !== "string" ||
      rawSYB.length === 0
    ) {
      res.status(400).json({
        error: "windowA, schoolYearA, windowB, schoolYearB are required",
      });
      return;
    }
    const windowA = rawWinA;
    const schoolYearA = rawSYA;
    const windowB = rawWinB;
    const schoolYearB = rawSYB;

    // Same window can't be both endpoints — useless and would always
    // render zero deltas.
    if (windowA === windowB && schoolYearA === schoolYearB) {
      res.status(400).json({ error: "Pick two different windows" });
      return;
    }

    const available = await loadAvailableWindows(
      ctx.schoolId,
      ctx.subject,
      ctx.studentIds,
    );

    const baseResponse = {
      teacher: {
        id: ctx.targetTeacher.id,
        displayName: ctx.targetTeacher.displayName,
      },
      subject: ctx.subject,
      windowA,
      schoolYearA,
      windowB,
      schoolYearB,
      availableWindows: available,
      thresholdPct: ctx.thresholdPct,
    };

    if (ctx.studentIds.length === 0) {
      res.json({
        ...baseResponse,
        students: [],
        benchmarks: [],
        topMovers: [],
        topRegressions: [],
      });
      return;
    }

    const [students, items] = await Promise.all([
      db
        .select({
          studentId: studentsTable.studentId,
          firstName: studentsTable.firstName,
          lastName: studentsTable.lastName,
          grade: studentsTable.grade,
        })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.schoolId, ctx.schoolId),
            inArray(studentsTable.studentId, ctx.studentIds),
          ),
        ),
      db
        .select({
          studentId: studentFastItemResponsesTable.studentId,
          schoolYear: studentFastItemResponsesTable.schoolYear,
          window: studentFastItemResponsesTable.window,
          category: studentFastItemResponsesTable.category,
          benchmarkCode: studentFastItemResponsesTable.benchmarkCode,
          pointsEarned: studentFastItemResponsesTable.pointsEarned,
          pointsPossible: studentFastItemResponsesTable.pointsPossible,
        })
        .from(studentFastItemResponsesTable)
        .where(
          and(
            eq(studentFastItemResponsesTable.schoolId, ctx.schoolId),
            eq(studentFastItemResponsesTable.subject, ctx.subject),
            inArray(studentFastItemResponsesTable.schoolYear, [
              schoolYearA,
              schoolYearB,
            ]),
            inArray(studentFastItemResponsesTable.window, [windowA, windowB]),
            inArray(
              studentFastItemResponsesTable.studentId,
              ctx.studentIds,
            ),
          ),
        ),
    ]);

    // (sliceKey, studentId, code) → {earned, possible}. sliceKey is
    // "a" or "b" since we only fetched those two slices.
    interface CellAgg { earned: number; possible: number }
    const aMap = new Map<string, CellAgg>(); // studentId|code → agg
    const bMap = new Map<string, CellAgg>();
    const benchmarkMeta = new Map<string, { category: string | null }>();
    for (const r of items) {
      if (r.pointsPossible == null || r.pointsPossible <= 0) continue;
      if (!benchmarkMeta.has(r.benchmarkCode)) {
        benchmarkMeta.set(r.benchmarkCode, { category: r.category });
      }
      const isA =
        r.schoolYear === schoolYearA && r.window === windowA;
      const isB =
        r.schoolYear === schoolYearB && r.window === windowB;
      if (!isA && !isB) continue;
      const dest = isA ? aMap : bMap;
      const key = `${r.studentId}|${r.benchmarkCode}`;
      const prior = dest.get(key) ?? { earned: 0, possible: 0 };
      prior.earned += r.pointsEarned ?? 0;
      prior.possible += r.pointsPossible;
      dest.set(key, prior);
    }

    const benchmarks = Array.from(benchmarkMeta.entries())
      .map(([code, meta]) => ({ code, category: meta.category }))
      .sort((a, b) => {
        const ca = a.category ?? "";
        const cb = b.category ?? "";
        if (ca !== cb) return ca.localeCompare(cb);
        return compareBenchmarkCodes(a.code, b.code);
      });

    interface DeltaCell {
      pctA: number | null;
      pctB: number | null;
      delta: number | null;
    }
    const studentOut = students
      .map((s) => {
        const cells: Record<string, DeltaCell> = {};
        for (const b of benchmarks) {
          const a = aMap.get(`${s.studentId}|${b.code}`);
          const bb = bMap.get(`${s.studentId}|${b.code}`);
          const pctA =
            a && a.possible > 0
              ? Math.round((a.earned / a.possible) * 100)
              : null;
          const pctB =
            bb && bb.possible > 0
              ? Math.round((bb.earned / bb.possible) * 100)
              : null;
          cells[b.code] = {
            pctA,
            pctB,
            delta: pctA != null && pctB != null ? pctB - pctA : null,
          };
        }
        return {
          studentId: s.studentId,
          firstName: s.firstName,
          lastName: s.lastName,
          grade: s.grade,
          cells,
        };
      })
      .sort((a, b) => {
        const ln = (a.lastName ?? "").localeCompare(b.lastName ?? "");
        if (ln !== 0) return ln;
        return (a.firstName ?? "").localeCompare(b.firstName ?? "");
      });

    // Per-student overall delta = mean of available cell deltas (drops
    // benchmarks with no pair). Used to rank top movers + top
    // regressions tiles.
    interface MoverEntry {
      studentId: string;
      firstName: string | null;
      lastName: string | null;
      delta: number;
      pairs: number;
    }
    const movers: MoverEntry[] = [];
    for (const s of studentOut) {
      let sum = 0;
      let n = 0;
      for (const code of Object.keys(s.cells)) {
        const c = s.cells[code];
        if (c.delta != null) {
          sum += c.delta;
          n += 1;
        }
      }
      if (n === 0) continue;
      movers.push({
        studentId: s.studentId,
        firstName: s.firstName,
        lastName: s.lastName,
        delta: Math.round(sum / n),
        pairs: n,
      });
    }
    movers.sort((a, b) => b.delta - a.delta);
    const topMovers = movers.slice(0, 3);
    const topRegressions = movers
      .filter((m) => m.delta < 0)
      .slice(-3)
      .reverse();

    res.json({
      ...baseResponse,
      students: studentOut,
      benchmarks,
      topMovers,
      topRegressions,
    });
  },
);

// Admin: category rollup across the whole school for one window.
router.get(
  "/insights/fast-benchmarks/category-rollup",
  async (req: Request, res: Response) => {
    const staff = await resolveStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!isCoreTeam(staff)) {
      res.status(403).json({ error: "Core team only" });
      return;
    }
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;

    const rawSubject = req.query.subject;
    const subject = typeof rawSubject === "string" ? rawSubject : "ela";
    if (!VALID_SUBJECTS.has(subject)) {
      res.status(400).json({ error: "Invalid subject" });
      return;
    }
    const rawWindow = req.query.window;
    const rawSY = req.query.schoolYear;
    if (
      typeof rawWindow !== "string" ||
      !VALID_WINDOWS.has(rawWindow) ||
      typeof rawSY !== "string" ||
      rawSY.length === 0
    ) {
      res
        .status(400)
        .json({ error: "subject, window, schoolYear are required" });
      return;
    }
    const window = rawWindow;
    const schoolYear = rawSY;

    const [settings] = await db
      .select({
        thresholdPct: schoolSettingsTable.fastBenchmarkMasteryThreshold,
      })
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId));
    const thresholdPct = settings?.thresholdPct ?? 80;

    // Need grade for each student — join via studentsTable. Fetch the
    // raw item rows + the matching student grades in parallel and
    // pivot in memory.
    const items = await db
      .select({
        studentId: studentFastItemResponsesTable.studentId,
        category: studentFastItemResponsesTable.category,
        benchmarkCode: studentFastItemResponsesTable.benchmarkCode,
        pointsEarned: studentFastItemResponsesTable.pointsEarned,
        pointsPossible: studentFastItemResponsesTable.pointsPossible,
      })
      .from(studentFastItemResponsesTable)
      .where(
        and(
          eq(studentFastItemResponsesTable.schoolId, schoolId),
          eq(studentFastItemResponsesTable.subject, subject),
          eq(studentFastItemResponsesTable.schoolYear, schoolYear),
          eq(studentFastItemResponsesTable.window, window),
        ),
      );

    if (items.length === 0) {
      res.json({
        subject,
        schoolYear,
        window,
        thresholdPct,
        rollup: [],
        bottom3: [],
      });
      return;
    }

    const uniqStudentIds = Array.from(new Set(items.map((r) => r.studentId)));
    const studentRows = await db
      .select({
        studentId: studentsTable.studentId,
        grade: studentsTable.grade,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          inArray(studentsTable.studentId, uniqStudentIds),
        ),
      );
    const gradeOf = new Map<string, number>();
    for (const r of studentRows) gradeOf.set(r.studentId, r.grade);

    // (grade, category) → {earned, possible, codeSet}
    interface CatAgg {
      earned: number;
      possible: number;
      codes: Set<string>;
      students: Set<string>;
    }
    const byGradeCat = new Map<string, CatAgg>();
    // (code) → {earned, possible, category} for the school-wide
    // bottom-3 tile.
    interface CodeAgg {
      earned: number;
      possible: number;
      category: string | null;
      students: Set<string>;
    }
    const byCode = new Map<string, CodeAgg>();
    for (const r of items) {
      if (r.pointsPossible == null || r.pointsPossible <= 0) continue;
      const grade = gradeOf.get(r.studentId);
      if (grade == null) continue; // student deleted/transferred
      const cat = r.category ?? "Uncategorized";
      const k = `${grade}|${cat}`;
      const prior =
        byGradeCat.get(k) ??
        ({
          earned: 0,
          possible: 0,
          codes: new Set<string>(),
          students: new Set<string>(),
        } as CatAgg);
      prior.earned += r.pointsEarned ?? 0;
      prior.possible += r.pointsPossible;
      prior.codes.add(r.benchmarkCode);
      prior.students.add(r.studentId);
      byGradeCat.set(k, prior);

      const codePrior =
        byCode.get(r.benchmarkCode) ??
        ({
          earned: 0,
          possible: 0,
          category: r.category,
          students: new Set<string>(),
        } as CodeAgg);
      codePrior.earned += r.pointsEarned ?? 0;
      codePrior.possible += r.pointsPossible;
      if (!codePrior.category && r.category) codePrior.category = r.category;
      codePrior.students.add(r.studentId);
      byCode.set(r.benchmarkCode, codePrior);
    }

    const rollup = Array.from(byGradeCat.entries())
      .map(([k, v]) => {
        const [gradeStr, category] = k.split("|");
        return {
          grade: Number(gradeStr),
          category,
          masteryPct:
            v.possible > 0
              ? Math.round((v.earned / v.possible) * 100)
              : null,
          benchmarkCount: v.codes.size,
          studentCount: v.students.size,
        };
      })
      .sort((a, b) => {
        if (a.grade !== b.grade) return a.grade - b.grade;
        return a.category.localeCompare(b.category);
      });

    const bottom3 = Array.from(byCode.entries())
      .map(([code, v]) => ({
        code,
        category: v.category,
        masteryPct:
          v.possible > 0
            ? Math.round((v.earned / v.possible) * 100)
            : 0,
        studentCount: v.students.size,
      }))
      .filter((r) => r.studentCount >= 5) // suppress tiny-N noise
      .sort((a, b) => {
        if (a.masteryPct !== b.masteryPct) return a.masteryPct - b.masteryPct;
        return compareBenchmarkCodes(a.code, b.code);
      })
      .slice(0, 3);

    res.json({
      subject,
      schoolYear,
      window,
      thresholdPct,
      rollup,
      bottom3,
    });
  },
);

// Admin: outlier teachers for a single benchmark (or the school's
// weakest benchmark if none supplied) at a given window. Per-teacher
// class mean is z-scored against the school-wide mean+stdev for that
// benchmark; teachers with z below −threshold are flagged. Threshold
// comes from school_settings.fast_outlier_z_threshold (default 1.0).
router.get(
  "/insights/fast-benchmarks/outliers",
  async (req: Request, res: Response) => {
    const staff = await resolveStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!isCoreTeam(staff)) {
      res.status(403).json({ error: "Core team only" });
      return;
    }
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;

    const rawSubject = req.query.subject;
    const subject = typeof rawSubject === "string" ? rawSubject : "ela";
    if (!VALID_SUBJECTS.has(subject)) {
      res.status(400).json({ error: "Invalid subject" });
      return;
    }
    const rawWindow = req.query.window;
    const rawSY = req.query.schoolYear;
    if (
      typeof rawWindow !== "string" ||
      !VALID_WINDOWS.has(rawWindow) ||
      typeof rawSY !== "string" ||
      rawSY.length === 0
    ) {
      res
        .status(400)
        .json({ error: "subject, window, schoolYear are required" });
      return;
    }
    const window = rawWindow;
    const schoolYear = rawSY;
    const rawCode = req.query.benchmarkCode;
    const benchmarkCode =
      typeof rawCode === "string" && rawCode.length > 0 ? rawCode : null;

    const [settings] = await db
      .select({
        zThreshold: schoolSettingsTable.fastOutlierZThreshold,
      })
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId));
    const zThreshold = settings?.zThreshold ?? 1.0;

    const rosters = await loadAllSchoolRosters(schoolId);
    if (rosters.size === 0) {
      res.json({
        subject,
        schoolYear,
        window,
        zThreshold,
        benchmarkCode: benchmarkCode ?? null,
        benchmarkCategory: null,
        teachers: [],
        availableBenchmarks: [],
      });
      return;
    }

    const allStudentIds = Array.from(
      new Set(
        Array.from(rosters.values()).flatMap((v) => v.studentIds),
      ),
    );
    if (allStudentIds.length === 0) {
      res.json({
        subject,
        schoolYear,
        window,
        zThreshold,
        benchmarkCode: benchmarkCode ?? null,
        benchmarkCategory: null,
        teachers: [],
        availableBenchmarks: [],
      });
      return;
    }

    const items = await db
      .select({
        studentId: studentFastItemResponsesTable.studentId,
        category: studentFastItemResponsesTable.category,
        benchmarkCode: studentFastItemResponsesTable.benchmarkCode,
        pointsEarned: studentFastItemResponsesTable.pointsEarned,
        pointsPossible: studentFastItemResponsesTable.pointsPossible,
      })
      .from(studentFastItemResponsesTable)
      .where(
        and(
          eq(studentFastItemResponsesTable.schoolId, schoolId),
          eq(studentFastItemResponsesTable.subject, subject),
          eq(studentFastItemResponsesTable.schoolYear, schoolYear),
          eq(studentFastItemResponsesTable.window, window),
          inArray(studentFastItemResponsesTable.studentId, allStudentIds),
        ),
      );

    // (code) → category + (studentId → mastery%). Pivot once so we
    // can both pick the weakest benchmark (when none was passed) and
    // compute per-teacher means.
    interface CodeBucket {
      category: string | null;
      // studentId → {earned, possible}
      perStudent: Map<string, { earned: number; possible: number }>;
    }
    const byCode = new Map<string, CodeBucket>();
    for (const r of items) {
      if (r.pointsPossible == null || r.pointsPossible <= 0) continue;
      const bucket =
        byCode.get(r.benchmarkCode) ??
        ({
          category: r.category,
          perStudent: new Map<
            string,
            { earned: number; possible: number }
          >(),
        } as CodeBucket);
      if (!bucket.category && r.category) bucket.category = r.category;
      const ps =
        bucket.perStudent.get(r.studentId) ?? { earned: 0, possible: 0 };
      ps.earned += r.pointsEarned ?? 0;
      ps.possible += r.pointsPossible;
      bucket.perStudent.set(r.studentId, ps);
      byCode.set(r.benchmarkCode, bucket);
    }

    // Available benchmarks (for the picker) sorted by school-wide
    // mastery ascending — the weakest naturally rises to the top.
    const availableBenchmarks = Array.from(byCode.entries())
      .map(([code, b]) => {
        let earned = 0;
        let possible = 0;
        for (const ps of b.perStudent.values()) {
          earned += ps.earned;
          possible += ps.possible;
        }
        return {
          code,
          category: b.category,
          schoolMasteryPct:
            possible > 0 ? Math.round((earned / possible) * 100) : 0,
          studentCount: b.perStudent.size,
        };
      })
      .filter((r) => r.studentCount >= 5)
      .sort((a, b) => {
        if (a.schoolMasteryPct !== b.schoolMasteryPct) {
          return a.schoolMasteryPct - b.schoolMasteryPct;
        }
        return compareBenchmarkCodes(a.code, b.code);
      });

    const targetCode =
      benchmarkCode ?? availableBenchmarks[0]?.code ?? null;
    if (!targetCode || !byCode.has(targetCode)) {
      res.json({
        subject,
        schoolYear,
        window,
        zThreshold,
        benchmarkCode: targetCode,
        benchmarkCategory: null,
        teachers: [],
        availableBenchmarks,
      });
      return;
    }

    const bucket = byCode.get(targetCode)!;
    // Per-teacher: class-avg mastery on this benchmark + n students.
    interface TeacherStat {
      teacherId: number;
      displayName: string | null;
      meanPct: number;
      studentCount: number;
    }
    const teacherStats: TeacherStat[] = [];
    for (const [teacherId, roster] of rosters.entries()) {
      let earned = 0;
      let possible = 0;
      let n = 0;
      for (const sid of roster.studentIds) {
        const ps = bucket.perStudent.get(sid);
        if (!ps || ps.possible <= 0) continue;
        earned += ps.earned;
        possible += ps.possible;
        n += 1;
      }
      if (n < 5) continue; // suppress tiny-N teachers
      teacherStats.push({
        teacherId,
        displayName: roster.displayName,
        meanPct: Math.round((earned / possible) * 100),
        studentCount: n,
      });
    }

    // School-wide mean + stdev for the z-score. Use the per-teacher
    // mean distribution (one observation per teacher) — that's the
    // distribution the admin is comparing against when they ask
    // "which teachers look unusually low here".
    let schoolMean = 0;
    let stdev = 0;
    if (teacherStats.length > 0) {
      const sum = teacherStats.reduce((a, t) => a + t.meanPct, 0);
      schoolMean = sum / teacherStats.length;
      const sqSum = teacherStats.reduce(
        (a, t) => a + (t.meanPct - schoolMean) ** 2,
        0,
      );
      stdev =
        teacherStats.length > 1
          ? Math.sqrt(sqSum / (teacherStats.length - 1))
          : 0;
    }

    const teachers = teacherStats
      .map((t) => {
        const z = stdev > 0 ? (t.meanPct - schoolMean) / stdev : 0;
        return {
          teacherId: t.teacherId,
          displayName: t.displayName,
          meanPct: t.meanPct,
          studentCount: t.studentCount,
          zScore: Math.round(z * 100) / 100,
          flagged: stdev > 0 && Math.abs(z) > zThreshold,
          direction:
            stdev > 0 && Math.abs(z) > zThreshold
              ? z < 0
                ? ("low" as const)
                : ("high" as const)
              : null,
        };
      })
      .sort((a, b) => a.meanPct - b.meanPct);

    res.json({
      subject,
      schoolYear,
      window,
      zThreshold,
      schoolMeanPct: Math.round(schoolMean * 10) / 10,
      stdevPct: Math.round(stdev * 10) / 10,
      benchmarkCode: targetCode,
      benchmarkCategory: bucket.category,
      teachers,
      availableBenchmarks,
    });
  },
);

// Admin: year-over-year cohort comparison for one (subject, current
// grade, current school year). Compares prior-year G-1 PM3 against
// current-year G PM1 by benchmark — the grade-aligned comparison
// admins use to spot summer slide and identify which benchmarks
// didn't transfer over.
router.get(
  "/insights/fast-benchmarks/year-over-year",
  async (req: Request, res: Response) => {
    const staff = await resolveStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!isCoreTeam(staff)) {
      res.status(403).json({ error: "Core team only" });
      return;
    }
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;

    const rawSubject = req.query.subject;
    const subject = typeof rawSubject === "string" ? rawSubject : "ela";
    if (!VALID_SUBJECTS.has(subject)) {
      res.status(400).json({ error: "Invalid subject" });
      return;
    }
    const rawGrade = req.query.grade;
    const grade = Number(rawGrade);
    if (!Number.isInteger(grade) || grade < 0 || grade > 12) {
      res.status(400).json({ error: "grade (0–12) required" });
      return;
    }
    const rawSY = req.query.schoolYear;
    const SY_FORMAT = /^\d{2}-\d{2}$/;
    if (typeof rawSY !== "string" || !SY_FORMAT.test(rawSY)) {
      res.status(400).json({ error: "schoolYear (YY-YY) required" });
      return;
    }
    const currentYear = rawSY;
    // Prior year = "(YY-1)-(YY-1+1)". The Phase 3 schoolYear format
    // is "24-25" / "25-26"; subtract 1 from both halves.
    const [a, b] = currentYear.split("-");
    const priorYear = `${String(Number(a) - 1).padStart(2, "0")}-${String(
      Number(b) - 1,
    ).padStart(2, "0")}`;

    // Current-year cohort: students at the requested grade right now.
    const currentRoster = await db
      .select({ studentId: studentsTable.studentId })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          eq(studentsTable.grade, grade),
        ),
      );
    const currentIds = currentRoster.map((r) => r.studentId);

    const baseResponse = {
      subject,
      grade,
      currentSchoolYear: currentYear,
      priorSchoolYear: priorYear,
      currentWindow: "pm1" as const,
      priorWindow: "pm3" as const,
    };

    if (currentIds.length === 0) {
      res.json({
        ...baseResponse,
        benchmarks: [],
        cohortSize: 0,
        priorCohortMatchCount: 0,
      });
      return;
    }

    // One read for both slices (prior PM3 + current PM1, scoped to
    // the current grade's roster — the same student ids on both
    // sides since student_id is stable across years).
    const items = await db
      .select({
        studentId: studentFastItemResponsesTable.studentId,
        schoolYear: studentFastItemResponsesTable.schoolYear,
        window: studentFastItemResponsesTable.window,
        category: studentFastItemResponsesTable.category,
        benchmarkCode: studentFastItemResponsesTable.benchmarkCode,
        pointsEarned: studentFastItemResponsesTable.pointsEarned,
        pointsPossible: studentFastItemResponsesTable.pointsPossible,
      })
      .from(studentFastItemResponsesTable)
      .where(
        and(
          eq(studentFastItemResponsesTable.schoolId, schoolId),
          eq(studentFastItemResponsesTable.subject, subject),
          inArray(studentFastItemResponsesTable.studentId, currentIds),
          inArray(studentFastItemResponsesTable.schoolYear, [
            priorYear,
            currentYear,
          ]),
          inArray(studentFastItemResponsesTable.window, ["pm1", "pm3"]),
        ),
      );

    interface SideAgg {
      earned: number;
      possible: number;
      category: string | null;
      students: Set<string>;
    }
    const priorByCode = new Map<string, SideAgg>();
    const currentByCode = new Map<string, SideAgg>();
    const priorMatchSet = new Set<string>();
    for (const r of items) {
      if (r.pointsPossible == null || r.pointsPossible <= 0) continue;
      const isPrior =
        r.schoolYear === priorYear && r.window === "pm3";
      const isCurr =
        r.schoolYear === currentYear && r.window === "pm1";
      if (!isPrior && !isCurr) continue;
      const dest = isPrior ? priorByCode : currentByCode;
      const prior =
        dest.get(r.benchmarkCode) ??
        ({
          earned: 0,
          possible: 0,
          category: r.category,
          students: new Set<string>(),
        } as SideAgg);
      prior.earned += r.pointsEarned ?? 0;
      prior.possible += r.pointsPossible;
      if (!prior.category && r.category) prior.category = r.category;
      prior.students.add(r.studentId);
      dest.set(r.benchmarkCode, prior);
      if (isPrior) priorMatchSet.add(r.studentId);
    }

    const codes = new Set<string>([
      ...priorByCode.keys(),
      ...currentByCode.keys(),
    ]);
    const benchmarks = Array.from(codes)
      .map((code) => {
        const p = priorByCode.get(code);
        const c = currentByCode.get(code);
        const priorPct =
          p && p.possible > 0
            ? Math.round((p.earned / p.possible) * 100)
            : null;
        const currentPct =
          c && c.possible > 0
            ? Math.round((c.earned / c.possible) * 100)
            : null;
        return {
          code,
          category: c?.category ?? p?.category ?? null,
          priorPct,
          currentPct,
          delta:
            priorPct != null && currentPct != null
              ? currentPct - priorPct
              : null,
          priorN: p?.students.size ?? 0,
          currentN: c?.students.size ?? 0,
        };
      })
      .sort((a, b) => {
        // Biggest regressions first — that's the actionable view.
        // Push code rows missing a side to the bottom.
        if (a.delta == null && b.delta == null) {
          return compareBenchmarkCodes(a.code, b.code);
        }
        if (a.delta == null) return 1;
        if (b.delta == null) return -1;
        return a.delta - b.delta;
      });

    res.json({
      ...baseResponse,
      benchmarks,
      cohortSize: currentIds.length,
      priorCohortMatchCount: priorMatchSet.size,
    });
  },
);

export default router;
