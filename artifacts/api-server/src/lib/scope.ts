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

// ---------------------------------------------------------------------------
// Data Imports tier gates (Phase 3). The importers all funnel through these
// two helpers so the route layer never re-derives "who can upload data".
// ---------------------------------------------------------------------------
//
// canImportSchoolData: anyone who can administer a single school. School
// Admin, District Admin, and SuperUser all qualify. School Admins are
// confined to their own school (req.schoolId); the higher tiers can
// override the school via the existing tenancy switcher.
export function canImportSchoolData(staff: {
  isSuperUser?: boolean | null;
  isDistrictAdmin?: boolean | null;
  isAdmin?: boolean | null;
}): boolean {
  return (
    Boolean(staff.isSuperUser) ||
    Boolean(staff.isDistrictAdmin) ||
    Boolean(staff.isAdmin)
  );
}

// canImportDistrictData: only District Admin + SuperUser. School Admins
// cannot upload a district-scoped CSV (one with a school_code column that
// fans out across many schools) because they have no authority over the
// other schools.
export function canImportDistrictData(staff: {
  isSuperUser?: boolean | null;
  isDistrictAdmin?: boolean | null;
}): boolean {
  return Boolean(staff.isSuperUser) || Boolean(staff.isDistrictAdmin);
}

// ---------------------------------------------------------------------------
// Per-kind delegated import capabilities (school scope only).
//
// Four assignable caps let an admin (or Core Team) hand a single importer to a
// data clerk without the full admin surface. Admins / DA / SuperUser keep
// every importer via canImportSchoolData(); a delegated clerk needs the
// specific cap for the kind they're uploading. District-scope imports are
// unaffected — they stay gated by canImportDistrictData().
//
// Map of importer `kind` → the cap that unlocks it. Kinds NOT in this map
// (rosters, behavior, points_migration) are NOT delegable and remain
// admin-only. Attendance is NOT here because it lives on the Eligibility
// route, not the dataImports router — it's gated there by canManageEligibility
// OR capImportAttendance.
type ImportCapStaff = {
  isSuperUser?: boolean | null;
  isDistrictAdmin?: boolean | null;
  isAdmin?: boolean | null;
  capImportGrades?: boolean | null;
  capImportAttendance?: boolean | null;
  capImportFast?: boolean | null;
  capImportIready?: boolean | null;
};

export const SCHOOL_IMPORT_KIND_CAP: Record<
  string,
  "capImportGrades" | "capImportFast" | "capImportIready"
> = {
  gradebook: "capImportGrades",
  fast_florida: "capImportFast",
  fast_scores: "capImportFast",
  fast_prior_year: "capImportFast",
  assessments: "capImportIready",
};

// True if the staff member can reach the Data Imports surface at all — admins
// (every importer) or anyone holding at least one delegated import cap.
// Attendance-only clerks are intentionally excluded here: attendance lives on
// the Eligibility route, so a clerk with ONLY capImportAttendance has no
// business on the dataImports router.
export function hasAnySchoolImportCap(staff: ImportCapStaff): boolean {
  return (
    canImportSchoolData(staff) ||
    Boolean(staff.capImportGrades) ||
    Boolean(staff.capImportFast) ||
    Boolean(staff.capImportIready)
  );
}

// Authorize a specific importer `kind` for a staff member. Admins bypass;
// otherwise the staff needs the cap mapped to that kind. Unmapped kinds
// (rosters / behavior / points_migration) return false for non-admins.
export function canImportKind(staff: ImportCapStaff, kind: string): boolean {
  if (canImportSchoolData(staff)) return true;
  const cap = SCHOOL_IMPORT_KIND_CAP[kind];
  return cap ? Boolean(staff[cap]) : false;
}

// The set of importer kinds a non-admin delegated clerk may see/list. Used to
// scope the jobs/templates history so a grades-only clerk never sees FAST or
// roster jobs. Admins get the full set elsewhere (callers check
// canImportSchoolData first).
export function allowedSchoolImportKinds(staff: ImportCapStaff): string[] {
  const out: string[] = [];
  for (const [kind, cap] of Object.entries(SCHOOL_IMPORT_KIND_CAP)) {
    if (staff[cap]) out.push(kind);
  }
  return out;
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
