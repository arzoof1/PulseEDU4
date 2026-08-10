// Single source of truth for "does this staff member have to complete MFA?"
// (Gate A / Section 1). Every code path — the login flow, the /me endpoint,
// admin screens — must call this rather than re-deriving the rule, so the
// policy stays consistent everywhere.
//
// Policy model: TWO tiers, because the staff schema has no distinct
// teacher / AP / support role flags — "teacher" is simply the absence of a
// privileged flag (see the tracker note on role granularity):
//   - "privileged" = SuperUser / District Admin / School Admin (items 1.1-1.3)
//   - "staff"      = every other login-holding role (items 1.4-1.6)
//
// A tier is required when EITHER the staff member's school OR their district
// has turned that tier on. Both halves default OFF, so this returns false for
// everyone until a policy flag is deliberately flipped — i.e. shipping the
// MFA system is a no-op.

import { eq } from "drizzle-orm";
import {
  db,
  schoolsTable,
  schoolSettingsTable,
  districtsTable,
  staffTable,
} from "@workspace/db";

type StaffRow = typeof staffTable.$inferSelect;

export type MfaTier = "privileged" | "staff";

export function staffMfaTier(
  staff: Pick<StaffRow, "isSuperUser" | "isDistrictAdmin" | "isAdmin">,
): MfaTier {
  return staff.isSuperUser || staff.isDistrictAdmin || staff.isAdmin
    ? "privileged"
    : "staff";
}

export async function isMfaRequiredForStaff(
  staff: Pick<
    StaffRow,
    "isSuperUser" | "isDistrictAdmin" | "isAdmin" | "schoolId"
  >,
): Promise<boolean> {
  const tier = staffMfaTier(staff);

  const [settings] = await db
    .select({
      priv: schoolSettingsTable.mfaRequiredPrivileged,
      staffReq: schoolSettingsTable.mfaRequiredStaff,
    })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, staff.schoolId))
    .limit(1);

  let districtPriv = false;
  let districtStaff = false;
  const [school] = await db
    .select({ districtId: schoolsTable.districtId })
    .from(schoolsTable)
    .where(eq(schoolsTable.id, staff.schoolId))
    .limit(1);
  if (school?.districtId != null) {
    const [district] = await db
      .select({
        priv: districtsTable.mfaRequiredPrivileged,
        staffReq: districtsTable.mfaRequiredStaff,
      })
      .from(districtsTable)
      .where(eq(districtsTable.id, school.districtId))
      .limit(1);
    districtPriv = district?.priv ?? false;
    districtStaff = district?.staffReq ?? false;
  }

  const schoolPriv = settings?.priv ?? false;
  const schoolStaff = settings?.staffReq ?? false;

  return tier === "privileged"
    ? schoolPriv || districtPriv
    : schoolStaff || districtStaff;
}
