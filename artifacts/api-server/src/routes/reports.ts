// Admin / ESE / Teacher accommodation usage reports.
// R1: mode=teacher only. mode=student returns 501 (not yet implemented).
//
// Authz:
//   - Admin or ESE Coordinator: may request any teacherId.
//   - Plain teacher: may only request their own teacherId in mode=teacher.
//   - mode=student: admin/ESE only (returns 501 in R1 anyway).

import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  staffTable,
  classSectionsTable,
  sectionRosterTable,
  studentAccommodationsTable,
  accommodationLogsTable,
  studentsTable,
  hallPassesTable,
  pbisEntriesTable,
  housesTable,
} from "@workspace/db";
import { and, eq, isNull, inArray, sql, desc } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { requireSchool } from "../lib/scope.js";
import { computeWalletsForSchool } from "../lib/storeRedemptions.js";

// Neutralize CSV formula injection: a cell starting with = + - @ (or a control
// char) can execute in Excel/Sheets. Prefix with an apostrophe and always quote.
function csvCell(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

// Parse a positive-integer query param, or null when absent/invalid.
function intParam(v: unknown): number | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const router: IRouter = Router();

async function requireStaff(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  (req as Request & { staff: typeof staff }).staff = staff;
  next();
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;

function todayIsoDate(): string {
  // UTC day, matches the substring(created_at,1,10) key used in the
  // accommodation_logs partial unique index and duplicate guard.
  return new Date().toISOString().slice(0, 10);
}

// Strict YYYY-MM-DD validation: format AND real calendar date (not 02-30).
function parseStrictIsoDate(s: string): Date | null {
  if (!ISO_DATE_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  // Round-trip: reject normalized dates like 2026-02-30 → 2026-03-02
  if (d.toISOString().slice(0, 10) !== s) return null;
  return d;
}

function eachDateInclusive(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  const from = new Date(`${fromIso}T00:00:00Z`).getTime();
  const to = new Date(`${toIso}T00:00:00Z`).getTime();
  for (let t = from; t <= to; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

// List of teachers (active staff who teach at least one non-planning section).
// Used by the Reports UI's teacher picker. Admin / ESE only.
router.get("/reports/teachers", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  if (!staff.isSuperUser && !staff.isAdmin && !staff.isEseCoordinator) {
    res.status(403).json({ error: "Admin or ESE coordinator only" });
    return;
  }
  // Scope by staff.school_id. classSections does not yet carry school_id
  // (D4), so we scope through the teacher record instead.
  const rows = await db
    .selectDistinct({
      id: staffTable.id,
      displayName: staffTable.displayName,
    })
    .from(staffTable)
    .innerJoin(
      classSectionsTable,
      eq(classSectionsTable.teacherStaffId, staffTable.id),
    )
    .where(
      and(
        eq(staffTable.active, true),
        eq(classSectionsTable.isPlanning, false),
        eq(staffTable.schoolId, schoolId),
      ),
    );
  rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
  res.json({ teachers: rows });
});

router.get("/reports/accommodations", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const mode = String(req.query.mode ?? "");

  // ---- date range ----
  const fromRaw = req.query.from ? String(req.query.from) : todayIsoDate();
  const toRaw = req.query.to ? String(req.query.to) : todayIsoDate();
  const fromDate = parseStrictIsoDate(fromRaw);
  const toDate = parseStrictIsoDate(toRaw);
  if (!fromDate || !toDate) {
    res
      .status(400)
      .json({ error: "from and to must be valid YYYY-MM-DD calendar dates" });
    return;
  }
  if (toRaw < fromRaw) {
    res.status(400).json({ error: "to must be on or after from" });
    return;
  }
  const spanDays =
    Math.round((toDate.getTime() - fromDate.getTime()) / 86400000) + 1;
  if (spanDays > MAX_RANGE_DAYS) {
    res
      .status(400)
      .json({ error: `Date range may not exceed ${MAX_RANGE_DAYS} days` });
    return;
  }
  const dates = eachDateInclusive(fromRaw, toRaw);

  // ---- mode dispatch ----
  if (mode === "student") {
    if (!staff.isSuperUser && !staff.isAdmin && !staff.isEseCoordinator) {
      res.status(403).json({ error: "Admin or ESE coordinator only" });
      return;
    }
    res.status(501).json({ error: "Student-mode reports not yet implemented" });
    return;
  }
  if (mode !== "teacher") {
    res.status(400).json({ error: "mode must be 'teacher' or 'student'" });
    return;
  }

  // ---- mode=teacher ----
  const teacherIdNum = Number(req.query.teacherId);
  if (!Number.isInteger(teacherIdNum) || teacherIdNum < 1) {
    res.status(400).json({ error: "teacherId (positive integer) is required" });
    return;
  }

  // Teacher can only see their own data; admin / ESE can see anyone's.
  const isPrivileged = staff.isSuperUser || staff.isAdmin || staff.isEseCoordinator;
  if (!isPrivileged && teacherIdNum !== staff.id) {
    res.status(403).json({ error: "You may only view your own usage" });
    return;
  }

  // Teacher must belong to the same school as the caller — otherwise an
  // admin in school A could pull a teacher's full activity from school B
  // by knowing the teacher's id.
  const [teacher] = await db
    .select()
    .from(staffTable)
    .where(
      and(eq(staffTable.id, teacherIdNum), eq(staffTable.schoolId, schoolId)),
    );
  if (!teacher) {
    res.status(404).json({ error: "Teacher not found" });
    return;
  }

  let periodFilter: number | null = null;
  if (req.query.period !== undefined && req.query.period !== "") {
    const p = Number(req.query.period);
    if (!Number.isInteger(p) || p < 1 || p > 12) {
      res
        .status(400)
        .json({ error: "period must be an integer between 1 and 12" });
      return;
    }
    periodFilter = p;
  }

  // ---- Teacher's sections ----
  const sectionsAll = await db
    .select()
    .from(classSectionsTable)
    .where(
      and(
        eq(classSectionsTable.schoolId, schoolId),
        eq(classSectionsTable.teacherStaffId, teacher.id),
      ),
    );

  const sections =
    periodFilter == null
      ? sectionsAll
      : sectionsAll.filter((s) => s.period === periodFilter);
  const sectionIds = sections.map((s) => s.id);
  const teachingPeriods = Array.from(
    new Set(sections.filter((s) => !s.isPlanning).map((s) => s.period)),
  );

  // ---- Roster + accommodated count per section ----
  const rosterRows = sectionIds.length
    ? await db
        .select()
        .from(sectionRosterTable)
        .where(
          and(
            eq(sectionRosterTable.schoolId, schoolId),
            inArray(sectionRosterTable.sectionId, sectionIds),
          ),
        )
    : [];
  const rosterBySection = new Map<number, string[]>();
  for (const r of rosterRows) {
    const list = rosterBySection.get(r.sectionId) ?? [];
    list.push(r.studentId);
    rosterBySection.set(r.sectionId, list);
  }

  const allRosterStudentIds = Array.from(
    new Set(rosterRows.map((r) => r.studentId)),
  );
  const activeAssignments = allRosterStudentIds.length
    ? await db
        .select({
          studentId: studentAccommodationsTable.studentId,
        })
        .from(studentAccommodationsTable)
        .where(
          and(
            eq(studentAccommodationsTable.schoolId, schoolId),
            inArray(
              studentAccommodationsTable.studentId,
              allRosterStudentIds,
            ),
            isNull(studentAccommodationsTable.removedAt),
          ),
        )
    : [];
  const accommodatedStudentIds = new Set(
    activeAssignments.map((a) => a.studentId),
  );

  const sectionsOut = sections.map((s) => {
    const roster = rosterBySection.get(s.id) ?? [];
    const accommodatedRosterCount = roster.filter((id) =>
      accommodatedStudentIds.has(id),
    ).length;
    return {
      id: s.id,
      period: s.period,
      courseName: s.courseName,
      isPlanning: s.isPlanning,
      rosterCount: roster.length,
      accommodatedRosterCount,
    };
  });

  // ---- Logs by this teacher in range (optionally filtered by period) ----
  const logRows = await db
    .select()
    .from(accommodationLogsTable)
    .where(
      and(
        eq(accommodationLogsTable.schoolId, schoolId),
        eq(accommodationLogsTable.staffId, teacher.id),
        sql`substring(${accommodationLogsTable.createdAt}, 1, 10) >= ${fromRaw}`,
        sql`substring(${accommodationLogsTable.createdAt}, 1, 10) <= ${toRaw}`,
        periodFilter != null
          ? eq(accommodationLogsTable.period, periodFilter)
          : sql`true`,
      ),
    );

  // ---- Daily x period grid ----
  type Cell = {
    date: string;
    period: number;
    sectionId: number | null;
    submitted: boolean;
    providedCount: number;
    refusedCount: number;
    coverage: { logged: number; eligible: number };
  };

  // Map period -> sectionId (non-planning only)
  const sectionByPeriod = new Map<number, (typeof sectionsOut)[number]>();
  for (const s of sectionsOut) {
    if (!s.isPlanning) sectionByPeriod.set(s.period, s);
  }

  const daily: Cell[] = [];
  for (const date of dates) {
    for (const period of teachingPeriods) {
      const section = sectionByPeriod.get(period);
      const cellLogs = logRows.filter(
        (l) =>
          l.period === period &&
          typeof l.createdAt === "string" &&
          l.createdAt.slice(0, 10) === date,
      );
      const provided = cellLogs.filter(
        (l) => (l.status ?? "provided") === "provided",
      );
      const refused = cellLogs.filter((l) => l.status === "refused");
      const loggedStudentIds = new Set(
        provided.map((l) => l.studentId).filter((id) => !!id),
      );
      const eligible = section?.accommodatedRosterCount ?? 0;
      daily.push({
        date,
        period,
        sectionId: section?.id ?? null,
        submitted: cellLogs.length > 0,
        providedCount: provided.length,
        refusedCount: refused.length,
        coverage: { logged: loggedStudentIds.size, eligible },
      });
    }
  }

  // ---- Totals ----
  const totalProvided = logRows.filter(
    (l) => (l.status ?? "provided") === "provided",
  ).length;
  const totalRefused = logRows.filter((l) => l.status === "refused").length;
  const daysWithActivity = new Set(
    logRows.map((l) =>
      typeof l.createdAt === "string" ? l.createdAt.slice(0, 10) : "",
    ),
  ).size;

  let coverageNumerator = 0;
  let coverageDenominator = 0;
  for (const c of daily) {
    if (c.coverage.eligible > 0) {
      coverageNumerator += c.coverage.logged;
      coverageDenominator += c.coverage.eligible;
    }
  }
  const avgCoveragePct =
    coverageDenominator > 0
      ? Math.round((coverageNumerator / coverageDenominator) * 100)
      : null;

  // ---- Recent feed (last 20) ----
  const recentRows = await db
    .select({
      id: accommodationLogsTable.id,
      createdAt: accommodationLogsTable.createdAt,
      period: accommodationLogsTable.period,
      studentId: accommodationLogsTable.studentId,
      accommodation: accommodationLogsTable.accommodation,
      status: accommodationLogsTable.status,
    })
    .from(accommodationLogsTable)
    .where(
      and(
        eq(accommodationLogsTable.schoolId, schoolId),
        eq(accommodationLogsTable.staffId, teacher.id),
        sql`substring(${accommodationLogsTable.createdAt}::text, 1, 10) >= ${fromRaw}`,
        sql`substring(${accommodationLogsTable.createdAt}::text, 1, 10) <= ${toRaw}`,
        periodFilter != null
          ? eq(accommodationLogsTable.period, periodFilter)
          : sql`true`,
      ),
    )
    .orderBy(desc(accommodationLogsTable.createdAt))
    .limit(20);

  const recentStudentIds = Array.from(
    new Set(recentRows.map((r) => r.studentId)),
  );
  const recentStudents = recentStudentIds.length
    ? await db
        .select({
          studentId: studentsTable.studentId,
          localSisId: studentsTable.localSisId,
          firstName: studentsTable.firstName,
          lastName: studentsTable.lastName,
        })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.schoolId, schoolId),
            inArray(studentsTable.studentId, recentStudentIds),
          ),
        )
    : [];
  const studentInfoById = new Map(
    recentStudents.map((s) => [
      s.studentId,
      {
        name:
          `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim() ||
          (s.localSisId ?? ""),
        localSisId: s.localSisId ?? null,
      },
    ]),
  );

  const recent = recentRows.map((r) => {
    const info = studentInfoById.get(r.studentId);
    return {
      id: r.id,
      createdAt: r.createdAt,
      period: r.period,
      studentId: r.studentId,
      localSisId: info?.localSisId ?? null,
      studentName: info?.name ?? "",
      accommodation: r.accommodation,
      status: r.status ?? "provided",
    };
  });

  res.json({
    mode: "teacher",
    teacher: {
      id: teacher.id,
      displayName: teacher.displayName,
    },
    range: { from: fromRaw, to: toRaw, days: dates.length },
    periodFilter,
    sections: sectionsOut,
    daily,
    totals: {
      providedCount: totalProvided,
      refusedCount: totalRefused,
      daysWithActivity,
      avgCoveragePct,
    },
    recent,
  });
});

// School-wide hall pass report for a single day. Admin / ESE only.
//   GET /api/reports/hall-passes?date=YYYY-MM-DD  (default: today UTC)
// Returns: totals + top-10 lists (student takers, student lost minutes,
// teacher granters, destinations).
router.get("/reports/hall-passes", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  if (!staff.isSuperUser && !staff.isAdmin && !staff.isEseCoordinator) {
    res.status(403).json({ error: "Admin or ESE coordinator only" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const dateRaw = req.query.date ? String(req.query.date) : todayIsoDate();
  if (!parseStrictIsoDate(dateRaw)) {
    res
      .status(400)
      .json({ error: "date must be a valid YYYY-MM-DD calendar date" });
    return;
  }

  const passes = await db
    .select({
      studentId: hallPassesTable.studentId,
      destination: hallPassesTable.destination,
      teacherName: hallPassesTable.teacherName,
      createdAt: hallPassesTable.createdAt,
      endedAt: hallPassesTable.endedAt,
      status: hallPassesTable.status,
    })
    .from(hallPassesTable)
    .where(
      and(
        eq(hallPassesTable.schoolId, schoolId),
        sql`substring(${hallPassesTable.createdAt}, 1, 10) = ${dateRaw}`,
      ),
    );

  const nowMs = Date.now();
  // Per-pass minutes lost. Capped at 8h to neutralize stuck active passes.
  const SAFETY_CAP_MIN = 480;
  function passMinutes(p: { createdAt: string; endedAt: string | null }): number {
    const start = Date.parse(p.createdAt);
    if (Number.isNaN(start)) return 0;
    const endRef = p.endedAt ? Date.parse(p.endedAt) : nowMs;
    if (Number.isNaN(endRef)) return 0;
    const mins = Math.max(0, (endRef - start) / 60000);
    return Math.min(mins, SAFETY_CAP_MIN);
  }

  let totalLost = 0;
  let activePassCount = 0;
  const studentCount = new Map<string, number>();
  const studentMins = new Map<string, number>();
  const teacherCount = new Map<string, number>();
  const destCount = new Map<string, number>();
  for (const p of passes) {
    const m = passMinutes(p);
    totalLost += m;
    if (p.status === "active") activePassCount++;
    studentCount.set(p.studentId, (studentCount.get(p.studentId) ?? 0) + 1);
    studentMins.set(p.studentId, (studentMins.get(p.studentId) ?? 0) + m);
    teacherCount.set(
      p.teacherName,
      (teacherCount.get(p.teacherName) ?? 0) + 1,
    );
    destCount.set(p.destination, (destCount.get(p.destination) ?? 0) + 1);
  }

  // Resolve student display names for the top lists (single batch query).
  const idsNeeded = Array.from(
    new Set([
      ...Array.from(studentCount.keys()),
      ...Array.from(studentMins.keys()),
    ]),
  );
  const studentRows = idsNeeded.length
    ? await db
        .select({
          studentId: studentsTable.studentId,
          localSisId: studentsTable.localSisId,
          firstName: studentsTable.firstName,
          lastName: studentsTable.lastName,
        })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.schoolId, schoolId),
            inArray(studentsTable.studentId, idsNeeded),
          ),
        )
    : [];
  const nameById = new Map(
    studentRows.map((s) => [
      s.studentId,
      `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim() || "—",
    ]),
  );
  const localSisById = new Map(
    studentRows.map((s) => [s.studentId, s.localSisId ?? null]),
  );

  function topN<K>(m: Map<K, number>, n = 10): Array<[K, number]> {
    return Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
  }

  res.json({
    date: dateRaw,
    asOf: new Date(nowMs).toISOString(),
    totalPasses: passes.length,
    totalLostMinutes: Math.round(totalLost),
    activePassCount,
    topStudentTakers: topN(studentCount).map(([id, count]) => ({
      studentId: id,
      localSisId: localSisById.get(id) ?? null,
      studentName: nameById.get(id) ?? id,
      count,
    })),
    topStudentLostMinutes: topN(studentMins).map(([id, mins]) => ({
      studentId: id,
      localSisId: localSisById.get(id) ?? null,
      studentName: nameById.get(id) ?? id,
      minutes: Math.round(mins),
    })),
    topTeacherGranters: topN(teacherCount).map(([teacherName, count]) => ({
      teacherName,
      count,
    })),
    topDestinations: topN(destCount).map(([destination, count]) => ({
      destination,
      count,
    })),
  });
});

// PBIS report.
//   GET /api/reports/pbis?from=YYYY-MM-DD&to=YYYY-MM-DD&teacherName=&reason=&studentId=
// Auth scope:
//   - admin / ESE / PBIS coordinator: school-wide; all filters honored as given.
//   - other staff: forced to their own awarded entries (teacherName filter ignored).
router.get("/reports/pbis", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const fromRaw = req.query.from ? String(req.query.from) : todayIsoDate();
  const toRaw = req.query.to ? String(req.query.to) : todayIsoDate();
  if (!parseStrictIsoDate(fromRaw) || !parseStrictIsoDate(toRaw)) {
    res
      .status(400)
      .json({ error: "from and to must be valid YYYY-MM-DD calendar dates" });
    return;
  }
  if (toRaw < fromRaw) {
    res.status(400).json({ error: "to must be on or after from" });
    return;
  }
  const fromDate = parseStrictIsoDate(fromRaw)!;
  const toDate = parseStrictIsoDate(toRaw)!;
  const spanDays =
    Math.round((toDate.getTime() - fromDate.getTime()) / 86400000) + 1;
  if (spanDays > MAX_RANGE_DAYS) {
    res
      .status(400)
      .json({ error: `Date range may not exceed ${MAX_RANGE_DAYS} days` });
    return;
  }

  const isPrivileged =
    staff.isSuperUser || staff.isAdmin || staff.isEseCoordinator || staff.isPbisCoordinator;

  const reasonFilter =
    typeof req.query.reason === "string" && req.query.reason.trim()
      ? req.query.reason.trim()
      : null;
  const studentFilter =
    typeof req.query.studentId === "string" && req.query.studentId.trim()
      ? req.query.studentId.trim()
      : null;

  // Privileged users may filter by any teacher name; non-privileged users are
  // pinned to their own entries via the immutable staff_id, never the
  // mutable, non-unique display name.
  let teacherFilter: string | null = null;
  if (isPrivileged) {
    if (
      typeof req.query.teacherName === "string" &&
      req.query.teacherName.trim()
    ) {
      teacherFilter = req.query.teacherName.trim();
    }
  }

  const conds = [
    eq(pbisEntriesTable.schoolId, schoolId),
    sql`substring(${pbisEntriesTable.createdAt}, 1, 10) >= ${fromRaw}`,
    sql`substring(${pbisEntriesTable.createdAt}, 1, 10) <= ${toRaw}`,
    sql`${pbisEntriesTable.voidedAt} IS NULL`,
  ];
  if (reasonFilter) conds.push(eq(pbisEntriesTable.reason, reasonFilter));
  if (studentFilter) conds.push(eq(pbisEntriesTable.studentId, studentFilter));
  if (teacherFilter) conds.push(eq(pbisEntriesTable.staffName, teacherFilter));
  if (!isPrivileged) {
    conds.push(eq(pbisEntriesTable.staffId, staff.id));
    teacherFilter = staff.displayName; // surfaced in appliedFilters only
  }

  const rowsRaw = await db
    .select()
    .from(pbisEntriesTable)
    .where(and(...conds))
    .orderBy(desc(pbisEntriesTable.createdAt))
    .limit(500);

  const rowStudentIds = Array.from(
    new Set(rowsRaw.map((r) => r.studentId).filter(Boolean)),
  );
  const studentRows = rowStudentIds.length
    ? await db
        .select({
          studentId: studentsTable.studentId,
          localSisId: studentsTable.localSisId,
          firstName: studentsTable.firstName,
          lastName: studentsTable.lastName,
        })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.schoolId, schoolId),
            inArray(studentsTable.studentId, rowStudentIds),
          ),
        )
    : [];
  const nameById = new Map(
    studentRows.map((s) => [
      s.studentId,
      `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim() || "—",
    ]),
  );
  const localSisById = new Map(
    studentRows.map((s) => [s.studentId, s.localSisId ?? null]),
  );

  let totalPoints = 0;
  const byReason = new Map<string, { count: number; points: number }>();
  const byTeacher = new Map<string, { count: number; points: number }>();
  const distinctStudents = new Set<string>();
  for (const r of rowsRaw) {
    totalPoints += r.points || 0;
    distinctStudents.add(r.studentId);
    const br = byReason.get(r.reason) ?? { count: 0, points: 0 };
    br.count++;
    br.points += r.points || 0;
    byReason.set(r.reason, br);
    const bt = byTeacher.get(r.staffName || "—") ?? { count: 0, points: 0 };
    bt.count++;
    bt.points += r.points || 0;
    byTeacher.set(r.staffName || "—", bt);
  }

  res.json({
    range: { from: fromRaw, to: toRaw, days: spanDays },
    scope: isPrivileged ? "school" : "self",
    appliedFilters: {
      teacherName: teacherFilter,
      reason: reasonFilter,
      studentId: studentFilter,
    },
    totals: {
      count: rowsRaw.length,
      totalPoints,
      distinctStudents: distinctStudents.size,
      truncated: rowsRaw.length === 500,
    },
    byReason: Array.from(byReason.entries())
      .map(([reason, v]) => ({ reason, ...v }))
      .sort((a, b) => b.points - a.points),
    byTeacher: Array.from(byTeacher.entries())
      .map(([teacherName, v]) => ({ teacherName, ...v }))
      .sort((a, b) => b.points - a.points),
    rows: rowsRaw.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      studentId: r.studentId,
      localSisId: localSisById.get(r.studentId) ?? null,
      studentName: nameById.get(r.studentId) ?? "—",
      reason: r.reason,
      points: r.points,
      staffName: r.staffName,
    })),
  });
});

// ---------------------------------------------------------------------------
// My PBIS Usage — anonymized, school-wide point-AWARDING benchmark.
//   GET /api/reports/pbis-usage?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Purpose: let EVERY staffer see how much they use the positive-recognition
// system relative to their peers, WITHOUT exposing any other teacher's name.
// The caller's own numbers come back in `me`; everyone else is rolled up into
// anonymized school / department / period aggregates.
//
// Privacy: comparison buckets (school avg, each department, each period) are
// suppressed (value = null, suppressed = true) whenever fewer than
// MIN_COMPARE_TEACHERS distinct awarding teachers contributed, so a small
// department or single-teacher period can't be used to back into one person's
// numbers. Top behaviors are reason-level (not teacher-identifying) and are
// never suppressed.
//
// Counts only NON-VOIDED POSITIVE awards (polarity <> 'negative'), matching the
// /insights/behavior "positives" definition.
const MIN_COMPARE_TEACHERS = 3;
router.get("/reports/pbis-usage", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  // Window — default to the trailing 30 days (matches the insights default).
  const toRaw = req.query.to ? String(req.query.to) : todayIsoDate();
  let fromRaw: string;
  if (req.query.from) {
    fromRaw = String(req.query.from);
  } else {
    const base = parseStrictIsoDate(toRaw);
    if (!base) {
      res
        .status(400)
        .json({ error: "to must be a valid YYYY-MM-DD calendar date" });
      return;
    }
    base.setUTCDate(base.getUTCDate() - 29);
    fromRaw = base.toISOString().slice(0, 10);
  }
  if (!parseStrictIsoDate(fromRaw) || !parseStrictIsoDate(toRaw)) {
    res
      .status(400)
      .json({ error: "from and to must be valid YYYY-MM-DD calendar dates" });
    return;
  }
  if (toRaw < fromRaw) {
    res.status(400).json({ error: "to must be on or after from" });
    return;
  }
  const fromDate = parseStrictIsoDate(fromRaw)!;
  const toDate = parseStrictIsoDate(toRaw)!;
  const spanDays =
    Math.round((toDate.getTime() - fromDate.getTime()) / 86400000) + 1;
  if (spanDays > MAX_RANGE_DAYS) {
    res
      .status(400)
      .json({ error: `Date range may not exceed ${MAX_RANGE_DAYS} days` });
    return;
  }

  // ---- All non-voided positive awards in the window (school-wide) ---------
  const entries = await db
    .select({
      studentId: pbisEntriesTable.studentId,
      reason: pbisEntriesTable.reason,
      points: pbisEntriesTable.points,
      staffId: pbisEntriesTable.staffId,
    })
    .from(pbisEntriesTable)
    .where(
      and(
        eq(pbisEntriesTable.schoolId, schoolId),
        sql`substring(${pbisEntriesTable.createdAt}, 1, 10) >= ${fromRaw}`,
        sql`substring(${pbisEntriesTable.createdAt}, 1, 10) <= ${toRaw}`,
        sql`${pbisEntriesTable.voidedAt} IS NULL`,
        sql`${pbisEntriesTable.polarity} <> 'negative'`,
      ),
    );

  // ---- Staff -> department map (active staff at this school) --------------
  const staffRows = await db
    .select({ id: staffTable.id, department: staffTable.department })
    .from(staffTable)
    .where(eq(staffTable.schoolId, schoolId));
  const deptByStaff = new Map<number, string>();
  for (const s of staffRows) {
    deptByStaff.set(s.id, (s.department ?? "").trim() || "Unassigned");
  }

  // ---- (teacher, student) -> class period, for the by-period breakdown ----
  // An award has no period of its own, so we attribute it to the period of the
  // section where the awarding teacher rosters that student. Awards with no
  // matching section (e.g. admins, cross-class recognitions) fall into the
  // "Unmatched" bucket.
  const rosterRows = await db
    .select({
      studentId: sectionRosterTable.studentId,
      teacherStaffId: classSectionsTable.teacherStaffId,
      period: classSectionsTable.period,
    })
    .from(sectionRosterTable)
    .innerJoin(
      classSectionsTable,
      eq(classSectionsTable.id, sectionRosterTable.sectionId),
    )
    .where(
      and(
        eq(sectionRosterTable.schoolId, schoolId),
        eq(classSectionsTable.isPlanning, false),
      ),
    );
  const periodByTeacherStudent = new Map<string, number>();
  for (const r of rosterRows) {
    if (r.teacherStaffId == null) continue;
    const key = `${r.teacherStaffId}|${r.studentId}`;
    if (!periodByTeacherStudent.has(key)) {
      periodByTeacherStudent.set(key, r.period);
    }
  }

  // ---- Per-teacher aggregation -------------------------------------------
  type TeacherAgg = { points: number; count: number; students: Set<string> };
  const byTeacher = new Map<number, TeacherAgg>();
  // Reason (behavior) rollup — school-wide, anonymized.
  const byReason = new Map<string, { count: number; points: number }>();
  // Period rollup — period -> points + distinct contributing teachers.
  const periodAgg = new Map<
    number,
    { points: number; count: number; teachers: Set<number> }
  >();
  // "Unmatched" period bucket keyed separately (no real period number).
  let unmatchedPeriodPoints = 0;
  let unmatchedPeriodCount = 0;
  const unmatchedPeriodTeachers = new Set<number>();

  let schoolPoints = 0;
  let schoolRecognitions = 0;

  for (const e of entries) {
    const pts = e.points ?? 0;

    // Top behaviors are a school-wide, non-teacher-identifying view, so they
    // count every positive award (including rare unattributed bulk awards).
    const br = byReason.get(e.reason) ?? { count: 0, points: 0 };
    br.count += 1;
    br.points += pts;
    byReason.set(e.reason, br);

    // Peer-comparison totals must reflect the SAME population as the
    // per-teacher denominator (`awardingTeachers`), so unattributed awards
    // (staffId == null) are excluded from school totals as well. Otherwise
    // the school average and the me-vs-peers math drift.
    if (e.staffId == null) continue;
    schoolPoints += pts;
    schoolRecognitions += 1;
    const ta = byTeacher.get(e.staffId) ?? {
      points: 0,
      count: 0,
      students: new Set<string>(),
    };
    ta.points += pts;
    ta.count += 1;
    ta.students.add(e.studentId);
    byTeacher.set(e.staffId, ta);

    const period = periodByTeacherStudent.get(`${e.staffId}|${e.studentId}`);
    if (period == null) {
      unmatchedPeriodPoints += pts;
      unmatchedPeriodCount += 1;
      unmatchedPeriodTeachers.add(e.staffId);
    } else {
      const pa = periodAgg.get(period) ?? {
        points: 0,
        count: 0,
        teachers: new Set<number>(),
      };
      pa.points += pts;
      pa.count += 1;
      pa.teachers.add(e.staffId);
      periodAgg.set(period, pa);
    }
  }

  const awardingTeachers = byTeacher.size;
  const round1 = (n: number) => Math.round(n * 10) / 10;

  // ---- School-wide averages (suppressed under the threshold) -------------
  // When suppressed we must withhold EVERY derivable figure (totals + the
  // teacher count), not just the averages: with only 1–2 awarding teachers a
  // viewer could otherwise compute a peer's exact output as
  // `totalPoints - myPoints`. Below the threshold the whole school scope
  // collapses to nulls.
  const schoolSuppressed = awardingTeachers < MIN_COMPARE_TEACHERS;
  const school = {
    awardingTeachers: schoolSuppressed ? null : awardingTeachers,
    totalPoints: schoolSuppressed ? null : schoolPoints,
    totalRecognitions: schoolSuppressed ? null : schoolRecognitions,
    avgPointsPerTeacher: schoolSuppressed
      ? null
      : round1(schoolPoints / awardingTeachers),
    avgRecognitionsPerTeacher: schoolSuppressed
      ? null
      : round1(schoolRecognitions / awardingTeachers),
    suppressed: schoolSuppressed,
  };

  // ---- The caller's own numbers (always shown, never suppressed) ----------
  const mine = byTeacher.get(staff.id);
  const me = {
    department: (staff.department ?? "").trim() || "Unassigned",
    points: mine?.points ?? 0,
    recognitions: mine?.count ?? 0,
    studentsRecognized: mine?.students.size ?? 0,
  };

  // ---- By department ------------------------------------------------------
  const deptAgg = new Map<
    string,
    { points: number; recognitions: number; teachers: number }
  >();
  for (const [staffId, agg] of byTeacher.entries()) {
    const dept = deptByStaff.get(staffId) ?? "Unassigned";
    const d = deptAgg.get(dept) ?? { points: 0, recognitions: 0, teachers: 0 };
    d.points += agg.points;
    d.recognitions += agg.count;
    d.teachers += 1;
    deptAgg.set(dept, d);
  }
  const byDepartment = Array.from(deptAgg.entries())
    .map(([department, d]) => {
      const suppressed = d.teachers < MIN_COMPARE_TEACHERS;
      return {
        department,
        // Withhold the contributor count for suppressed buckets too — it is a
        // derivation input, so exposing it would weaken the threshold guard.
        teacherCount: suppressed ? null : d.teachers,
        avgPointsPerTeacher: suppressed ? null : round1(d.points / d.teachers),
        avgRecognitionsPerTeacher: suppressed
          ? null
          : round1(d.recognitions / d.teachers),
        suppressed,
        isMine: department === me.department,
      };
    })
    .sort((a, b) => {
      // Mine first, then by avg (suppressed last), then name.
      if (a.isMine !== b.isMine) return a.isMine ? -1 : 1;
      const av = a.avgPointsPerTeacher ?? -1;
      const bv = b.avgPointsPerTeacher ?? -1;
      if (av !== bv) return bv - av;
      return a.department.localeCompare(b.department);
    });

  // ---- By period ----------------------------------------------------------
  const byPeriod = Array.from(periodAgg.entries())
    .map(([period, p]) => {
      const teacherCount = p.teachers.size;
      const suppressed = teacherCount < MIN_COMPARE_TEACHERS;
      return {
        period: String(period),
        teacherCount: suppressed ? null : teacherCount,
        totalPoints: suppressed ? null : p.points,
        avgPointsPerTeacher: suppressed
          ? null
          : round1(p.points / teacherCount),
        suppressed,
      };
    })
    .sort((a, b) => Number(a.period) - Number(b.period));
  if (unmatchedPeriodCount > 0) {
    const teacherCount = unmatchedPeriodTeachers.size;
    const suppressed = teacherCount < MIN_COMPARE_TEACHERS;
    byPeriod.push({
      period: "Unmatched",
      teacherCount: suppressed ? null : teacherCount,
      totalPoints: suppressed ? null : unmatchedPeriodPoints,
      avgPointsPerTeacher: suppressed
        ? null
        : round1(unmatchedPeriodPoints / teacherCount),
      suppressed,
    });
  }

  // ---- Top behaviors (reasons) — school-wide, not teacher-identifying -----
  const topBehaviors = Array.from(byReason.entries())
    .map(([reason, v]) => ({ reason, count: v.count, points: v.points }))
    .sort((a, b) => b.points - a.points || b.count - a.count)
    .slice(0, 10);

  res.json({
    window: { from: fromRaw, to: toRaw, days: spanDays },
    threshold: MIN_COMPARE_TEACHERS,
    me,
    school,
    byDepartment,
    byPeriod,
    topBehaviors,
  });
});

// ---------------------------------------------------------------------------
// PBIS Points balance report (roster of lifetime EARNED + current BANK balance)
//   GET /api/reports/pbis-wallets?houseId=&sectionId=&teacherStaffId=&format=
// Shows, per student, lifetime points earned alongside their spendable bank
// balance (available = earned - held). Filterable by house, class section, or
// teacher. Exports as JSON (default), CSV (?format=csv), or PDF (?format=pdf).
//
// Auth scope:
//   - admin / ESE / PBIS coordinator: school-wide; all filters honored.
//   - other staff: forced to their OWN roster (students in sections they
//     teach); house/teacher filters ignored, sectionId must be one of theirs.
//
// FLEID boundary: the canonical students.student_id is NEVER rendered — only
// students.local_sis_id (shown as "—" when absent).
// Filter options for the PBIS Wallets report. Self-contained so the report UI
// does not depend on the PBIS Hub's section/teacher props (which are loaded
// under a narrower admin scope that excludes PBIS coordinators). Mirrors the
// report's own privilege gate so options match what the report will honor:
//   - privileged (admin/ESE/PBIS coordinator): all school sections + teachers.
//   - other staff: only the sections they teach.
router.get("/reports/pbis-wallets/options", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const isPrivileged =
    staff.isSuperUser ||
    staff.isAdmin ||
    staff.isEseCoordinator ||
    staff.isPbisCoordinator;

  const sectionRows = await db
    .select({
      id: classSectionsTable.id,
      period: classSectionsTable.period,
      courseName: classSectionsTable.courseName,
      teacherStaffId: classSectionsTable.teacherStaffId,
    })
    .from(classSectionsTable)
    .where(
      isPrivileged
        ? and(
            eq(classSectionsTable.schoolId, schoolId),
            eq(classSectionsTable.isPlanning, false),
          )
        : and(
            eq(classSectionsTable.schoolId, schoolId),
            eq(classSectionsTable.isPlanning, false),
            eq(classSectionsTable.teacherStaffId, staff.id),
          ),
    );

  const teacherIds = Array.from(
    new Set(sectionRows.map((s) => s.teacherStaffId)),
  );
  const teacherRows = teacherIds.length
    ? await db
        .select({ id: staffTable.id, displayName: staffTable.displayName })
        .from(staffTable)
        .where(
          and(
            eq(staffTable.schoolId, schoolId),
            inArray(staffTable.id, teacherIds),
          ),
        )
    : [];
  const teacherNameById = new Map(
    teacherRows.map((t) => [t.id, t.displayName]),
  );

  res.json({
    privileged: isPrivileged,
    teachers: teacherRows
      .map((t) => ({ id: t.id, name: t.displayName }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    sections: sectionRows
      .map((s) => ({
        id: s.id,
        period: s.period,
        courseName: s.courseName,
        teacherStaffId: s.teacherStaffId,
        teacherName: teacherNameById.get(s.teacherStaffId) ?? "",
      }))
      .sort((a, b) => (a.period ?? 0) - (b.period ?? 0)),
  });
});

router.get("/reports/pbis-wallets", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const isPrivileged =
    staff.isSuperUser ||
    staff.isAdmin ||
    staff.isEseCoordinator ||
    staff.isPbisCoordinator;

  const houseIdFilter = intParam(req.query.houseId);
  const sectionIdFilter = intParam(req.query.sectionId);
  const teacherStaffIdFilter = intParam(req.query.teacherStaffId);
  const format =
    typeof req.query.format === "string"
      ? req.query.format.toLowerCase()
      : "json";

  // Resolve the set of section IDs whose roster defines the eligible students.
  // null = no class/teacher restriction (school-wide, privileged only).
  let restrictSectionIds: number[] | null = null;

  if (!isPrivileged) {
    // Non-privileged staff are pinned to the sections they teach. They may
    // narrow to a single one of their own sections, but never see another
    // teacher's roster, another house, or the whole school.
    const ownSections = await db
      .select({ id: classSectionsTable.id })
      .from(classSectionsTable)
      .where(
        and(
          eq(classSectionsTable.schoolId, schoolId),
          eq(classSectionsTable.teacherStaffId, staff.id),
        ),
      );
    const ownIds = ownSections.map((s) => s.id);
    if (sectionIdFilter !== null) {
      if (!ownIds.includes(sectionIdFilter)) {
        res
          .status(403)
          .json({ error: "You may only report on your own classes." });
        return;
      }
      restrictSectionIds = [sectionIdFilter];
    } else {
      restrictSectionIds = ownIds;
    }
  } else {
    // Privileged: class and/or teacher filters both narrow via sections.
    if (sectionIdFilter !== null) {
      restrictSectionIds = [sectionIdFilter];
    } else if (teacherStaffIdFilter !== null) {
      const tSections = await db
        .select({ id: classSectionsTable.id })
        .from(classSectionsTable)
        .where(
          and(
            eq(classSectionsTable.schoolId, schoolId),
            eq(classSectionsTable.teacherStaffId, teacherStaffIdFilter),
          ),
        );
      restrictSectionIds = tSections.map((s) => s.id);
    }
  }

  // Turn the section restriction into a concrete studentId allow-list. An
  // empty restriction means "no eligible students" — return an empty report
  // rather than silently widening to the whole school.
  let rosterStudentIds: Set<string> | null = null;
  if (restrictSectionIds !== null) {
    if (restrictSectionIds.length === 0) {
      rosterStudentIds = new Set();
    } else {
      const rosterRows = await db
        .select({ studentId: sectionRosterTable.studentId })
        .from(sectionRosterTable)
        .where(
          and(
            eq(sectionRosterTable.schoolId, schoolId),
            inArray(sectionRosterTable.sectionId, restrictSectionIds),
          ),
        );
      rosterStudentIds = new Set(rosterRows.map((r) => r.studentId));
    }
  }

  // House filter is privileged-only (non-privileged never reach here with one).
  const effectiveHouseId = isPrivileged ? houseIdFilter : null;

  // Load the candidate students (school-scoped, optional house filter).
  const studentConds = [eq(studentsTable.schoolId, schoolId)];
  if (effectiveHouseId !== null) {
    studentConds.push(eq(studentsTable.houseId, effectiveHouseId));
  }
  const studentRows = await db
    .select({
      studentId: studentsTable.studentId,
      localSisId: studentsTable.localSisId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
      houseId: studentsTable.houseId,
    })
    .from(studentsTable)
    .where(and(...studentConds));

  // House names for labeling.
  const houseRows = await db
    .select({ id: housesTable.id, name: housesTable.name })
    .from(housesTable)
    .where(eq(housesTable.schoolId, schoolId));
  const houseNameById = new Map(houseRows.map((h) => [h.id, h.name]));

  // Batch wallet read (agrees with computeWallet for every student).
  const wallets = await computeWalletsForSchool(schoolId);

  const rows = studentRows
    .filter((s) => rosterStudentIds === null || rosterStudentIds.has(s.studentId))
    .map((s) => {
      const w = wallets.get(s.studentId) ?? {
        earned: 0,
        spent: 0,
        available: 0,
      };
      return {
        localSisId: s.localSisId ?? null,
        studentName:
          `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim() || "—",
        grade: s.grade,
        houseName: s.houseId != null ? (houseNameById.get(s.houseId) ?? null) : null,
        earned: w.earned,
        spent: w.spent,
        available: w.available,
      };
    })
    .sort(
      (a, b) =>
        b.available - a.available || a.studentName.localeCompare(b.studentName),
    );

  const houseLabel =
    effectiveHouseId !== null
      ? (houseNameById.get(effectiveHouseId) ?? `House #${effectiveHouseId}`)
      : null;
  const teacherLabel =
    isPrivileged && teacherStaffIdFilter !== null
      ? (
          await db
            .select({ name: staffTable.displayName })
            .from(staffTable)
            .where(
              and(
                eq(staffTable.id, teacherStaffIdFilter),
                eq(staffTable.schoolId, schoolId),
              ),
            )
        )[0]?.name ?? `Staff #${teacherStaffIdFilter}`
      : null;

  const scopeBits: string[] = [];
  if (houseLabel) scopeBits.push(`House: ${houseLabel}`);
  if (teacherLabel) scopeBits.push(`Teacher: ${teacherLabel}`);
  if (sectionIdFilter !== null) scopeBits.push(`Class section #${sectionIdFilter}`);
  if (!isPrivileged) scopeBits.push("Your classes");
  const scopeText = scopeBits.length ? scopeBits.join(" · ") : "School-wide";

  // ---- CSV ----
  if (format === "csv") {
    const header = [
      "Student",
      "SIS ID",
      "Grade",
      "House",
      "Earned (lifetime)",
      "Spent (held)",
      "Bank (available)",
    ]
      .map(csvCell)
      .join(",");
    const body = rows
      .map((r) =>
        [
          r.studentName,
          r.localSisId ?? "—",
          r.grade ?? "",
          r.houseName ?? "—",
          r.earned,
          r.spent,
          r.available,
        ]
          .map(csvCell)
          .join(","),
      )
      .join("\r\n");
    const stamp = todayIsoDate();
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="pbis-points-report-${stamp}.csv"`,
    );
    res.send(`${header}\r\n${body}\r\n`);
    return;
  }

  // ---- PDF ----
  if (format === "pdf") {
    const stamp = todayIsoDate();
    const doc = new PDFDocument({ size: "LETTER", margin: 40 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="pbis-points-report-${stamp}.pdf"`,
    );
    doc.pipe(res);

    doc.fontSize(16).fillColor("#0f172a").text("PBIS Points Report");
    doc
      .fontSize(10)
      .fillColor("#475569")
      .text(`${scopeText}  ·  ${stamp}  ·  ${rows.length} students`);
    doc.moveDown(0.6);

    // Column layout (content x: 40..572 on LETTER with 40pt margins).
    const cols = {
      name: 40,
      sis: 182,
      grade: 255,
      house: 290,
      earned: 402,
      spent: 456,
      bank: 506,
    };
    const rightEdges = { earned: 454, spent: 502, bank: 570 };
    const bottomY = doc.page.height - 50;

    const drawHeader = () => {
      const y = doc.y;
      doc.fontSize(9).fillColor("#0f172a");
      doc.text("Student", cols.name, y, { width: 138 });
      doc.text("SIS ID", cols.sis, y, { width: 70 });
      doc.text("Gr", cols.grade, y, { width: 30 });
      doc.text("House", cols.house, y, { width: 108 });
      doc.text("Earned", cols.earned, y, {
        width: rightEdges.earned - cols.earned,
        align: "right",
      });
      doc.text("Spent", cols.spent, y, {
        width: rightEdges.spent - cols.spent,
        align: "right",
      });
      doc.text("Bank", cols.bank, y, {
        width: rightEdges.bank - cols.bank,
        align: "right",
      });
      doc
        .moveTo(40, y + 13)
        .lineTo(572, y + 13)
        .strokeColor("#cbd5e1")
        .stroke();
      doc.y = y + 18;
    };

    drawHeader();
    doc.fontSize(9);
    for (const r of rows) {
      if (doc.y > bottomY) {
        doc.addPage();
        drawHeader();
        doc.fontSize(9);
      }
      const y = doc.y;
      doc.fillColor("#0f172a");
      doc.text(r.studentName, cols.name, y, { width: 138, ellipsis: true });
      doc.fillColor("#475569");
      doc.text(r.localSisId ?? "—", cols.sis, y, { width: 70 });
      doc.text(r.grade != null ? String(r.grade) : "—", cols.grade, y, {
        width: 30,
      });
      doc.text(r.houseName ?? "—", cols.house, y, {
        width: 108,
        ellipsis: true,
      });
      doc.fillColor("#0f172a");
      doc.text(String(r.earned), cols.earned, y, {
        width: rightEdges.earned - cols.earned,
        align: "right",
      });
      doc.text(String(r.spent), cols.spent, y, {
        width: rightEdges.spent - cols.spent,
        align: "right",
      });
      doc.fillColor("#15803d");
      doc.text(String(r.available), cols.bank, y, {
        width: rightEdges.bank - cols.bank,
        align: "right",
      });
      doc.y = y + 15;
    }

    if (rows.length === 0) {
      doc
        .fillColor("#64748b")
        .text("No students match these filters.", 40, doc.y + 6);
    }

    doc.end();
    return;
  }

  // ---- JSON (default) ----
  res.json({
    scope: scopeText,
    appliedFilters: {
      houseId: effectiveHouseId,
      houseName: houseLabel,
      sectionId: sectionIdFilter,
      teacherStaffId: isPrivileged ? teacherStaffIdFilter : null,
      teacherName: teacherLabel,
      privileged: isPrivileged,
    },
    totals: {
      students: rows.length,
      earned: rows.reduce((a, r) => a + r.earned, 0),
      spent: rows.reduce((a, r) => a + r.spent, 0),
      available: rows.reduce((a, r) => a + r.available, 0),
    },
    rows,
  });
});

export default router;
