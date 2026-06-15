import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  locationsTable,
  staffTable,
  staffDefaultsTable,
  staffReceivedLocationsTable,
} from "@workspace/db";

// ---------------------------------------------------------------------------
// One-way hall pass helpers (destination check-in).
//
// Non-restroom passes are one-way: the student leaves the origin ("in route")
// and is received / checked in at the destination. Restroom passes stay
// round-trip ("I'm back" at the origin). These helpers centralize the two
// pieces of shared logic the lifecycle needs:
//
//   1. Which destinations are restrooms (round-trip) vs everything else
//      (one-way) — keyed by the location NAME stored on hall_passes.destination.
//   2. Which destination locations a staff member "covers" so a pass headed
//      there shows on their "Heading to me" list (their own room +
//      admin-assigned coverage rows).
// ---------------------------------------------------------------------------

// Restroom-kind destination NAMES for a school. The hall pass row stores the
// destination as the location name (text), so callers compare against names.
export async function loadRestroomDestinationNames(
  schoolId: number,
): Promise<Set<string>> {
  const rows = await db
    .select({ name: locationsTable.name })
    .from(locationsTable)
    .where(
      and(
        eq(locationsTable.schoolId, schoolId),
        eq(locationsTable.kind, "restroom"),
      ),
    );
  return new Set(rows.map((r) => r.name));
}

// True when a destination name is a restroom (round-trip) for this school.
export function isRestroomDestination(
  destination: string,
  restroomNames: Set<string>,
): boolean {
  return restroomNames.has(destination);
}

// Destination location NAMES a staff member covers (their "Heading to me"
// scope). Hybrid model:
//   - their own room (staff.defaultRoom + staff_defaults.default_location_name),
//     so teachers auto-cover passes headed to their classroom; PLUS
//   - any location admin-assigned to them via staff_received_locations.
export async function loadStaffCoverage(
  schoolId: number,
  staffId: number,
): Promise<Set<string>> {
  const covered = new Set<string>();

  const [staff] = await db
    .select({ defaultRoom: staffTable.defaultRoom })
    .from(staffTable)
    .where(and(eq(staffTable.id, staffId), eq(staffTable.schoolId, schoolId)));
  if (staff?.defaultRoom) covered.add(staff.defaultRoom);

  const defaults = await db
    .select({ room: staffDefaultsTable.defaultLocationName })
    .from(staffDefaultsTable)
    .where(
      and(
        eq(staffDefaultsTable.schoolId, schoolId),
        eq(staffDefaultsTable.staffId, staffId),
      ),
    );
  for (const d of defaults) if (d.room) covered.add(d.room);

  const assigned = await db
    .select({ name: locationsTable.name })
    .from(staffReceivedLocationsTable)
    .innerJoin(
      locationsTable,
      and(
        eq(locationsTable.id, staffReceivedLocationsTable.locationId),
        eq(locationsTable.schoolId, schoolId),
      ),
    )
    .where(
      and(
        eq(staffReceivedLocationsTable.schoolId, schoolId),
        eq(staffReceivedLocationsTable.staffId, staffId),
      ),
    );
  for (const a of assigned) if (a.name) covered.add(a.name);

  return covered;
}

// Which staff cover a given set of destination location names — the inverse
// of loadStaffCoverage, used by the overdue-in-route alert to find who to
// notify about a stranded student. Returns a map destinationName -> staffIds.
export async function loadCoverageByDestination(
  schoolId: number,
  destinationNames: string[],
): Promise<Map<string, Set<number>>> {
  const result = new Map<string, Set<number>>();
  for (const n of destinationNames) result.set(n, new Set<number>());
  if (destinationNames.length === 0) return result;

  // Room-based coverage (staff.defaultRoom).
  const roomStaff = await db
    .select({ id: staffTable.id, room: staffTable.defaultRoom })
    .from(staffTable)
    .where(
      and(
        eq(staffTable.schoolId, schoolId),
        inArray(staffTable.defaultRoom, destinationNames),
      ),
    );
  for (const s of roomStaff) {
    if (s.room && result.has(s.room)) result.get(s.room)!.add(s.id);
  }

  // Assigned coverage (staff_received_locations -> locations.name).
  const assigned = await db
    .select({
      staffId: staffReceivedLocationsTable.staffId,
      name: locationsTable.name,
    })
    .from(staffReceivedLocationsTable)
    .innerJoin(
      locationsTable,
      and(
        eq(locationsTable.id, staffReceivedLocationsTable.locationId),
        eq(locationsTable.schoolId, schoolId),
      ),
    )
    .where(
      and(
        eq(staffReceivedLocationsTable.schoolId, schoolId),
        inArray(locationsTable.name, destinationNames),
      ),
    );
  for (const a of assigned) {
    if (result.has(a.name)) result.get(a.name)!.add(a.staffId);
  }

  return result;
}

// Resolve the activating teacher's display name for a kiosk activation. Used to
// match inbound passes addressed to that teacher even when the kiosk's
// activated room string differs from the destination string.
export async function loadKioskTeacherDisplayName(
  schoolId: number,
  staffId: number,
): Promise<string | null> {
  const [staff] = await db
    .select({ displayName: staffTable.displayName })
    .from(staffTable)
    .where(and(eq(staffTable.id, staffId), eq(staffTable.schoolId, schoolId)));
  return staff?.displayName ?? null;
}

// True when a one-way pass is "heading to" this kiosk. A kiosk is both a
// physical room AND the teacher who activated it; destinations in this school
// are frequently named after the teacher's displayName (e.g.
// "Amy Brown - Math G7") rather than the activated room string (e.g. "203").
// So a pass matches when its destination equals the kiosk's activated room, OR
// the destination is the activating teacher's displayName. We deliberately do
// NOT match on the (currently-unpopulated) destinationTeacher column: that
// could let a pass whose destination is some OTHER location check in here.
// Both the kiosk's "Heading here" list and the arrive guard call this so they
// never disagree.
export function passHeadsToKiosk(
  pass: { destination: string },
  room: string,
  teacherDisplayName: string | null,
): boolean {
  if (pass.destination === room) return true;
  if (teacherDisplayName && pass.destination === teacherDisplayName) return true;
  return false;
}
