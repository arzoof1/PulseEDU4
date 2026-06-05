/* eslint-disable no-console */
// Idempotent one-shot: for EVERY school in the DB, walk the staff
// table and create a `locations` row for each teacher who has a
// `default_room` set. Name format: "Display Name — Room <n>".
//
// Designed to be safe to re-run:
// - Locations are matched on the global-unique `name` column;
//   ON CONFLICT DO NOTHING (with a follow-up UPDATE that re-asserts
//   the flags + active=true, so a re-run heals stale rows).
// - After inserting, the script meshes every active classroom in
//   the school via location_allowed_destinations (same shape as
//   the /locations/wire-classrooms-mesh route).
//
// Phone extensions are intentionally NOT folded into the location
// name — they already live on `staff.work_extension` and surface
// via the Staff Directory ("Where is …?"). Including them in the
// kiosk/Send-Pass dropdown would clutter it.
//
// Run with: pnpm --filter @workspace/scripts run seed-teacher-locations
import {
  db,
  pool,
  schoolsTable,
  staffTable,
  locationsTable,
  locationAllowedDestinationsTable,
} from "@workspace/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";

// Normalize "204" / " 204 " / "Room 204" / "RM 204" → "204" so the
// location name ends up "Mrs. Smith — Room 204" without doubling.
function normalizeRoom(raw: string): string {
  return raw.trim().replace(/^(room|rm\.?|rm)\s+/i, "").trim();
}

function locationNameFor(displayName: string, room: string): string {
  return `${displayName.trim()} — Room ${normalizeRoom(room)}`;
}

async function backfillSchool(
  schoolId: number,
  schoolLabel: string,
): Promise<{ created: number; healed: number; skipped: number; pairs: number }> {
  // Pull every teacher with a default room. We don't filter on a
  // "teacher" role flag — any staff member with a defaultRoom is a
  // valid origin (some specials/coaches have rooms too).
  const teachers = await db
    .select({
      id: staffTable.id,
      displayName: staffTable.displayName,
      defaultRoom: staffTable.defaultRoom,
    })
    .from(staffTable)
    .where(
      and(
        eq(staffTable.schoolId, schoolId),
        isNotNull(staffTable.defaultRoom),
      ),
    );

  let created = 0;
  let healed = 0;
  let skipped = 0;

  for (const t of teachers) {
    const room = (t.defaultRoom ?? "").trim();
    if (!room) {
      skipped++;
      continue;
    }
    const name = locationNameFor(t.displayName, room);
    // INSERT … ON CONFLICT (name) DO UPDATE: a re-run repairs
    // flags / active without changing the row identity. Returns
    // `xmax = 0` when a fresh insert happened, non-zero on update,
    // so we can tell created vs healed.
    const rows = await db.execute<{
      id: number;
      created: boolean;
    }>(sql`
      INSERT INTO locations
        (school_id, name, kind, is_origin, is_destination,
         student_visible, active)
      VALUES
        (${schoolId}, ${name}, 'classroom', TRUE, TRUE, FALSE, TRUE)
      ON CONFLICT (name) DO UPDATE
        SET kind = 'classroom',
            is_origin = TRUE,
            is_destination = TRUE,
            active = TRUE
      RETURNING id, (xmax = 0) AS created
    `);
    const r = rows.rows?.[0] ?? (rows as unknown as { id: number; created: boolean }[])[0];
    if (r?.created) created++;
    else healed++;
  }

  // Mesh allowed-destinations across every active classroom in
  // this school (existing + newly inserted). Same logic as the
  // /locations/wire-classrooms-mesh route, inlined.
  const classrooms = await db
    .select()
    .from(locationsTable)
    .where(
      and(
        eq(locationsTable.schoolId, schoolId),
        eq(locationsTable.kind, "classroom"),
        eq(locationsTable.active, true),
      ),
    );
  const existing = await db
    .select({
      o: locationAllowedDestinationsTable.originLocationId,
      d: locationAllowedDestinationsTable.destinationLocationId,
    })
    .from(locationAllowedDestinationsTable)
    .where(eq(locationAllowedDestinationsTable.schoolId, schoolId));
  const have = new Set(existing.map((r) => `${r.o}->${r.d}`));
  const toInsert: Array<{
    schoolId: number;
    originLocationId: number;
    destinationLocationId: number;
  }> = [];
  for (const o of classrooms) {
    for (const d of classrooms) {
      if (o.id === d.id) continue;
      if (!have.has(`${o.id}->${d.id}`)) {
        toInsert.push({
          schoolId,
          originLocationId: o.id,
          destinationLocationId: d.id,
        });
      }
    }
  }
  const CHUNK = 500;
  let pairs = 0;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const slice = toInsert.slice(i, i + CHUNK);
    if (slice.length === 0) continue;
    await db.insert(locationAllowedDestinationsTable).values(slice);
    pairs += slice.length;
  }

  console.log(
    `  [${schoolLabel}] teachers=${teachers.length}  created=${created} healed=${healed} skipped=${skipped}  pairsAdded=${pairs}`,
  );
  return { created, healed, skipped, pairs };
}

async function main() {
  const schools = await db
    .select({
      id: schoolsTable.id,
      name: schoolsTable.name,
      shortName: schoolsTable.shortName,
    })
    .from(schoolsTable);

  console.log(`Backfilling teacher locations for ${schools.length} school(s)…`);
  let totalCreated = 0;
  let totalHealed = 0;
  let totalSkipped = 0;
  let totalPairs = 0;
  for (const s of schools) {
    const label = s.shortName ?? s.name ?? `school#${s.id}`;
    try {
      const r = await backfillSchool(s.id, label);
      totalCreated += r.created;
      totalHealed += r.healed;
      totalSkipped += r.skipped;
      totalPairs += r.pairs;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  [${label}] FAILED: ${msg}`);
    }
  }
  console.log(
    `Done. created=${totalCreated}  healed=${totalHealed}  skipped=${totalSkipped}  pairsAdded=${totalPairs}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
