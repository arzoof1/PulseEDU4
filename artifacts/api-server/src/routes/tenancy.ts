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

// Tables we report row counts for. All have a school_id column as of Day 2.
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

  // Per-school + global counts in one pass per table.
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
