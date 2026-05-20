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

// ----------------------------- catalog -------------------------------------
router.get(
  "/teacher-roster/benchmark-catalog",
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const subject = parseSubject(req.query.subject);
    if (!subject) {
      res.status(400).json({ error: "subject required" });
      return;
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
    res.json({ subject, benchmarks: rows });
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

export default router;
