// End-of-day auto-clear for the parent pickup queue.
//
// Background: the Admin Hub "Still on campus" tile is meant to surface
// the small list of kids who came through the dismissal queue but never
// got a terminal event (in_car / walker_released). Without an
// end-of-day reset, that list carries forward overnight and the next
// morning the front office sees yesterday's stragglers stacked on top
// of today's queue.
//
// What it does, once per day:
//   1. For every school with any pickup_queue_events today, find every
//      student who has at least one event today AND no terminal event
//      today.
//   2. Insert an `auto_cleared` event per student. The action is
//      already in the pickup_queue_events vocabulary (see
//      lib/db/src/schema/pickupQueueEvents.ts) and the reconciliation
//      query already treats it as terminal — so once written, the kid
//      drops off the tile.
//   3. Idempotent by construction: if we re-run, kids who already got
//      an auto_cleared today will now have a terminal event today and
//      be excluded from step 1.
//
// Audit trail: append-only, same as every other queue event. Reason
// note carries the cron timestamp so a parent's "what time did you
// release my kid?" question still has an answer ("system auto-clear at
// HH:MM").

import { sql } from "drizzle-orm";
import { db, pickupQueueEventsTable } from "@workspace/db";
import { logger } from "../lib/logger.js";

const TERMINAL_ACTIONS = [
  "in_car",
  "walker_released",
  "auto_cleared",
] as const;

export type AutoClearResult = {
  schoolsProcessed: number;
  studentsCleared: number;
};

// Arbitrary stable 64-bit-ish key for the cross-process lock so two
// workers (multi-instance deploy, restart overlap, manual + scheduled
// run) can't race each other into duplicate `auto_cleared` rows.
const ADVISORY_LOCK_KEY = 728_491_001;

export async function runPickupEndOfDayAutoClear(
  now: Date = new Date(),
  // School-local day boundary. America/New_York for HCSB.
  timeZone: string = "America/New_York",
): Promise<AutoClearResult> {
  // pg_try_advisory_lock returns false immediately if another session
  // holds the same key — we skip rather than block so an overlap just
  // turns into a single execution, not a queued double-run.
  const lockRow = await db.execute<{ locked: boolean }>(sql`
    SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) AS locked
  `);
  const gotLock = (
    lockRow as unknown as { rows: Array<{ locked: boolean }> }
  ).rows[0]?.locked;
  if (!gotLock) {
    logger.info(
      "pickup auto-clear: another run holds the advisory lock; skipping",
    );
    return { schoolsProcessed: 0, studentsCleared: 0 };
  }

  try {
    return await runUnderLock(now, timeZone);
  } finally {
    // Always release — the lock is session-scoped, so a crashed
    // session would eventually drop it, but we don't want to wait.
    await db.execute(sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`);
  }
}

async function runUnderLock(
  now: Date,
  timeZone: string,
): Promise<AutoClearResult> {
  // School-local start-of-day in UTC. We compute it via SQL so the
  // timezone math is the same one Postgres uses for any future
  // date-bucketed query — no JS/PG drift.
  const sinceRow = await db.execute<{ since: Date }>(sql`
    SELECT date_trunc('day', ${now.toISOString()}::timestamptz AT TIME ZONE ${timeZone})
             AT TIME ZONE ${timeZone} AS since
  `);
  const sinceRaw = (sinceRow as unknown as { rows: Array<{ since: Date }> })
    .rows[0]?.since;
  if (!sinceRaw) {
    logger.warn("pickup auto-clear: could not resolve start-of-day; skipping");
    return { schoolsProcessed: 0, studentsCleared: 0 };
  }
  const since = sinceRaw instanceof Date ? sinceRaw : new Date(sinceRaw);

  // Find every (school, student) pair that has at least one queue
  // event today and no terminal event today. We DON'T limit to
  // `added`-action stragglers because some flows record other
  // non-terminal actions (e.g. restricted_attempt) and we want a
  // clean slate either way.
  const stragglers = await db.execute<{
    school_id: number;
    student_id: number;
  }>(sql`
    SELECT DISTINCT e.school_id, e.student_id
      FROM pickup_queue_events e
     WHERE e.occurred_at >= ${since}
       AND NOT EXISTS (
         SELECT 1
           FROM pickup_queue_events t
          WHERE t.school_id = e.school_id
            AND t.student_id = e.student_id
            AND t.occurred_at >= ${since}
            AND t.action = ANY(${sql.raw(
              `ARRAY['${TERMINAL_ACTIONS.join("','")}']::text[]`,
            )})
       )
  `);
  const rows = (
    stragglers as unknown as {
      rows: Array<{ school_id: number; student_id: number }>;
    }
  ).rows;

  if (rows.length === 0) {
    return { schoolsProcessed: 0, studentsCleared: 0 };
  }

  // One bulk insert. actor_staff_id = 0 is the documented "system"
  // sentinel used by the AST lapse cron too; actor_display_name spells
  // out the source so audit consumers don't have to know the sentinel.
  const stamp = now.toISOString();
  await db.insert(pickupQueueEventsTable).values(
    rows.map((r) => ({
      schoolId: r.school_id,
      studentId: r.student_id,
      pickupAuthorizationId: null,
      actorStaffId: 0,
      actorDisplayName: "System (end-of-day auto-clear)",
      action: "auto_cleared",
      note: `Auto-cleared at end of day (${stamp}).`,
      occurredAt: now,
    })),
  );

  const distinctSchools = new Set(rows.map((r) => r.school_id));
  return {
    schoolsProcessed: distinctSchools.size,
    studentsCleared: rows.length,
  };
}
