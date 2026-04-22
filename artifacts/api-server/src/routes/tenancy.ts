import { Router, type IRouter } from "express";
import { db, staffTable, districtsTable, schoolsTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

// SuperUser-only guard. Loads the staff row and returns it on success, or
// writes the appropriate error response and returns null on failure.
async function requireSuperUser(req: any, res: any) {
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
  if (!staff.isSuperUser) {
    res.status(403).json({ error: "SuperUser access required" });
    return null;
  }
  return staff;
}

// Tables we report row counts for on Day 1. These are the data tables that
// will receive a school_id column on Day 2.
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

  // Global counts (district-wide). Per-school counts arrive in Day 2 once
  // each table has a school_id column.
  const counts: Record<string, number> = {};
  for (const t of COUNT_TABLES) {
    const result = await db.execute(
      sql.raw(`SELECT COUNT(*)::int AS n FROM ${t}`),
    );
    const row = (result as any).rows?.[0] ?? (result as any)[0];
    counts[t] = Number(row?.n ?? 0);
  }

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
    // Day 2 work: school_id columns + per-school breakdown + orphan check.
    perSchoolBreakdownAvailable: false,
    note: "Day 1 foundation. Day 2 will tag every existing record to D. S. Parrott Middle School and enable per-school row counts and an orphan check.",
  });
});

export default router;
