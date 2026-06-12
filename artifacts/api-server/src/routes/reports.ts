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
} from "@workspace/db";
import { and, eq, isNull, inArray, sql, desc } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

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

export default router;
