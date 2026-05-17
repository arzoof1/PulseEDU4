import { Router, type IRouter } from "express";
import {
  db,
  staffTable,
  districtsTable,
  schoolsTable,
  studentsTable,
  hallPassesTable,
  pbisEntriesTable,
  issAttendanceDayTable,
} from "@workspace/db";
import { eq, and, inArray, sql, isNull } from "drizzle-orm";
import { canActAsDistrict } from "../lib/scope";
import { getDistrictIdForSchool } from "../lib/scope";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Shared loader: caller's staff row, 401 on miss.
// ---------------------------------------------------------------------------
async function loadStaff(req: any, res: any) {
  const id = req.staffId ?? null;
  if (!id) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, id));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  return staff;
}

// ---------------------------------------------------------------------------
// GET /api/superuser/overview
//   Cross-district read-only rollup for the SuperUser Home landing.
//   Returns top-level totals plus a per-district summary (school count,
//   active-student count, active-staff count, last-activity timestamp).
//
//   NOTE on scope: this endpoint is deliberately CROSS-DISTRICT for the
//   SuperUser tier. The existing tenancy panel (/api/tenancy/status) is
//   single-district by design to prevent cross-district row-data leaks;
//   this endpoint exposes only aggregate counts + district names which
//   the SuperUser is presumed to know already (they administer them).
//   Switching INTO another district's school is still blocked by the
//   write-side guard in /api/tenancy/switch-school.
//
//   Cross-district reach is GATED. SuperUser in the rest of this codebase
//   is district-scoped (see /api/tenancy/switch-school). To avoid silently
//   broadening that contract, this route defaults to the caller's own
//   district. Operators flip ALLOW_CROSS_DISTRICT_SUPERUSER=1 in the env
//   to unlock cross-district reach for the demo / control tier. When a
//   real `isCrossDistrictSuperUser` flag lands on `staff`, swap the env
//   check for the per-staff flag.
// ---------------------------------------------------------------------------
router.get("/superuser/overview", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!staff.isSuperUser) {
    res.status(403).json({ error: "SuperUser access required" });
    return;
  }

  const crossDistrict = process.env.ALLOW_CROSS_DISTRICT_SUPERUSER === "1";
  const actorDistrictId = crossDistrict
    ? null
    : await getDistrictIdForSchool(staff.schoolId);
  if (!crossDistrict && actorDistrictId === null) {
    res.status(403).json({ error: "Caller has no resolvable district" });
    return;
  }

  // 1) Districts + schools (single read each, deterministic order).
  //    When not cross-district, hard-filter to the caller's district at
  //    the SQL layer so no other district's metadata leaves the server.
  const districts = await db
    .select()
    .from(districtsTable)
    .where(crossDistrict ? sql`TRUE` : eq(districtsTable.id, actorDistrictId!))
    .orderBy(districtsTable.id);
  const schools = await db
    .select()
    .from(schoolsTable)
    .where(
      and(
        eq(schoolsTable.active, true),
        crossDistrict
          ? sql`TRUE`
          : eq(schoolsTable.districtId, actorDistrictId!),
      ),
    )
    .orderBy(schoolsTable.districtId, schoolsTable.id);

  // 2) Per-school student + staff counts. ONE grouped query per metric
  //    (no N+1). school_id is indexed on every row table in this app.
  const studentCountRows = await db
    .select({
      schoolId: studentsTable.schoolId,
      n: sql<number>`COUNT(*)::int`.as("n"),
    })
    .from(studentsTable)
    .groupBy(studentsTable.schoolId);

  const staffCountRows = await db
    .select({
      schoolId: staffTable.schoolId,
      n: sql<number>`COUNT(*)::int`.as("n"),
    })
    .from(staffTable)
    .where(eq(staffTable.active, true))
    .groupBy(staffTable.schoolId);

  // 3) Per-school last-activity timestamp. We sample three high-volume
  //    activity tables (hall passes, PBIS entries, ISS attendance days)
  //    and take the max for each school. createdAt is TEXT on the legacy
  //    tables (ISO 8601 strings sort lexicographically) and TIMESTAMP
  //    on iss_attendance_day; both cast to text for the comparison.
  const lastActivityRows = await db.execute(sql`
    SELECT school_id, MAX(ts) AS last_ts FROM (
      SELECT school_id, created_at AS ts FROM hall_passes
      UNION ALL
      SELECT school_id, created_at AS ts FROM pbis_entries
      UNION ALL
      SELECT school_id, created_at::text AS ts FROM iss_attendance_day
    ) x
    GROUP BY school_id
  `);
  const lastActivityBySchool = new Map<number, string | null>();
  for (const row of (lastActivityRows as any).rows ?? lastActivityRows) {
    const sid = Number(row.school_id);
    if (Number.isFinite(sid)) {
      lastActivityBySchool.set(sid, row.last_ts ?? null);
    }
  }

  // Project per-school maps for fast lookup.
  const studentBySchool = new Map<number, number>();
  for (const r of studentCountRows) studentBySchool.set(r.schoolId, r.n);
  const staffBySchool = new Map<number, number>();
  for (const r of staffCountRows) staffBySchool.set(r.schoolId, r.n);

  // 4) Roll up to district-level + compute totals.
  let totalSchools = 0;
  let totalStudents = 0;
  let totalStaff = 0;
  const districtSummaries = districts.map((d) => {
    const schoolsInDistrict = schools.filter((s) => s.districtId === d.id);
    let dStudents = 0;
    let dStaff = 0;
    let dLast: string | null = null;
    for (const s of schoolsInDistrict) {
      dStudents += studentBySchool.get(s.id) ?? 0;
      dStaff += staffBySchool.get(s.id) ?? 0;
      const lt = lastActivityBySchool.get(s.id) ?? null;
      if (lt && (!dLast || lt > dLast)) dLast = lt;
    }
    totalSchools += schoolsInDistrict.length;
    totalStudents += dStudents;
    totalStaff += dStaff;
    return {
      id: d.id,
      name: d.name,
      slug: d.slug,
      stateDistrictCode: d.stateDistrictCode,
      timezone: d.timezone,
      active: d.active,
      schoolCount: schoolsInDistrict.length,
      studentCount: dStudents,
      staffCount: dStaff,
      lastActivityAt: dLast,
    };
  });

  res.json({
    totals: {
      districts: districts.length,
      schools: totalSchools,
      students: totalStudents,
      staff: totalStaff,
    },
    districts: districtSummaries,
  });
});

// ---------------------------------------------------------------------------
// GET /api/district-admin/overview
//   Per-school rollup for the caller's district. Surfaces what a District
//   Admin actually wants on their landing: students/staff per school plus
//   a recent-activity snapshot (PBIS pts, hall passes, ISS days, all
//   last 7 days) so they can spot a school that went quiet.
// ---------------------------------------------------------------------------
router.get("/district-admin/overview", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!canActAsDistrict(staff)) {
    res.status(403).json({ error: "District Admin access required" });
    return;
  }

  const districtId = await getDistrictIdForSchool(staff.schoolId);
  if (districtId === null) {
    res.status(409).json({ error: "Caller is not assigned to a district" });
    return;
  }

  // District metadata for the header.
  const [district] = await db
    .select()
    .from(districtsTable)
    .where(eq(districtsTable.id, districtId));
  if (!district) {
    res.status(404).json({ error: "District not found" });
    return;
  }

  // Schools in this district.
  const schools = await db
    .select()
    .from(schoolsTable)
    .where(
      and(
        eq(schoolsTable.districtId, districtId),
        eq(schoolsTable.active, true),
      ),
    )
    .orderBy(schoolsTable.id);

  if (schools.length === 0) {
    res.json({
      district: {
        id: district.id,
        name: district.name,
        slug: district.slug,
        timezone: district.timezone,
      },
      totals: { schools: 0, students: 0, staff: 0 },
      schools: [],
    });
    return;
  }

  const schoolIds = schools.map((s) => s.id);

  // ISO 8601 cutoff for "last 7 days". ISO strings sort lexicographically,
  // so plain >= comparisons against the TEXT createdAt columns work.
  const sevenDaysAgoIso = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const sevenDaysAgoDate = sevenDaysAgoIso.slice(0, 10);

  // Per-school counts (one grouped query each).
  const [
    studentRows,
    staffRows,
    pbisRows,
    hallPassRows,
    issDayRows,
  ] = await Promise.all([
    db
      .select({
        schoolId: studentsTable.schoolId,
        n: sql<number>`COUNT(*)::int`.as("n"),
      })
      .from(studentsTable)
      .where(inArray(studentsTable.schoolId, schoolIds))
      .groupBy(studentsTable.schoolId),
    db
      .select({
        schoolId: staffTable.schoolId,
        n: sql<number>`COUNT(*)::int`.as("n"),
      })
      .from(staffTable)
      .where(
        and(inArray(staffTable.schoolId, schoolIds), eq(staffTable.active, true)),
      )
      .groupBy(staffTable.schoolId),
    db
      .select({
        schoolId: pbisEntriesTable.schoolId,
        // Sum of points so admins see "PBIS activity" not just row count.
        // Excludes voided rows so the headline matches the student record.
        pts: sql<number>`COALESCE(SUM(${pbisEntriesTable.points}), 0)::int`.as(
          "pts",
        ),
        n: sql<number>`COUNT(*)::int`.as("n"),
      })
      .from(pbisEntriesTable)
      .where(
        and(
          inArray(pbisEntriesTable.schoolId, schoolIds),
          sql`${pbisEntriesTable.createdAt} >= ${sevenDaysAgoIso}`,
          isNull(pbisEntriesTable.voidedAt),
        ),
      )
      .groupBy(pbisEntriesTable.schoolId),
    db
      .select({
        schoolId: hallPassesTable.schoolId,
        n: sql<number>`COUNT(*)::int`.as("n"),
      })
      .from(hallPassesTable)
      .where(
        and(
          inArray(hallPassesTable.schoolId, schoolIds),
          sql`${hallPassesTable.createdAt} >= ${sevenDaysAgoIso}`,
        ),
      )
      .groupBy(hallPassesTable.schoolId),
    db
      .select({
        schoolId: issAttendanceDayTable.schoolId,
        n: sql<number>`COUNT(*)::int`.as("n"),
      })
      .from(issAttendanceDayTable)
      .where(
        and(
          inArray(issAttendanceDayTable.schoolId, schoolIds),
          sql`${issAttendanceDayTable.day} >= ${sevenDaysAgoDate}`,
        ),
      )
      .groupBy(issAttendanceDayTable.schoolId),
  ]);

  const map = <T,>(rows: { schoolId: number }[], pick: (r: any) => T) => {
    const m = new Map<number, T>();
    for (const r of rows) m.set(r.schoolId, pick(r));
    return m;
  };
  const students = map(studentRows, (r) => r.n);
  const staffCounts = map(staffRows, (r) => r.n);
  const pbisPts = map(pbisRows, (r) => r.pts);
  const pbisCount = map(pbisRows, (r) => r.n);
  const hallPassCount = map(hallPassRows, (r) => r.n);
  const issDayCount = map(issDayRows, (r) => r.n);

  let totalStudents = 0;
  let totalStaff = 0;
  const schoolSummaries = schools.map((s) => {
    const stu = students.get(s.id) ?? 0;
    const stf = staffCounts.get(s.id) ?? 0;
    totalStudents += stu;
    totalStaff += stf;
    return {
      id: s.id,
      name: s.name,
      shortName: s.shortName,
      stateSchoolCode: s.stateSchoolCode,
      isPrimary: s.isPrimary,
      studentCount: stu,
      staffCount: stf,
      pbisPoints7d: pbisPts.get(s.id) ?? 0,
      pbisEntries7d: pbisCount.get(s.id) ?? 0,
      hallPasses7d: hallPassCount.get(s.id) ?? 0,
      issDays7d: issDayCount.get(s.id) ?? 0,
    };
  });

  res.json({
    district: {
      id: district.id,
      name: district.name,
      slug: district.slug,
      timezone: district.timezone,
    },
    totals: {
      schools: schools.length,
      students: totalStudents,
      staff: totalStaff,
    },
    schools: schoolSummaries,
    // Expose just enough caller identity for the client to know whether
    // to render privileged row actions (today: "Switch to this school"
    // requires SuperUser per /api/tenancy/switch-school).
    caller: {
      isSuperUser: !!staff.isSuperUser,
    },
  });
});

export default router;
