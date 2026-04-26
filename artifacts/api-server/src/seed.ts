import {
  db,
  districtsTable,
  schoolsTable,
  hallPassesTable,
  tardiesTable,
  pbisEntriesTable,
  pbisReasonsTable,
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
  studentFastScoresTable,
  housesTable,
  assessmentsTable,
  importJobsTable,
} from "@workspace/db";
import bcrypt from "bcryptjs";
import { eq, sql, and, inArray } from "drizzle-orm";
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
// HOUSES: PBIS team affiliations (Falcon, Phoenix, Stag, Wolf). Idempotent
// CREATE TABLE IF NOT EXISTS at boot mirrors the MTSS / FAST-scores pattern
// because drizzle-kit push refuses to apply this non-interactively (it
// confuses the new table with legacy `user_sessions` / `check_in_with_options`
// rename targets). Safe to re-run on every boot.
// -----------------------------------------------------------------------------
const HOUSE_DEFAULTS = [
  { name: "Falcon",  color: "#3b82f6", motto: "Sharp eyes. Steady wings." },
  { name: "Phoenix", color: "#ef4444", motto: "Rise every day."           },
  { name: "Stag",    color: "#10b981", motto: "Stand tall. Stand together." },
  { name: "Wolf",    color: "#8b5cf6", motto: "One pack."                  },
];

export async function ensureHousesSchema() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS houses (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      motto TEXT,
      created_at TEXT NOT NULL
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS houses_school_idx ON houses (school_id)`,
  );
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS houses_school_name_unique ON houses (school_id, name)`,
  );
  // students.house_id is added separately because it's an ALTER on an
  // existing table. IF NOT EXISTS keeps re-runs harmless.
  await db.execute(
    sql`ALTER TABLE students ADD COLUMN IF NOT EXISTS house_id INTEGER`,
  );
}

export async function seedHousesIfEmpty() {
  await ensureHousesSchema();
  const schools = await db.select().from(schoolsTable);
  for (const school of schools) {
    // 1. Houses for this school (idempotent).
    const existing = await db
      .select()
      .from(housesTable)
      .where(eq(housesTable.schoolId, school.id));
    let houseRows = existing;
    if (houseRows.length === 0) {
      const created = await db
        .insert(housesTable)
        .values(
          HOUSE_DEFAULTS.map((h) => ({
            schoolId: school.id,
            name: h.name,
            color: h.color,
            motto: h.motto,
            createdAt: new Date().toISOString(),
          })),
        )
        .returning();
      houseRows = created;
      logger.info(
        { schoolId: school.id, count: created.length },
        "[seed] houses seeded",
      );
    }

    // 2. Round-robin assign students that don't yet have a house.
    if (houseRows.length === 0) continue;
    const unassigned = await db
      .select({ id: studentsTable.id })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, school.id),
          sql`${studentsTable.houseId} IS NULL`,
        ),
      );
    if (unassigned.length === 0) continue;

    // Group student ids by target house, then UPDATE in batches per house.
    const buckets: Record<number, number[]> = {};
    unassigned.forEach((s, i) => {
      const houseId = houseRows[i % houseRows.length].id;
      if (!buckets[houseId]) buckets[houseId] = [];
      buckets[houseId].push(s.id);
    });
    for (const [houseIdStr, ids] of Object.entries(buckets)) {
      const houseId = Number(houseIdStr);
      // chunk to keep the IN-list reasonable
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        await db
          .update(studentsTable)
          .set({ houseId })
          .where(inArray(studentsTable.id, chunk));
      }
    }
    logger.info(
      { schoolId: school.id, assigned: unassigned.length },
      "[seed] students assigned to houses (round-robin)",
    );
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
// FAST scores seeding — placeholder PM1/PM2/PM3 + prior-year score per
// student per subject (ELA + Math). Real ingestion will come via the
// Settings → CSV import (planned). v1 just makes the Teacher Roster
// page render with realistic-looking data.
//
// Same pattern as MTSS plans: idempotent CREATE TABLE IF NOT EXISTS at
// boot, then a per-school skip-if-non-empty seed.
// -----------------------------------------------------------------------------
// Per-school feature flags (two-tier billing/admin model). These columns
// were added after school_settings was already in production, so they're
// applied via ALTER TABLE … ADD COLUMN IF NOT EXISTS at boot. Defaults
// are TRUE so every existing school keeps every feature live until
// somebody explicitly turns one off.
export async function ensureSchoolSettingsFeatureFlagsSchema() {
  const cols = [
    "feature_family_comm",
    "feature_pbis",
    "feature_school_store",
    "feature_accommodations",
    "feature_log_intervention",
    "feature_request_pullout",
    "super_feature_family_comm",
    "super_feature_pbis",
    "super_feature_school_store",
    "super_feature_accommodations",
    "super_feature_log_intervention",
    "super_feature_request_pullout",
  ];
  for (const col of cols) {
    await db.execute(
      sql.raw(
        `ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS ${col} BOOLEAN NOT NULL DEFAULT TRUE`,
      ),
    );
  }
}

export async function ensureFastScoresSchema() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS student_fast_scores (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      student_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      pm1 INTEGER,
      pm2 INTEGER,
      pm3 INTEGER,
      prior_year_score INTEGER,
      prior_year_bq BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS student_fast_scores_school_idx ON student_fast_scores (school_id)`,
  );
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS student_fast_scores_student_subject_unique ON student_fast_scores (school_id, student_id, subject)`,
  );
}

// Per-grade plausible score range for seeding. Values are the absolute
// chart floor (L1 Low min) and ceiling (L5 max) for ELA and Math grades
// 3–10. We pick a "true level" 1..5 with weighted distribution, then
// generate scores within that level's band so PM placements look
// realistic. PM2 and PM3 drift slightly upward from PM1 to mimic
// learning gains over the year.
const ELA_BANDS: Record<
  number,
  { L1: [number, number]; L2: [number, number]; L3: [number, number]; L4: [number, number]; L5: [number, number] }
> = {
  3: { L1: [140, 185], L2: [186, 200], L3: [201, 212], L4: [213, 224], L5: [225, 260] },
  4: { L1: [154, 198], L2: [199, 212], L3: [213, 223], L4: [224, 236], L5: [237, 270] },
  5: { L1: [160, 205], L2: [206, 221], L3: [222, 231], L4: [232, 245], L5: [246, 279] },
  6: { L1: [161, 208], L2: [209, 224], L3: [225, 236], L4: [237, 249], L5: [250, 284] },
  7: { L1: [165, 214], L2: [215, 231], L3: [232, 241], L4: [242, 256], L5: [257, 292] },
  8: { L1: [169, 219], L2: [220, 237], L3: [238, 250], L4: [251, 261], L5: [262, 300] },
  9: { L1: [174, 223], L2: [224, 241], L3: [242, 253], L4: [254, 266], L5: [267, 303] },
  10: { L1: [179, 229], L2: [230, 246], L3: [247, 257], L4: [258, 270], L5: [271, 308] },
};
const MATH_BANDS: Record<
  number,
  { L1: [number, number]; L2: [number, number]; L3: [number, number]; L4: [number, number]; L5: [number, number] }
> = {
  3: { L1: [140, 182], L2: [183, 197], L3: [198, 208], L4: [209, 224], L5: [225, 260] },
  4: { L1: [155, 199], L2: [200, 210], L3: [211, 220], L4: [221, 237], L5: [238, 273] },
  5: { L1: [158, 206], L2: [207, 221], L3: [222, 233], L4: [234, 245], L5: [246, 285] },
  6: { L1: [168, 212], L2: [213, 228], L3: [229, 238], L4: [239, 253], L5: [254, 287] },
  7: { L1: [175, 222], L2: [223, 234], L3: [235, 246], L4: [247, 257], L5: [258, 288] },
  // L1 spans full L1Low+L1Mid+L1High (chart MATH[8] L1High ends at 226).
  // Earlier rev had L1: [183, 222] which left a 223-226 hole.
  8: { L1: [183, 226], L2: [227, 243], L3: [244, 253], L4: [254, 262], L5: [263, 291] },
};

// Weighted level pick — middle-skewed (most students cluster around L2/L3).
function pickLevel(rng: () => number): 1 | 2 | 3 | 4 | 5 {
  const r = rng();
  if (r < 0.2) return 1;
  if (r < 0.55) return 2;
  if (r < 0.8) return 3;
  if (r < 0.95) return 4;
  return 5;
}

function randInRange(rng: () => number, lo: number, hi: number): number {
  return Math.round(lo + rng() * (hi - lo));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export async function seedFastScoresIfEmpty() {
  await ensureFastScoresSchema();
  await ensureSchoolSettingsFeatureFlagsSchema();
  const schools = await db.select().from(schoolsTable);
  for (const school of schools) {
    const [{ c }] = (await db.execute(
      sql`SELECT COUNT(*)::int AS c FROM student_fast_scores WHERE school_id = ${school.id}`,
    )).rows as { c: number }[];
    if (c > 0) continue;

    const studentRows = await db
      .select({ studentId: studentsTable.studentId, grade: studentsTable.grade })
      .from(studentsTable)
      .where(eq(studentsTable.schoolId, school.id));
    if (studentRows.length === 0) continue;

    const rng = makeRng(0xfa57 + school.id * 1009);
    const inserts: (typeof studentFastScoresTable.$inferInsert)[] = [];

    for (const stu of studentRows) {
      const grade = Number(stu.grade);
      if (!Number.isInteger(grade) || grade < 3 || grade > 10) continue;

      for (const subject of ["ela", "math"] as const) {
        const bands = subject === "ela" ? ELA_BANDS : MATH_BANDS;
        const band = bands[grade];
        if (!band) continue; // Math only goes G3-G8 for now

        const trueLevel = pickLevel(rng);
        const range = band[`L${trueLevel}` as `L${1 | 2 | 3 | 4 | 5}`];
        const fullLo = band.L1[0];
        const fullHi = band.L5[1];

        // PM1: in band, with mild noise
        const pm1Base = randInRange(rng, range[0], range[1]);
        // PM2: PM1 + small positive drift (-3..+10)
        const pm2Base = pm1Base + randInRange(rng, -3, 10);
        // PM3: PM2 + small positive drift (-2..+12)
        const pm3Base = pm2Base + randInRange(rng, -2, 12);
        const pm1 = clamp(pm1Base, fullLo, fullHi);
        const pm2 = clamp(pm2Base, fullLo, fullHi);
        const pm3 = clamp(pm3Base, fullLo, fullHi);

        // Prior-year final: pick on the prior-grade chart if available;
        // otherwise reuse the current grade band (3rd graders).
        const priorGrade = grade - 1;
        const priorBand = bands[priorGrade] ?? bands[grade];
        const priorRange =
          priorBand[`L${trueLevel}` as `L${1 | 2 | 3 | 4 | 5}`];
        const priorYearScore = randInRange(rng, priorRange[0], priorRange[1]);
        // BQ ~ 25% overall: heavily skew to L1/L2 (low achievers).
        let bqProb = 0.05;
        if (trueLevel === 1) bqProb = 0.85;
        else if (trueLevel === 2) bqProb = 0.45;
        const priorYearBq = rng() < bqProb;

        inserts.push({
          schoolId: school.id,
          studentId: stu.studentId,
          subject,
          pm1,
          pm2,
          pm3,
          priorYearScore,
          priorYearBq,
        });
      }
    }

    if (inserts.length === 0) continue;
    for (let i = 0; i < inserts.length; i += 500) {
      await db.insert(studentFastScoresTable).values(inserts.slice(i, i + 500));
    }
    logger.info(
      { schoolId: school.id, count: inserts.length },
      "[seed] FAST scores seeded (placeholder PM1/PM2/PM3 + prior year)",
    );
  }
}

// =============================================================================
// iReady AP1/AP2/AP3 + SCI Benchmark 1/2/3 placeholder seeding
// =============================================================================
// Both land in the long-format `assessments` table (one row per
// student/assessment_name/date). This is the same table the generic CSV
// importer writes to, so the dashboard treats seeded data exactly like
// uploaded data — including History → Imports listing the synthetic
// import_jobs row, and rollback (DELETE WHERE import_job_id = X) wiping
// the seed cleanly.
//
// Coverage:
//   * iReady Reading + Math AP1/AP2/AP3 — grades K–8 only (HS doesn't
//     use iReady in either Hernando or Pasco).
//   * SCI Benchmark 1/2/3              — grades 6–12 (district science
//     benchmark; ES doesn't run it).
//
// Idempotency:
//   Per-school + per-source skip — if the school already has any rows
//   for `source = 'iReady'` we skip the iReady block; same for
//   'District SCI'. Re-running on boot is therefore a near-noop.
// =============================================================================

// Per-grade plausible iReady scaled-score band (level 1 floor through
// level 5 ceiling). Modelled on iReady placement-level cut points; not
// exact vendor cuts but plausible enough for a demo dataset and
// monotonic across grades. Grade 0 = Kindergarten.
const IREADY_READING_BANDS: Record<
  number,
  { L1: [number, number]; L2: [number, number]; L3: [number, number]; L4: [number, number]; L5: [number, number] }
> = {
  0: { L1: [100, 329], L2: [330, 360], L3: [361, 400], L4: [401, 440], L5: [441, 500] },
  1: { L1: [200, 388], L2: [389, 418], L3: [419, 452], L4: [453, 490], L5: [491, 540] },
  2: { L1: [250, 425], L2: [426, 456], L3: [457, 488], L4: [489, 520], L5: [521, 570] },
  3: { L1: [300, 455], L2: [456, 488], L3: [489, 520], L4: [521, 560], L5: [561, 610] },
  4: { L1: [350, 485], L2: [486, 517], L3: [518, 540], L4: [541, 580], L5: [581, 640] },
  5: { L1: [380, 510], L2: [511, 541], L3: [542, 565], L4: [566, 605], L5: [606, 665] },
  6: { L1: [400, 530], L2: [531, 559], L3: [560, 580], L4: [581, 615], L5: [616, 690] },
  7: { L1: [420, 548], L2: [549, 580], L3: [581, 600], L4: [601, 635], L5: [636, 710] },
  8: { L1: [440, 565], L2: [566, 595], L3: [596, 615], L4: [616, 650], L5: [651, 730] },
};
const IREADY_MATH_BANDS: Record<
  number,
  { L1: [number, number]; L2: [number, number]; L3: [number, number]; L4: [number, number]; L5: [number, number] }
> = {
  0: { L1: [100, 330], L2: [331, 359], L3: [360, 395], L4: [396, 425], L5: [426, 475] },
  1: { L1: [200, 388], L2: [389, 418], L3: [419, 447], L4: [448, 485], L5: [486, 535] },
  2: { L1: [250, 425], L2: [426, 453], L3: [454, 485], L4: [486, 520], L5: [521, 565] },
  3: { L1: [300, 455], L2: [456, 484], L3: [485, 510], L4: [511, 545], L5: [546, 595] },
  4: { L1: [350, 478], L2: [479, 506], L3: [507, 530], L4: [531, 562], L5: [563, 610] },
  5: { L1: [380, 495], L2: [496, 524], L3: [525, 547], L4: [548, 575], L5: [576, 625] },
  6: { L1: [400, 515], L2: [516, 544], L3: [545, 565], L4: [566, 595], L5: [596, 650] },
  7: { L1: [420, 528], L2: [529, 557], L3: [558, 580], L4: [581, 610], L5: [611, 665] },
  8: { L1: [440, 538], L2: [539, 567], L3: [568, 590], L4: [591, 620], L5: [621, 680] },
};
const IREADY_LEVEL_LABELS: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "Two+ Grade Levels Below",
  2: "One Grade Level Below",
  3: "Early On Grade Level",
  4: "Mid On Grade Level",
  5: "Above Grade Level",
};

// SCI Benchmark scoring is percent correct (0–100). FL achievement-level
// rubric used at the district level; identical band shape across G6–12.
const SCI_BANDS = {
  L1: [25, 49] as [number, number],
  L2: [50, 59] as [number, number],
  L3: [60, 69] as [number, number],
  L4: [70, 84] as [number, number],
  L5: [85, 100] as [number, number],
};
const SCI_LEVEL_LABELS: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "Below",
  2: "Approaching",
  3: "On Track",
  4: "Mastery",
  5: "Above",
};

// 2025–2026 administration windows (matches today = April 2026 so AP3 /
// Benchmark 3 reads as a recently-completed event in the UI).
const AP1_DATE = new Date("2025-10-15T14:00:00Z");
const AP2_DATE = new Date("2026-01-20T14:00:00Z");
const AP3_DATE = new Date("2026-04-10T14:00:00Z");

// Parse a roster grade string into a number. Numeric strings ("0".."12")
// pass straight through; "K" / "KG" / "Kindergarten" map to 0; anything
// else (Pre-K, "TK", malformed) returns null and the caller skips.
function parseGrade(g: string | null | undefined): number | null {
  if (g == null) return null;
  const trimmed = String(g).trim().toUpperCase();
  if (trimmed === "K" || trimmed === "KG" || trimmed === "KINDERGARTEN") {
    return 0;
  }
  const n = Number(trimmed);
  return Number.isInteger(n) ? n : null;
}

// Derive the placement-level (1..5) a score falls into using an
// already-known per-grade band table.
function levelForBand(
  score: number,
  band: { L1: [number, number]; L2: [number, number]; L3: [number, number]; L4: [number, number]; L5: [number, number] },
): 1 | 2 | 3 | 4 | 5 {
  if (score <= band.L1[1]) return 1;
  if (score <= band.L2[1]) return 2;
  if (score <= band.L3[1]) return 3;
  if (score <= band.L4[1]) return 4;
  return 5;
}

export async function seedIreadyAndSciIfEmpty() {
  const schools = await db.select().from(schoolsTable);
  for (const school of schools) {
    const studentRows = await db
      .select({
        studentId: studentsTable.studentId,
        grade: studentsTable.grade,
      })
      .from(studentsTable)
      .where(eq(studentsTable.schoolId, school.id));
    if (studentRows.length === 0) continue;

    // Synthetic import_jobs.uploaded_by — not a hard FK so any positive
    // staff id is fine. We pick the first staff in the school so the
    // History UI can still render a sensible "uploaded by" name.
    const [firstStaff] = await db
      .select({ id: staffTable.id })
      .from(staffTable)
      .where(eq(staffTable.schoolId, school.id))
      .limit(1);
    if (!firstStaff) continue;

    // ---- iReady AP1/AP2/AP3 (Reading + Math), grades K–8 -------------
    const [{ c: iReadyExisting }] = (
      await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM assessments WHERE school_id = ${school.id} AND source = 'iReady'`,
      )
    ).rows as { c: number }[];

    if (iReadyExisting === 0) {
      const k8Students = studentRows.filter((s) => {
        const g = parseGrade(s.grade);
        return g !== null && g >= 0 && g <= 8;
      });

      if (k8Students.length > 0) {
        // Build all rows first (CPU-only, no I/O), then commit the
        // import_jobs row + every assessment row + the counter patch
        // inside a single transaction. If anything fails the txn
        // rolls back and the source-count guard above still reads
        // zero on the next boot — we re-attempt from scratch instead
        // of being permanently wedged with a partial dataset.
        const rng = makeRng(0x1ead7 + school.id * 1031);
        const inserts: (typeof assessmentsTable.$inferInsert)[] = [];

        for (const stu of k8Students) {
          const grade = parseGrade(stu.grade);
          if (grade === null) continue;
          for (const subject of ["Reading", "Math"] as const) {
            const bands =
              subject === "Reading" ? IREADY_READING_BANDS : IREADY_MATH_BANDS;
            const band = bands[grade];
            if (!band) continue;

            const trueLevel = pickLevel(rng);
            const range = band[`L${trueLevel}` as `L${1 | 2 | 3 | 4 | 5}`];
            const fullLo = band.L1[0];
            const fullHi = band.L5[1];

            const ap1 = clamp(
              randInRange(rng, range[0], range[1]),
              fullLo,
              fullHi,
            );
            const ap2 = clamp(ap1 + randInRange(rng, -3, 12), fullLo, fullHi);
            const ap3 = clamp(ap2 + randInRange(rng, -2, 14), fullLo, fullHi);

            // importJobId is set inside the txn once we know the id.
            // Use 0 as a placeholder; we patch each row's importJobId
            // before insert.
            inserts.push(
              {
                schoolId: school.id,
                studentId: stu.studentId,
                assessmentName: `iReady ${subject} AP1`,
                score: ap1,
                scoreLevel: IREADY_LEVEL_LABELS[levelForBand(ap1, band)],
                administeredAt: AP1_DATE,
                source: "iReady",
                importJobId: 0,
              },
              {
                schoolId: school.id,
                studentId: stu.studentId,
                assessmentName: `iReady ${subject} AP2`,
                score: ap2,
                scoreLevel: IREADY_LEVEL_LABELS[levelForBand(ap2, band)],
                administeredAt: AP2_DATE,
                source: "iReady",
                importJobId: 0,
              },
              {
                schoolId: school.id,
                studentId: stu.studentId,
                assessmentName: `iReady ${subject} AP3`,
                score: ap3,
                scoreLevel: IREADY_LEVEL_LABELS[levelForBand(ap3, band)],
                administeredAt: AP3_DATE,
                source: "iReady",
                importJobId: 0,
              },
            );
          }
        }

        if (inserts.length > 0) {
          await db.transaction(async (tx) => {
            const now = new Date();
            const [job] = await tx
              .insert(importJobsTable)
              .values({
                schoolId: school.id,
                districtId: null,
                kind: "assessments",
                filename: "[seed] iReady AP1-AP3 placeholder.csv",
                objectPath: null,
                uploadedBy: firstStaff.id,
                // Land already-committed: counters are correct because
                // we set them in this same txn just below.
                status: "committed",
                totalRows: inserts.length,
                successRows: inserts.length,
                errorRows: 0,
                errorLog: [],
                // Tag so support / History can tell this row came from
                // the boot seeder versus a real CSV upload.
                mapping: { _seed: "true", _source: "iReady" },
                committedAt: now,
              })
              .returning({ id: importJobsTable.id });

            for (const row of inserts) row.importJobId = job.id;
            for (let i = 0; i < inserts.length; i += 500) {
              await tx
                .insert(assessmentsTable)
                .values(inserts.slice(i, i + 500));
            }
          });
          logger.info(
            { schoolId: school.id, count: inserts.length },
            "[seed] iReady AP1-AP3 seeded (K-8 placeholder)",
          );
        }
      }
    }

    // ---- SCI Benchmark 1/2/3, grades 6–12 ----------------------------
    const [{ c: sciExisting }] = (
      await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM assessments WHERE school_id = ${school.id} AND source = 'District SCI'`,
      )
    ).rows as { c: number }[];

    if (sciExisting === 0) {
      const sciStudents = studentRows.filter((s) => {
        const g = parseGrade(s.grade);
        return g !== null && g >= 6 && g <= 12;
      });

      if (sciStudents.length > 0) {
        const rng = makeRng(0x5c1be4 + school.id * 1033);
        const inserts: (typeof assessmentsTable.$inferInsert)[] = [];

        for (const stu of sciStudents) {
          const trueLevel = pickLevel(rng);
          const range = SCI_BANDS[`L${trueLevel}` as `L${1 | 2 | 3 | 4 | 5}`];
          const fullLo = SCI_BANDS.L1[0];
          const fullHi = SCI_BANDS.L5[1];

          const b1 = clamp(
            randInRange(rng, range[0], range[1]),
            fullLo,
            fullHi,
          );
          const b2 = clamp(b1 + randInRange(rng, -4, 8), fullLo, fullHi);
          const b3 = clamp(b2 + randInRange(rng, -2, 10), fullLo, fullHi);

          inserts.push(
            {
              schoolId: school.id,
              studentId: stu.studentId,
              assessmentName: "SCI Benchmark 1",
              score: b1,
              scoreLevel: SCI_LEVEL_LABELS[levelForBand(b1, SCI_BANDS)],
              administeredAt: AP1_DATE,
              source: "District SCI",
              importJobId: 0,
            },
            {
              schoolId: school.id,
              studentId: stu.studentId,
              assessmentName: "SCI Benchmark 2",
              score: b2,
              scoreLevel: SCI_LEVEL_LABELS[levelForBand(b2, SCI_BANDS)],
              administeredAt: AP2_DATE,
              source: "District SCI",
              importJobId: 0,
            },
            {
              schoolId: school.id,
              studentId: stu.studentId,
              assessmentName: "SCI Benchmark 3",
              score: b3,
              scoreLevel: SCI_LEVEL_LABELS[levelForBand(b3, SCI_BANDS)],
              administeredAt: AP3_DATE,
              source: "District SCI",
              importJobId: 0,
            },
          );
        }

        if (inserts.length > 0) {
          await db.transaction(async (tx) => {
            const now = new Date();
            const [job] = await tx
              .insert(importJobsTable)
              .values({
                schoolId: school.id,
                districtId: null,
                kind: "assessments",
                filename: "[seed] SCI Benchmark 1-3 placeholder.csv",
                objectPath: null,
                uploadedBy: firstStaff.id,
                status: "committed",
                totalRows: inserts.length,
                successRows: inserts.length,
                errorRows: 0,
                errorLog: [],
                mapping: { _seed: "true", _source: "District SCI" },
                committedAt: now,
              })
              .returning({ id: importJobsTable.id });

            for (const row of inserts) row.importJobId = job.id;
            for (let i = 0; i < inserts.length; i += 500) {
              await tx
                .insert(assessmentsTable)
                .values(inserts.slice(i, i + 500));
            }
          });
          logger.info(
            { schoolId: school.id, count: inserts.length },
            "[seed] SCI Benchmark 1-3 seeded (G6-12 placeholder)",
          );
        }
      }
    }
  }
}

// -----------------------------------------------------------------------------
// seedEngagementEventsIfEmpty: populate hall_passes / tardies / iss /
// pullouts with realistic-looking demo events spread over the last 60 days,
// so the new Engagement dashboard renders something on first launch instead
// of a sea of zeros. These tables don't have a `source` column to mark seed
// rows, so the skip guard is strictly "table is empty for this school" — any
// existing row (real or seeded) means we leave it alone. A previous version
// used a "skip if > 50 rows" threshold, but the seeded ISS volume is ~40 per
// school, which kept the guard open and caused deterministic re-seed
// attempts to crash on the (student_id, day, school_id) unique index.
// Each per-school per-table seed runs in its own transaction so a partial
// crash rolls back fully (same idempotency contract as the iReady/SCI seed).
// -----------------------------------------------------------------------------

const HALL_DESTINATIONS = [
  "Restroom",
  "Office",
  "Nurse",
  "Counselor",
  "Library",
  "Front Desk",
  "Water",
];
const TARDY_REASONS = [
  "Bus delay",
  "Locker",
  "Late to class",
  "Talking",
  "No reason given",
  "Bathroom",
];
const PULLOUT_REASONS = [
  "Disruptive behavior",
  "Refusal",
  "Crisis support",
  "Behavior plan check-in",
  "Counselor request",
];
const ISS_SOURCES = ["assigned", "scheduled"];
// Strictly empty-only — see the comment block at the top of
// seedEngagementEventsIfEmpty for why a non-zero threshold is unsafe.
const ENGAGEMENT_SEED_THRESHOLD = 0;

// School-day filter — Mon-Fri only. Sat/Sun yield zero events so the trend
// charts honestly drop on weekends instead of showing a flat fake baseline.
function isSchoolDay(d: Date): boolean {
  const dow = d.getUTCDay(); // 0=Sun, 6=Sat
  return dow >= 1 && dow <= 5;
}

// Build a Pareto-ish weight distribution over student ids: top 10% of
// students get ~50% of the events, mimicking real-world distribution.
function buildWeightedSampler(
  rng: () => number,
  ids: string[],
): () => string {
  const sorted = shuffle(rng, ids); // randomize who's "top"
  const weights = sorted.map((_, i) => {
    const rank = i / sorted.length;
    // Higher weight for low rank (top of list). Drops off smoothly.
    return Math.exp(-3 * rank);
  });
  const totalW = weights.reduce((a, b) => a + b, 0);
  return () => {
    let r = rng() * totalW;
    for (let i = 0; i < sorted.length; i++) {
      r -= weights[i];
      if (r <= 0) return sorted[i];
    }
    return sorted[sorted.length - 1];
  };
}

export async function seedEngagementEventsIfEmpty() {
  const schools = await db.select().from(schoolsTable);
  if (schools.length === 0) return;

  const now = new Date();
  const dayMs = 86400000;

  for (const school of schools) {
    // We need the student roster + at least one staff name per school.
    const studentRows = await db
      .select({
        studentId: studentsTable.studentId,
      })
      .from(studentsTable)
      .where(eq(studentsTable.schoolId, school.id));
    if (studentRows.length === 0) continue;
    const studentIds = studentRows.map((s) => s.studentId);

    const [firstStaff] = await db
      .select({
        id: staffTable.id,
        displayName: staffTable.displayName,
      })
      .from(staffTable)
      .where(eq(staffTable.schoolId, school.id))
      .limit(1);
    if (!firstStaff) continue;
    const teacherName = firstStaff.displayName?.trim() || "Demo Teacher";

    const rng = makeRng(0xe11ace + school.id * 1009);
    const samplePareto = buildWeightedSampler(rng, studentIds);

    // ---- Hall passes ----
    const [{ c: hpExisting }] = (
      await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM hall_passes WHERE school_id = ${school.id}`,
      )
    ).rows as { c: number }[];

    if (hpExisting <= ENGAGEMENT_SEED_THRESHOLD) {
      const inserts: (typeof hallPassesTable.$inferInsert)[] = [];
      // Walk 60 days back → today, school days only, ~12 passes per school day.
      for (let back = 60; back >= 0; back--) {
        const day = new Date(now.getTime() - back * dayMs);
        if (!isSchoolDay(day)) continue;
        const count = 8 + Math.floor(rng() * 10); // 8–17 per school day
        for (let i = 0; i < count; i++) {
          // Hours 8–14 (school day), random minute.
          const hour = 8 + Math.floor(rng() * 7);
          const min = Math.floor(rng() * 60);
          const start = new Date(day);
          start.setUTCHours(hour, min, 0, 0);
          const durationMin = 5 + Math.floor(rng() * 25); // 5–29 min
          const ended = new Date(start.getTime() + durationMin * 60000);
          inserts.push({
            schoolId: school.id,
            studentId: samplePareto(),
            destination:
              HALL_DESTINATIONS[
                Math.floor(rng() * HALL_DESTINATIONS.length)
              ],
            originRoom: `Room ${100 + Math.floor(rng() * 30)}`,
            teacherName,
            status: "ended",
            createdAt: start.toISOString(),
            maxDurationMinutes: 10,
            endedAt: ended.toISOString(),
          });
        }
      }
      if (inserts.length > 0) {
        await db.transaction(async (tx) => {
          for (let i = 0; i < inserts.length; i += 500) {
            await tx
              .insert(hallPassesTable)
              .values(inserts.slice(i, i + 500));
          }
        });
        logger.info(
          { schoolId: school.id, count: inserts.length },
          "[seed] hall_passes demo events seeded",
        );
      }
    }

    // ---- Tardies ----
    const [{ c: tdExisting }] = (
      await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM tardies WHERE school_id = ${school.id}`,
      )
    ).rows as { c: number }[];

    if (tdExisting <= ENGAGEMENT_SEED_THRESHOLD) {
      const inserts: (typeof tardiesTable.$inferInsert)[] = [];
      for (let back = 60; back >= 0; back--) {
        const day = new Date(now.getTime() - back * dayMs);
        if (!isSchoolDay(day)) continue;
        const count = 4 + Math.floor(rng() * 5); // 4–8 per school day
        for (let i = 0; i < count; i++) {
          // Tardies cluster at hour 8 (start of day) + period changes.
          const periodNum = 1 + Math.floor(rng() * 7);
          const hour = 7 + periodNum;
          const min = Math.floor(rng() * 15);
          const ts = new Date(day);
          ts.setUTCHours(hour, min, 0, 0);
          inserts.push({
            schoolId: school.id,
            studentId: samplePareto(),
            teacherName,
            period: String(periodNum),
            reason: TARDY_REASONS[Math.floor(rng() * TARDY_REASONS.length)],
            entryType: "tardy",
            notes: "",
            createdAt: ts.toISOString(),
          });
        }
      }
      if (inserts.length > 0) {
        await db.transaction(async (tx) => {
          for (let i = 0; i < inserts.length; i += 500) {
            await tx
              .insert(tardiesTable)
              .values(inserts.slice(i, i + 500));
          }
        });
        logger.info(
          { schoolId: school.id, count: inserts.length },
          "[seed] tardies demo events seeded",
        );
      }
    }

    // ---- ISS days ----
    const [{ c: issExisting }] = (
      await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM iss_attendance_day WHERE school_id = ${school.id}`,
      )
    ).rows as { c: number }[];

    if (issExisting <= ENGAGEMENT_SEED_THRESHOLD) {
      const inserts: (typeof issAttendanceDayTable.$inferInsert)[] = [];
      // Track (studentId, day) so we don't violate the unique index
      // (student_id, day, school_id). Same student can have ISS multiple
      // days in the period but never two on the same day.
      const taken = new Set<string>();
      for (let back = 60; back >= 0; back--) {
        const day = new Date(now.getTime() - back * dayMs);
        if (!isSchoolDay(day)) continue;
        const count = Math.floor(rng() * 3); // 0–2 per school day
        for (let i = 0; i < count; i++) {
          const sid = samplePareto();
          const dayStr = day.toISOString().slice(0, 10);
          const key = `${sid}|${dayStr}`;
          if (taken.has(key)) continue;
          taken.add(key);
          inserts.push({
            schoolId: school.id,
            studentId: sid,
            day: dayStr,
            source: ISS_SOURCES[Math.floor(rng() * ISS_SOURCES.length)],
            presentPeriods: [1, 2, 3, 4, 5, 6, 7],
          });
        }
      }
      if (inserts.length > 0) {
        await db.transaction(async (tx) => {
          for (let i = 0; i < inserts.length; i += 500) {
            await tx
              .insert(issAttendanceDayTable)
              .values(inserts.slice(i, i + 500));
          }
        });
        logger.info(
          { schoolId: school.id, count: inserts.length },
          "[seed] iss_attendance_day demo events seeded",
        );
      }
    }

    // ---- Pullouts ----
    const [{ c: poExisting }] = (
      await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM pullouts WHERE school_id = ${school.id}`,
      )
    ).rows as { c: number }[];

    if (poExisting <= ENGAGEMENT_SEED_THRESHOLD) {
      const inserts: (typeof pulloutsTable.$inferInsert)[] = [];
      for (let back = 60; back >= 0; back--) {
        const day = new Date(now.getTime() - back * dayMs);
        if (!isSchoolDay(day)) continue;
        const count = 1 + Math.floor(rng() * 4); // 1–4 per school day
        for (let i = 0; i < count; i++) {
          const periodNum = 1 + Math.floor(rng() * 7);
          const hour = 8 + periodNum;
          const min = Math.floor(rng() * 60);
          const ts = new Date(day);
          ts.setUTCHours(hour, min, 0, 0);
          inserts.push({
            schoolId: school.id,
            studentId: samplePareto(),
            requestedById: firstStaff.id,
            requestedByName: teacherName,
            requestedAt: ts.toISOString(),
            referringTeacherStaffId: firstStaff.id,
            referringTeacherName: teacherName,
            period: periodNum,
            reason:
              PULLOUT_REASONS[Math.floor(rng() * PULLOUT_REASONS.length)],
            status: "closed",
            arrivedAt: new Date(ts.getTime() + 5 * 60000).toISOString(),
            returnedAt: new Date(ts.getTime() + 25 * 60000).toISOString(),
            closedAt: new Date(ts.getTime() + 30 * 60000).toISOString(),
          });
        }
      }
      if (inserts.length > 0) {
        await db.transaction(async (tx) => {
          for (let i = 0; i < inserts.length; i += 500) {
            await tx
              .insert(pulloutsTable)
              .values(inserts.slice(i, i + 500));
          }
        });
        logger.info(
          { schoolId: school.id, count: inserts.length },
          "[seed] pullouts demo events seeded",
        );
      }
    }
  }
}

// -----------------------------------------------------------------------------
// seedPbisCatalogIfEmpty: per-school pbis_reasons starter catalog. Most
// schools have an empty catalog, so the Behavior dashboard's "top reasons"
// table would be useless. We only seed when the catalog is strictly empty
// for the school — schools (like #1) with even one hand-curated reason are
// left alone. Mirrors the engagement-seed empty-only policy.
// -----------------------------------------------------------------------------

const PBIS_DEFAULT_POSITIVES = [
  { name: "Respectful", category: "Character", points: 1 },
  { name: "Responsible", category: "Character", points: 1 },
  { name: "Kind to others", category: "Character", points: 1 },
  { name: "Leadership", category: "Character", points: 2 },
  { name: "Helpful", category: "Character", points: 1 },
  { name: "On-task", category: "Effort", points: 1 },
  { name: "Excellent Work", category: "Effort", points: 2 },
  { name: "Show Sportsmanship", category: "Athletics", points: 2 },
];

const PBIS_DEFAULT_NEGATIVES = [
  { name: "Disruption", category: "Classroom", points: 1 },
  { name: "Talk too much in class", category: "Classroom", points: 1 },
  { name: "Off-task", category: "Effort", points: 1 },
  { name: "Disrespect", category: "Character", points: 1 },
  { name: "Tech misuse", category: "Classroom", points: 1 },
  { name: "Tardy to class", category: "Classroom", points: 1 },
];

export async function seedPbisCatalogIfEmpty() {
  const schools = await db.select().from(schoolsTable);
  if (schools.length === 0) return;

  for (const school of schools) {
    const [{ c: existing }] = (
      await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM pbis_reasons WHERE school_id = ${school.id}`,
      )
    ).rows as { c: number }[];
    if (existing > 0) continue;

    const inserts: (typeof pbisReasonsTable.$inferInsert)[] = [];
    PBIS_DEFAULT_POSITIVES.forEach((r, i) => {
      inserts.push({
        schoolId: school.id,
        name: r.name,
        category: r.category,
        defaultPoints: r.points,
        polarity: "positive",
        sortOrder: i,
        ownerScope: "school",
      });
    });
    PBIS_DEFAULT_NEGATIVES.forEach((r, i) => {
      inserts.push({
        schoolId: school.id,
        name: r.name,
        category: r.category,
        defaultPoints: r.points,
        polarity: "negative",
        sortOrder: i,
        ownerScope: "school",
      });
    });
    await db.insert(pbisReasonsTable).values(inserts);
    logger.info(
      { schoolId: school.id, count: inserts.length },
      "[seed] pbis_reasons starter catalog seeded",
    );
  }
}

// -----------------------------------------------------------------------------
// seedPbisEntriesIfEmpty: populate pbis_entries with realistic positive +
// negative awards over the last 60 days so the Behavior dashboard demos
// well on a fresh DB. Skip-if-table-empty per school (strict 0-row rule).
// Pulls reasons live from pbis_reasons so it always stays consistent with
// the school's actual catalog (whether seeded or hand-curated).
// -----------------------------------------------------------------------------

export async function seedPbisEntriesIfEmpty() {
  const schools = await db.select().from(schoolsTable);
  if (schools.length === 0) return;

  const now = new Date();
  const dayMs = 86400000;

  for (const school of schools) {
    const [{ c: entriesExisting }] = (
      await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM pbis_entries WHERE school_id = ${school.id}`,
      )
    ).rows as { c: number }[];
    if (entriesExisting > 0) continue;

    const studentRows = await db
      .select({ studentId: studentsTable.studentId })
      .from(studentsTable)
      .where(eq(studentsTable.schoolId, school.id));
    if (studentRows.length === 0) continue;
    const studentIds = studentRows.map((s) => s.studentId);

    const reasons = await db
      .select({
        id: pbisReasonsTable.id,
        name: pbisReasonsTable.name,
        defaultPoints: pbisReasonsTable.defaultPoints,
        polarity: pbisReasonsTable.polarity,
      })
      .from(pbisReasonsTable)
      .where(eq(pbisReasonsTable.schoolId, school.id));
    const positives = reasons.filter((r) => r.polarity === "positive");
    const negatives = reasons.filter((r) => r.polarity === "negative");
    if (positives.length === 0 && negatives.length === 0) continue;

    // Up to 5 staff for variety in top-N "recognizing staff" tables.
    const staffRows = await db
      .select({
        id: staffTable.id,
        displayName: staffTable.displayName,
      })
      .from(staffTable)
      .where(eq(staffTable.schoolId, school.id))
      .limit(5);
    if (staffRows.length === 0) continue;

    const rng = makeRng(0xb12ae + school.id * 1009);
    const samplePareto = buildWeightedSampler(rng, studentIds);

    const inserts: (typeof pbisEntriesTable.$inferInsert)[] = [];
    for (let back = 60; back >= 0; back--) {
      const day = new Date(now.getTime() - back * dayMs);
      if (!isSchoolDay(day)) continue;
      const count = 18 + Math.floor(rng() * 14); // 18–31 per school day
      for (let i = 0; i < count; i++) {
        // ~80% positive / 20% negative split.
        const isNegative = rng() < 0.2;
        const pool = isNegative ? negatives : positives;
        if (pool.length === 0) continue;
        const reason = pool[Math.floor(rng() * pool.length)];
        const staff = staffRows[Math.floor(rng() * staffRows.length)];
        const hour = 8 + Math.floor(rng() * 7);
        const min = Math.floor(rng() * 60);
        const ts = new Date(day);
        ts.setUTCHours(hour, min, 0, 0);
        // Negatives are recorded as positive integers; the polarity column
        // tells the dashboard how to color them. Keeps the points magnitude
        // honest regardless of school_settings.pbisNegativeAffectsTotal.
        inserts.push({
          schoolId: school.id,
          studentId: samplePareto(),
          reason: reason.name,
          points: reason.defaultPoints,
          staffId: staff.id,
          staffName: staff.displayName,
          createdAt: ts.toISOString(),
          polarity: reason.polarity,
        });
      }
    }
    if (inserts.length === 0) continue;
    await db.transaction(async (tx) => {
      for (let i = 0; i < inserts.length; i += 500) {
        await tx
          .insert(pbisEntriesTable)
          .values(inserts.slice(i, i + 500));
      }
    });
    logger.info(
      { schoolId: school.id, count: inserts.length },
      "[seed] pbis_entries demo events seeded",
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
