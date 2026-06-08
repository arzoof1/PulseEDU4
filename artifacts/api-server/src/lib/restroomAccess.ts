import {
  db,
  locationsTable,
  locationAllowedDestinationsTable,
  schoolSettingsTable,
  teacherRestroomOverridesTable,
} from "@workspace/db";
import { alias } from "drizzle-orm/pg-core";
import { and, eq } from "drizzle-orm";

/**
 * Server-side enforcement for Restroom Access Control. The Create Pass
 * modal already hides blocked restrooms in the UI, but a stale tab or a
 * crafted request could still POST a now-blocked restroom — so the hard
 * block MUST be enforced here on every pass-creation path, not just in
 * the client.
 *
 * Precedence mirrors the modal exactly:
 *   - Feature OFF  -> always allowed (no-op; preserves legacy behavior).
 *   - Destination is NOT a restroom-kind location -> always allowed
 *     (only restrooms are governed; classrooms/offices are untouched).
 *   - Teacher has >=1 override row -> allowed set = the teacher override.
 *   - Otherwise -> allowed set = the origin room's restroom defaults
 *     (restroom-kind rows of location_allowed_destinations).
 *   - Empty allowed set => the restroom is denied (no fall-through).
 */
export async function checkRestroomAccess(
  schoolId: number,
  params: { destination: string; originRoom: string; teacherName: string },
): Promise<{ allowed: boolean; reason?: string }> {
  const [settings] = await db
    .select({ enabled: schoolSettingsTable.restroomAccessControlEnabled })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  if (!settings?.enabled) return { allowed: true };

  // Only restroom-kind destinations are governed.
  const [destLoc] = await db
    .select({ kind: locationsTable.kind })
    .from(locationsTable)
    .where(
      and(
        eq(locationsTable.schoolId, schoolId),
        eq(locationsTable.name, params.destination),
      ),
    );
  if (!destLoc || destLoc.kind !== "restroom") return { allowed: true };

  // Teacher override (active restrooms only).
  const overrideRows = await db
    .select({ name: locationsTable.name })
    .from(teacherRestroomOverridesTable)
    .innerJoin(
      locationsTable,
      and(
        eq(
          locationsTable.id,
          teacherRestroomOverridesTable.restroomLocationId,
        ),
        eq(locationsTable.schoolId, schoolId),
        eq(locationsTable.active, true),
      ),
    )
    .where(
      and(
        eq(teacherRestroomOverridesTable.schoolId, schoolId),
        eq(teacherRestroomOverridesTable.staffName, params.teacherName),
      ),
    );

  let allowedNames: Set<string>;
  if (overrideRows.length > 0) {
    allowedNames = new Set(overrideRows.map((r) => r.name));
  } else {
    const origin = alias(locationsTable, "origin_loc");
    const dest = alias(locationsTable, "dest_loc");
    const rows = await db
      .select({ destName: dest.name })
      .from(locationAllowedDestinationsTable)
      .innerJoin(
        origin,
        and(
          eq(origin.id, locationAllowedDestinationsTable.originLocationId),
          eq(origin.schoolId, schoolId),
        ),
      )
      .innerJoin(
        dest,
        and(
          eq(dest.id, locationAllowedDestinationsTable.destinationLocationId),
          eq(dest.schoolId, schoolId),
        ),
      )
      .where(
        and(
          eq(locationAllowedDestinationsTable.schoolId, schoolId),
          eq(origin.name, params.originRoom),
          eq(origin.active, true),
          eq(dest.active, true),
          eq(dest.kind, "restroom"),
        ),
      );
    allowedNames = new Set(rows.map((r) => r.destName));
  }

  if (allowedNames.has(params.destination)) return { allowed: true };
  return {
    allowed: false,
    reason: `${params.destination} isn't an available restroom for this pass.`,
  };
}
