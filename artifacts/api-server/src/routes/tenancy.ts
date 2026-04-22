import { Router, type IRouter } from "express";
import { db, staffTable, districtsTable, schoolsTable } from "@workspace/db";
import { eq, asc, and } from "drizzle-orm";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

// Loads the caller's staff row. Returns null on failure (after writing
// the appropriate error response to res).
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

async function requireSuperUser(req: any, res: any) {
  const staff = await loadStaff(req, res);
  if (!staff) return null;
  if (!staff.isSuperUser) {
    res.status(403).json({ error: "SuperUser access required" });
    return null;
  }
  return staff;
}

// ---------------------------------------------------------------------------
// GET /api/tenancy/schools
//   Lists schools the caller can pick from. SuperUsers see all active schools.
//   Regular staff see exactly their home school. Used to populate the top-bar
//   switcher (SuperUser) and the read-only badge (everyone else).
// ---------------------------------------------------------------------------
router.get("/tenancy/schools", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;

  const all = await db
    .select()
    .from(schoolsTable)
    .where(eq(schoolsTable.active, true))
    .orderBy(asc(schoolsTable.districtId), asc(schoolsTable.id));

  const visible = staff.isSuperUser
    ? all
    : all.filter((s) => s.id === staff.schoolId);

  res.json({
    homeSchoolId: staff.schoolId,
    activeSchoolId: req.schoolId ?? staff.schoolId,
    isSwitched: !!req.isSchoolSwitched,
    canSwitch: !!staff.isSuperUser,
    schools: visible.map((s) => ({
      id: s.id,
      districtId: s.districtId,
      name: s.name,
      shortName: s.shortName,
      stateSchoolCode: s.stateSchoolCode,
      isPrimary: s.isPrimary,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /api/tenancy/switch-school { schoolId }
//   SuperUser-only. Persists session.activeSchoolId so subsequent requests
//   resolve req.schoolId to the chosen school. Pass schoolId=null (or the
//   caller's home school id) to clear the override.
// ---------------------------------------------------------------------------
router.post("/tenancy/switch-school", async (req, res) => {
  const staff = await requireSuperUser(req, res);
  if (!staff) return;

  const raw = (req.body ?? {}) as { schoolId?: unknown };
  const wantsClear = raw.schoolId === null || raw.schoolId === undefined;

  // We persist the override on the staff row instead of req.session because
  // bearer-token requests (the Replit preview iframe blocks session cookies)
  // create a fresh session each request, so session.activeSchoolId never
  // survives a reload.
  if (wantsClear) {
    await db
      .update(staffTable)
      .set({ activeSchoolOverride: null })
      .where(eq(staffTable.id, staff.id));
    res.json({
      ok: true,
      activeSchoolId: staff.schoolId,
      isSwitched: false,
    });
    return;
  }

  const schoolId = Number(raw.schoolId);
  if (!Number.isInteger(schoolId) || schoolId <= 0) {
    res.status(400).json({ error: "schoolId must be a positive integer" });
    return;
  }

  const [school] = await db
    .select()
    .from(schoolsTable)
    .where(and(eq(schoolsTable.id, schoolId), eq(schoolsTable.active, true)));
  if (!school) {
    res.status(404).json({ error: "School not found or inactive" });
    return;
  }

  // schoolId === staff.schoolId means the SuperUser picked their own home
  // school explicitly. Treat that as "clear the override" so the badge
  // returns to its non-switched state.
  const overrideValue = schoolId === staff.schoolId ? null : schoolId;
  await db
    .update(staffTable)
    .set({ activeSchoolOverride: overrideValue })
    .where(eq(staffTable.id, staff.id));

  res.json({
    ok: true,
    activeSchoolId: schoolId,
    isSwitched: schoolId !== staff.schoolId,
    schoolName: school.name,
  });
});

// ---------------------------------------------------------------------------
// POST /api/tenancy/schools
//   SuperUser-only. Creates a new school inside a district. Used by the
//   Tenancy panel "Create new school" action so SuperUsers can prove silo
//   isolation by switching into a brand-new (empty) school.
// ---------------------------------------------------------------------------
router.post("/tenancy/schools", async (req, res) => {
  const staff = await requireSuperUser(req, res);
  if (!staff) return;

  const body = (req.body ?? {}) as {
    districtId?: unknown;
    name?: unknown;
    shortName?: unknown;
    stateSchoolCode?: unknown;
  };

  const districtId = Number(body.districtId);
  if (!Number.isInteger(districtId) || districtId <= 0) {
    res.status(400).json({ error: "districtId must be a positive integer" });
    return;
  }
  const [district] = await db
    .select()
    .from(districtsTable)
    .where(eq(districtsTable.id, districtId));
  if (!district) {
    res.status(404).json({ error: "District not found" });
    return;
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const shortName =
    typeof body.shortName === "string" && body.shortName.trim()
      ? body.shortName.trim()
      : null;
  const stateSchoolCode =
    typeof body.stateSchoolCode === "string" && body.stateSchoolCode.trim()
      ? body.stateSchoolCode.trim()
      : null;

  // Reject duplicate name OR state code within the same district. The DB
  // doesn't have a composite unique yet (D4) so we enforce it here.
  const existing = await db
    .select()
    .from(schoolsTable)
    .where(eq(schoolsTable.districtId, districtId));
  if (existing.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
    res
      .status(409)
      .json({ error: `A school named "${name}" already exists in this district` });
    return;
  }
  if (
    stateSchoolCode &&
    existing.some((s) => s.stateSchoolCode === stateSchoolCode)
  ) {
    res
      .status(409)
      .json({ error: `State code ${stateSchoolCode} is already used in this district` });
    return;
  }

  const [created] = await db
    .insert(schoolsTable)
    .values({
      districtId,
      name,
      shortName,
      stateSchoolCode,
      isPrimary: false,
      active: true,
    })
    .returning();

  res.status(201).json({
    school: {
      id: created.id,
      districtId: created.districtId,
      name: created.name,
      shortName: created.shortName,
      stateSchoolCode: created.stateSchoolCode,
      isPrimary: created.isPrimary,
      active: created.active,
    },
  });
});

// Tables we report row counts for. All have a school_id column as of Day 2.
// Day 4 added the per-school settings/config tables so SuperUsers can verify
// silo isolation at a glance (e.g. "1 settings row per school visited").
const COUNT_TABLES = [
  "students",
  "staff",
  "hall_passes",
  "tardies",
  "pbis_entries",
  "pullouts",
  "accommodation_logs",
  "support_notes",
  "intervention_entries",
  "iss_roster",
  "school_settings",
  "bell_schedules",
  "pbis_reasons",
  "pbis_milestones",
] as const;

router.get("/tenancy/status", async (req, res) => {
  const staff = await requireSuperUser(req, res);
  if (!staff) return;

  const districts = await db
    .select()
    .from(districtsTable)
    .orderBy(asc(districtsTable.id));

  const schools = await db
    .select()
    .from(schoolsTable)
    .orderBy(asc(schoolsTable.districtId), asc(schoolsTable.id));

  const counts: Record<string, number> = {};
  const perSchool: Record<string, Record<number, number>> = {};
  const orphans: Record<string, number> = {};
  for (const t of COUNT_TABLES) {
    perSchool[t] = {};
    const result = await db.execute(
      sql.raw(
        `SELECT school_id, COUNT(*)::int AS n FROM ${t} GROUP BY school_id`,
      ),
    );
    const rows = (result as any).rows ?? (result as any);
    let total = 0;
    let orphanCount = 0;
    for (const row of rows) {
      const n = Number(row.n ?? 0);
      const sid = row.school_id;
      total += n;
      if (sid === null || sid === undefined) {
        orphanCount += n;
      } else {
        perSchool[t][Number(sid)] = n;
      }
    }
    counts[t] = total;
    orphans[t] = orphanCount;
  }

  const totalOrphans = Object.values(orphans).reduce((a, b) => a + b, 0);

  res.json({
    districts: districts.map((d) => ({
      id: d.id,
      name: d.name,
      slug: d.slug,
      stateDistrictCode: d.stateDistrictCode,
      timezone: d.timezone,
      active: d.active,
    })),
    schools: schools.map((s) => ({
      id: s.id,
      districtId: s.districtId,
      name: s.name,
      shortName: s.shortName,
      stateSchoolCode: s.stateSchoolCode,
      isPrimary: s.isPrimary,
      active: s.active,
    })),
    counts,
    perSchool,
    orphans,
    totalOrphans,
    perSchoolBreakdownAvailable: true,
  });
});

export default router;
