/* eslint-disable no-console */
// =============================================================================
// seedPickupBadges — assign pickup numbers to ~25% of students on each
// school's teacher rosters (one-off demo seed).
//
// Why: gives the "Print by teacher" workflow visible output without
// requiring a real bulk-assign run in every demo tenant. Idempotent —
// students who already have an active authorization are skipped, so
// re-running just tops up to the 25% bar.
//
// Picks 25% of the union of every non-planning section roster per
// school (i.e. students who actually appear on a teacher's roster).
// Pickup numbers are allocated from the same 1001–9999 pool the
// runtime uses (lib/coreTeam → routes/pickup.ts NUMBER_RANGE_*).
//
// Run: pnpm --filter @workspace/scripts run seed-pickup-badges
// =============================================================================

import {
  classSectionsTable,
  db,
  pool,
  schoolsTable,
  sectionRosterTable,
  studentPickupAuthorizationsTable,
  studentsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

// Must match NUMBER_RANGE_* in artifacts/api-server/src/routes/pickup.ts.
const NUMBER_RANGE_MIN = 1001;
const NUMBER_RANGE_MAX = 9999;

// Cycle a few labels so the demo tag stack doesn't look like every
// pickup belongs to "Primary". Mirrors what front-office staff
// typically enter at issue time.
const GUARDIAN_LABELS = [
  "Mom",
  "Dad",
  "Grandma",
  "Grandpa",
  "Aunt",
  "Uncle",
  "Stepmom",
  "Stepdad",
];

const TARGET_PCT = 0.25;

function pickPercent<T>(arr: T[], pct: number): T[] {
  const n = Math.floor(arr.length * pct);
  if (n <= 0) return [];
  // Fisher-Yates with Math.random — fine for a demo seed; we don't
  // need a reproducible PRNG here.
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i] as T;
    a[i] = a[j] as T;
    a[j] = tmp;
  }
  return a.slice(0, n);
}

function nextFreeNumber(used: Set<string>): string | null {
  for (let n = NUMBER_RANGE_MIN; n <= NUMBER_RANGE_MAX; n++) {
    const candidate = String(n);
    if (!used.has(candidate)) return candidate;
  }
  return null;
}

async function seedSchool(schoolId: number, schoolName: string) {
  // 1. All students on any non-planning section roster in this school.
  //    section_roster.student_id is the district TEXT code, so join
  //    through students to land on the integer PK pickup keys against.
  const onRoster = await db
    .selectDistinct({ id: studentsTable.id })
    .from(classSectionsTable)
    .innerJoin(
      sectionRosterTable,
      eq(sectionRosterTable.sectionId, classSectionsTable.id),
    )
    .innerJoin(
      studentsTable,
      and(
        eq(studentsTable.studentId, sectionRosterTable.studentId),
        eq(studentsTable.schoolId, classSectionsTable.schoolId),
      ),
    )
    .where(
      and(
        eq(classSectionsTable.schoolId, schoolId),
        eq(classSectionsTable.isPlanning, false),
      ),
    );

  if (onRoster.length === 0) {
    console.log(`  · ${schoolName} (id=${schoolId}): no roster students, skipping`);
    return { picked: 0, created: 0, alreadyHad: 0 };
  }

  const picked = pickPercent(onRoster, TARGET_PCT);

  // 2. Students in the pick set who already have an active authorization
  //    are left alone (idempotent). Pull the existing set in one query.
  const pickedIds = picked.map((s) => s.id);
  const existing = await db
    .select({ studentId: studentPickupAuthorizationsTable.studentId })
    .from(studentPickupAuthorizationsTable)
    .where(
      and(
        eq(studentPickupAuthorizationsTable.schoolId, schoolId),
        eq(studentPickupAuthorizationsTable.active, true),
        inArray(studentPickupAuthorizationsTable.studentId, pickedIds),
      ),
    );
  const haveActive = new Set(existing.map((r) => r.studentId));
  const toCreate = pickedIds.filter((id) => !haveActive.has(id));

  if (toCreate.length === 0) {
    console.log(
      `  · ${schoolName} (id=${schoolId}): ${onRoster.length} roster students, ` +
        `${picked.length} sampled, all already have tags — skipped`,
    );
    return { picked: picked.length, created: 0, alreadyHad: picked.length };
  }

  // 3. Allocate numbers from the school-wide free pool.
  const taken = await db
    .select({ pickupNumber: studentPickupAuthorizationsTable.pickupNumber })
    .from(studentPickupAuthorizationsTable)
    .where(
      and(
        eq(studentPickupAuthorizationsTable.schoolId, schoolId),
        eq(studentPickupAuthorizationsTable.active, true),
      ),
    );
  const used = new Set(taken.map((t) => t.pickupNumber));

  let created = 0;
  for (let i = 0; i < toCreate.length; i++) {
    const studentId = toCreate[i]!;
    const num = nextFreeNumber(used);
    if (!num) {
      console.warn(
        `  · ${schoolName}: capacity exhausted at ${created} new tags`,
      );
      break;
    }
    used.add(num);
    const label = GUARDIAN_LABELS[i % GUARDIAN_LABELS.length]!;
    await db.insert(studentPickupAuthorizationsTable).values({
      schoolId,
      studentId,
      parentId: null,
      guardianLabel: label,
      pickupNumber: num,
      restrictedFrom: false,
      active: true,
    });
    created++;
  }

  console.log(
    `  · ${schoolName} (id=${schoolId}): ${onRoster.length} roster students, ` +
      `${picked.length} sampled (~25%), ${haveActive.size} already had tags, ` +
      `${created} new tags issued`,
  );
  return {
    picked: picked.length,
    created,
    alreadyHad: haveActive.size,
  };
}

async function main() {
  const schools = await db
    .select({ id: schoolsTable.id, name: schoolsTable.name })
    .from(schoolsTable);

  console.log(
    `Seeding pickup badges for ${schools.length} school(s) ` +
      `(target ${Math.round(TARGET_PCT * 100)}% of roster students)…`,
  );

  let totalCreated = 0;
  let totalPicked = 0;
  let totalAlready = 0;
  for (const s of schools) {
    const r = await seedSchool(s.id, s.name);
    totalCreated += r.created;
    totalPicked += r.picked;
    totalAlready += r.alreadyHad;
  }

  console.log("");
  console.log(
    `Done. ${totalCreated} new pickup authorization(s) created; ` +
      `${totalAlready} student(s) in the sampled set already had active tags; ` +
      `${totalPicked} student(s) sampled total.`,
  );
}

main()
  .catch((err) => {
    console.error("seed-pickup-badges failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
