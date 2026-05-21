// Instruction Log + Instructional Coverage routes.
//
// Teacher-owned (writes) and Core-Team-visible (admin rollups) backing
// for the "stars on the Benchmarks tab" / new "Instruction Log" Roster
// tab / "Instructional Coverage" Insights dashboard.
//
// Routes:
//   GET    /api/teacher-roster/benchmark-catalog?subject=
//          → catalog of standards for the dropdown. Subject is required.
//
//   GET    /api/teacher-roster/benchmark-deliveries/counts?subject=&teacherId=
//          → { [benchmarkCode]: { count, lastTaughtOn } }
//            Per-teacher. Powers the star badges. teacherId optional
//            (defaults to caller); Core Team only when targeting others.
//
//   GET    /api/teacher-roster/benchmark-deliveries?subject=&benchmark=&teacherId=
//          → history rows (id, deliveredOn, notes, createdAt).
//
//   POST   /api/teacher-roster/benchmark-deliveries
//          body: { subject, benchmarkCodes: string[], deliveredOn, notes? }
//          → creates N rows in one shot. Backdating allowed within
//            current school year; future dates rejected.
//
//   DELETE /api/teacher-roster/benchmark-deliveries/:id
//          → owner-only hard delete.
//
//   GET    /api/teacher-roster/benchmark-deliveries/export.csv?subject=&teacherId=
//          → CSV of the caller's (or, for Core Team, target teacher's) log.
//
//   GET    /api/insights/instructional-coverage?subject=
//          → Core-Team: { [benchmarkCode]: { totalDeliveries,
//            distinctTeachers, lastTaughtOn, category, label } }
//            Plus mastery stitch (avgPct from student_fast_item_responses
//            current school year) when the subject has FAST data, so
//            the dashboard can flag "weak + untaught" without a second
//            round-trip.
import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  staffTable,
  schoolBenchmarksTable,
  benchmarkDeliveriesTable,
  studentFastItemResponsesTable,
  classSectionsTable,
  sectionRosterTable,
  studentsTable,
} from "@workspace/db";
import { and, eq, inArray, sql, desc, asc } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam as isCoreTeamShared } from "../lib/coreTeam.js";
import { schoolYearLabelFor, DEFAULT_SCHOOL_TZ } from "../lib/schoolYear.js";

const router: IRouter = Router();

const VALID_SUBJECTS = new Set([
  "ela",
  "math",
  "writing",
  "science",
  "social_studies",
]);

type StaffRow = typeof staffTable.$inferSelect;

async function resolveStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function isCoreTeam(s: StaffRow): boolean {
  return isCoreTeamShared(s);
}

function parseSubject(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.toLowerCase().trim();
  return VALID_SUBJECTS.has(s) ? s : null;
}

function todayISO(): string {
  // School-local YYYY-MM-DD per existing convention.
  return new Date().toLocaleDateString("en-CA", {
    timeZone: DEFAULT_SCHOOL_TZ,
  });
}

// Pull the distinct grade levels a teacher is responsible for, by
// walking their class sections → roster → students. Used to filter
// the benchmark catalog so a 6th-grade teacher doesn't see 7th/8th
// standards in the Instruction Log dropdown.
async function teacherGrades(
  schoolId: number,
  teacherStaffId: number,
): Promise<number[]> {
  const rows = await db
    .select({ grade: studentsTable.grade })
    .from(classSectionsTable)
    .innerJoin(
      sectionRosterTable,
      and(
        eq(sectionRosterTable.schoolId, classSectionsTable.schoolId),
        eq(sectionRosterTable.sectionId, classSectionsTable.id),
      ),
    )
    .innerJoin(
      studentsTable,
      and(
        eq(studentsTable.schoolId, sectionRosterTable.schoolId),
        eq(studentsTable.studentId, sectionRosterTable.studentId),
      ),
    )
    .where(
      and(
        eq(classSectionsTable.schoolId, schoolId),
        eq(classSectionsTable.teacherStaffId, teacherStaffId),
        eq(classSectionsTable.isPlanning, false),
      ),
    );
  return Array.from(new Set(rows.map((r) => r.grade))).sort((a, b) => a - b);
}

// Florida benchmark codes encode grade as the 2nd dotted segment
// (e.g. "ELA.6.R.1.1" → 6, "MA.6.NSO.1.1" → 6, "ELA.K.R.1.1" → "K").
// Returns the grade as a string token for set lookups; null when the
// code doesn't follow the convention.
function gradeTokenFromCode(code: string): string | null {
  const parts = code.split(".");
  if (parts.length < 2) return null;
  const g = parts[1]?.trim().toUpperCase();
  return g ? g : null;
}

function gradeTokensForTeacherGrades(grades: number[]): Set<string> {
  const out = new Set<string>();
  for (const g of grades) {
    if (g === 0) out.add("K");
    out.add(String(g));
  }
  return out;
}

// ----------------------------- catalog -------------------------------------
router.get(
  "/teacher-roster/benchmark-catalog",
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = await resolveStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    const subject = parseSubject(req.query.subject);
    if (!subject) {
      res.status(400).json({ error: "subject required" });
      return;
    }
    // Resolve target teacher (defaults to caller; Core Team may pass
    // another staffId — mirrors counts/history endpoints).
    let teacherId = staff.id;
    if (req.query.teacherId) {
      const t = Number(req.query.teacherId);
      if (!Number.isInteger(t) || t <= 0) {
        res.status(400).json({ error: "bad teacherId" });
        return;
      }
      if (t !== staff.id && !isCoreTeam(staff)) {
        res.status(403).json({ error: "Core Team required" });
        return;
      }
      teacherId = t;
    }
    const rows = await db
      .select({
        code: schoolBenchmarksTable.code,
        category: schoolBenchmarksTable.category,
        label: schoolBenchmarksTable.label,
        source: schoolBenchmarksTable.source,
      })
      .from(schoolBenchmarksTable)
      .where(
        and(
          eq(schoolBenchmarksTable.schoolId, schoolId),
          eq(schoolBenchmarksTable.subject, subject),
          eq(schoolBenchmarksTable.active, true),
        ),
      )
      .orderBy(asc(schoolBenchmarksTable.category), asc(schoolBenchmarksTable.code));

    // Filter by the teacher's actual grade levels. A 6th-grade teacher
    // should only see 6th-grade benchmarks. If we can't determine any
    // grades (teacher has no roster yet, or none of the codes encode a
    // recognizable grade), fall back to the unfiltered list so the
    // dropdown isn't empty.
    const grades = await teacherGrades(schoolId, teacherId);
    const allowed = gradeTokensForTeacherGrades(grades);
    let filtered = rows;
    if (allowed.size > 0) {
      const matches = rows.filter((r) => {
        const tok = gradeTokenFromCode(r.code);
        return tok != null && allowed.has(tok);
      });
      if (matches.length > 0) filtered = matches;
    }
    res.json({ subject, teacherId, grades, benchmarks: filtered });
  },
);

// ----------------------------- counts (per-teacher star) -------------------
router.get(
  "/teacher-roster/benchmark-deliveries/counts",
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = await resolveStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    const subject = parseSubject(req.query.subject);
    if (!subject) {
      res.status(400).json({ error: "subject required" });
      return;
    }
    let teacherId = staff.id;
    if (req.query.teacherId) {
      const t = Number(req.query.teacherId);
      if (!Number.isInteger(t) || t <= 0) {
        res.status(400).json({ error: "bad teacherId" });
        return;
      }
      if (t !== staff.id && !isCoreTeam(staff)) {
        res.status(403).json({ error: "Core Team required" });
        return;
      }
      teacherId = t;
    }
    const currentSY = schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ);
    const rows = (await db.execute(sql`
      SELECT benchmark_code,
             COUNT(*)::int AS cnt,
             MAX(delivered_on)::text AS last_on
        FROM benchmark_deliveries
       WHERE school_id = ${schoolId}
         AND teacher_staff_id = ${teacherId}
         AND subject = ${subject}
       GROUP BY benchmark_code
    `)).rows as Array<{ benchmark_code: string; cnt: number; last_on: string }>;
    const counts: Record<string, { count: number; lastTaughtOn: string }> = {};
    for (const r of rows) {
      counts[r.benchmark_code] = { count: r.cnt, lastTaughtOn: r.last_on };
    }
    res.json({ subject, teacherId, schoolYear: currentSY, counts });
  },
);

// ----------------------------- history list --------------------------------
router.get(
  "/teacher-roster/benchmark-deliveries",
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = await resolveStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    const subject = parseSubject(req.query.subject);
    if (!subject) {
      res.status(400).json({ error: "subject required" });
      return;
    }
    let teacherId = staff.id;
    if (req.query.teacherId) {
      const t = Number(req.query.teacherId);
      if (!Number.isInteger(t) || t <= 0) {
        res.status(400).json({ error: "bad teacherId" });
        return;
      }
      if (t !== staff.id && !isCoreTeam(staff)) {
        res.status(403).json({ error: "Core Team required" });
        return;
      }
      teacherId = t;
    }
    const benchmarkRaw = req.query.benchmark;
    const conds = [
      eq(benchmarkDeliveriesTable.schoolId, schoolId),
      eq(benchmarkDeliveriesTable.teacherStaffId, teacherId),
      eq(benchmarkDeliveriesTable.subject, subject),
    ];
    if (typeof benchmarkRaw === "string" && benchmarkRaw.trim()) {
      conds.push(eq(benchmarkDeliveriesTable.benchmarkCode, benchmarkRaw.trim()));
    }
    const rows = await db
      .select({
        id: benchmarkDeliveriesTable.id,
        benchmarkCode: benchmarkDeliveriesTable.benchmarkCode,
        deliveredOn: benchmarkDeliveriesTable.deliveredOn,
        notes: benchmarkDeliveriesTable.notes,
        createdAt: benchmarkDeliveriesTable.createdAt,
        teacherStaffId: benchmarkDeliveriesTable.teacherStaffId,
      })
      .from(benchmarkDeliveriesTable)
      .where(and(...conds))
      .orderBy(desc(benchmarkDeliveriesTable.deliveredOn), desc(benchmarkDeliveriesTable.id))
      .limit(500);
    res.json({
      subject,
      teacherId,
      ownerCanDelete: teacherId === staff.id,
      rows,
    });
  },
);

// ----------------------------- create (multi-select) -----------------------
router.post(
  "/teacher-roster/benchmark-deliveries",
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = await resolveStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    const body = req.body as {
      subject?: unknown;
      benchmarkCodes?: unknown;
      deliveredOn?: unknown;
      notes?: unknown;
    };
    const subject = parseSubject(body.subject);
    if (!subject) {
      res.status(400).json({ error: "subject required" });
      return;
    }
    if (!Array.isArray(body.benchmarkCodes) || body.benchmarkCodes.length === 0) {
      res.status(400).json({ error: "benchmarkCodes[] required" });
      return;
    }
    const codes = Array.from(
      new Set(
        body.benchmarkCodes
          .filter((c): c is string => typeof c === "string")
          .map((c) => c.trim())
          .filter(Boolean),
      ),
    );
    if (codes.length === 0) {
      res.status(400).json({ error: "benchmarkCodes[] required" });
      return;
    }
    if (codes.length > 50) {
      res.status(400).json({ error: "too many codes (max 50)" });
      return;
    }
    const deliveredOnRaw =
      typeof body.deliveredOn === "string" ? body.deliveredOn.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deliveredOnRaw)) {
      res.status(400).json({ error: "deliveredOn must be YYYY-MM-DD" });
      return;
    }
    const today = todayISO();
    if (deliveredOnRaw > today) {
      res.status(400).json({ error: "Cannot log a date in the future" });
      return;
    }
    const currentSY = schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ);
    const deliveredSY = schoolYearLabelFor(
      new Date(`${deliveredOnRaw}T12:00:00`),
      DEFAULT_SCHOOL_TZ,
    );
    if (deliveredSY !== currentSY) {
      res.status(400).json({
        error: `Date must be in the current school year (${currentSY})`,
      });
      return;
    }
    let notes: string | null = null;
    if (typeof body.notes === "string") {
      const trimmed = body.notes.trim();
      if (trimmed.length > 280) {
        res.status(400).json({ error: "notes too long (max 280)" });
        return;
      }
      notes = trimmed || null;
    }
    // Verify each code exists in this school's catalog for this subject.
    // Prevents typos from silently inflating counts.
    const catalog = await db
      .select({ code: schoolBenchmarksTable.code })
      .from(schoolBenchmarksTable)
      .where(
        and(
          eq(schoolBenchmarksTable.schoolId, schoolId),
          eq(schoolBenchmarksTable.subject, subject),
          inArray(schoolBenchmarksTable.code, codes),
        ),
      );
    const known = new Set(catalog.map((r) => r.code));
    const unknown = codes.filter((c) => !known.has(c));
    if (unknown.length > 0) {
      res.status(400).json({
        error: `Unknown benchmark code(s): ${unknown.slice(0, 3).join(", ")}`,
      });
      return;
    }
    const rows = codes.map((code) => ({
      schoolId,
      teacherStaffId: staff.id,
      subject,
      benchmarkCode: code,
      deliveredOn: deliveredOnRaw,
      notes,
    }));
    const inserted = await db
      .insert(benchmarkDeliveriesTable)
      .values(rows)
      .returning({ id: benchmarkDeliveriesTable.id });
    res.json({ created: inserted.length, ids: inserted.map((r) => r.id) });
  },
);

// ----------------------------- delete (owner-only) -------------------------
router.delete(
  "/teacher-roster/benchmark-deliveries/:id",
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = await resolveStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "bad id" });
      return;
    }
    const [row] = await db
      .select()
      .from(benchmarkDeliveriesTable)
      .where(
        and(
          eq(benchmarkDeliveriesTable.id, id),
          eq(benchmarkDeliveriesTable.schoolId, schoolId),
        ),
      );
    if (!row) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (row.teacherStaffId !== staff.id) {
      res.status(403).json({ error: "Only the owning teacher can delete" });
      return;
    }
    await db
      .delete(benchmarkDeliveriesTable)
      .where(eq(benchmarkDeliveriesTable.id, id));
    res.json({ ok: true });
  },
);

// ----------------------------- CSV export ----------------------------------
router.get(
  "/teacher-roster/benchmark-deliveries/export.csv",
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = await resolveStaff(req);
    if (!staff) {
      res.status(401).send("Sign-in required");
      return;
    }
    const subject = parseSubject(req.query.subject);
    if (!subject) {
      res.status(400).send("subject required");
      return;
    }
    let teacherId = staff.id;
    if (req.query.teacherId) {
      const t = Number(req.query.teacherId);
      if (!Number.isInteger(t) || t <= 0) {
        res.status(400).send("bad teacherId");
        return;
      }
      if (t !== staff.id && !isCoreTeam(staff)) {
        res.status(403).send("Core Team required");
        return;
      }
      teacherId = t;
    }
    const rows = await db
      .select({
        benchmarkCode: benchmarkDeliveriesTable.benchmarkCode,
        deliveredOn: benchmarkDeliveriesTable.deliveredOn,
        notes: benchmarkDeliveriesTable.notes,
        createdAt: benchmarkDeliveriesTable.createdAt,
      })
      .from(benchmarkDeliveriesTable)
      .where(
        and(
          eq(benchmarkDeliveriesTable.schoolId, schoolId),
          eq(benchmarkDeliveriesTable.teacherStaffId, teacherId),
          eq(benchmarkDeliveriesTable.subject, subject),
        ),
      )
      .orderBy(desc(benchmarkDeliveriesTable.deliveredOn));

    const esc = (v: unknown): string => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = "benchmark_code,delivered_on,notes,logged_at\n";
    const lines = rows.map(
      (r) =>
        `${esc(r.benchmarkCode)},${esc(r.deliveredOn)},${esc(r.notes)},${esc(
          r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
        )}`,
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="instruction-log-${subject}.csv"`,
    );
    res.send(header + lines.join("\n") + "\n");
  },
);

// ----------------------------- admin rollup --------------------------------
router.get(
  "/insights/instructional-coverage",
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = await resolveStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!isCoreTeam(staff)) {
      res.status(403).json({ error: "Core Team required" });
      return;
    }
    const subject = parseSubject(req.query.subject);
    if (!subject) {
      res.status(400).json({ error: "subject required" });
      return;
    }
    // Catalog drives the row set so untaught standards still appear.
    const catalog = await db
      .select({
        code: schoolBenchmarksTable.code,
        category: schoolBenchmarksTable.category,
        label: schoolBenchmarksTable.label,
      })
      .from(schoolBenchmarksTable)
      .where(
        and(
          eq(schoolBenchmarksTable.schoolId, schoolId),
          eq(schoolBenchmarksTable.subject, subject),
          eq(schoolBenchmarksTable.active, true),
        ),
      )
      .orderBy(asc(schoolBenchmarksTable.category), asc(schoolBenchmarksTable.code));

    // Per-benchmark delivery stats. Single grouped query.
    const stats = (await db.execute(sql`
      SELECT benchmark_code,
             COUNT(*)::int AS total,
             COUNT(DISTINCT teacher_staff_id)::int AS distinct_teachers,
             MAX(delivered_on)::text AS last_on
        FROM benchmark_deliveries
       WHERE school_id = ${schoolId}
         AND subject = ${subject}
       GROUP BY benchmark_code
    `)).rows as Array<{
      benchmark_code: string;
      total: number;
      distinct_teachers: number;
      last_on: string;
    }>;
    const statMap = new Map<
      string,
      { total: number; distinctTeachers: number; lastTaughtOn: string }
    >();
    for (const r of stats) {
      statMap.set(r.benchmark_code, {
        total: r.total,
        distinctTeachers: r.distinct_teachers,
        lastTaughtOn: r.last_on,
      });
    }

    // Mastery stitch (current SY only, FAST subjects only). Drives the
    // "weak + untaught" flag in the dashboard. Subjects with no FAST data
    // (writing/science/social_studies) simply return null mastery.
    const currentSY = schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ);
    const mastery = (await db.execute(sql`
      SELECT benchmark_code,
             SUM(points_earned)::int AS earned,
             SUM(points_possible)::int AS possible
        FROM student_fast_item_responses
       WHERE school_id = ${schoolId}
         AND subject = ${subject}
         AND school_year = ${currentSY}
       GROUP BY benchmark_code
    `)).rows as Array<{
      benchmark_code: string;
      earned: number | null;
      possible: number | null;
    }>;
    const masteryMap = new Map<string, number | null>();
    for (const r of mastery) {
      const p = r.possible ?? 0;
      masteryMap.set(
        r.benchmark_code,
        p > 0 ? Math.round(((r.earned ?? 0) / p) * 100) : null,
      );
    }

    const benchmarks = catalog.map((c) => {
      const s = statMap.get(c.code);
      return {
        code: c.code,
        category: c.category,
        label: c.label,
        totalDeliveries: s?.total ?? 0,
        distinctTeachers: s?.distinctTeachers ?? 0,
        lastTaughtOn: s?.lastTaughtOn ?? null,
        masteryPct: masteryMap.get(c.code) ?? null,
      };
    });

    res.json({ subject, schoolYear: currentSY, benchmarks });
  },
);

// ----------------------------- per-benchmark teacher drilldown -------------
//
// Powers the Instructional Coverage row-click drawer. Given a benchmark
// (either exact code, e.g. "ELA.7.R.1.1", or a suffix that spans grades,
// e.g. "R.1.1"), return one row per teacher who has students in a
// matching grade, with their delivery count, last-taught date, and the
// mastery their roster achieved on that benchmark in the current SY.
//
// Multi-tenancy: every read filters by school_id. Core Team gated.
router.get(
  "/insights/instructional-coverage/benchmark",
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = await resolveStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!isCoreTeam(staff)) {
      res.status(403).json({ error: "Core Team required" });
      return;
    }
    const subject = parseSubject(req.query.subject);
    if (!subject) {
      res.status(400).json({ error: "subject required" });
      return;
    }
    const codeParam =
      typeof req.query.code === "string" ? req.query.code.trim() : "";
    const suffixParam =
      typeof req.query.suffix === "string" ? req.query.suffix.trim() : "";
    if (!codeParam && !suffixParam) {
      res.status(400).json({ error: "code or suffix required" });
      return;
    }
    const gradeParam =
      typeof req.query.grade === "string" ? req.query.grade.trim() : "";

    // Resolve the set of catalog codes this drilldown spans. Suffix
    // mode collapses cross-grade duplicates (e.g. R.1.1 across G6/G7/G8).
    const catalog = await db
      .select({
        code: schoolBenchmarksTable.code,
        category: schoolBenchmarksTable.category,
        label: schoolBenchmarksTable.label,
      })
      .from(schoolBenchmarksTable)
      .where(
        and(
          eq(schoolBenchmarksTable.schoolId, schoolId),
          eq(schoolBenchmarksTable.subject, subject),
          eq(schoolBenchmarksTable.active, true),
        ),
      );

    const suffixOf = (c: string) => {
      const parts = c.split(".");
      return parts.length > 2 ? parts.slice(2).join(".") : c;
    };
    const matchingCodes = catalog.filter((r) => {
      if (codeParam && r.code !== codeParam) return false;
      if (suffixParam && suffixOf(r.code) !== suffixParam) return false;
      if (gradeParam && gradeTokenFromCode(r.code) !== gradeParam) return false;
      return true;
    });
    if (matchingCodes.length === 0) {
      res.json({
        subject,
        codes: [],
        teachers: [],
        schoolYear: schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ),
      });
      return;
    }
    const codeList = matchingCodes.map((c) => c.code);
    const category = matchingCodes[0].category;
    const label = matchingCodes[0].label;

    // Grade → codes lookup: a teacher who teaches Grade 6 is responsible
    // for the Grade-6 variants of this benchmark only.
    const codesByGrade = new Map<string, string[]>();
    for (const c of matchingCodes) {
      const g = gradeTokenFromCode(c.code);
      if (!g) continue;
      const arr = codesByGrade.get(g) ?? [];
      arr.push(c.code);
      codesByGrade.set(g, arr);
    }
    const relevantGrades = new Set(codesByGrade.keys());

    // Teacher roster: (teacherStaffId, studentId, gradeToken). Walks
    // class_sections → section_roster → students. is_planning sections
    // are excluded so an unscheduled prep section doesn't fake
    // attribution.
    const rosterRows = await db
      .select({
        teacherStaffId: classSectionsTable.teacherStaffId,
        studentId: studentsTable.studentId,
        grade: studentsTable.grade,
      })
      .from(classSectionsTable)
      .innerJoin(
        sectionRosterTable,
        and(
          eq(sectionRosterTable.schoolId, classSectionsTable.schoolId),
          eq(sectionRosterTable.sectionId, classSectionsTable.id),
        ),
      )
      .innerJoin(
        studentsTable,
        and(
          eq(studentsTable.schoolId, sectionRosterTable.schoolId),
          eq(studentsTable.studentId, sectionRosterTable.studentId),
        ),
      )
      .where(
        and(
          eq(classSectionsTable.schoolId, schoolId),
          eq(classSectionsTable.isPlanning, false),
        ),
      );

    // Per-teacher: which codes apply (based on grades they teach), and
    // which student IDs feed into their mastery roll-up.
    type TeacherAgg = {
      teacherStaffId: number;
      codes: Set<string>;
      grades: Set<string>;
      students: Set<string>;
    };
    const teacherMap = new Map<number, TeacherAgg>();
    for (const r of rosterRows) {
      const g = r.grade === 0 ? "K" : String(r.grade);
      if (!relevantGrades.has(g)) continue;
      const existing = teacherMap.get(r.teacherStaffId) ?? {
        teacherStaffId: r.teacherStaffId,
        codes: new Set<string>(),
        grades: new Set<string>(),
        students: new Set<string>(),
      };
      existing.grades.add(g);
      for (const code of codesByGrade.get(g) ?? []) existing.codes.add(code);
      existing.students.add(r.studentId);
      teacherMap.set(r.teacherStaffId, existing);
    }

    // Also include teachers who logged a delivery for any of these
    // codes but somehow aren't on the active roster (data hygiene
    // case). They get "—" for mastery but their teaching is visible.
    const deliveryRows = await db
      .select({
        teacherStaffId: benchmarkDeliveriesTable.teacherStaffId,
        benchmarkCode: benchmarkDeliveriesTable.benchmarkCode,
        deliveredOn: benchmarkDeliveriesTable.deliveredOn,
      })
      .from(benchmarkDeliveriesTable)
      .where(
        and(
          eq(benchmarkDeliveriesTable.schoolId, schoolId),
          eq(benchmarkDeliveriesTable.subject, subject),
          inArray(benchmarkDeliveriesTable.benchmarkCode, codeList),
        ),
      );

    type DeliveryAgg = { count: number; lastTaughtOn: string | null };
    const deliveryByTeacher = new Map<number, DeliveryAgg>();
    for (const d of deliveryRows) {
      const cur = deliveryByTeacher.get(d.teacherStaffId) ?? {
        count: 0,
        lastTaughtOn: null,
      };
      cur.count += 1;
      if (!cur.lastTaughtOn || d.deliveredOn > cur.lastTaughtOn) {
        cur.lastTaughtOn = d.deliveredOn;
      }
      deliveryByTeacher.set(d.teacherStaffId, cur);
      if (!teacherMap.has(d.teacherStaffId)) {
        teacherMap.set(d.teacherStaffId, {
          teacherStaffId: d.teacherStaffId,
          codes: new Set<string>([d.benchmarkCode]),
          grades: new Set<string>(),
          students: new Set<string>(),
        });
      } else {
        teacherMap.get(d.teacherStaffId)!.codes.add(d.benchmarkCode);
      }
    }

    // Pull mastery once: every (student, code) item response in the
    // current SY for the codes in scope. Then bucket by teacher using
    // the roster map.
    // Pull mastery once for every (student, code) in the current SY for
    // the codes in scope. We deliberately do NOT pass the roster student
    // list as a SQL parameter — `ANY(${arr})` with drizzle's sql tag
    // expands into one placeholder per value, which blows past the
    // node-postgres parameter limit on schools with hundreds of kids.
    // The (school_id, subject, school_year, benchmark_code) filter
    // already prunes hard; we filter to roster kids in JS below.
    const currentSY = schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ);
    const codeLiteral = `{${codeList
      .map((c) => `"${c.replace(/"/g, '\\"')}"`)
      .join(",")}}`;
    const masteryRows = (
      await db.execute(sql`
        SELECT student_id,
               benchmark_code,
               SUM(points_earned)::int AS earned,
               SUM(points_possible)::int AS possible
          FROM student_fast_item_responses
         WHERE school_id = ${schoolId}
           AND subject = ${subject}
           AND school_year = ${currentSY}
           AND benchmark_code = ANY(${codeLiteral}::text[])
         GROUP BY student_id, benchmark_code
      `)
    ).rows as Array<{
      student_id: string;
      benchmark_code: string;
      earned: number | null;
      possible: number | null;
    }>;

    // Index roster: studentId → which teachers carry that kid. Mastery
    // points feed into every responsible teacher (a kid might be in
    // multiple sections; that's fine — same roster math as the rest of
    // the app).
    const teachersForStudent = new Map<string, Set<number>>();
    for (const r of rosterRows) {
      const set = teachersForStudent.get(r.studentId) ?? new Set<number>();
      set.add(r.teacherStaffId);
      teachersForStudent.set(r.studentId, set);
    }

    const masteryByTeacher = new Map<
      number,
      { earned: number; possible: number; studentIds: Set<string> }
    >();
    for (const m of masteryRows) {
      const teachers = teachersForStudent.get(m.student_id);
      if (!teachers) continue;
      for (const t of teachers) {
        // Only count if this teacher is responsible for this code's
        // grade (prevents a science teacher who happens to also have
        // these kids on a roster from getting attributed).
        const agg = teacherMap.get(t);
        if (!agg || !agg.codes.has(m.benchmark_code)) continue;
        const cur = masteryByTeacher.get(t) ?? {
          earned: 0,
          possible: 0,
          studentIds: new Set<string>(),
        };
        cur.earned += m.earned ?? 0;
        cur.possible += m.possible ?? 0;
        cur.studentIds.add(m.student_id);
        masteryByTeacher.set(t, cur);
      }
    }

    // Resolve staff display names in one round-trip.
    const staffIds = Array.from(teacherMap.keys());
    const staffRows = staffIds.length
      ? await db
          .select({
            id: staffTable.id,
            displayName: staffTable.displayName,
          })
          .from(staffTable)
          .where(inArray(staffTable.id, staffIds))
      : [];
    const nameById = new Map<number, string>();
    for (const s of staffRows) {
      nameById.set(s.id, s.displayName || `Staff #${s.id}`);
    }

    const teachers = Array.from(teacherMap.values()).map((t) => {
      const d = deliveryByTeacher.get(t.teacherStaffId);
      const m = masteryByTeacher.get(t.teacherStaffId);
      const masteryPct =
        m && m.possible > 0 ? Math.round((m.earned / m.possible) * 100) : null;
      const gradeArr = Array.from(t.grades).sort((a, b) =>
        a === "K" ? -1 : b === "K" ? 1 : Number(a) - Number(b),
      );
      return {
        teacherStaffId: t.teacherStaffId,
        name: nameById.get(t.teacherStaffId) ?? `Staff #${t.teacherStaffId}`,
        grades: gradeArr,
        rosterStudents: t.students.size,
        codes: Array.from(t.codes).sort(),
        deliveries: d?.count ?? 0,
        lastTaughtOn: d?.lastTaughtOn ?? null,
        masteryPct,
        studentsAssessed: m?.studentIds.size ?? 0,
      };
    });

    res.json({
      subject,
      codes: codeList,
      category,
      label,
      schoolYear: currentSY,
      teachers,
    });
  },
);

export default router;
