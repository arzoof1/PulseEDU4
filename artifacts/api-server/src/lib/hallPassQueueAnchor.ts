// Re-anchor the hall-pass waiting line from kiosk activation to room.
//
// PRODUCTION NOTE: production runs with RUN_BOOT_SEED off, so runSeed and
// runMigrations never execute there. Any schema change the app depends on has
// to be an idempotent ensure wired into bootstrapCriticalColumns(), or it
// simply never happens in prod. (This is the same failure mode that caused a
// real outage; students.fleid and the class_sections index are here for the
// identical reason.)
//
// Three changes, all idempotent and safe to re-run on every boot:
//
//   1. hall_pass_queue.kiosk_activation_id → NULLABLE. Teacher-created entries
//      have no kiosk device behind them. The column stays as provenance.
//   2. Drop the old unique index on (kiosk_activation_id, student_id). With a
//      null activation, Postgres treats every row as distinct, so that index
//      stopped constraining anything for teacher entries — the "one student
//      per line" guarantee would have quietly evaporated.
//   3. Add a unique index on (school_id, room, student_id) — the same
//      guarantee, re-expressed against the new anchor.
//
// Existing rows already carry the correct `room` (it was cached on every row
// from day one), so no backfill is required — which is why this is safe to run
// against a live table while teachers are using it.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

export async function ensureHallPassQueueRoomAnchor(): Promise<void> {
  // The table may legitimately not exist yet on a brand-new database that has
  // never been seeded; every statement below is guarded so this is a no-op
  // rather than a boot failure in that case.
  const exists = await db.execute(sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'hall_pass_queue'
  `);
  if (exists.rows.length === 0) return;

  // (1) Teacher entries have no activation.
  await db.execute(sql`
    ALTER TABLE hall_pass_queue
    ALTER COLUMN kiosk_activation_id DROP NOT NULL
  `);

  // (2) The old anchor's uniqueness guarantee, which no longer holds.
  await db.execute(sql`
    DROP INDEX IF EXISTS hall_pass_queue_kiosk_student_idx
  `);

  // (3) The same guarantee against the new anchor. Built non-uniquely first
  // would be pointless here — the table is tiny (≤5 rows per room per period),
  // so a plain CREATE UNIQUE INDEX is instant and safe on live traffic.
  //
  // If a duplicate somehow exists at upgrade time the index creation fails and
  // boot fails loudly, which is correct: silently tolerating two entries for
  // one student in one line is worse than a refused boot we can see.
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS hall_pass_queue_room_student_idx
    ON hall_pass_queue (school_id, room, student_id)
  `);

  logger.info("[boot] hall_pass_queue room anchor ensured");
}
