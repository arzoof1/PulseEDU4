// Predicate used by every district-scoped surface (district CSV imports,
// district reports, the upcoming Insights cross-school dashboards) to decide
// whether the caller may operate at the *district* scope rather than the
// single-school scope. Centralized so the SuperUser ⊇ DistrictAdmin
// hierarchy stays honest — the route layer should never check
// `staff.isDistrictAdmin` on its own and accidentally exclude SuperUsers.
export function canActAsDistrict(staff: {
  isSuperUser?: boolean | null;
  isDistrictAdmin?: boolean | null;
}): boolean {
  return Boolean(staff.isSuperUser) || Boolean(staff.isDistrictAdmin);
}

// Tiny helper to require a resolved school for a request. Most routes call
// this at the top of each handler so the type narrows from `number | null`
// to `number` and a 401 is written if the request is unauthenticated.
import type { Request, Response } from "express";
import { db, schoolsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export function requireSchool(req: Request, res: Response): number | null {
  const sid = req.schoolId;
  if (!sid) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  return sid;
}

// Resolve the districtId for a given schoolId via a single-row lookup. Used
// by the SuperUser surfaces (tenancy switcher, adminStaff) to confine
// "district-wide" reach to the actor's own district. Returns null if the
// school does not exist.
export async function getDistrictIdForSchool(
  schoolId: number,
): Promise<number | null> {
  const [row] = await db
    .select({ districtId: schoolsTable.districtId })
    .from(schoolsTable)
    .where(eq(schoolsTable.id, schoolId));
  return row?.districtId ?? null;
}

// Returns the set of school ids that belong to a district. Used to AND-
// filter SuperUser list/edit queries by `staffTable.schoolId IN (...)`. The
// list is small (a handful for Hernando, ~96 for Pasco) so we materialize
// it instead of joining in every query.
export async function getSchoolIdsForDistrict(
  districtId: number,
): Promise<number[]> {
  const rows = await db
    .select({ id: schoolsTable.id })
    .from(schoolsTable)
    .where(eq(schoolsTable.districtId, districtId));
  return rows.map((r) => r.id);
}
