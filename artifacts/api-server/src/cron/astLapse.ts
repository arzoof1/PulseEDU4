// AST year-end lapse job.
//
// Per HCTA contract, any unused AST balance lapses on June 30. On July 1
// at 00:05 in the school's local timezone (default America/New_York),
// this job:
//
//   1. Sums each (school_id, staff_id) ledger total in quarter-hours.
//   2. For every (school, staff) with a positive balance, inserts a
//      `lapse` ledger row with delta = -balance, zeroing the bank.
//   3. Records a per-school summary log line.
//
// Concurrency / idempotency:
//   * Each school is processed in a single transaction.
//   * We take a pg advisory lock keyed on (schoolId, yearLabel hash) so
//     two cron processes racing on the same day cannot both insert
//     lapse rows for the same school+year.
//   * Inside the tx, we re-check for any existing lapse row with the
//     current year-label prefix; if present, the whole school is a
//     no-op.
//   * If the tx commits, every staff for that school is lapsed
//     atomically. If it rolls back (crash, error), nothing is inserted
//     and the next run starts clean.
//
// Notification: we do NOT email staff individually (the per-staff
// ledger drilldown is the dispute path). The summary log gives admins
// a single line per school to confirm the job ran.

import { and, eq, sql } from "drizzle-orm";
import {
  db,
  staffAstLedgerTable,
  staffTable,
  schoolsTable,
} from "@workspace/db";
import { logger } from "../lib/logger.js";
import { schoolYearLabelFor } from "../lib/schoolYear.js";

const LAPSE_NOTE_PREFIX = "year-end lapse";
// Stable namespace for advisory locks — keeps us out of any other
// caller's lock space. Arbitrary 32-bit constant.
const ADVISORY_LOCK_NAMESPACE = 0x4153_544c; // "ASTL"

export type LapseResult = {
  schoolId: number;
  yearLabel: string;
  staffLapsed: number;
  totalQuarterHoursLapsed: number;
  skippedAlreadyLapsed?: boolean;
};

// Cheap deterministic 31-bit hash of the year label so the advisory
// lock key changes year-over-year. Two different years on the same
// school must NOT share a lock.
function hashYearLabel(label: string): number {
  let h = 0;
  for (let i = 0; i < label.length; i++) {
    h = ((h << 5) - h + label.charCodeAt(i)) | 0;
  }
  return Math.abs(h) & 0x7fff_ffff;
}

export async function runAstYearEndLapse(
  now: Date = new Date(),
): Promise<LapseResult[]> {
  // School-year label for the year that just ENDED (the one whose
  // balance is being zeroed). When this runs July 1 2027 it should
  // record "26-27" lapses, not "27-28".
  const oneSecondBeforeMidnight = new Date(now.getTime() - 1000);
  const yearLabel = schoolYearLabelFor(oneSecondBeforeMidnight);
  const yearKey = hashYearLabel(yearLabel);

  const schools = await db.select({ id: schoolsTable.id }).from(schoolsTable);
  const results: LapseResult[] = [];

  for (const school of schools) {
    const schoolId = school.id;

    const result = await db.transaction(async (tx) => {
      // 1. Advisory lock on (namespace ^ schoolId, yearKey). Auto-
      //    released on tx commit/rollback. Two concurrent cron runs
      //    against the same school+year will serialize here.
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          ${ADVISORY_LOCK_NAMESPACE ^ schoolId}::int,
          ${yearKey}::int
        )
      `);

      // 2. Inside the lock: has this job already committed for this
      //    school+year? If so, skip — atomically.
      const existing = await tx.execute(sql`
        SELECT 1 FROM staff_ast_ledger
         WHERE school_id = ${schoolId}
           AND kind = 'lapse'
           AND note LIKE ${LAPSE_NOTE_PREFIX + " " + yearLabel + "%"}
         LIMIT 1
      `);
      if (existing.rows.length > 0) {
        return {
          schoolId,
          yearLabel,
          staffLapsed: 0,
          totalQuarterHoursLapsed: 0,
          skippedAlreadyLapsed: true,
        } as LapseResult;
      }

      // 3. Active staff at this school with positive balance.
      const balanceRows = await tx
        .select({
          staffId: staffAstLedgerTable.staffId,
          total: sql<number>`COALESCE(SUM(${staffAstLedgerTable.deltaQuarterHours}), 0)::int`,
        })
        .from(staffAstLedgerTable)
        .innerJoin(staffTable, eq(staffTable.id, staffAstLedgerTable.staffId))
        .where(
          and(
            eq(staffAstLedgerTable.schoolId, schoolId),
            eq(staffTable.schoolId, schoolId),
          ),
        )
        .groupBy(staffAstLedgerTable.staffId)
        .having(
          sql`COALESCE(SUM(${staffAstLedgerTable.deltaQuarterHours}), 0) > 0`,
        );

      let staffLapsed = 0;
      let totalLapsed = 0;

      for (const row of balanceRows) {
        const balance = Number(row.total);
        if (balance <= 0) continue;
        await tx.insert(staffAstLedgerTable).values({
          schoolId,
          staffId: row.staffId,
          deltaQuarterHours: -balance,
          kind: "lapse",
          note: `${LAPSE_NOTE_PREFIX} ${yearLabel} (auto)`,
        });
        staffLapsed += 1;
        totalLapsed += balance;
      }

      return {
        schoolId,
        yearLabel,
        staffLapsed,
        totalQuarterHoursLapsed: totalLapsed,
      } as LapseResult;
    });

    if (result.skippedAlreadyLapsed) {
      logger.info(
        { schoolId, yearLabel },
        "AST lapse already recorded for this school+year; skipping",
      );
    } else {
      logger.info(
        {
          schoolId,
          yearLabel,
          staffLapsed: result.staffLapsed,
          totalQuarterHoursLapsed: result.totalQuarterHoursLapsed,
        },
        "AST year-end lapse complete for school",
      );
    }
    results.push(result);
  }

  return results;
}
