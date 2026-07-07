// School-controlled school-year rollover ("flip") reconciler.
//
// A school schedules a flip by setting school_settings.school_year_flip_date
// (YYYY-MM-DD, school-local). On or after that date the FAST/Insights reporting
// year advances by one and the OUTGOING year's rows are re-tagged historical so
// they slide into the prior-year column; before that date (or with no date set)
// nothing changes. The whole thing is reversible: clear/postpone the date and
// the outgoing year returns to being current.
//
// This ONLY touches the reporting year label + the is_historical tag on
// student_fast_scores. Schedules, rosters, and grade promotion stay owned by
// the SIS (RosterOne) and are never modified here.
//
// The activated year is stored in school_settings.school_year_flip_active and
// is what getActiveSchoolYear() returns; reconciliation keeps that column and
// the is_historical tags in sync with the flip date. Idempotent: safe to call
// on every settings save and on boot.

import { eq, sql } from "drizzle-orm";
import { db, studentFastScoresTable, schoolSettingsTable } from "@workspace/db";
import { resolveCurrentFastYear } from "./fastHistory.js";
import { nextSchoolYear, prevSchoolYear, getSchoolTimezone } from "./schoolYear.js";

// Today's date as YYYY-MM-DD in the given timezone. en-CA formats as
// YYYY-MM-DD, which compares correctly lexically against the stored flip date.
function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Bring a single school's flip state into agreement with its flip date.
// - date set and reached, not yet flipped  -> apply (advance + re-tag outgoing)
// - date unset/future, currently flipped    -> reverse (restore outgoing)
// - otherwise                                -> no-op
export async function reconcileSchoolYearFlip(schoolId: number): Promise<void> {
  const [row] = await db
    .select({
      flipDate: schoolSettingsTable.schoolYearFlipDate,
      flipActive: schoolSettingsTable.schoolYearFlipActive,
    })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  if (!row) return;

  const flipDate = row.flipDate?.trim() || null;
  const flipActive = row.flipActive?.trim() || null;
  // The flip date is school-local, so evaluate "has today reached it?" in the
  // school's own timezone (not a hardcoded default) to avoid flipping a school
  // a day early/late at the date boundary in multi-timezone tenancy.
  const tz = await getSchoolTimezone(schoolId);
  const desiredFlipped = flipDate !== null && todayInTz(tz) >= flipDate;
  const currentlyFlipped = flipActive !== null;

  if (desiredFlipped === currentlyFlipped) return;

  if (desiredFlipped && !currentlyFlipped) {
    // Apply: the outgoing year is the current newest non-historical data year.
    const base = await resolveCurrentFastYear(schoolId);
    const incoming = nextSchoolYear(base);
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`UPDATE student_fast_scores SET is_historical = TRUE WHERE school_id = ${schoolId} AND school_year = ${base}`,
      );
      await tx
        .update(schoolSettingsTable)
        .set({ schoolYearFlipActive: incoming })
        .where(eq(schoolSettingsTable.schoolId, schoolId));
    });
    return;
  }

  // Reverse: restore the year we flipped away from (one below the active year).
  const outgoing = prevSchoolYear(flipActive as string);
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`UPDATE student_fast_scores SET is_historical = FALSE WHERE school_id = ${schoolId} AND school_year = ${outgoing}`,
    );
    await tx
      .update(schoolSettingsTable)
      .set({ schoolYearFlipActive: null })
      .where(eq(schoolSettingsTable.schoolId, schoolId));
  });
}

// Reconcile every school that has a scheduled flip date. Called on boot so a
// flip whose date passed while the server was idle still applies. Defensive:
// one school's failure never blocks the rest or crashes boot.
export async function reconcileAllSchoolYearFlips(): Promise<void> {
  const rows = await db
    .select({ schoolId: schoolSettingsTable.schoolId })
    .from(schoolSettingsTable)
    .where(sql`school_year_flip_date IS NOT NULL`);
  for (const r of rows) {
    try {
      await reconcileSchoolYearFlip(r.schoolId);
    } catch {
      // Swallow — reconciliation is best-effort on boot; a bad row must not
      // take down the server. The next settings save will retry.
    }
  }
}

// `studentFastScoresTable` is imported to keep this module's dependency on the
// FAST scores table explicit even though the re-tag UPDATEs use raw SQL for a
// single set-based statement (drizzle's typed update would need a per-row plan).
void studentFastScoresTable;
