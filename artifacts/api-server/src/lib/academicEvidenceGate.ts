import { db, schoolSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// Per-school admin toggle for the whole Academic Evidence feature
// ("Partnering with Parents" staff surface / "Learning at Home" parent
// surface). Two-tier: super (district) AND admin (school) must both be on.
// Defaults ON when no settings row exists. This is the single source of
// truth the staff routes, parent routes, parent snapshot, and client all
// gate on, so the feature can't be reached by calling a route directly
// while it is disabled.
export async function academicEvidenceEnabled(
  schoolId: number,
): Promise<boolean> {
  const [row] = await db
    .select({
      admin: schoolSettingsTable.featureAcademicEvidence,
      sup: schoolSettingsTable.superFeatureAcademicEvidence,
    })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  if (!row) return true;
  return row.admin !== false && row.sup !== false;
}
