// Reteach Activity — school-wide rollup of benchmark_reteach_log so admin /
// reading coach / MTSS roles can see what reteach has been provided across
// the whole school, not just one teacher's roster.
//
// Routes:
//   GET /api/reteach-activity/summary
//       Tile rollup: last-30-day totals (1:1 + small-group), unique
//       students reached, unique benchmarks targeted, top-3 loggers,
//       top-3 benchmarks. Powers the InsightsHub tile preview.
//
//   GET /api/reteach-activity
//       Filterable detail list. Filters: dateFrom, dateTo, teacherId,
//       grade, subject, benchmarkCode, format, schoolYear. Joined with
//       student + staff names. Capped at 1000 rows (CSV-friendly).
//
// Authz: read-only, gated to admin / Core Team / Counselor / Guidance
// Counselor. Reading-coach is not its own schema column today; a school
// typically tags them as MTSS Coordinator or Behavior Specialist
// (already in Core Team), so the existing gate covers the role.
// Teachers do NOT see this surface — they get their own roster's data
// via the existing progress-report footer.
import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  benchmarkReteachLogTable,
  staffTable,
  studentsTable,
} from "@workspace/db";
import { and, eq, isNull, sql, desc, gte, lte } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam } from "../lib/coreTeam.js";

const router: IRouter = Router();

const VALID_FORMATS = new Set(["one_on_one", "small_group"]);

function canView(staff: {
  isSuperUser?: boolean | null;
  isDistrictAdmin?: boolean | null;
  isAdmin?: boolean | null;
  isBehaviorSpecialist?: boolean | null;
  isMtssCoordinator?: boolean | null;
  isSchoolPsychologist?: boolean | null;
  isCounselor?: boolean | null;
  isGuidanceCounselor?: boolean | null;
}): boolean {
  return (
    isCoreTeam(staff) ||
    Boolean(staff.isCounselor || staff.isGuidanceCounselor)
  );
}

async function loadStaff(req: Request) {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

// GET /api/reteach-activity/summary?days=30
router.get("/reteach-activity/summary", async (req: Request, res: Response) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req);
  if (!staff) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  if (!canView(staff)) {
    res.status(403).json({ error: "Not authorized" });
    return;
  }

  const days = (() => {
    const raw = req.query.days;
    if (typeof raw !== "string") return 30;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0 || n > 365) return 30;
    return n;
  })();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const base = and(
    eq(benchmarkReteachLogTable.schoolId, schoolId),
    isNull(benchmarkReteachLogTable.deletedAt),
    gte(benchmarkReteachLogTable.createdAt, since),
  );

  const [totals, byLogger, byBenchmark, uniqueAgg] = await Promise.all([
    // Format totals
    db
      .select({
        format: benchmarkReteachLogTable.format,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(benchmarkReteachLogTable)
      .where(base)
      .groupBy(benchmarkReteachLogTable.format),
    // Top 3 loggers (rows attributed to them, with name)
    db
      .select({
        teacherStaffId: benchmarkReteachLogTable.teacherStaffId,
        teacherName: staffTable.displayName,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(benchmarkReteachLogTable)
      .leftJoin(
        staffTable,
        eq(staffTable.id, benchmarkReteachLogTable.teacherStaffId),
      )
      .where(base)
      .groupBy(
        benchmarkReteachLogTable.teacherStaffId,
        staffTable.displayName,
      )
      .orderBy(desc(sql`COUNT(*)`))
      .limit(3),
    // Top 3 benchmark codes
    db
      .select({
        benchmarkCode: benchmarkReteachLogTable.benchmarkCode,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(benchmarkReteachLogTable)
      .where(base)
      .groupBy(benchmarkReteachLogTable.benchmarkCode)
      .orderBy(desc(sql`COUNT(*)`))
      .limit(3),
    // Unique student + benchmark counts
    db
      .select({
        uniqueStudents: sql<number>`COUNT(DISTINCT ${benchmarkReteachLogTable.studentId})::int`,
        uniqueBenchmarks: sql<number>`COUNT(DISTINCT ${benchmarkReteachLogTable.benchmarkCode})::int`,
      })
      .from(benchmarkReteachLogTable)
      .where(base),
  ]);

  let oneOnOne = 0;
  let smallGroup = 0;
  for (const t of totals) {
    if (t.format === "one_on_one") oneOnOne = t.count;
    else if (t.format === "small_group") smallGroup = t.count;
  }

  res.json({
    days,
    oneOnOne,
    smallGroup,
    uniqueStudents: uniqueAgg[0]?.uniqueStudents ?? 0,
    uniqueBenchmarks: uniqueAgg[0]?.uniqueBenchmarks ?? 0,
    topLoggers: byLogger.map((r) => ({
      staffId: r.teacherStaffId,
      name: r.teacherName ?? `Staff #${r.teacherStaffId}`,
      count: r.count,
    })),
    topBenchmarks: byBenchmark,
  });
});

// GET /api/reteach-activity?dateFrom=&dateTo=&teacherId=&grade=&benchmarkCode=&format=&schoolYear=
router.get("/reteach-activity", async (req: Request, res: Response) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req);
  if (!staff) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  if (!canView(staff)) {
    res.status(403).json({ error: "Not authorized" });
    return;
  }

  const conds = [
    eq(benchmarkReteachLogTable.schoolId, schoolId),
    isNull(benchmarkReteachLogTable.deletedAt),
  ];

  const { dateFrom, dateTo, teacherId, benchmarkCode, format, schoolYear } =
    req.query;

  if (typeof dateFrom === "string" && dateFrom.length > 0) {
    const d = new Date(dateFrom);
    if (!Number.isNaN(d.getTime())) {
      conds.push(gte(benchmarkReteachLogTable.createdAt, d));
    }
  }
  if (typeof dateTo === "string" && dateTo.length > 0) {
    const d = new Date(dateTo);
    if (!Number.isNaN(d.getTime())) {
      // Inclusive end-of-day
      d.setHours(23, 59, 59, 999);
      conds.push(lte(benchmarkReteachLogTable.createdAt, d));
    }
  }
  if (typeof teacherId === "string" && teacherId.length > 0) {
    const n = Number.parseInt(teacherId, 10);
    if (Number.isFinite(n)) {
      conds.push(eq(benchmarkReteachLogTable.teacherStaffId, n));
    }
  }
  if (typeof benchmarkCode === "string" && benchmarkCode.length > 0) {
    conds.push(eq(benchmarkReteachLogTable.benchmarkCode, benchmarkCode));
  }
  if (
    typeof format === "string" &&
    VALID_FORMATS.has(format)
  ) {
    conds.push(eq(benchmarkReteachLogTable.format, format));
  }
  if (typeof schoolYear === "string" && schoolYear.length > 0) {
    conds.push(eq(benchmarkReteachLogTable.schoolYear, schoolYear));
  }

  // Grade filter must be applied in SQL — applying it after `LIMIT 1000`
  // would silently drop matches in large schools (architect finding).
  // Push it down by joining the students table and adding it to the
  // WHERE clause before ORDER BY / LIMIT.
  if (typeof req.query.grade === "string" && req.query.grade.length > 0) {
    const g = Number.parseInt(req.query.grade, 10);
    if (Number.isFinite(g)) {
      conds.push(eq(studentsTable.grade, g));
    }
  }

  const LIMIT = 1000;

  const rows = await db
    .select({
      id: benchmarkReteachLogTable.id,
      createdAt: benchmarkReteachLogTable.createdAt,
      studentId: benchmarkReteachLogTable.studentId,
      benchmarkCode: benchmarkReteachLogTable.benchmarkCode,
      teacherStaffId: benchmarkReteachLogTable.teacherStaffId,
      teacherName: staffTable.displayName,
      format: benchmarkReteachLogTable.format,
      groupSessionId: benchmarkReteachLogTable.groupSessionId,
      strategy: benchmarkReteachLogTable.strategy,
      minutes: benchmarkReteachLogTable.minutes,
      note: benchmarkReteachLogTable.note,
      schoolYear: benchmarkReteachLogTable.schoolYear,
      pmWindowAtLog: benchmarkReteachLogTable.pmWindowAtLog,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      localSisId: studentsTable.localSisId,
      grade: studentsTable.grade,
    })
    .from(benchmarkReteachLogTable)
    .leftJoin(
      staffTable,
      eq(staffTable.id, benchmarkReteachLogTable.teacherStaffId),
    )
    // INNER JOIN to students so the grade filter (when set) is applied
    // in SQL and so we get student name/grade in a single round trip.
    // School scoping on the reteach row already isolates the tenant;
    // the additional `students.school_id` predicate is defense in depth.
    .innerJoin(
      studentsTable,
      and(
        eq(studentsTable.studentId, benchmarkReteachLogTable.studentId),
        eq(studentsTable.schoolId, schoolId),
      ),
    )
    .where(and(...conds))
    .orderBy(desc(benchmarkReteachLogTable.createdAt))
    .limit(LIMIT);

  const enriched = rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    studentId: r.studentId,
    benchmarkCode: r.benchmarkCode,
    teacherStaffId: r.teacherStaffId,
    teacherName: r.teacherName ?? `Staff #${r.teacherStaffId}`,
    format: r.format,
    groupSessionId: r.groupSessionId,
    strategy: r.strategy,
    minutes: r.minutes,
    note: r.note,
    schoolYear: r.schoolYear,
    pmWindowAtLog: r.pmWindowAtLog,
    firstName: r.firstName,
    lastName: r.lastName,
    localSisId: r.localSisId ?? null,
    grade: r.grade,
  }));

  res.json({
    rows: enriched,
    truncated: rows.length >= LIMIT,
    limit: LIMIT,
  });
});

export default router;
