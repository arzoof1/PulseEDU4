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
  schoolSettingsTable,
  schoolsTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { requireSchool } from "../lib/scope.js";
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

function isCoreTeam(s: StaffRow): boolean {
  return Boolean(
    s.isSuperUser ||
      s.isAdmin ||
      s.isEseCoordinator ||
      s.isMtssCoordinator ||
      s.isBehaviorSpecialist,
  );
}

// Natural sort for Florida benchmark codes like "ELA.6.R.1.10" vs
// "ELA.6.R.1.2" — split on '.', compare numeric segments numerically,
// string segments lexically. Without this "ELA.6.R.1.10" sorts ahead
// of "ELA.6.R.1.2" alphabetically, which is wrong.
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

  // Roster (union of periods) — same source-of-truth as /teacher-roster
  // but without the period filter, since the heatmap is class-wide.
  const sections = await db
    .select({ id: classSectionsTable.id })
    .from(classSectionsTable)
    .where(
      and(
        eq(classSectionsTable.schoolId, schoolId),
        eq(classSectionsTable.teacherStaffId, targetTeacherId),
      ),
    );
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

    // Per-student row data. Cells are keyed by benchmark code; nulls
    // for benchmarks the student has no data on (rare but possible
    // — student absent or row dropped at import).
    interface OutCell {
      pct: number;
      earned: number;
      possible: number;
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
    const [students, items] = await Promise.all([
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
        `${ctx.subject.toUpperCase()} · ${schoolYear} ${window.toUpperCase()} · Mastery threshold ${ctx.thresholdPct}% · Generated ${new Date().toLocaleString()}`,
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

      // Column header row — rotate -45° so long benchmark codes fit
      // without overflowing the column width.
      const headerHeight = 90;
      const headerY = doc.y;
      doc
        .font("Helvetica-Bold")
        .fontSize(9)
        .text("Student", doc.page.margins.left, headerY + headerHeight - 14, {
          width: nameColW,
        });

      chunk.forEach((b, i) => {
        const x = doc.page.margins.left + nameColW + i * cellW + cellW / 2;
        doc.save();
        doc.rotate(-45, { origin: [x, headerY + headerHeight - 6] });
        doc
          .font("Helvetica")
          .fontSize(7)
          .text(b.code, x - 80, headerY + headerHeight - 10, {
            width: 80,
            align: "right",
          });
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

    doc
      .moveDown(0.8)
      .fontSize(8)
      .fillColor("#888")
      .text(
        "Confidential — for staff use only. Cells = percent of points earned on each benchmark.",
        { align: "center" },
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

export default router;
