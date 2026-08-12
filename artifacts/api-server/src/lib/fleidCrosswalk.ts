// FLEID → local student_id translation for Florida state assessment imports.
//
// Florida's FAST exports key every row on the state id (FLEID,
// "FL000008157762"). Hernando's ClassLink feed makes students.student_id the
// DISTRICT's local number ("5006415") and carries the FLEID separately, so a
// FAST file joined naively on student_id matches nothing — which is exactly
// what happened: ~228 records "imported successfully" and attached to no one.
//
// The demo seed hid this because there student_id WAS the FLEID and
// local_sis_id was derived from it. ClassLink inverted that relationship.
//
// Resolution is deliberately forgiving on FORM (case, whitespace) and strict
// on IDENTITY: an id that matches nothing is simply absent from the returned
// map, so callers must decide what to do about it. Never invent a student.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db, studentsTable } from "@workspace/db";

/** Normalize for comparison only — never for storage or display. */
function norm(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Map each supplied id to the local `students.student_id` for this school.
 *
 * Accepts FLEIDs and local ids interchangeably: district exports vary, and a
 * file that already uses local ids must keep working. Keys in the returned
 * map are the caller's ORIGINAL strings (untrimmed, original case) so a caller
 * can look up exactly what it passed in.
 *
 * Ids that match no student in this school are OMITTED — treat their absence
 * as "unmatched" and report it rather than writing an orphan row.
 */
export async function resolveStudentIdsByFleid(
  schoolId: number,
  rawIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (rawIds.length === 0) return out;

  // De-duplicate on the normalized form; keep every original spelling that
  // produced it so each caller key can be answered.
  const originalsByNorm = new Map<string, string[]>();
  for (const raw of rawIds) {
    if (typeof raw !== "string") continue;
    const n = norm(raw);
    if (!n) continue;
    const list = originalsByNorm.get(n) ?? [];
    list.push(raw);
    originalsByNorm.set(n, list);
  }
  if (originalsByNorm.size === 0) return out;

  const needles = [...originalsByNorm.keys()];

  // One query, both columns. UPPER() on the DB side matches `norm` above;
  // student_id is included so a file already keyed on local ids resolves
  // without a second round-trip.
  const rows = await db
    .select({
      studentId: studentsTable.studentId,
      fleid: studentsTable.fleid,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        sql`(UPPER(${studentsTable.fleid}) IN ${needles} OR UPPER(${studentsTable.studentId}) IN ${needles})`,
      ),
    );

  const localByNorm = new Map<string, string>();
  for (const row of rows) {
    // FLEID first: if some other student's local id collides with this
    // student's FLEID, the state id is the more specific claim.
    if (row.fleid) localByNorm.set(norm(row.fleid), row.studentId);
  }
  for (const row of rows) {
    const n = norm(row.studentId);
    if (!localByNorm.has(n)) localByNorm.set(n, row.studentId);
  }

  for (const [n, originals] of originalsByNorm) {
    const local = localByNorm.get(n);
    if (!local) continue;
    for (const original of originals) out.set(original, local);
  }
  return out;
}

/** Split ids into those that resolved and those that did not. */
export async function partitionByFleidMatch(
  schoolId: number,
  rawIds: string[],
): Promise<{ resolved: Map<string, string>; unmatched: string[] }> {
  const resolved = await resolveStudentIdsByFleid(schoolId, rawIds);
  const unmatched: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawIds) {
    if (resolved.has(raw)) continue;
    const key = norm(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unmatched.push(raw);
  }
  return { resolved, unmatched };
}

/** Idempotent column ensure — prod runs with RUN_BOOT_SEED off. */
export async function ensureStudentFleidColumn(): Promise<void> {
  await db.execute(
    sql`ALTER TABLE students ADD COLUMN IF NOT EXISTS fleid TEXT`,
  );
  // Partial index: the crosswalk only ever looks up non-null FLEIDs, and
  // most non-FL rows have none.
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS students_fleid_upper_idx ON students (school_id, UPPER(fleid)) WHERE fleid IS NOT NULL`,
  );
}
