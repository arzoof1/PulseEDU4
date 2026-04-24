import {
  db,
  districtsTable,
  schoolsTable,
  hallPassesTable,
  tardiesTable,
  pbisEntriesTable,
  supportNotesTable,
  accommodationLogsTable,
  studentsTable,
  classSectionsTable,
  sectionRosterTable,
  schoolAccommodationsTable,
  studentAccommodationsTable,
  locationsTable,
  staffDefaultsTable,
  locationAllowedDestinationsTable,
  staffTable,
  kioskActivationsTable,
  recordEditsTable,
  adminNotificationsTable,
  bellSchedulesTable,
  bellSchedulePeriodsTable,
  schoolSettingsTable,
  studentHallPassLimitsTable,
  pulloutsTable,
  issAttendanceDayTable,
  issRosterTable,
  interventionEntriesTable,
  studentMtssPlansTable,
} from "@workspace/db";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { logger } from "./lib/logger";

// =============================================================================
// MULTI-SCHOOL SEED
// =============================================================================
// This produces the realistic 7-school dataset (Hernando County 6 schools +
// Pasco County 1 school) used by the live demo. It runs at boot:
//   - seedTenancy() always runs and is idempotent. It guarantees the two
//     districts and seven schools exist.
//   - seedIfEmpty() runs only when school_accommodations is empty. It
//     applies the bell_schedules index fix and produces the full dataset
//     (staff, students, sections, roster, accommodations, locations,
//     bell schedules, settings).
// On a fresh production database this means publishing once and getting
// principals logged in without any manual SQL or curl steps.
// =============================================================================

const TEMP_PASSWORD = "PulseDemo!";

interface SchoolSpec {
  district: "hernando" | "pasco";
  name: string;
  shortName: string;
  stateSchoolCode: string;
  isPrimary: boolean;
  // SuperUser homed at this school (optional). If set, creates a SuperUser
  // login with the given email/password. Both SuperUsers can switch schools.
  superUser?: {
    email: string;
    displayName: string;
    password: string;
  };
  // Named (non-SuperUser) admin homed at this school. Optional.
  admin?: {
    email: string;
    displayName: string;
  };
}

const SCHOOL_SPECS: SchoolSpec[] = [
  {
    district: "hernando",
    name: "D. S. Parrott Middle School",
    shortName: "Parrott",
    stateSchoolCode: "0241",
    isPrimary: true,
    superUser: {
      email: "chris.clifford@hcsb.k12.fl.us",
      displayName: "Chris Clifford",
      password: "@Leopards",
    },
  },
  {
    district: "hernando",
    name: "F. W. Springstead High School",
    shortName: "Springstead",
    stateSchoolCode: "0181",
    isPrimary: false,
    superUser: {
      email: "brandon.wright@hcsb.k12.fl.us",
      displayName: "Brandon Wright",
      password: "@GoEagles",
    },
  },
  {
    district: "hernando",
    name: "Nature Coast Technical High School",
    shortName: "Nature Coast",
    stateSchoolCode: "0351",
    isPrimary: false,
    admin: { email: "brad.merschbach@hcsb.k12.fl.us", displayName: "Brad Merschbach" },
  },
  {
    district: "hernando",
    name: "Weeki Wachee High School",
    shortName: "Weeki Wachee",
    stateSchoolCode: "0391",
    isPrimary: false,
    admin: { email: "ed.larose@hcsb.k12.fl.us", displayName: "Ed LaRose" },
  },
  {
    district: "hernando",
    name: "Powell Middle School",
    shortName: "Powell",
    stateSchoolCode: "0221",
    isPrimary: false,
    admin: { email: "alex.rastatter@hcsb.k12.fl.us", displayName: "Alex Rastatter" },
  },
  {
    district: "hernando",
    name: "Test Middle School",
    shortName: "Test Middle",
    stateSchoolCode: "0999",
    isPrimary: false,
    admin: { email: "luke.skywalker@hcsb.k12.fl.us", displayName: "Luke Skywalker" },
  },
  {
    district: "pasco",
    name: "Cypress Creek Middle/High School",
    shortName: "Cypress Creek",
    stateSchoolCode: "0501",
    isPrimary: true,
  },
];

const DISTRICTS = [
  {
    slug: "hernando" as const,
    name: "Hernando County School District",
    stateDistrictCode: "27",
  },
  {
    slug: "pasco" as const,
    name: "Pasco County School District",
    stateDistrictCode: "51",
  },
];

// Per-school sizing. Conservative numbers that match the dev demo.
const TEACHERS_PER_SCHOOL = 55;
const STUDENTS_PER_SCHOOL = 1390;
const PERIODS = 7;

// Master accommodations list (no Strategy category — IEP / 504 / ELL only).
const MASTER_ACCS: { name: string; category: "IEP" | "504" | "ELL" }[] = [
  { name: "Extended Time", category: "IEP" },
  { name: "Small Group Testing", category: "IEP" },
  { name: "Read Aloud Directions", category: "IEP" },
  { name: "Frequent Breaks", category: "IEP" },
  { name: "Reduced Workload", category: "IEP" },
  { name: "Visual Schedule", category: "IEP" },
  { name: "Copies of Notes", category: "IEP" },
  { name: "Preferential Seating", category: "504" },
  { name: "Movement Breaks", category: "504" },
  { name: "Use of Fidgets", category: "504" },
  { name: "Extended Deadlines", category: "504" },
  { name: "Bilingual Dictionary", category: "ELL" },
  { name: "Native Language Clarification", category: "ELL" },
  { name: "Sentence Stems", category: "ELL" },
];

const STUDENT_FIRST = [
  "Ava","Liam","Sophia","Noah","Mia","Ethan","Olivia","Lucas","Isabella","Mason",
  "Charlotte","Logan","Amelia","Elijah","Harper","James","Evelyn","Benjamin","Abigail","Henry",
  "Emily","Alexander","Ella","Daniel","Scarlett","Matthew","Grace","Jack","Chloe","Sebastian",
  "Aria","Jackson","Lily","Aiden","Zoe","Owen","Layla","Levi","Hazel","Wyatt",
  "Aurora","Carter","Nora","Jayden","Riley","Julian","Stella","Asher","Hannah","Leo",
  "Violet","Caleb","Lucy","Mateo","Aaliyah","Isaiah","Ruby","Eli","Bella","Connor",
];

const STUDENT_LAST = [
  "Johnson","Martinez","Nguyen","Patel","Brown","Garcia","Smith","Davis","Lopez","Wilson",
  "Anderson","Thomas","Taylor","Moore","Jackson","White","Harris","Clark","Lewis","Walker",
  "Hall","Young","King","Wright","Scott","Green","Adams","Baker","Nelson","Carter",
  "Mitchell","Perez","Roberts","Turner","Phillips","Campbell","Parker","Evans","Edwards","Collins",
];

const TEACHER_FIRST = [
  "Sarah","Michael","Linda","James","Patricia","Robert","Jennifer","David","Maria","Daniel",
  "Karen","Mark","Lisa","Steven","Nancy","Paul","Susan","Kevin","Donna","Brian",
  "Carol","George","Sandra","Edward","Ashley","Anthony","Kimberly","Charles","Heather","Jason",
];

const TEACHER_LAST = [
  "Rivera","Johnson","Lee","Patel","Davis","Garcia","Smith","Brown","Wilson","Martinez",
  "Anderson","Thomas","Taylor","Moore","Jackson","White","Harris","Clark","Lewis","Walker",
  "Hall","Young","King","Wright","Scott","Green","Adams","Baker","Nelson","Carter",
];

// Deterministic RNG so the seed is reproducible across deploys.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

// -----------------------------------------------------------------------------
// seedTenancy: idempotent. Districts + schools.
// -----------------------------------------------------------------------------
export async function seedTenancy() {
  for (const d of DISTRICTS) {
    await db
      .insert(districtsTable)
      .values({
        name: d.name,
        slug: d.slug,
        stateDistrictCode: d.stateDistrictCode,
        timezone: "America/New_York",
      })
      .onConflictDoNothing({ target: districtsTable.slug });
  }

  // Resolve district IDs by slug.
  const districtRows = await db.select().from(districtsTable);
  const districtIdBySlug = new Map(districtRows.map((r) => [r.slug, r.id]));

  for (const s of SCHOOL_SPECS) {
    const districtId = districtIdBySlug.get(s.district);
    if (!districtId) continue;
    await db
      .insert(schoolsTable)
      .values({
        districtId,
        name: s.name,
        shortName: s.shortName,
        stateSchoolCode: s.stateSchoolCode,
        isPrimary: s.isPrimary,
      })
      .onConflictDoNothing();
  }
}

// -----------------------------------------------------------------------------
// seedMtssPlansIfEmpty: idempotent per-school. Adds an active MTSS plan to
// 20% of the students at any school that has zero plans yet. Runs at boot
// AFTER the main dataset is in place so the demo always has a realistic
// pool of Tier-2 students for the Invisible Student Finder to flag.
//
// Uses a deterministic RNG seeded by school id so re-runs produce the same
// 20% sample (until plans are added/deleted manually). Plans the seed
// inserts are explicitly attributed to "System Seed" so coordinators can
// distinguish them from real plans they've authored.
// -----------------------------------------------------------------------------
const MTSS_SEED_TITLES = [
  "Tier 2 Behavior Support",
  "Reading Intervention",
  "Math Intervention",
  "Attendance Plan",
  "Engagement / Check-in Plan",
  "Social-Emotional Support",
];

// Idempotent CREATE TABLE for student_mtss_plans. drizzle-kit push refuses
// to apply this non-interactively because it confuses the new table with
// legacy `user_sessions` / `check_in_with_options` rename targets, so we
// commit the DDL here so a fresh prod deploy still gets the table without
// any out-of-band SQL. Mirrors the always-run bell_schedules index fix in
// seedIfEmpty(). Safe to re-run: every statement uses IF NOT EXISTS.
export async function ensureMtssPlansSchema() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS student_mtss_plans (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      student_id TEXT NOT NULL,
      title TEXT NOT NULL,
      goals TEXT NOT NULL DEFAULT '',
      tier INTEGER NOT NULL DEFAULT 2,
      point_range_min INTEGER,
      point_range_max INTEGER,
      notes TEXT NOT NULL DEFAULT '',
      opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      opened_by_staff_id INTEGER,
      opened_by_name TEXT,
      closed_at TIMESTAMPTZ,
      closed_by_staff_id INTEGER,
      closed_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS student_mtss_plans_school_idx ON student_mtss_plans (school_id)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS student_mtss_plans_student_idx ON student_mtss_plans (school_id, student_id)`,
  );
}

export async function seedMtssPlansIfEmpty() {
  // Ensure the table exists first. On a fresh prod DB this is the only
  // place the DDL runs; in dev it's a no-op after the first boot.
  await ensureMtssPlansSchema();
  const schools = await db.select().from(schoolsTable);
  for (const school of schools) {
    const [{ c }] = (await db.execute(
      sql`SELECT COUNT(*)::int AS c FROM student_mtss_plans WHERE school_id = ${school.id}`,
    )).rows as { c: number }[];
    if (c > 0) continue;

    const studentRows = await db
      .select({ studentId: studentsTable.studentId })
      .from(studentsTable)
      .where(eq(studentsTable.schoolId, school.id));
    if (studentRows.length === 0) continue;

    // Deterministic shuffle, then take the first 20%.
    const rng = makeRng(school.id * 31 + 7);
    const ids = studentRows.map((s) => s.studentId);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const sampleSize = Math.floor(ids.length * 0.2);
    const sampled = ids.slice(0, sampleSize);

    const plans = sampled.map((studentId) => ({
      schoolId: school.id,
      studentId,
      title: pick(rng, MTSS_SEED_TITLES),
      goals:
        "Placeholder goals — to be filled in by the MTSS coordinator. v1 seed only.",
      tier: 2,
      pointRangeMin: 0,
      pointRangeMax: 100,
      notes: "Auto-seeded plan. Remove or edit before live use.",
      openedByName: "System Seed",
    }));

    if (plans.length === 0) continue;

    // Batch insert to avoid one-giant-statement issues at large schools.
    for (let i = 0; i < plans.length; i += 500) {
      await db.insert(studentMtssPlansTable).values(plans.slice(i, i + 500));
    }
    logger.info(
      { schoolId: school.id, count: plans.length },
      "[seed] MTSS plans seeded (20% of students)",
    );
  }
}

// -----------------------------------------------------------------------------
// seedIfEmpty: only runs when school_accommodations is empty (fresh DB).
// -----------------------------------------------------------------------------
export async function seedIfEmpty() {
  // ---- Schema fix: ALWAYS run, regardless of marker, so a prod DB
  // that already has the legacy `bell_schedules_one_default_idx`
  // from a pre-silo `db push` gets corrected on every boot. Both
  // statements are no-ops once the state is right; total cost is a
  // couple of catalog lookups.
  await db.execute(sql`DROP INDEX IF EXISTS bell_schedules_one_default_idx`);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS bell_schedules_school_default_idx
    ON bell_schedules (school_id) WHERE is_default = true
  `);

  // ---- Marker check that survives a partial / crashed prior seed.
  // Earlier versions used "is school_accommodations empty?" — that
  // flips to "non-empty" the moment school #1 finishes inserting,
  // so a crash on school #2 would permanently wedge the DB at one
  // school. Instead, count distinct school_ids in
  // school_accommodations: if every spec'd school is represented,
  // we're done; otherwise wipe and reseed.
  const [{ n }] = (await db.execute(
    sql`SELECT COUNT(DISTINCT school_id)::int AS n FROM school_accommodations`,
  )).rows as { n: number }[];
  if (n >= SCHOOL_SPECS.length) return; // Already fully seeded.

  logger.info(
    { distinctSchoolsWithAccs: n, expected: SCHOOL_SPECS.length },
    "[seed] Multi-school seed starting (this takes ~30s)...",
  );

  // ---- Wipe order: children before parents. Safe to call on empty tables.
  await db.delete(kioskActivationsTable);
  await db.delete(adminNotificationsTable);
  await db.delete(recordEditsTable);
  await db.delete(hallPassesTable);
  await db.delete(tardiesTable);
  await db.delete(pbisEntriesTable);
  await db.delete(supportNotesTable);
  await db.delete(accommodationLogsTable);
  await db.delete(studentAccommodationsTable);
  await db.delete(schoolAccommodationsTable);
  await db.delete(studentHallPassLimitsTable);
  await db.delete(pulloutsTable);
  await db.delete(issAttendanceDayTable);
  await db.delete(issRosterTable);
  await db.delete(interventionEntriesTable);
  await db.delete(sectionRosterTable);
  await db.delete(classSectionsTable);
  await db.delete(staffDefaultsTable);
  await db.delete(locationAllowedDestinationsTable);
  await db.delete(locationsTable);
  await db.delete(bellSchedulePeriodsTable);
  await db.delete(bellSchedulesTable);
  await db.delete(schoolSettingsTable);
  await db.delete(studentsTable);
  await db.delete(staffTable);

  // ---- Resolve school IDs (by shortName) into a map.
  const schoolRows = await db.select().from(schoolsTable);
  const schoolIdByShort = new Map(schoolRows.map((r) => [r.shortName, r.id]));

  const tempHash = await bcrypt.hash(TEMP_PASSWORD, 10);

  // Global teacher counter so generated emails are globally unique even when
  // two schools happen to draw the same first/last pair.
  let globalTeacherSeq = 0;

  // Insert per-school data in deterministic order.
  let totalStaff = 0;
  let totalStudents = 0;
  let totalSections = 0;
  let totalRoster = 0;
  let totalAccs = 0;

  for (const spec of SCHOOL_SPECS) {
    const schoolId = schoolIdByShort.get(spec.shortName);
    if (!schoolId) {
      logger.warn({ shortName: spec.shortName }, "[seed] missing school id, skipping");
      continue;
    }

    // School-scoped deterministic RNG so reseeds produce the same data.
    const rng = makeRng(0xc0ffee + schoolId * 7919);

    // ---- school_settings row (one per school).
    await db.insert(schoolSettingsTable).values({
      schoolId,
      schoolName: spec.shortName,
      fromName: spec.shortName,
      emailSignature: `Thank you,\n${spec.shortName}`,
      periodCount: PERIODS,
    });

    // ---- Staff: SuperUser (if any) + named admin (if any) + teachers.
    type StaffInsert = typeof staffTable.$inferInsert;
    const staffRows: StaffInsert[] = [];

    if (spec.superUser) {
      const suHash = await bcrypt.hash(spec.superUser.password, 10);
      staffRows.push({
        schoolId,
        email: spec.superUser.email,
        displayName: spec.superUser.displayName,
        passwordHash: suHash,
        isSuperUser: true,
        isAdmin: true,
      });
    }

    if (spec.admin) {
      staffRows.push({
        schoolId,
        email: spec.admin.email,
        displayName: spec.admin.displayName,
        passwordHash: tempHash,
        isAdmin: true,
      });
    }

    for (let t = 0; t < TEACHERS_PER_SCHOOL; t++) {
      const first = pick(rng, TEACHER_FIRST);
      const last = pick(rng, TEACHER_LAST);
      globalTeacherSeq += 1;
      const email = `${first.toLowerCase()}.${last.toLowerCase()}${globalTeacherSeq}@hcsb.k12.fl.us`;
      staffRows.push({
        schoolId,
        email,
        displayName: `${first} ${last}`,
        passwordHash: tempHash,
        isAdmin: false,
      });
    }

    const insertedStaff = await db
      .insert(staffTable)
      .values(staffRows)
      .returning();

    // Index of the first teacher in insertedStaff (after optional SU/admin).
    const teacherStart =
      (spec.superUser ? 1 : 0) + (spec.admin ? 1 : 0);
    const teacherIds = insertedStaff
      .slice(teacherStart)
      .map((s) => s.id);

    // ---- Students. Globally-unique student_id via "S{schoolId}-{n}".
    type StudentInsert = typeof studentsTable.$inferInsert;
    const studentRows: StudentInsert[] = [];
    for (let i = 0; i < STUDENTS_PER_SCHOOL; i++) {
      const first = pick(rng, STUDENT_FIRST);
      const last = pick(rng, STUDENT_LAST);
      studentRows.push({
        schoolId,
        studentId: `S${schoolId}-${i + 1}`,
        firstName: first,
        lastName: last,
        grade: 6 + Math.floor(rng() * 7), // 6..12
        parentName: `${pick(rng, STUDENT_FIRST)} ${last}`,
        parentEmail: `${first.toLowerCase()}.${last.toLowerCase()}.parent${i + 1}@example.com`,
        parentPhone: null,
      });
    }
    const insertedStudents = await chunkedInsertReturning(
      studentsTable,
      studentRows,
      500,
    );

    // ---- Sections: 7 periods per teacher (one is planning).
    type SectionInsert = typeof classSectionsTable.$inferInsert;
    const sectionRows: SectionInsert[] = [];
    const planningByTeacher: number[] = []; // teacherIndex -> planningPeriod
    for (let t = 0; t < teacherIds.length; t++) {
      const planning = 1 + (t % PERIODS);
      planningByTeacher.push(planning);
      for (let p = 1; p <= PERIODS; p++) {
        sectionRows.push({
          schoolId,
          teacherStaffId: teacherIds[t],
          period: p,
          courseName: p === planning ? `Planning P${p}` : `Section P${p}`,
          isPlanning: p === planning,
        });
      }
    }
    const insertedSections = await chunkedInsertReturning(
      classSectionsTable,
      sectionRows,
      500,
    );

    const sectionLookup = new Map<string, number>();
    for (const s of insertedSections) {
      sectionLookup.set(`${s.teacherStaffId}:${s.period}`, s.id);
    }

    // ---- Roster: every student in every period, distributed across teachers.
    type RosterInsert = typeof sectionRosterTable.$inferInsert;
    const rosterRows: RosterInsert[] = [];
    for (let i = 0; i < insertedStudents.length; i++) {
      const stu = insertedStudents[i];
      for (let p = 1; p <= PERIODS; p++) {
        // Pick a teacher whose planning period is NOT p, deterministically.
        let attempt = 0;
        let tIdx = (i + p * 13 + attempt) % teacherIds.length;
        while (planningByTeacher[tIdx] === p && attempt < teacherIds.length) {
          attempt += 1;
          tIdx = (i + p * 13 + attempt) % teacherIds.length;
        }
        if (planningByTeacher[tIdx] === p) continue; // unreachable in practice
        const sectionId = sectionLookup.get(`${teacherIds[tIdx]}:${p}`);
        if (sectionId) {
          rosterRows.push({
            schoolId,
            sectionId,
            studentId: stu.studentId,
          });
        }
      }
    }
    await chunkedInsert(sectionRosterTable, rosterRows, 1000);

    // ---- Master accommodations.
    const insertedAccs = await db
      .insert(schoolAccommodationsTable)
      .values(
        MASTER_ACCS.map((a) => ({
          schoolId,
          name: a.name,
          category: a.category,
          active: true,
        })),
      )
      .returning();

    const iepIds = insertedAccs
      .filter((_, i) => MASTER_ACCS[i].category === "IEP")
      .map((a) => a.id);
    const sec504Ids = insertedAccs
      .filter((_, i) => MASTER_ACCS[i].category === "504")
      .map((a) => a.id);
    const ellIds = insertedAccs
      .filter((_, i) => MASTER_ACCS[i].category === "ELL")
      .map((a) => a.id);

    // Pick the staff row to attribute accommodation assignments to. Prefer
    // the named admin, then the SuperUser, then the first teacher.
    const assignedById =
      (spec.admin && insertedStaff.find((s) => s.email === spec.admin!.email)?.id) ||
      (spec.superUser && insertedStaff.find((s) => s.email === spec.superUser!.email)?.id) ||
      teacherIds[0];

    // ---- Per-student accommodations: 25% of students get a base of
    // 2-4 IEP-OR-504 accs; 30% chance to also get 1-2 ELL on top, capped at 4.
    type AssignInsert = typeof studentAccommodationsTable.$inferInsert;
    const assignRows: AssignInsert[] = [];
    for (const stu of insertedStudents) {
      if (rng() >= 0.25) continue;
      const useIep = rng() < 0.5;
      const basePool = useIep ? iepIds : sec504Ids;
      const baseCount = 2 + Math.floor(rng() * 3); // 2..4
      const chosen = shuffle(rng, basePool).slice(0, baseCount);
      if (rng() < 0.3) {
        const ellCount = 1 + Math.floor(rng() * 2);
        const ellChosen = shuffle(rng, ellIds).slice(0, ellCount);
        for (const e of ellChosen) {
          if (chosen.length >= 4) break;
          chosen.push(e);
        }
      }
      for (const accId of chosen) {
        assignRows.push({
          schoolId,
          studentId: stu.studentId,
          accommodationId: accId,
          assignedByStaffId: assignedById,
        });
      }
    }
    await chunkedInsert(studentAccommodationsTable, assignRows, 1000);

    // ---- Locations (school-scoped names so they are globally unique).
    const baseLocs = [
      { name: "Room 101", kind: "classroom", isOrigin: true, isDestination: false },
      { name: "Room 102", kind: "classroom", isOrigin: true, isDestination: false },
      { name: "Room 201", kind: "classroom", isOrigin: true, isDestination: false },
      { name: "Room 202", kind: "classroom", isOrigin: true, isDestination: false },
      { name: "Room 204", kind: "classroom", isOrigin: true, isDestination: false },
      { name: "Room 305", kind: "classroom", isOrigin: true, isDestination: false },
      { name: "Gym", kind: "common_area", isOrigin: true, isDestination: false },
      { name: "Cafeteria", kind: "common_area", isOrigin: true, isDestination: true },
      { name: "Library", kind: "common_area", isOrigin: false, isDestination: true },
      { name: "Media Center", kind: "common_area", isOrigin: false, isDestination: true },
      { name: "Boys Restroom", kind: "restroom", isOrigin: false, isDestination: true, studentVisible: true },
      { name: "Girls Restroom", kind: "restroom", isOrigin: false, isDestination: true, studentVisible: true },
      { name: "Nurse", kind: "office", isOrigin: false, isDestination: true, studentVisible: true },
      { name: "Front Office", kind: "office", isOrigin: false, isDestination: true, studentVisible: true },
      { name: "Guidance", kind: "office", isOrigin: false, isDestination: true, studentVisible: true },
    ];
    const insertedLocs = await db
      .insert(locationsTable)
      .values(baseLocs.map((l) => ({ schoolId, ...l, name: `${spec.shortName} ${l.name}` })))
      .returning();

    const ladRows: {
      schoolId: number;
      originLocationId: number;
      destinationLocationId: number;
    }[] = [];
    for (const o of insertedLocs.filter((l) => l.isOrigin)) {
      for (const d of insertedLocs.filter((l) => l.isDestination)) {
        ladRows.push({
          schoolId,
          originLocationId: o.id,
          destinationLocationId: d.id,
        });
      }
    }
    if (ladRows.length > 0) {
      await db.insert(locationAllowedDestinationsTable).values(ladRows);
    }

    // ---- Bell schedule: 7 periods, 7:30am-2:00pm with lunch between P5/P6.
    const [insertedBell] = await db
      .insert(bellSchedulesTable)
      .values({
        schoolId,
        name: "Regular Day",
        kind: "regular",
        isDefault: true,
        active: true,
        sortOrder: 0,
      })
      .returning();

    const periodWindows: { name: string; start: string; end: string }[] = [
      { name: "Period 1", start: "07:30", end: "08:25" },
      { name: "Period 2", start: "08:30", end: "09:25" },
      { name: "Period 3", start: "09:30", end: "10:25" },
      { name: "Period 4", start: "10:30", end: "11:25" },
      { name: "Period 5", start: "11:30", end: "12:00" },
      // Lunch 12:00-12:35 (no period row needed)
      { name: "Period 6", start: "12:35", end: "13:25" },
      { name: "Period 7", start: "13:30", end: "14:00" },
    ];
    await db.insert(bellSchedulePeriodsTable).values(
      periodWindows.map((w, idx) => ({
        scheduleId: insertedBell.id,
        periodNumber: idx + 1,
        name: w.name,
        startTime: w.start,
        endTime: w.end,
      })),
    );

    totalStaff += insertedStaff.length;
    totalStudents += insertedStudents.length;
    totalSections += insertedSections.length;
    totalRoster += rosterRows.length;
    totalAccs += assignRows.length;

    logger.info(
      {
        school: spec.shortName,
        staff: insertedStaff.length,
        students: insertedStudents.length,
        sections: insertedSections.length,
        roster: rosterRows.length,
        accAssignments: assignRows.length,
      },
      "[seed] school complete",
    );
  }

  // Reset key sequences so future inserts don't collide.
  await db.execute(
    sql`SELECT setval(pg_get_serial_sequence('students','id'), (SELECT COALESCE(MAX(id),1) FROM students))`,
  );
  await db.execute(
    sql`SELECT setval(pg_get_serial_sequence('staff','id'), (SELECT COALESCE(MAX(id),1) FROM staff))`,
  );

  logger.info(
    {
      schools: SCHOOL_SPECS.length,
      staff: totalStaff,
      students: totalStudents,
      sections: totalSections,
      roster: totalRoster,
      accAssignments: totalAccs,
    },
    "[seed] Multi-school seed complete",
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function shuffle<T>(rng: () => number, arr: T[]): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function chunkedInsert<T extends { _: { name: string } }>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: any[],
  size: number,
): Promise<void> {
  void table;
  for (let i = 0; i < rows.length; i += size) {
    const slice = rows.slice(i, i + size);
    if (slice.length === 0) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.insert(table as any).values(slice);
  }
}

async function chunkedInsertReturning<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: any[],
  size: number,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < rows.length; i += size) {
    const slice = rows.slice(i, i + size);
    if (slice.length === 0) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inserted = await db.insert(table as any).values(slice).returning();
    out.push(...(inserted as T[]));
  }
  return out;
}
