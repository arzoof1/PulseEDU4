// PulseDNA video retention purge.
//
// TWO-TIER retention (only the MEDIA FILES are deleted — the row + the
// teleprompter script transcript persist permanently for the audit trail):
//
//   1. UNSENT (library/draft) videos — purged once NOW passes `purge_after`
//      (created_at + 14 days, +7 if the school postponed once). A hard stop of
//      ~21 days. These never went to a family, so they're transient.
//
//   2. SENT videos (sent_at set) — kept for the school year, purged at the
//      rollover. We compare the school-year LABEL of sent_at against the label
//      of NOW (per the school's timezone). When they differ, the year has
//      rolled and the file is purged.
//
// "Purge" = delete the three object-storage files (original WebM, derived MP4,
// derived MP3), null their keys, and flip status to "purged". Idempotent: a
// purged row has null keys + status "purged" so it's skipped next run.
//
// Cross-process safe via a pg advisory lock — a multi-instance deploy or a
// manual+scheduled overlap collapses to a single run instead of double-deleting.
import { and, eq, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db, pulseDnaVideosTable } from "@workspace/db";
import { deleteStoredObject } from "../routes/storage.js";
import { schoolYearLabelFor, getSchoolTimezone } from "../lib/schoolYear.js";
import { logger } from "../lib/logger.js";

export type PulseDnaPurgeResult = {
  purged: number;
};

// Stable, arbitrary 64-bit-ish key distinct from the other cron locks.
const ADVISORY_LOCK_KEY = 728_491_044;

export async function runPulseDnaVideoPurge(
  now: Date = new Date(),
): Promise<PulseDnaPurgeResult> {
  const lockRow = await db.execute<{ locked: boolean }>(sql`
    SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) AS locked
  `);
  const gotLock = (
    lockRow as unknown as { rows: Array<{ locked: boolean }> }
  ).rows[0]?.locked;
  if (!gotLock) {
    logger.info(
      "PulseDNA video purge: another run holds the advisory lock; skipping",
    );
    return { purged: 0 };
  }
  try {
    return await runUnderLock(now);
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`);
  }
}

async function runUnderLock(now: Date): Promise<PulseDnaPurgeResult> {
  // Candidate set: anything not already purged that EITHER
  //   (a) is unsent with an elapsed purge_after, OR
  //   (b) is sent (sent_at present).
  // For (b) we still defer the school-year comparison to JS so we can use the
  // per-school timezone. (a) is fully decided in SQL.
  const candidates = await db
    .select()
    .from(pulseDnaVideosTable)
    .where(
      and(
        ne(pulseDnaVideosTable.status, "purged"),
        or(
          and(
            isNull(pulseDnaVideosTable.sentAt),
            isNotNull(pulseDnaVideosTable.purgeAfter),
            lte(pulseDnaVideosTable.purgeAfter, now),
          ),
          isNotNull(pulseDnaVideosTable.sentAt),
        ),
      ),
    );

  // Cache per-school timezone + the school-year label of NOW so we don't
  // recompute for every row.
  const tzCache = new Map<number, string>();
  const nowLabelCache = new Map<number, string>();

  let purged = 0;
  for (const row of candidates) {
    let shouldPurge = false;
    if (row.sentAt == null) {
      // Unsent: SQL already confirmed purge_after <= now.
      shouldPurge = true;
    } else {
      let tz = tzCache.get(row.schoolId);
      if (tz == null) {
        tz = await getSchoolTimezone(row.schoolId);
        tzCache.set(row.schoolId, tz);
      }
      let nowLabel = nowLabelCache.get(row.schoolId);
      if (nowLabel == null) {
        nowLabel = schoolYearLabelFor(now, tz);
        nowLabelCache.set(row.schoolId, nowLabel);
      }
      const sentLabel = schoolYearLabelFor(new Date(row.sentAt), tz);
      shouldPurge = sentLabel !== nowLabel;
    }
    if (!shouldPurge) continue;

    // Delete the media files (best-effort; missing objects are fine).
    for (const key of [
      row.originalObjectKey,
      row.mp4ObjectKey,
      row.audioObjectKey,
    ]) {
      if (key) {
        try {
          await deleteStoredObject(key);
        } catch (err) {
          logger.warn(
            { videoId: row.id, key, err },
            "PulseDNA purge: object delete failed (continuing)",
          );
        }
      }
    }

    await db
      .update(pulseDnaVideosTable)
      .set({
        status: "purged",
        originalObjectKey: null,
        mp4ObjectKey: null,
        audioObjectKey: null,
        purgedAt: now,
        updatedAt: now,
      })
      .where(eq(pulseDnaVideosTable.id, row.id));
    purged += 1;
  }

  return { purged };
}
