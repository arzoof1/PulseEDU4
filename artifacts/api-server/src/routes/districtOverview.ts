import { Router, type IRouter } from "express";
import {
  db,
  staffTable,
  districtsTable,
  schoolsTable,
  plansTable,
  studentsTable,
  hallPassesTable,
  pbisEntriesTable,
  issAttendanceDayTable,
  featureLicensingAuditLogTable,
  issAdminLogAuditTable,
  interactionAuditLogTable,
  interventionEntriesTable,
} from "@workspace/db";
import { eq, and, inArray, sql, isNull, desc } from "drizzle-orm";
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

  // Schools in this district. SuperUsers see inactive schools too so
  // they can reactivate from the rollup row; everyone else gets the
  // active-only view.
  const schools = await db
    .select()
    .from(schoolsTable)
    .where(
      staff.isSuperUser
        ? eq(schoolsTable.districtId, districtId)
        : and(
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

  // Plan label per school: one bulk lookup, joined client-side via Map.
  // Plans table is tiny (handful of rows); pulling them all is cheaper
  // than a join per school and avoids an N+1 if planId is null.
  const planRows = await db
    .select({
      id: plansTable.id,
      key: plansTable.key,
      label: plansTable.label,
    })
    .from(plansTable);
  const planById = new Map(planRows.map((p) => [p.id, p] as const));

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
      active: s.active,
      planId: s.planId ?? null,
      planKey: s.planId != null ? planById.get(s.planId)?.key ?? null : null,
      planLabel: s.planId != null ? planById.get(s.planId)?.label ?? null : null,
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

// ---------------------------------------------------------------------------
// GET /api/superuser/audit-health
//   Tenant-health + recent-admin-activity panel for the SuperUser Home.
//   Two payload halves:
//     * `perDistrict`: rolled-up health snapshot per district —
//         schools (active/inactive), active staff, audit-event count
//         in the last 7d across the three audit tables we own.
//     * `recentEvents`: last 25 audit events across all in-scope
//         districts, projected into a uniform shape with district and
//         school context for the timeline. Reads three existing audit
//         tables (no new schema).
//
//   Scope follows /superuser/overview: defaults to the caller's
//   district; flip ALLOW_CROSS_DISTRICT_SUPERUSER=1 to expand reach.
// ---------------------------------------------------------------------------
router.get("/superuser/audit-health", async (req, res) => {
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

  // Districts + schools in scope. Inactive schools are INCLUDED here so
  // the health tile can surface the active-vs-inactive ratio.
  const districts = await db
    .select()
    .from(districtsTable)
    .where(
      crossDistrict ? sql`TRUE` : eq(districtsTable.id, actorDistrictId!),
    )
    .orderBy(districtsTable.id);
  const districtIds = districts.map((d) => d.id);
  if (districtIds.length === 0) {
    res.json({ perDistrict: [], recentEvents: [] });
    return;
  }

  const schools = await db
    .select()
    .from(schoolsTable)
    .where(inArray(schoolsTable.districtId, districtIds))
    .orderBy(schoolsTable.districtId, schoolsTable.id);
  const schoolIds = schools.map((s) => s.id);
  const districtBySchool = new Map<number, number>();
  const schoolNameById = new Map<number, string>();
  for (const s of schools) {
    districtBySchool.set(s.id, s.districtId);
    schoolNameById.set(s.id, s.name);
  }

  // Active staff per school (single grouped query).
  const staffRows = schoolIds.length
    ? await db
        .select({
          schoolId: staffTable.schoolId,
          n: sql<number>`COUNT(*)::int`.as("n"),
        })
        .from(staffTable)
        .where(
          and(
            inArray(staffTable.schoolId, schoolIds),
            eq(staffTable.active, true),
          ),
        )
        .groupBy(staffTable.schoolId)
    : [];
  const staffBySchool = new Map<number, number>();
  for (const r of staffRows) staffBySchool.set(r.schoolId, r.n);

  // 7-day audit event count per school across all three audit tables.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const auditRows = schoolIds.length
    ? ((
        await db.execute(sql`
          SELECT school_id, COUNT(*)::int AS n FROM (
            SELECT school_id, created_at FROM feature_licensing_audit_log
            UNION ALL
            SELECT school_id, created_at FROM iss_admin_log_audit
            UNION ALL
            SELECT school_id, created_at FROM interaction_audit_log
          ) x
          WHERE school_id IN (${sql.join(
            schoolIds.map((id) => sql`${id}`),
            sql`, `,
          )})
            AND created_at >= ${sevenDaysAgo}
          GROUP BY school_id
        `)
      ).rows as Array<{ school_id: number; n: number }>)
    : [];
  const auditBySchool = new Map<number, number>();
  for (const r of auditRows) auditBySchool.set(Number(r.school_id), Number(r.n));

  // Roll up per-district.
  const perDistrict = districts.map((d) => {
    const dSchools = schools.filter((s) => s.districtId === d.id);
    let active = 0;
    let inactive = 0;
    let staffCount = 0;
    let events = 0;
    for (const s of dSchools) {
      if (s.active) active++;
      else inactive++;
      staffCount += staffBySchool.get(s.id) ?? 0;
      events += auditBySchool.get(s.id) ?? 0;
    }
    return {
      districtId: d.id,
      name: d.name,
      schoolsActive: active,
      schoolsInactive: inactive,
      staffActive: staffCount,
      auditEvents7d: events,
    };
  });

  // Recent activity timeline: top 25 across the three audit tables.
  // Each branch projects into a uniform shape, then we sort + slice in
  // memory (3 × 25 rows is trivial).
  const TIMELINE_LIMIT = 25;
  const [flRows, issRows, interactionRows] = schoolIds.length
    ? await Promise.all([
        db
          .select({
            createdAt: featureLicensingAuditLogTable.createdAt,
            schoolId: featureLicensingAuditLogTable.schoolId,
            action: featureLicensingAuditLogTable.action,
            actorStaffId: featureLicensingAuditLogTable.actorStaffId,
            actorName: featureLicensingAuditLogTable.actorName,
          })
          .from(featureLicensingAuditLogTable)
          .where(inArray(featureLicensingAuditLogTable.schoolId, schoolIds))
          .orderBy(desc(featureLicensingAuditLogTable.createdAt))
          .limit(TIMELINE_LIMIT),
        db
          .select({
            createdAt: issAdminLogAuditTable.createdAt,
            schoolId: issAdminLogAuditTable.schoolId,
            action: issAdminLogAuditTable.action,
            actorStaffId: issAdminLogAuditTable.actorStaffId,
            actorName: issAdminLogAuditTable.actorDisplayName,
          })
          .from(issAdminLogAuditTable)
          .where(inArray(issAdminLogAuditTable.schoolId, schoolIds))
          .orderBy(desc(issAdminLogAuditTable.createdAt))
          .limit(TIMELINE_LIMIT),
        db
          .select({
            createdAt: interactionAuditLogTable.createdAt,
            schoolId: interactionAuditLogTable.schoolId,
            action: interactionAuditLogTable.action,
            actorStaffId: interactionAuditLogTable.actorStaffId,
            actorName: sql<string | null>`NULL`.as("actor_name"),
          })
          .from(interactionAuditLogTable)
          .where(inArray(interactionAuditLogTable.schoolId, schoolIds))
          .orderBy(desc(interactionAuditLogTable.createdAt))
          .limit(TIMELINE_LIMIT),
      ])
    : [[], [], []];

  type Event = {
    at: string;
    source: "feature_licensing" | "iss_admin" | "interaction";
    action: string;
    schoolId: number;
    schoolName: string | null;
    districtId: number | null;
    districtName: string | null;
    actorStaffId: number | null;
    actorName: string | null;
  };
  const districtNameById = new Map<number, string>();
  for (const d of districts) districtNameById.set(d.id, d.name);
  const tag = (
    source: Event["source"],
    rows: Array<{
      createdAt: Date;
      schoolId: number;
      action: string;
      actorStaffId: number | null;
      actorName: string | null;
    }>,
  ): Event[] =>
    rows.map((r) => {
      const dId = districtBySchool.get(r.schoolId) ?? null;
      return {
        at: r.createdAt.toISOString(),
        source,
        action: r.action,
        schoolId: r.schoolId,
        schoolName: schoolNameById.get(r.schoolId) ?? null,
        districtId: dId,
        districtName: dId !== null ? (districtNameById.get(dId) ?? null) : null,
        actorStaffId: r.actorStaffId,
        actorName: r.actorName,
      };
    });

  const merged: Event[] = [
    ...tag("feature_licensing", flRows),
    ...tag("iss_admin", issRows),
    ...tag("interaction", interactionRows),
  ]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, TIMELINE_LIMIT);

  // Backfill missing actor names with the staff display name (one bulk
  // lookup for the merged set so we don't N+1 across the timeline).
  const missingActorIds = Array.from(
    new Set(
      merged
        .filter((e) => !e.actorName && e.actorStaffId !== null)
        .map((e) => e.actorStaffId as number),
    ),
  );
  if (missingActorIds.length > 0) {
    const actorRows = await db
      .select({ id: staffTable.id, displayName: staffTable.displayName })
      .from(staffTable)
      .where(inArray(staffTable.id, missingActorIds));
    const nameById = new Map<number, string>();
    for (const r of actorRows) nameById.set(r.id, r.displayName);
    for (const e of merged) {
      if (!e.actorName && e.actorStaffId !== null) {
        e.actorName = nameById.get(e.actorStaffId) ?? null;
      }
    }
  }

  res.json({ perDistrict, recentEvents: merged });
});

// ---------------------------------------------------------------------------
// GET /api/superuser/cross-district-reports  (Phase 5)
//   Per-district 7-day activity rollup for the SuperUser cross-district
//   surface. Surfaces "what's actually happening across every silo I
//   operate" in one table:
//     - PBIS points (sum, last 7d)
//     - hall passes (count, last 7d)
//     - ISS days (count, last 7d)
//     - active intervention entries (count, last 7d)
//
//   Cross-district reach gated by ALLOW_CROSS_DISTRICT_SUPERUSER=1; without
//   it the route falls back to the caller's own district (still useful as
//   a single-district report, mirrors the /superuser/overview pattern).
//
//   Each metric is ONE grouped SQL query keyed on school_id — no N+1.
//   The handler rolls schools up to districts in memory.
// ---------------------------------------------------------------------------
router.get("/superuser/cross-district-reports", async (req, res) => {
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

  if (schools.length === 0) {
    res.json({
      windowDays: 7,
      crossDistrict,
      perDistrict: districts.map((d) => ({
        id: d.id,
        name: d.name,
        schoolCount: 0,
        pbisPoints7d: 0,
        hallPasses7d: 0,
        issDays7d: 0,
        interventions7d: 0,
      })),
    });
    return;
  }

  const schoolIds = schools.map((s) => s.id);
  const sevenDaysAgoIso = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const sevenDaysAgoDate = sevenDaysAgoIso.slice(0, 10);

  // 4 grouped queries, one per metric. Each filtered to the schools we
  // care about so cross-district scope mirrors the /superuser/overview
  // contract — no per-school N+1.
  const [pbisRows, hallRows, issRows, intvRows] = await Promise.all([
    db
      .select({
        schoolId: pbisEntriesTable.schoolId,
        pts: sql<number>`COALESCE(SUM(${pbisEntriesTable.points}), 0)::int`.as(
          "pts",
        ),
      })
      .from(pbisEntriesTable)
      .where(
        and(
          inArray(pbisEntriesTable.schoolId, schoolIds),
          sql`${pbisEntriesTable.createdAt} >= ${sevenDaysAgoIso}`,
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
    db
      .select({
        schoolId: interventionEntriesTable.schoolId,
        n: sql<number>`COUNT(*)::int`.as("n"),
      })
      .from(interventionEntriesTable)
      .where(
        and(
          inArray(interventionEntriesTable.schoolId, schoolIds),
          sql`${interventionEntriesTable.createdAt} >= ${sevenDaysAgoIso}`,
        ),
      )
      .groupBy(interventionEntriesTable.schoolId),
  ]);

  const pbisBySchool = new Map<number, number>();
  for (const r of pbisRows) pbisBySchool.set(r.schoolId, r.pts);
  const hallBySchool = new Map<number, number>();
  for (const r of hallRows) hallBySchool.set(r.schoolId, r.n);
  const issBySchool = new Map<number, number>();
  for (const r of issRows) issBySchool.set(r.schoolId, r.n);
  const intvBySchool = new Map<number, number>();
  for (const r of intvRows) intvBySchool.set(r.schoolId, r.n);

  const perDistrict = districts.map((d) => {
    const schoolsInDistrict = schools.filter((s) => s.districtId === d.id);
    let pts = 0;
    let halls = 0;
    let iss = 0;
    let intv = 0;
    for (const s of schoolsInDistrict) {
      pts += pbisBySchool.get(s.id) ?? 0;
      halls += hallBySchool.get(s.id) ?? 0;
      iss += issBySchool.get(s.id) ?? 0;
      intv += intvBySchool.get(s.id) ?? 0;
    }
    return {
      id: d.id,
      name: d.name,
      schoolCount: schoolsInDistrict.length,
      pbisPoints7d: pts,
      hallPasses7d: halls,
      issDays7d: iss,
      interventions7d: intv,
    };
  });

  res.json({ windowDays: 7, crossDistrict, perDistrict });
});

export default router;
