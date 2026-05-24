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
  studentAttendanceDayTable,
  weatherDayTable,
  issRosterTable,
  interventionEntriesTable,
  studentMtssPlansTable,
  tier3GoalsTable,
  studentFastScoresTable,
  housesTable,
  assessmentsTable,
  importJobsTable,
  safetyPlanLibraryTable,
  safetyPlansTable,
  separationReasonTagsTable,
  interactionsTable,
  interactionParticipantsTable,
  interactionCasesTable,
  interactionCaseNotesTable,
  witnessStatementsTable,
  interactionQuickEntriesTable,
  cameraRegistryTable,
  caseOutcomeTypesTable,
  DEFAULT_CASE_OUTCOMES,
  studentRetentionsTable,
} from "@workspace/db";
import bcrypt from "bcryptjs";
import { eq, sql, and, inArray, isNull, asc, desc } from "drizzle-orm";
import { logger } from "./lib/logger";
import { fetchWeatherForLocation } from "./lib/weatherFetcher";
import { schoolYearLabelFor, DEFAULT_SCHOOL_TZ } from "./lib/schoolYear.js";
import benchmarkDeliveriesSeedJson from "./seedData/benchmarkDeliveriesSeed.json" with { type: "json" };

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
  { name: "Falcon",  color: "#3b82f6", motto: "Sharp eyes. Steady wings.",   iconKey: "Bird"   },
  { name: "Phoenix", color: "#ef4444", motto: "Rise every day.",             iconKey: "Flame"  },
  { name: "Stag",    color: "#10b981", motto: "Stand tall. Stand together.", iconKey: "Crown"  },
  { name: "Wolf",    color: "#8b5cf6", motto: "One pack.",                   iconKey: "Shield" },
];

// Round-robin pool used to backfill iconKey for any pre-existing houses
// (created before this column existed) that admins haven't customised.
const HOUSE_ICON_POOL = ["Crown", "Shield", "Flame", "Star", "Bird", "Sparkles"];

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
  // Additive evolution: icon_key was added after the initial schema. ALTER
  // TABLE ... IF NOT EXISTS keeps re-runs cheap and avoids drizzle-kit's
  // interactive rename prompt (per the project gotchas note).
  await db.execute(
    sql`ALTER TABLE houses ADD COLUMN IF NOT EXISTS icon_key TEXT`,
  );
  // students.house_id is added separately because it's an ALTER on an
  // existing table. IF NOT EXISTS keeps re-runs harmless.
  await db.execute(
    sql`ALTER TABLE students ADD COLUMN IF NOT EXISTS house_id INTEGER`,
  );
  // staff.house_id — teachers/staff can belong to a house too (printed on
  // their kiosk activation card and any future "your house" surfaces).
  await db.execute(
    sql`ALTER TABLE staff ADD COLUMN IF NOT EXISTS house_id INTEGER`,
  );
  // student_house_changes — append-only audit of every house move.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS student_house_changes (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      student_db_id INTEGER NOT NULL,
      from_house_id INTEGER,
      to_house_id INTEGER,
      reason TEXT NOT NULL,
      changed_by_staff_id INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      sort_job_id INTEGER,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS student_house_changes_by_school
      ON student_house_changes (school_id, changed_at)
  `);
  // Drop the legacy NOT NULL on to_house_id so admin "clear back to
  // unassigned" moves can be audited too. Safe on tables created
  // before this column was nullable.
  await db.execute(
    sql`ALTER TABLE student_house_changes ALTER COLUMN to_house_id DROP NOT NULL`,
  );
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS student_house_changes_by_student
      ON student_house_changes (student_db_id)
  `);
  // student_house_sort_jobs — snapshot per bulk sort for 24h undo.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS student_house_sort_jobs (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      committed_by_staff_id INTEGER NOT NULL,
      committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      include_assigned INTEGER NOT NULL DEFAULT 0,
      keep_siblings INTEGER NOT NULL DEFAULT 0,
      affected_count INTEGER NOT NULL DEFAULT 0,
      snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
      undone_at TIMESTAMPTZ,
      undone_by_staff_id INTEGER
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS student_house_sort_jobs_by_school
      ON student_house_sort_jobs (school_id, committed_at)
  `);
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
            iconKey: h.iconKey,
            createdAt: new Date().toISOString(),
          })),
        )
        .returning();
      houseRows = created;
      logger.info(
        { schoolId: school.id, count: created.length },
        "[seed] houses seeded",
      );
    } else {
      // Backfill iconKey for pre-existing houses created before this column
      // existed. Round-robin from the icon pool, ordered by id so the same
      // house always gets the same icon across re-runs.
      const missing = houseRows.filter((h) => !h.iconKey);
      if (missing.length > 0) {
        const ordered = [...missing].sort((a, b) => a.id - b.id);
        for (let i = 0; i < ordered.length; i++) {
          const iconKey = HOUSE_ICON_POOL[i % HOUSE_ICON_POOL.length];
          await db
            .update(housesTable)
            .set({ iconKey })
            .where(eq(housesTable.id, ordered[i].id));
        }
        logger.info(
          { schoolId: school.id, backfilled: ordered.length },
          "[seed] houses iconKey backfilled",
        );
        // Refresh local copy so downstream logic sees the iconKey if it cares.
        houseRows = await db
          .select()
          .from(housesTable)
          .where(eq(housesTable.schoolId, school.id));
      }
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
  // ---- Tier 2 / Tier 3 columns added after the original v1 ship.
  // ALTER … IF NOT EXISTS keeps prod migrations idempotent.
  await db.execute(
    sql`ALTER TABLE student_mtss_plans ADD COLUMN IF NOT EXISTS intervention_sub_type TEXT`,
  );
  await db.execute(
    sql`ALTER TABLE student_mtss_plans ADD COLUMN IF NOT EXISTS assigned_teacher_ids TEXT NOT NULL DEFAULT ''`,
  );
  await db.execute(
    sql`ALTER TABLE student_mtss_plans ADD COLUMN IF NOT EXISTS track_school_wide_expectations BOOLEAN NOT NULL DEFAULT TRUE`,
  );
  await db.execute(
    sql`ALTER TABLE student_mtss_plans ADD COLUMN IF NOT EXISTS tier3_goal_slots INTEGER NOT NULL DEFAULT 2`,
  );
  // FAST Phase 3 — benchmark linkage. Read path lights an "MTSS"
  // pill on student-profile benchmark rows; Phase 5 will add the
  // writer in the plan editor. Nullable / additive — safe on prod.
  await db.execute(
    sql`ALTER TABLE student_mtss_plans ADD COLUMN IF NOT EXISTS fast_benchmark_code TEXT`,
  );
  // ---- tier3_goals — version-on-edit goal storage for Tier 3 plans.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS tier3_goals (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      student_id TEXT NOT NULL,
      slot INTEGER NOT NULL,
      text TEXT NOT NULL,
      effective_from TEXT NOT NULL,
      created_by_staff_id INTEGER,
      created_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS tier3_goals_school_idx ON tier3_goals (school_id)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS tier3_goals_student_slot_idx ON tier3_goals (school_id, student_id, slot, effective_from)`,
  );
  // ---- Per-goal-per-day score map on the weekly record. Added after
  // teachers reported that a single shared "overall" score row was
  // confusing — each goal now gets its own 1..5 row in the form, stored
  // here as { "<slot>": { mon: 1..5|null, tue: ..., ... } }. The
  // legacy mon_score..fri_score columns stay as the rounded average so
  // every existing dashboard query keeps working unchanged.
  await db.execute(
    sql`ALTER TABLE tier3_weekly_records ADD COLUMN IF NOT EXISTS goal_scores JSONB NOT NULL DEFAULT '{}'::jsonb`,
  );
  // ---- Per-day absent flag map { mon: true, ... }. Absent days are
  // excluded from any "% of points earned" calc and from the bell's
  // missing-day count so teachers aren't pestered to score days the
  // student wasn't present for.
  await db.execute(
    sql`ALTER TABLE tier3_weekly_records ADD COLUMN IF NOT EXISTS absent_days JSONB NOT NULL DEFAULT '{}'::jsonb`,
  );
  // ---- Submitted-at timestamp distinguishing a working draft (NULL)
  // from a teacher's final Friday submission (timestamp). Edits are
  // still allowed after submission — the timestamp just refreshes.
  await db.execute(
    sql`ALTER TABLE tier3_weekly_records ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ`,
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
// seedTieredInterventionsIfEmpty: idempotent per-school. Picks ~10% of
// each school's students and gives them a *tiered* (Tier 2 daily or
// Tier 3 weekly) intervention plan that's fully wired up: sub-type set,
// assignedTeacherIds populated from the section roster so the bell
// shows up for the right teachers, plus 2-3 versioned goals per Tier 3
// student so the weekly form has score rows to render.
//
// This sits alongside the legacy `seedMtssPlansIfEmpty` (which only
// produces v1 metadata-only Tier 2 plans). Use `opened_by_name =
// 'Tiered Demo Seed'` as the marker so re-runs are safe and so demo
// users can tell auto-seeded tiered plans apart from real ones.
//
// Distribution:
//   * 60% Tier 2 → split 50/50 between CICO and Group sub-types
//   * 40% Tier 3 → 2 or 3 goal slots, PRIDE on by default
// Each plan gets 1-3 assigned teachers pulled from the student's own
// section roster, so the "owed today" bell actually fires.
// -----------------------------------------------------------------------------
const TIER2_PLAN_TITLES = [
  "Tier 2 — Check-In/Check-Out",
  "Tier 2 — Behavior Group",
  "Tier 2 — Daily Engagement Plan",
];
const TIER3_PLAN_TITLES = [
  "Tier 3 — Individualized Behavior Plan",
  "Tier 3 — Wraparound Support",
  "Tier 3 — Intensive Daily Monitoring",
];
const TIER3_GOAL_TEXTS = [
  "Arrive to class on time and ready to learn (materials out within 2 minutes).",
  "Use respectful language with peers and adults throughout the day.",
  "Complete and turn in assigned classwork by end of period.",
  "Use a coping strategy (deep breath, break, journal) when frustrated.",
  "Stay in assigned seat / area unless given permission to move.",
  "Follow first-time directions from the teacher without argument.",
  "Use kind words and keep hands/feet to self during transitions.",
  "Track speaker and raise hand before contributing to class discussion.",
];

// One-shot cleanup: prior runs of `seedIfEmpty()` created loose
// (case_id IS NULL) demo interactions for high-not-on-case, all
// medium, and all low tier students. Those rows padded the
// "Loose / no case" cluster on the Schoolwide Behavior Network and
// added node-spam to the Full School Web view. The seeder no longer
// emits them, but the existing rows stay in the DB until we sweep
// them out. This sweep is gated to **demo-seeded schools only** (the
// `school_accommodations`-non-empty marker that the rest of the
// seed uses) so we never touch a real SIS school's loose
// interactions. Idempotent — once the rows are gone the DELETEs are
// no-ops on subsequent boots.
export async function cleanupLooseSeedInteractionsOnce() {
  // Self-contained: ensure the watchlist tables exist before we
  // touch them. seedIfEmpty() also calls this, but on a fresh DB
  // where seedIfEmpty short-circuited (e.g. partial migration
  // state) the tables may not exist yet. Idempotent IF NOT EXISTS.
  await ensureWatchlistSchema();
  const schools = await db.select().from(schoolsTable);
  for (const school of schools) {
    const [{ c: demoMarker }] = (
      await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM school_accommodations
            WHERE school_id = ${school.id}`,
      )
    ).rows as { c: number }[];
    if (demoMarker === 0) continue;

    // No FK constraints on interaction_id (bare int columns), so we
    // delete child rows in dependency order before the parent. The
    // subquery is school-scoped and case_id IS NULL, so we never touch
    // any interaction tied to a real case (or a different school).
    // Drizzle's sql template flattens JS arrays as separate params
    // rather than a Postgres ARRAY, which broke an earlier ANY()
    // version of this — using a nested SELECT avoids that entirely.
    const looseSelect = sql`SELECT id FROM interactions
        WHERE school_id = ${school.id}
          AND case_id IS NULL`;
    await db.execute(
      sql`DELETE FROM interaction_participants
          WHERE school_id = ${school.id}
            AND interaction_id IN (${looseSelect})`,
    );
    await db.execute(
      sql`DELETE FROM witness_statements
          WHERE school_id = ${school.id}
            AND interaction_id IN (${looseSelect})`,
    );
    const removed = await db.execute(
      sql`DELETE FROM interactions
          WHERE school_id = ${school.id}
            AND case_id IS NULL`,
    );
    if ((removed.rowCount ?? 0) > 0) {
      logger.info(
        { schoolId: school.id, removed: removed.rowCount },
        "[seed] cleaned up loose (case_id IS NULL) demo interactions",
      );
    }
  }
}

export async function seedTieredInterventionsIfEmpty() {
  await ensureMtssPlansSchema();

  const schools = await db.select().from(schoolsTable);
  for (const school of schools) {
    // Idempotency marker: skip schools that already have a tiered seed.
    const [{ c }] = (
      await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM student_mtss_plans
            WHERE school_id = ${school.id}
              AND opened_by_name = 'Tiered Demo Seed'`,
      )
    ).rows as { c: number }[];
    if (c > 0) continue;

    const studentRows = await db
      .select({ studentId: studentsTable.studentId })
      .from(studentsTable)
      .where(eq(studentsTable.schoolId, school.id));
    if (studentRows.length === 0) continue;

    // Pull the section roster joined to class_sections so we know which
    // teachers each student sees during the day. Stored as a Map<studentId, teacherId[]>.
    const rosterRows = (
      await db.execute(
        sql`SELECT sr.student_id, cs.teacher_staff_id
            FROM section_roster sr
            JOIN class_sections cs ON cs.id = sr.section_id
            WHERE cs.school_id = ${school.id}
              AND cs.is_planning = false`,
      )
    ).rows as { student_id: string; teacher_staff_id: number }[];
    const teachersByStudent = new Map<string, number[]>();
    for (const r of rosterRows) {
      const arr = teachersByStudent.get(r.student_id) ?? [];
      if (!arr.includes(r.teacher_staff_id)) arr.push(r.teacher_staff_id);
      teachersByStudent.set(r.student_id, arr);
    }

    // Deterministic shuffle so re-seeds (after a wipe + skip-marker
    // clear) produce the same sample.
    const rng = makeRng(0x71e3ed + school.id * 8101);
    const ids = studentRows.map((s) => s.studentId);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const sampleSize = Math.floor(ids.length * 0.1);
    const sampled = ids.slice(0, sampleSize);

    type PlanInsert = typeof studentMtssPlansTable.$inferInsert;
    const plans: PlanInsert[] = [];
    // Track which sampled students are Tier 3 so we can write goals
    // after the plans are inserted (we need plan IDs first).
    const tier3Students: Array<{ studentId: string; goalCount: number }> = [];

    let idx = 0;
    for (const studentId of sampled) {
      idx += 1;
      const teacherIds = teachersByStudent.get(studentId) ?? [];
      // Up to 3 teachers, deterministic order.
      const assignedCsv = teacherIds.slice(0, 3).join(",");

      // 60% Tier 2, 40% Tier 3. Use idx so the split is exact and
      // independent of the RNG stream that picked the students.
      const isTier3 = idx % 5 >= 3;
      if (isTier3) {
        const goalCount = (idx % 2) + 2; // 2 or 3 goals
        tier3Students.push({ studentId, goalCount });
        plans.push({
          schoolId: school.id,
          studentId,
          title: pick(rng, TIER3_PLAN_TITLES),
          goals:
            "Auto-seeded Tier 3 plan. Goals are tracked in tier3_goals — edit there.",
          tier: 3,
          pointRangeMin: 1,
          pointRangeMax: 5,
          notes: "Auto-seeded tiered plan. Remove or replace before live use.",
          interventionSubType: null,
          assignedTeacherIds: assignedCsv,
          trackSchoolWideExpectations: true,
          tier3GoalSlots: goalCount,
          openedByName: "Tiered Demo Seed",
        });
      } else {
        // Tier 2 — alternate CICO and group so each school has both.
        const subType = idx % 2 === 0 ? "cico" : "group";
        plans.push({
          schoolId: school.id,
          studentId,
          title:
            subType === "cico"
              ? "Tier 2 — Check-In/Check-Out"
              : "Tier 2 — Behavior Group",
          goals:
            "Auto-seeded Tier 2 plan. Daily entries roll up into the MTSS dashboard.",
          tier: 2,
          pointRangeMin: 0,
          pointRangeMax: 100,
          notes: "Auto-seeded tiered plan. Remove or replace before live use.",
          interventionSubType: subType,
          assignedTeacherIds: assignedCsv,
          trackSchoolWideExpectations: true,
          tier3GoalSlots: 2,
          openedByName: "Tiered Demo Seed",
        });
      }
    }

    if (plans.length === 0) continue;

    for (let i = 0; i < plans.length; i += 500) {
      await db.insert(studentMtssPlansTable).values(plans.slice(i, i + 500));
    }

    // Now write Tier 3 goals. Use a stable effectiveFrom = today (school
    // local would be ideal, but this seed runs at boot and the demo uses
    // today everywhere else too — close enough for fixture data).
    const today = new Date().toISOString().slice(0, 10);
    type GoalInsert = typeof tier3GoalsTable.$inferInsert;
    const goals: GoalInsert[] = [];
    for (const t3 of tier3Students) {
      for (let slot = 1; slot <= t3.goalCount; slot++) {
        goals.push({
          schoolId: school.id,
          studentId: t3.studentId,
          slot,
          text: pick(rng, TIER3_GOAL_TEXTS),
          effectiveFrom: today,
          createdByName: "Tiered Demo Seed",
        });
      }
    }
    if (goals.length > 0) {
      for (let i = 0; i < goals.length; i += 500) {
        await db.insert(tier3GoalsTable).values(goals.slice(i, i + 500));
      }
    }

    logger.info(
      {
        schoolId: school.id,
        plansSeeded: plans.length,
        tier2: plans.length - tier3Students.length,
        tier3: tier3Students.length,
        goalsSeeded: goals.length,
      },
      "[seed] tiered intervention plans seeded (~10% of students)",
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
    // Expanded catalog (School Plans work).
    "feature_hall_passes",
    "feature_tardy_pass",
    "feature_mtss_plans",
    "feature_behavior_specialist",
    "feature_iss_dashboard",
    "feature_displays",
    "feature_bell_schedule",
    "feature_early_warning",
    "feature_academics",
    "feature_data_imports",
    "feature_houses",
    "feature_parent_portal",
    "super_feature_hall_passes",
    "super_feature_tardy_pass",
    "super_feature_mtss_plans",
    "super_feature_behavior_specialist",
    "super_feature_iss_dashboard",
    "super_feature_displays",
    "super_feature_bell_schedule",
    "super_feature_early_warning",
    "super_feature_academics",
    "super_feature_data_imports",
    "super_feature_houses",
    "super_feature_parent_portal",
  ];
  for (const col of cols) {
    await db.execute(
      sql.raw(
        `ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS ${col} BOOLEAN NOT NULL DEFAULT TRUE`,
      ),
    );
  }
  // Advisory tier-preset pointer (nullable). Stored as plain integer —
  // no FK so deleting a preset doesn't cascade to school_settings.
  await db.execute(
    sql.raw(
      `ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS tier_preset_id INTEGER`,
    ),
  );
  // FAST Phase 2 — per-benchmark mastery threshold (percent, default 80).
  // Drives the Teacher Roster → Benchmarks heatmap color buckets and
  // the bottom-3 tile. Configurable per school.
  await db.execute(
    sql.raw(
      `ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS fast_benchmark_mastery_threshold INTEGER NOT NULL DEFAULT 80`,
    ),
  );
  // FAST Phase 4 — outlier z-score threshold for the admin FAST
  // Benchmarks dashboard. REAL DEFAULT 1.0 = teachers more than 1
  // stdev below the school-wide grade mean for the selected
  // benchmark get flagged. Idempotent ALTER stays harmless across
  // restarts and deploys.
  await db.execute(
    sql.raw(
      `ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS fast_outlier_z_threshold REAL NOT NULL DEFAULT 1.0`,
    ),
  );
  // FAST Phase 5 — minimum number of below-threshold windows (out of
  // the most recent 3) required for a student×benchmark pair to surface
  // as a Tier 2 auto-suggestion on the MTSS hub. Default 2 mirrors the
  // common "two consecutive misses" rule of thumb. Threshold (% mastery)
  // reuses the existing `fast_benchmark_mastery_threshold` column so
  // admins only tune one number.
  await db.execute(
    sql.raw(
      `ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS fast_tier2_min_windows INTEGER NOT NULL DEFAULT 2`,
    ),
  );
  // FAST Phase 5 — dismissals ledger for the MTSS Tier 2 auto-suggest
  // tile. One row per (school, student, benchmark, school_year);
  // dismissals auto-expire when the school year rolls.
  await db.execute(
    sql.raw(
      `CREATE TABLE IF NOT EXISTS mtss_fast_suggestion_dismissals (
         id SERIAL PRIMARY KEY,
         school_id INTEGER NOT NULL,
         student_id TEXT NOT NULL,
         benchmark_code TEXT NOT NULL,
         school_year TEXT NOT NULL,
         dismissed_by_staff_id INTEGER,
         dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    ),
  );
  await db.execute(
    sql.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS mtss_fast_suggestion_dismissals_unique
         ON mtss_fast_suggestion_dismissals (school_id, student_id, benchmark_code, school_year)`,
    ),
  );
  await db.execute(
    sql.raw(
      `CREATE INDEX IF NOT EXISTS mtss_fast_suggestion_dismissals_school_idx
         ON mtss_fast_suggestion_dismissals (school_id, school_year)`,
    ),
  );
  // Manual on/off kill switch for an entire display URL (separate from
  // the time-window `schedule_enabled`). Defaults TRUE so existing
  // displays keep playing without any admin action. When FALSE the
  // public cycler returns an off-air payload and the cross-display
  // calendar hides the row.
  await db.execute(
    sql`ALTER TABLE display_playlists ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE`,
  );
  // Pullout Verify-modal additions: parent-facing message captured at
  // verify time + return-to-class message captured at /returned. Both
  // nullable so existing rows are untouched.
  await db.execute(
    sql`ALTER TABLE pullouts ADD COLUMN IF NOT EXISTS parent_message TEXT`,
  );
  await db.execute(
    sql`ALTER TABLE pullouts ADD COLUMN IF NOT EXISTS return_message TEXT`,
  );
  // Parent send-to-ISS email tracking — separate from the arrival
  // email so we can send both (one at verify, one at arrival) and
  // each stays idempotent on its own column.
  await db.execute(
    sql`ALTER TABLE pullouts ADD COLUMN IF NOT EXISTS sent_to_iss_email_sent_at TEXT`,
  );
  await db.execute(
    sql`ALTER TABLE pullouts ADD COLUMN IF NOT EXISTS sent_to_iss_email_status TEXT`,
  );
  await db.execute(
    sql`ALTER TABLE pullouts ADD COLUMN IF NOT EXISTS sent_to_iss_email_to TEXT`,
  );
  await db.execute(
    sql`ALTER TABLE pullouts ADD COLUMN IF NOT EXISTS sent_to_iss_email_error_msg TEXT`,
  );
  // School-scoped library of canned parent messages for the Verify
  // modal. Managed from the Behavior Dashboard.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS pullout_note_templates (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active TEXT NOT NULL DEFAULT 'true',
      created_at TEXT NOT NULL,
      updated_at TEXT
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS pullout_note_templates_school_idx ON pullout_note_templates(school_id)`,
  );
}

// -----------------------------------------------------------------------------
// Admin Hub schema (ISS / OSS multi-day discipline logging).
// All idempotent: ALTER TABLE ... IF NOT EXISTS for column additions to
// existing tables, CREATE TABLE IF NOT EXISTS for new tables. Called from
// boot so a fresh schema and an upgraded one both end up identical.
// -----------------------------------------------------------------------------
export async function ensureAdminHubSchema() {
  // Extend iss_attendance_day with admin-log linkage + rollover bookkeeping.
  await db.execute(
    sql`ALTER TABLE iss_attendance_day ADD COLUMN IF NOT EXISTS admin_log_id INTEGER`,
  );
  await db.execute(
    sql`ALTER TABLE iss_attendance_day ADD COLUMN IF NOT EXISTS rolled_from_date DATE`,
  );
  await db.execute(
    sql`ALTER TABLE iss_attendance_day ADD COLUMN IF NOT EXISTS marked_served BOOLEAN NOT NULL DEFAULT FALSE`,
  );

  // ISS daily seat capacity + soft/hard behavior on school_settings.
  await db.execute(
    sql`ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS iss_daily_capacity INTEGER`,
  );
  await db.execute(
    sql`ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS iss_capacity_behavior TEXT NOT NULL DEFAULT 'soft'`,
  );

  // OSS section + reason gates on school_heartbeat_settings + parent prefs.
  await db.execute(
    sql`ALTER TABLE school_heartbeat_settings ADD COLUMN IF NOT EXISTS show_oss BOOLEAN NOT NULL DEFAULT FALSE`,
  );
  await db.execute(
    sql`ALTER TABLE school_heartbeat_settings ADD COLUMN IF NOT EXISTS show_oss_reason BOOLEAN NOT NULL DEFAULT FALSE`,
  );
  await db.execute(
    sql`ALTER TABLE parent_heartbeat_prefs ADD COLUMN IF NOT EXISTS show_oss BOOLEAN`,
  );
  // Staff "Preview as another staff" override (DB-backed so it survives
  // bearer-only requests inside the Replit preview iframe — session
  // cookies are blocked there).
  await db.execute(
    sql`ALTER TABLE staff ADD COLUMN IF NOT EXISTS preview_target_staff_id INTEGER`,
  );

  // ---- Separation Suggestions: per-school tag catalog + teacher-filed
  // "do not pair" entries scoped to a class section. See
  // lib/db/src/schema/separationReasonTags.ts and
  // lib/db/src/schema/studentSeparations.ts for the full design notes.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS separation_reason_tags (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS separation_reason_tags_school_label_unique ON separation_reason_tags(school_id, label)`,
  );
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS student_separations (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      class_section_id INTEGER NOT NULL,
      reporter_staff_id INTEGER NOT NULL,
      student_a_id TEXT NOT NULL,
      student_b_id TEXT NOT NULL,
      school_year TEXT NOT NULL,
      reason_tag_ids INTEGER[] NOT NULL DEFAULT '{}',
      reason_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS student_separations_pair_unique ON student_separations(class_section_id, reporter_staff_id, student_a_id, student_b_id, school_year)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS student_separations_by_school ON student_separations(school_id, school_year)`,
  );

  // ---- iss_admin_logs (parent assignment record for blue-pill ISS) ----
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS iss_admin_logs (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      student_id TEXT NOT NULL,
      reason_id INTEGER,
      reason_text TEXT,
      notes TEXT,
      created_by_id INTEGER NOT NULL,
      created_by_name TEXT NOT NULL,
      cancelled_at TIMESTAMPTZ,
      cancelled_by_id INTEGER,
      cancelled_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS iss_admin_logs_by_school ON iss_admin_logs(school_id)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS iss_admin_logs_by_student ON iss_admin_logs(school_id, student_id)`,
  );

  // ---- oss_logs + oss_log_days ----
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS oss_logs (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      student_id TEXT NOT NULL,
      reason_id INTEGER,
      reason_text TEXT,
      notes TEXT,
      created_by_id INTEGER NOT NULL,
      created_by_name TEXT NOT NULL,
      cancelled_at TIMESTAMPTZ,
      cancelled_by_id INTEGER,
      cancelled_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS oss_logs_by_school ON oss_logs(school_id)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS oss_logs_by_student ON oss_logs(school_id, student_id)`,
  );

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS oss_log_days (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      log_id INTEGER NOT NULL,
      student_id TEXT NOT NULL,
      day DATE NOT NULL,
      cancelled BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS oss_log_days_by_log ON oss_log_days(log_id)`,
  );
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS oss_log_days_student_day_uq ON oss_log_days(school_id, student_id, day)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS oss_log_days_by_school_day ON oss_log_days(school_id, day)`,
  );

  // ---- discipline_reasons (school + district scopes) ----
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS discipline_reasons (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Add district_id (district-scoped master list) and allow school_id
  // to be NULL when a row is a district master entry. Existing rows
  // keep their school_id and remain school-scoped.
  await db.execute(
    sql`ALTER TABLE discipline_reasons ADD COLUMN IF NOT EXISTS district_id INTEGER`,
  );
  await db.execute(
    sql`ALTER TABLE discipline_reasons ALTER COLUMN school_id DROP NOT NULL`,
  );
  // Replace the old (school_id, label) global unique with two partials
  // — one per scope.
  await db.execute(
    sql`DROP INDEX IF EXISTS discipline_reasons_school_label_uq`,
  );
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS discipline_reasons_school_label_uq
        ON discipline_reasons(school_id, label)
        WHERE school_id IS NOT NULL`,
  );
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS discipline_reasons_district_label_uq
        ON discipline_reasons(district_id, label)
        WHERE district_id IS NOT NULL`,
  );
  // Exactly one of (school_id, district_id) must be set. Guards against
  // a row that is both (or neither) — shouldn't happen via the API but
  // we want the database to refuse it either way.
  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'discipline_reasons_scope_xor_chk'
      ) THEN
        ALTER TABLE discipline_reasons
          ADD CONSTRAINT discipline_reasons_scope_xor_chk
          CHECK ((school_id IS NULL) <> (district_id IS NULL));
      END IF;
    END$$;
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS discipline_reasons_by_district
        ON discipline_reasons(district_id) WHERE district_id IS NOT NULL`,
  );

  // ---- iss_admin_logs / oss_logs: day_count (admin-entered, for reports) ----
  await db.execute(
    sql`ALTER TABLE iss_admin_logs ADD COLUMN IF NOT EXISTS day_count INTEGER`,
  );
  await db.execute(
    sql`ALTER TABLE oss_logs ADD COLUMN IF NOT EXISTS day_count INTEGER`,
  );

  // ---- school_closed_days (no-school calendar) ----
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS school_closed_days (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      day DATE NOT NULL,
      label TEXT,
      created_by_id INTEGER,
      created_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS school_closed_days_school_day_uq ON school_closed_days(school_id, day)`,
  );

  // ---- iss_assignment_acknowledgements (teacher banner ack) ----
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS iss_assignment_acknowledgements (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      student_id TEXT NOT NULL,
      teacher_staff_id INTEGER NOT NULL,
      teacher_name TEXT NOT NULL,
      period INTEGER NOT NULL,
      day DATE NOT NULL,
      method TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS iss_ack_period_day_uq ON iss_assignment_acknowledgements(school_id, student_id, teacher_staff_id, period, day)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS iss_ack_school_day ON iss_assignment_acknowledgements(school_id, day)`,
  );

  // ---- student_emergency_contacts (read-only SIS-derived contact slots) ----
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS student_emergency_contacts (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      student_id TEXT NOT NULL,
      slot INTEGER NOT NULL,
      contact_name TEXT NOT NULL,
      relationship TEXT,
      phone TEXT,
      phone_label TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS student_emergency_contact_slot_uq ON student_emergency_contacts(school_id, student_id, slot)`,
  );

  // ---- iss_admin_log_audit (append-only audit trail for ISS edits) ----
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS iss_admin_log_audit (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      admin_log_id INTEGER NOT NULL,
      actor_staff_id INTEGER NOT NULL,
      actor_display_name TEXT NOT NULL,
      action TEXT NOT NULL,
      before_json JSONB,
      after_json JSONB,
      edit_reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS iss_admin_log_audit_by_log ON iss_admin_log_audit(admin_log_id)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS iss_admin_log_audit_by_school ON iss_admin_log_audit(school_id)`,
  );
}

// -----------------------------------------------------------------------------
// Watchlist Hub schema (interactions, cases, witness statements, audit log,
// alert dismissals). All idempotent CREATE TABLE IF NOT EXISTS so a fresh
// schema and an upgraded one both end up identical. Called from runSeed.
// -----------------------------------------------------------------------------
export async function ensureWatchlistSchema() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS interactions (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      occurred_date TEXT NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      kind TEXT NOT NULL,
      severity INTEGER NOT NULL DEFAULT 1,
      location TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      case_id INTEGER,
      logged_by_staff_id INTEGER,
      logged_by_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS interactions_school_idx ON interactions(school_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS interactions_school_date_idx ON interactions(school_id, occurred_date)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS interactions_school_case_idx ON interactions(school_id, case_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS interaction_participants (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      interaction_id INTEGER NOT NULL,
      student_id TEXT NOT NULL,
      role TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS interaction_participants_school_idx ON interaction_participants(school_id)`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS interaction_participants_interaction_student_idx ON interaction_participants(interaction_id, student_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS interaction_participants_school_student_idx ON interaction_participants(school_id, student_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS interaction_cases (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      case_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      lead_staff_id INTEGER,
      lead_staff_name TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ,
      created_by_staff_id INTEGER,
      created_by_name TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS interaction_cases_school_idx ON interaction_cases(school_id)`);
  // Per-(school, schoolYear) case-number migration. Old rows had a
  // global per-school sequence (Case #142). The new format is
  // "26-27-0042" — derived from opened_at, with the integer part
  // restarting at 1 each school year (July → June, US convention).
  // Steps are individually idempotent; the resequencing only fires
  // when the old unique index is still present, so subsequent boots
  // do nothing.
  await db.execute(sql`ALTER TABLE interaction_cases ADD COLUMN IF NOT EXISTS school_year_label TEXT`);
  // TZ-aware school-year backfill. Casts opened_at to America/New_York
  // before extracting month/year so cases opened in the late-evening
  // boundary window (e.g. 9pm PT on June 30 = July 1 UTC) land in
  // the correct school year. Matches schoolYearLabelFor's default TZ
  // in artifacts/api-server/src/lib/schoolYear.ts. When a real cross-
  // TZ tenant onboards, swap this constant for a per-school IANA col.
  await db.execute(sql`
    UPDATE interaction_cases
       SET school_year_label = CASE
         WHEN EXTRACT(MONTH FROM (opened_at AT TIME ZONE 'America/New_York')) >= 7
           THEN LPAD((EXTRACT(YEAR FROM (opened_at AT TIME ZONE 'America/New_York'))::INT % 100)::TEXT, 2, '0')
                || '-'
                || LPAD(((EXTRACT(YEAR FROM (opened_at AT TIME ZONE 'America/New_York'))::INT + 1) % 100)::TEXT, 2, '0')
         ELSE LPAD(((EXTRACT(YEAR FROM (opened_at AT TIME ZONE 'America/New_York'))::INT - 1) % 100)::TEXT, 2, '0')
                || '-'
                || LPAD((EXTRACT(YEAR FROM (opened_at AT TIME ZONE 'America/New_York'))::INT % 100)::TEXT, 2, '0')
       END
     WHERE school_year_label IS NULL OR school_year_label = ''
  `);
  await db.execute(sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'interaction_cases_school_number_idx'
      ) THEN
        DROP INDEX interaction_cases_school_number_idx;
        WITH ordered AS (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY school_id, school_year_label
                   ORDER BY opened_at, id
                 ) AS rn
          FROM interaction_cases
        )
        UPDATE interaction_cases c
           SET case_number = ordered.rn
          FROM ordered
         WHERE c.id = ordered.id AND c.case_number <> ordered.rn;
      END IF;
    END $$;
  `);
  await db.execute(sql`ALTER TABLE interaction_cases ALTER COLUMN school_year_label SET NOT NULL`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS interaction_cases_school_year_number_idx ON interaction_cases (school_id, school_year_label, case_number)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS interaction_case_notes (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      case_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      author_staff_id INTEGER,
      author_name TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS interaction_case_notes_case_idx ON interaction_case_notes(school_id, case_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS interaction_case_player_impact (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      case_id INTEGER NOT NULL,
      student_id TEXT NOT NULL,
      impact INTEGER NOT NULL DEFAULT 2,
      updated_by_staff_id INTEGER,
      updated_by_name TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS interaction_case_player_impact_case_student_idx ON interaction_case_player_impact(school_id, case_id, student_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS interaction_case_player_impact_school_idx ON interaction_case_player_impact(school_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS witness_statements (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      interaction_id INTEGER NOT NULL,
      student_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'requested',
      requested_by_staff_id INTEGER,
      requested_by_name TEXT NOT NULL DEFAULT '',
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reminded_at TIMESTAMPTZ,
      remind_count INTEGER NOT NULL DEFAULT 0,
      completed_at TIMESTAMPTZ,
      body TEXT NOT NULL DEFAULT ''
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS witness_statements_school_idx ON witness_statements(school_id)`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS witness_statements_interaction_student_idx ON witness_statements(interaction_id, student_id)`);
  // Per-case sequence number for human-readable witness statement IDs
  // (CASE-26-27-0042-WS-03). Assigned at promote-to-case / attach time.
  // NULL while the statement's interaction is still loose.
  await db.execute(sql`ALTER TABLE witness_statements ADD COLUMN IF NOT EXISTS ws_seq INTEGER`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS interaction_audit_log (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      actor_staff_id INTEGER,
      actor_name TEXT NOT NULL DEFAULT '',
      payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS interaction_audit_log_school_idx ON interaction_audit_log(school_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS interaction_audit_log_entity_idx ON interaction_audit_log(school_id, entity_type, entity_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS interaction_alert_dismissals (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      rule_kind TEXT NOT NULL,
      subject_student_id TEXT NOT NULL,
      subject_key TEXT NOT NULL DEFAULT '',
      dismissed_by_staff_id INTEGER,
      dismissed_by_name TEXT NOT NULL DEFAULT '',
      dismiss_reason TEXT NOT NULL DEFAULT '',
      dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS interaction_alert_dismissals_school_idx ON interaction_alert_dismissals(school_id)`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS interaction_alert_dismissals_active_idx ON interaction_alert_dismissals(school_id, rule_kind, subject_student_id, subject_key)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS interaction_quick_entries (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      kind TEXT NOT NULL,
      severity INTEGER NOT NULL DEFAULT 2,
      location TEXT NOT NULL DEFAULT '',
      summary_template TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by_staff_id INTEGER,
      created_by_name TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS interaction_quick_entries_school_idx ON interaction_quick_entries(school_id)`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS interaction_quick_entries_school_label_idx ON interaction_quick_entries(school_id, label)`);

  // ---- Statement-first rework migration (additive) -------------------
  // 1) interaction_cases.lead_statement_id — the originating witness
  //    statement that triggered the case. Backfilled to the earliest
  //    attached interaction so existing cases get a sensible "Lead".
  await db.execute(sql`ALTER TABLE interaction_cases ADD COLUMN IF NOT EXISTS lead_statement_id INTEGER`);
  await db.execute(sql`
    UPDATE interaction_cases c
       SET lead_statement_id = sub.first_id
      FROM (
        SELECT case_id, MIN(id) AS first_id
          FROM interactions
         WHERE case_id IS NOT NULL
         GROUP BY case_id
      ) sub
     WHERE c.id = sub.case_id
       AND c.lead_statement_id IS NULL
  `);
  // 2) interactions.dismissed_* — triage dismissal metadata. Status
  //    'dismissed' moves the row out of intake but keeps it for audit.
  await db.execute(sql`ALTER TABLE interactions ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ`);
  await db.execute(sql`ALTER TABLE interactions ADD COLUMN IF NOT EXISTS dismissed_reason TEXT NOT NULL DEFAULT ''`);
  await db.execute(sql`ALTER TABLE interactions ADD COLUMN IF NOT EXISTS dismissed_by_staff_id INTEGER`);
  await db.execute(sql`ALTER TABLE interactions ADD COLUMN IF NOT EXISTS dismissed_by_name TEXT NOT NULL DEFAULT ''`);
  // 3) interactions.witness_student_* — the student who authored the
  //    statement. Required at the UI level for new entries, nullable
  //    in the DB so legacy/seed rows without a recorded author keep
  //    loading.
  await db.execute(sql`ALTER TABLE interactions ADD COLUMN IF NOT EXISTS witness_student_id TEXT`);
  await db.execute(sql`ALTER TABLE interactions ADD COLUMN IF NOT EXISTS witness_student_name TEXT NOT NULL DEFAULT ''`);
}

// Per-school default quick-entry catalog. Idempotent: only seeds when
// the school has zero entries. Safe to re-run every boot.
export async function seedWatchlistQuickEntriesIfEmpty(): Promise<void> {
  await ensureWatchlistSchema();
  const schools = await db.select().from(schoolsTable);
  const defaults: Array<{
    label: string;
    kind: string;
    severity: number;
    location: string;
    summaryTemplate: string;
  }> = [
    { label: "Hallway shove", kind: "verbal", severity: 2, location: "Hallway", summaryTemplate: "Brief shove between students in the hallway during passing period." },
    { label: "Cafeteria verbal", kind: "verbal", severity: 2, location: "Cafeteria", summaryTemplate: "Verbal exchange in the cafeteria — words exchanged, no contact." },
    { label: "Lunch line cut / dispute", kind: "verbal", severity: 1, location: "Cafeteria", summaryTemplate: "Lunch line dispute — staff intervened." },
    { label: "Classroom disruption", kind: "class_disruption", severity: 2, location: "Classroom", summaryTemplate: "Disruption during class — student redirected." },
    { label: "Bus 14 incident", kind: "verbal", severity: 2, location: "Bus 14", summaryTemplate: "Reported incident on bus route — driver flagged." },
    { label: "Rumor heard from peers", kind: "rumor", severity: 1, location: "", summaryTemplate: "Secondhand rumor reported by peers — flagged for monitoring." },
    { label: "Locker / property damage", kind: "property", severity: 3, location: "Hallway", summaryTemplate: "Property damage reported — student belongings affected." },
    { label: "Physical fight", kind: "fight", severity: 4, location: "", summaryTemplate: "Physical altercation between students. Staff separated." },
    { label: "Threat reported", kind: "threat", severity: 4, location: "", summaryTemplate: "Threat reported by student/staff — under investigation." },
    { label: "Witnessed only (peripheral)", kind: "peripheral_note", severity: 1, location: "", summaryTemplate: "Witnessed nearby only — no direct involvement." },
  ];
  for (const school of schools) {
    const [{ c }] = (
      await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM interaction_quick_entries WHERE school_id = ${school.id}`,
      )
    ).rows as { c: number }[];
    if (c > 0) continue;
    await db.insert(interactionQuickEntriesTable).values(
      defaults.map((d, i) => ({
        schoolId: school.id,
        label: d.label,
        kind: d.kind,
        severity: d.severity,
        location: d.location,
        summaryTemplate: d.summaryTemplate,
        sortOrder: i,
        createdByName: "System (seed)",
      })),
    );
  }
}

// Tier-preset table + the three built-in Basic/Pro/Enterprise rows.
// Idempotent: existing rows are kept (in case the user has edited the
// preset's feature_keys) but missing rows are inserted.
// Onboarding checklist state. One row per (school_id, step_key) — created
// lazily the first time an admin manually toggles the step. Auto-detected
// statuses are computed at read-time from other tables, never stored here.
export async function ensureOnboardingChecklistSchema() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS onboarding_checklist_state (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      step_key TEXT NOT NULL,
      manual_checked BOOLEAN NOT NULL DEFAULT FALSE,
      completed_by_staff_id INTEGER,
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS onboarding_checklist_school_step_uq ON onboarding_checklist_state (school_id, step_key)`,
  );
}

// Generic mentions index for free-text fields on a discipline case
// (witness statements first; video-evidence notes and case notes later).
// Always rebuildable from the source body, so we don't worry about
// downtime — the table is an index, not a source of truth.
export async function ensureCaseMentionsSchema() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS case_mentions (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      source_kind TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      case_id INTEGER,
      student_id TEXT NOT NULL,
      display_name_at_time TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS case_mentions_school_idx ON case_mentions (school_id)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS case_mentions_source_idx ON case_mentions (source_kind, source_id)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS case_mentions_student_idx ON case_mentions (school_id, student_id)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS case_mentions_case_idx ON case_mentions (school_id, case_id)`,
  );
}

// Admin-only video evidence catalogue for a case (Phase 2 of the case
// enhancement suite). Append-only at the row level (rows can be edited
// or deleted but the audit log captures the change). Indexes target
// the two common reads: "all evidence on this case" and "label
// typeahead within this school".
export async function ensureCaseVideoEvidenceSchema() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS case_video_evidence (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      case_id INTEGER NOT NULL,
      camera_label TEXT NOT NULL,
      timestamp_start TIMESTAMPTZ NOT NULL,
      timestamp_end TIMESTAMPTZ,
      source_url TEXT,
      notes TEXT,
      logged_by_staff_id INTEGER,
      logged_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS case_video_evidence_case_idx ON case_video_evidence (school_id, case_id)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS case_video_evidence_school_label_idx ON case_video_evidence (school_id, camera_label)`,
  );
}

// (clip × player) junction for Phase 2.1 — confidence-rated linkage of
// a student to a video clip. See lib/db/src/schema/caseVideoEvidencePlayers.ts
// for the rationale on the closed-enum confidence tier and the
// orthogonal `cleared_by_footage` flag.
export async function ensureCaseVideoEvidencePlayersSchema() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS case_video_evidence_players (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      evidence_id INTEGER NOT NULL,
      case_id INTEGER NOT NULL,
      student_id TEXT NOT NULL,
      confidence TEXT NOT NULL,
      cleared_by_footage BOOLEAN NOT NULL DEFAULT FALSE,
      reason TEXT,
      set_by_staff_id INTEGER,
      set_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS case_vid_evidence_players_uniq ON case_video_evidence_players (school_id, evidence_id, student_id)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS case_vid_evidence_players_clip_idx ON case_video_evidence_players (school_id, evidence_id)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS case_vid_evidence_players_case_idx ON case_video_evidence_players (school_id, case_id)`,
  );
}

// Per-school registry of named security cameras. See
// lib/db/src/schema/cameraRegistry.ts for the soft-delete + audit
// rationale. Exact-match uniqueness is declared in the schema
// (case_camera_registry_school_name_uidx); case-insensitive
// duplicate detection is enforced in the POST/PATCH routes because
// expression-based unique indexes don't round-trip cleanly through
// the deploy migration tooling (it mis-emits the opclass on the
// lower(name) expression). App-level guard is sufficient — these
// writes are admin-only and infrequent.
export async function ensureCameraRegistrySchema() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS case_camera_registry (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      location TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS case_camera_registry_school_active_idx ON case_camera_registry (school_id, active)`,
  );
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS case_camera_registry_school_name_uidx ON case_camera_registry (school_id, name)`,
  );
  // Drop the legacy expression-based index if a previous boot of the
  // dev DB created it. Production deploys never had this index (the
  // migration that would have created it was the one that failed),
  // so this is a dev-DB-only cleanup.
  await db.execute(
    sql`DROP INDEX IF EXISTS case_camera_registry_school_name_lower_uidx`,
  );
}

// Demo cameras seeded once per school so a freshly-seeded environment
// has a working dropdown out of the box. Skipped if the school already
// has any camera rows so re-seeding doesn't re-add deleted ones.
async function seedDemoCamerasForSchools() {
  const DEMO_CAMERAS: Array<{ name: string; location: string }> = [
    { name: "Cafeteria North", location: "Cafeteria, north entrance" },
    { name: "Main Hallway", location: "Building 1, ground floor" },
    { name: "Gym Entrance", location: "Gymnasium foyer" },
    { name: "Front Office", location: "Administration suite" },
    { name: "Bus Loop", location: "East parking, bus loading zone" },
  ];
  const schools = await db.select().from(schoolsTable);
  for (const school of schools) {
    const [{ c }] = (
      await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM case_camera_registry WHERE school_id = ${school.id}`,
      )
    ).rows as { c: number }[];
    if (c > 0) continue;
    await db.insert(cameraRegistryTable).values(
      DEMO_CAMERAS.map((cam) => ({
        schoolId: school.id,
        name: cam.name,
        location: cam.location,
      })),
    );
  }
}

// Phase 3 (case enhancement suite): AI consistency-check storage. Three
// tables — runs (one row per AI execution, holds the redacted bundle and
// raw output for audit), findings (per-finding rows, including human-
// authored "AI missed this" entries; dismissed rows ARE the suppression
// list for future runs), and state (denormalised per-case latest-run
// snapshot so the header pill is one cheap read). All ADMIN/CORE-TEAM
// only — never joined into teacher/parent/student-facing queries.
export async function ensureCaseConsistencySchema() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS case_consistency_runs (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      case_id INTEGER NOT NULL,
      triggered_by_id INTEGER,
      triggered_by_name TEXT,
      trigger_reason TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      input_bundle_json JSONB NOT NULL,
      raw_output_json JSONB,
      score INTEGER NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      error_text TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS case_consistency_runs_case_idx ON case_consistency_runs (school_id, case_id, created_at)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS case_consistency_runs_hash_idx ON case_consistency_runs (school_id, case_id, prompt_hash)`,
  );

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS case_consistency_findings (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      case_id INTEGER NOT NULL,
      run_id INTEGER,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      summary TEXT NOT NULL,
      detail TEXT,
      cited_source_refs JSONB NOT NULL,
      signature_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      dismissed_by_id INTEGER,
      dismissed_by_name TEXT,
      dismiss_reason TEXT,
      dismiss_note TEXT,
      dismissed_at TIMESTAMPTZ,
      created_by_id INTEGER,
      created_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS case_consistency_findings_case_status_idx ON case_consistency_findings (school_id, case_id, status)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS case_consistency_findings_signature_idx ON case_consistency_findings (school_id, case_id, signature_hash)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS case_consistency_findings_run_idx ON case_consistency_findings (run_id)`,
  );

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS case_consistency_state (
      school_id INTEGER NOT NULL,
      case_id INTEGER NOT NULL,
      latest_run_id INTEGER,
      score INTEGER NOT NULL DEFAULT 100,
      open_finding_count INTEGER NOT NULL DEFAULT 0,
      high_severity_count INTEGER NOT NULL DEFAULT 0,
      last_run_at TIMESTAMPTZ,
      last_attempt_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (school_id, case_id)
    )
  `);

  // Idempotently attach ON DELETE CASCADE foreign keys so that
  // deleting an interaction_case removes its consistency runs,
  // findings, and state row automatically. Wrapped in DO blocks
  // so re-runs are no-ops once the constraints exist.
  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'case_consistency_runs_case_id_fkey'
      ) THEN
        ALTER TABLE case_consistency_runs
          ADD CONSTRAINT case_consistency_runs_case_id_fkey
          FOREIGN KEY (case_id)
          REFERENCES interaction_cases(id) ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'case_consistency_findings_case_id_fkey'
      ) THEN
        ALTER TABLE case_consistency_findings
          ADD CONSTRAINT case_consistency_findings_case_id_fkey
          FOREIGN KEY (case_id)
          REFERENCES interaction_cases(id) ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'case_consistency_findings_run_id_fkey'
      ) THEN
        ALTER TABLE case_consistency_findings
          ADD CONSTRAINT case_consistency_findings_run_id_fkey
          FOREIGN KEY (run_id)
          REFERENCES case_consistency_runs(id) ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'case_consistency_state_case_id_fkey'
      ) THEN
        ALTER TABLE case_consistency_state
          ADD CONSTRAINT case_consistency_state_case_id_fkey
          FOREIGN KEY (case_id)
          REFERENCES interaction_cases(id) ON DELETE CASCADE;
      END IF;
    END$$;
  `);
}

// Footage requests — internal record of "we need this video and have
// asked for it (typically over Microsoft Teams DM to whoever owns the
// camera system)." No outbound integration; the row exists so a stale
// case shows the gap immediately. See lib/db/src/schema/caseFootageRequests.ts
// for column rationale.
export async function ensureCaseFootageRequestsSchema() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS case_footage_requests (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      case_id INTEGER NOT NULL,
      source TEXT NOT NULL,
      location_text TEXT,
      window_start TIMESTAMPTZ NOT NULL,
      window_end TIMESTAMPTZ,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'requested',
      requested_by_staff_id INTEGER,
      requested_by_name TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      fulfilled_by_staff_id INTEGER,
      fulfilled_by_name TEXT,
      fulfilled_at TIMESTAMPTZ,
      fulfillment_note TEXT,
      linked_clip_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS case_footage_requests_case_idx ON case_footage_requests (school_id, case_id, status)`,
  );
  // Cascade-delete with the owning case so deleting a case cleans up
  // its outstanding-footage record instead of orphaning rows.
  await db.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'case_footage_requests_case_id_fkey'
      ) THEN
        ALTER TABLE case_footage_requests
          ADD CONSTRAINT case_footage_requests_case_id_fkey
          FOREIGN KEY (case_id)
          REFERENCES interaction_cases(id) ON DELETE CASCADE;
      END IF;
    END$$;
  `);
}

// Per-school configurable catalog of case-closure outcomes. Seeded with
// the DEFAULT_CASE_OUTCOMES list (no_action, conflict_resolution, etc.)
// the first time a school is touched. Closing a case requires picking
// one of these — see /watchlist/cases/:id/close.
export async function ensureCaseOutcomeCatalogSchema() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS case_outcome_types (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by_name TEXT NOT NULL DEFAULT ''
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS case_outcome_types_school_idx ON case_outcome_types (school_id)`,
  );
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS case_outcome_types_school_code_idx ON case_outcome_types (school_id, code)`,
  );

  // Closure metadata columns on interaction_cases. Additive — safe to
  // run on every boot.
  await db.execute(
    sql`ALTER TABLE interaction_cases ADD COLUMN IF NOT EXISTS outcome_code TEXT`,
  );
  await db.execute(
    sql`ALTER TABLE interaction_cases ADD COLUMN IF NOT EXISTS outcome_note TEXT NOT NULL DEFAULT ''`,
  );
  await db.execute(
    sql`ALTER TABLE interaction_cases ADD COLUMN IF NOT EXISTS closed_by_staff_id INTEGER`,
  );
  await db.execute(
    sql`ALTER TABLE interaction_cases ADD COLUMN IF NOT EXISTS closed_by_name TEXT NOT NULL DEFAULT ''`,
  );

  // Seed the default catalog into every school that doesn't have any
  // outcomes yet. We only seed when the school's catalog is empty so an
  // admin who has retired one of the defaults isn't punished by having
  // it silently re-added on the next boot.
  const schools = await db.select({ id: schoolsTable.id }).from(schoolsTable);
  for (const s of schools) {
    const [{ c }] = (
      await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM case_outcome_types WHERE school_id = ${s.id}`,
      )
    ).rows as { c: number }[];
    if (c > 0) continue;
    for (const o of DEFAULT_CASE_OUTCOMES) {
      await db
        .insert(caseOutcomeTypesTable)
        .values({
          schoolId: s.id,
          code: o.code,
          label: o.label,
          description: o.description,
          sortOrder: o.sortOrder,
          createdByName: "system (seeded default)",
        })
        .onConflictDoNothing();
    }
  }
}

export async function ensureTierPresetsSchema() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS tier_presets (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      is_built_in BOOLEAN NOT NULL DEFAULT FALSE,
      feature_keys JSONB NOT NULL DEFAULT '[]'::jsonb
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS tier_presets_name_unique ON tier_presets (name)`,
  );

  // Catalog used by the built-in presets. These strings are the
  // FeatureKey PascalCase names from routes/schoolSettings.ts.
  const ALL_FEATURES = [
    "FamilyComm",
    "Pbis",
    "SchoolStore",
    "Accommodations",
    "LogIntervention",
    "RequestPullout",
    "HallPasses",
    "TardyPass",
    "MtssPlans",
    "BehaviorSpecialist",
    "IssDashboard",
    "Displays",
    "BellSchedule",
    "EarlyWarning",
    "Academics",
    "DataImports",
    "Houses",
    "ParentPortal",
  ];
  const builtIns: Array<{
    name: string;
    description: string;
    featureKeys: string[];
  }> = [
    {
      name: "Basic",
      description:
        "Hall Passes, Tardy Pass, Family Communication, PBIS Points. Good for small pilots.",
      featureKeys: ["HallPasses", "TardyPass", "FamilyComm", "Pbis"],
    },
    {
      name: "Pro",
      description:
        "Basic plus PBIS Store, Accommodations, MTSS Plans, ISS Dashboard, Displays, Houses.",
      featureKeys: [
        "HallPasses",
        "TardyPass",
        "FamilyComm",
        "Pbis",
        "SchoolStore",
        "Accommodations",
        "LogIntervention",
        "RequestPullout",
        "MtssPlans",
        "IssDashboard",
        "Displays",
        "Houses",
        "BellSchedule",
        "ParentPortal",
      ],
    },
    {
      name: "Enterprise",
      description: "Everything PulseEDU has — full feature suite.",
      featureKeys: ALL_FEATURES,
    },
  ];
  for (const p of builtIns) {
    await db.execute(sql`
      INSERT INTO tier_presets (name, description, is_built_in, feature_keys)
      VALUES (${p.name}, ${p.description}, TRUE, ${JSON.stringify(p.featureKeys)}::jsonb)
      ON CONFLICT (name) DO UPDATE
        SET is_built_in = TRUE
    `);
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
  // ---------------------------------------------------------------------------
  // FAST Phase 1 (Florida xlsx parser): widen the upsert key to include
  // school_year so admins can backfill prior PM windows without
  // clobbering current-year rows.
  //
  // 1. Add the school_year TEXT column (default '' for legacy rows).
  // 2. Backfill legacy rows to the current school-year label so the
  //    new unique index has a sane partition. Done once — the WHERE
  //    school_year = '' guard makes subsequent boots a no-op.
  // 3. Drop the old (school_id, student_id, subject) unique index and
  //    create the wider one. Drizzle-kit would prompt to "rename" —
  //    direct SQL sidesteps that.
  // ---------------------------------------------------------------------------
  await db.execute(
    sql`ALTER TABLE student_fast_scores ADD COLUMN IF NOT EXISTS school_year TEXT NOT NULL DEFAULT ''`,
  );
  const currentYearLabel = schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ);
  await db.execute(
    sql`UPDATE student_fast_scores SET school_year = ${currentYearLabel} WHERE school_year = ''`,
  );
  await db.execute(
    sql`DROP INDEX IF EXISTS student_fast_scores_student_subject_unique`,
  );
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS student_fast_scores_student_subject_year_unique ON student_fast_scores (school_id, student_id, subject, school_year)`,
  );
}

// ---------------------------------------------------------------------------
// FAST Phase 1: per-item benchmark response storage for the Florida
// xlsx parser. One row per (student × administration × benchmark).
// Indexed for the two read patterns: per-student profile drill-down and
// per-benchmark heatmap.
// ---------------------------------------------------------------------------
export async function ensureFastItemResponsesSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS student_fast_item_responses (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      student_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      school_year TEXT NOT NULL,
      "window" TEXT NOT NULL,
      administered_at TIMESTAMPTZ,
      category TEXT,
      benchmark_code TEXT NOT NULL,
      points_earned INTEGER,
      points_possible INTEGER,
      item_seq INTEGER NOT NULL,
      import_job_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS student_fast_item_responses_school_idx ON student_fast_item_responses (school_id)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS student_fast_item_responses_student_idx ON student_fast_item_responses (school_id, student_id, subject, school_year)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS student_fast_item_responses_benchmark_idx ON student_fast_item_responses (school_id, benchmark_code, school_year)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS student_fast_item_responses_job_idx ON student_fast_item_responses (import_job_id)`,
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
  await ensureAdminHubSchema();
  await ensureTierPresetsSchema();
  await ensureOnboardingChecklistSchema();
  await ensureCaseMentionsSchema();
  await ensureCaseVideoEvidenceSchema();
  await ensureCaseVideoEvidencePlayersSchema();
  await ensureCameraRegistrySchema();
  await seedDemoCamerasForSchools();
  await ensureCaseConsistencySchema();
  await ensureCaseFootageRequestsSchema();
  await ensureCaseOutcomeCatalogSchema();
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
function parseGrade(g: string | number | null | undefined): number | null {
  if (g == null) return null;
  if (typeof g === "number") return Number.isInteger(g) ? g : null;
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

    // ---- Daily attendance ----
    // One row per (student, school day). Powers the Attendance dashboard
    // (ADA, excused vs unexcused, chronic absenteeism > 10%) and feeds
    // every other surface that mentions attendance.
    //
    // Status mix per draw (school-wide background rate):
    //   present 92% / tardy 5% / excused 2.5% / unexcused 0.5%
    //
    // ~7% of students are tagged "chronic" — those students re-roll absent
    // ~22% of the time so their personal absence rate clears the 10%
    // threshold. Tardies are also recorded here (in addition to the tardies
    // table) since FL counts tardies-as-attendance for chronic-absence
    // accounting, but the Attendance KPI splits them out so the user can
    // see both.
    const [{ c: attExisting }] = (
      await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM student_attendance_day WHERE school_id = ${school.id}`,
      )
    ).rows as { c: number }[];

    if (attExisting <= ENGAGEMENT_SEED_THRESHOLD) {
      type AttIns = typeof studentAttendanceDayTable.$inferInsert;
      const inserts: AttIns[] = [];

      // Pick the chronic cohort deterministically from the same RNG so
      // re-seeding produces the same kids on the chronic list.
      const chronicSet = new Set<string>();
      const chronicTarget = Math.max(
        1,
        Math.round(studentIds.length * 0.07),
      );
      // Sample without replacement.
      const pool = studentIds.slice();
      for (let i = 0; i < chronicTarget && pool.length > 0; i++) {
        const idx = Math.floor(rng() * pool.length);
        chronicSet.add(pool.splice(idx, 1)[0]);
      }

      for (let back = 60; back >= 0; back--) {
        const day = new Date(now.getTime() - back * dayMs);
        if (!isSchoolDay(day)) continue;
        const dayStr = day.toISOString().slice(0, 10);
        for (const sid of studentIds) {
          const isChronic = chronicSet.has(sid);
          const r = rng();
          let status: "present" | "tardy" | "excused" | "unexcused";
          let absentPeriods: number[] = [];
          if (isChronic) {
            // Chronic: ~14% absent (5% unexcused + 9% excused) — comfortably
            // above the FL >10% chronic-absence threshold while keeping the
            // school-wide overall mix close to the target ~92/5/2.5/0.5.
            // ~4% tardy. Rest present.
            if (r < 0.05) {
              status = "unexcused";
              absentPeriods = [1, 2, 3, 4, 5, 6, 7];
            } else if (r < 0.14) {
              status = "excused";
              absentPeriods = [1, 2, 3, 4, 5, 6, 7];
            } else if (r < 0.18) {
              status = "tardy";
              absentPeriods = [1];
            } else {
              status = "present";
            }
          } else {
            if (r < 0.005) {
              status = "unexcused";
              absentPeriods = [1, 2, 3, 4, 5, 6, 7];
            } else if (r < 0.03) {
              status = "excused";
              absentPeriods = [1, 2, 3, 4, 5, 6, 7];
            } else if (r < 0.08) {
              status = "tardy";
              // Tardies usually only knock out the first period.
              absentPeriods = [1];
            } else {
              status = "present";
            }
          }
          inserts.push({
            schoolId: school.id,
            studentId: sid,
            day: dayStr,
            status,
            absentPeriods,
          });
        }
      }

      if (inserts.length > 0) {
        await db.transaction(async (tx) => {
          for (let i = 0; i < inserts.length; i += 500) {
            await tx
              .insert(studentAttendanceDayTable)
              .values(inserts.slice(i, i + 500))
              .onConflictDoNothing();
          }
        });
        // Realized distribution from the planned inserts so we can spot
        // drift from the target ~92/5/2.5/0.5 if the RNG / chronic-cohort
        // weights are ever retuned.
        const total = inserts.length;
        const counts = { present: 0, tardy: 0, excused: 0, unexcused: 0 };
        for (const row of inserts) counts[row.status as keyof typeof counts]++;
        const pct = (n: number) => Math.round((n / total) * 1000) / 10;
        logger.info(
          {
            schoolId: school.id,
            count: total,
            chronic: chronicSet.size,
            chronicPct: Math.round((chronicSet.size / studentIds.length) * 1000) / 10,
            distribution: {
              presentPct: pct(counts.present),
              tardyPct: pct(counts.tardy),
              excusedPct: pct(counts.excused),
              unexcusedPct: pct(counts.unexcused),
            },
          },
          "[seed] student_attendance_day demo events seeded",
        );
      }
    }

    // ---- Weather ----
    // Pull ~62 days of daily weather (matches the attendance window) for
    // any school that has lat/lon set. Cached in weather_day so we don't
    // re-hit Open-Meteo on every restart. Network failures are treated
    // as "skip silently" — the dashboard just won't show a weather card
    // until the next restart that succeeds.
    if (school.latitude != null && school.longitude != null) {
      const [{ c: wxExisting }] = (
        await db.execute(
          sql`SELECT COUNT(*)::int AS c FROM weather_day WHERE school_id = ${school.id}`,
        )
      ).rows as { c: number }[];
      if (wxExisting <= ENGAGEMENT_SEED_THRESHOLD) {
        try {
          const wx = await fetchWeatherForLocation({
            latitude: school.latitude,
            longitude: school.longitude,
            pastDays: 62,
            timezone: school.timezone,
          });
          if (wx.length > 0) {
            type WxIns = typeof weatherDayTable.$inferInsert;
            const wxInserts: WxIns[] = wx.map((d) => ({
              schoolId: school.id,
              day: d.day,
              tempHighF: d.tempHighF,
              tempLowF: d.tempLowF,
              precipInches: d.precipInches,
              weatherCode: d.weatherCode,
              summary: d.summary,
            }));
            await db
              .insert(weatherDayTable)
              .values(wxInserts)
              .onConflictDoNothing();
            logger.info(
              { schoolId: school.id, count: wxInserts.length },
              "[seed] weather_day demo events seeded",
            );
          } else {
            logger.warn(
              { schoolId: school.id },
              "[seed] weather fetch returned empty — skipping (dashboard will show 'no data')",
            );
          }
        } catch (err) {
          logger.warn(
            { schoolId: school.id, err: String(err) },
            "[seed] weather fetch threw — skipping",
          );
        }
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
// ensureSpotlightPbisReason: idempotently makes sure every school has a
// "Class Participation (Spotlight)" reason in pbis_reasons. Spotlight's
// "Correct!" flow files awards under this reason so admins can see in
// reports how many points came from Spotlight vs Hall Pass vs other
// channels. Runs at boot AFTER the catalog seed, so even hand-curated
// schools get this row added without disturbing their existing reasons.
// -----------------------------------------------------------------------------
export const SPOTLIGHT_PBIS_REASON_NAME = "Class Participation (Spotlight)";

export async function ensureSpotlightPbisReason() {
  const schools = await db.select().from(schoolsTable);
  for (const school of schools) {
    const [existing] = await db
      .select({ id: pbisReasonsTable.id })
      .from(pbisReasonsTable)
      .where(
        and(
          eq(pbisReasonsTable.schoolId, school.id),
          eq(pbisReasonsTable.name, SPOTLIGHT_PBIS_REASON_NAME),
        ),
      );
    if (existing) continue;
    await db.insert(pbisReasonsTable).values({
      schoolId: school.id,
      name: SPOTLIGHT_PBIS_REASON_NAME,
      category: "Effort",
      defaultPoints: 5,
      polarity: "positive",
      sortOrder: 100,
      ownerScope: "school",
    });
    logger.info(
      { schoolId: school.id },
      "[seed] spotlight pbis reason ensured",
    );
  }
}

// -----------------------------------------------------------------------------
// seedSeparationReasonTagsIfEmpty: per-school starter catalog of "do not
// pair" tags for the Separation Suggestions feature. The Behavior
// Specialist curates this list going forward, but every new school needs a
// reasonable starting vocabulary so teachers see useful chips on day one
// instead of an empty dropdown that pushes them to type free text (which
// destroys aggregability for next year's scheduling team). Empty-only
// policy: a school with even one hand-curated tag is left alone.
// -----------------------------------------------------------------------------

const SEPARATION_REASON_DEFAULTS = [
  "Verbal conflict",
  "Physical altercation history",
  "Bullying / target dynamic",
  "Negative peer influence",
  "Disruptive when together",
  "Off-task when paired",
  "Romantic relationship",
  "Family conflict (siblings / cousins)",
  "Cliques / exclusion behavior",
  "Cheating / academic integrity concern",
  "Safety concern",
  "Prior administrative referral together",
];

export async function seedSeparationReasonTagsIfEmpty() {
  const schools = await db.select().from(schoolsTable);
  if (schools.length === 0) return;

  for (const school of schools) {
    const [{ c: existing }] = (
      await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM separation_reason_tags WHERE school_id = ${school.id}`,
      )
    ).rows as { c: number }[];
    if (existing > 0) continue;

    const inserts: (typeof separationReasonTagsTable.$inferInsert)[] =
      SEPARATION_REASON_DEFAULTS.map((label, i) => ({
        schoolId: school.id,
        label,
        sortOrder: i,
        active: true,
      }));
    await db.insert(separationReasonTagsTable).values(inserts);
    logger.info(
      { schoolId: school.id, count: inserts.length },
      "[seed] separation_reason_tags starter catalog seeded",
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
// seedStudentDemographicsIfEmpty: populate students.ell / ese / is_504 /
// gender so the SEB/SEL and Equity dashboards have demographic signal to
// disaggregate against. Runs idempotently per-school: skip the whole school
// the moment ANY student in that school already has a demographic flag set
// or a non-NULL gender (avoids stomping a real roster import).
//
// IMPORTANT — DEMO-ONLY CORRELATIONS:
// Real district demos hinge on the Equity dashboard surfacing realistic
// disparity ratios (1.3x–1.7x range). Pure-random seeding produces only
// statistical noise across 9,750 students. So this seeder applies *mild*
// intentional correlations to existing risk signals (FAST BQ + recent-30d
// negative PBIS counts) chosen to match documented real-world patterns:
//
//   * ELL students slightly over-represented among BQ + chronic-negative-PBIS
//     cohorts (mirrors language-acquisition academic gap).
//   * IEP (ese) students slightly over-represented among chronic-negative-
//     PBIS cohorts (mirrors documented special-ed discipline disparities).
//   * 504 mostly independent, with a small math-BQ bump.
//   * Gender ~50/50 with ~1% NULL preserved as an "unknown" bucket. NO
//     correlation to outcomes — gender disparities surfaced by the dashboard
//     would be pure noise on this seed and the demo script should say so.
//
// These correlations are *seed* artifacts. Real production data will reflect
// each school's actual disparities. The Equity dashboard footer carries a
// disclaimer to that effect.
// -----------------------------------------------------------------------------

export async function seedStudentDemographicsIfEmpty() {
  const schools = await db.select().from(schoolsTable);
  if (schools.length === 0) return;

  const now = Date.now();
  const dayMs = 86400000;
  const windowStartIso = new Date(now - 30 * dayMs).toISOString();

  for (const school of schools) {
    // ---- Two-stage idempotency check (architect-hardened).
    //
    // Stage 1: skip if ANY student in this school already has a demographic
    // flag set or a non-NULL gender. Catches prior runs of this seeder.
    //
    // Stage 2: skip if this school has NO demo-seeded marker. A real SIS-
    // imported roster could legitimately have students with all-false
    // demographic booleans + NULL gender (a valid "no demographics imported
    // yet" state) and the Stage 1 check alone would let this seeder
    // overwrite that real data with random demo flags. So we additionally
    // gate on `school_accommodations` being non-empty — that table is
    // populated exclusively by `seedIfEmpty()` on the demo schools, so a
    // production school that hasn't been demo-seeded will skip even on a
    // first run. If a real customer ever wants demo demographics, they'd
    // run a separate explicit one-time backfill, not boot-time seed.
    const [{ c: alreadySet }] = (
      await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM students
            WHERE school_id = ${school.id}
              AND (ell = true OR ese = true OR is_504 = true OR gender IS NOT NULL)`,
      )
    ).rows as { c: number }[];
    if (alreadySet > 0) continue;

    const [{ c: demoMarker }] = (
      await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM school_accommodations
            WHERE school_id = ${school.id}`,
      )
    ).rows as { c: number }[];
    if (demoMarker === 0) {
      logger.info(
        { schoolId: school.id },
        "[seed] skipping demographic seed — school has no demo marker (likely a real SIS-imported school)",
      );
      continue;
    }

    const studentRows = await db
      .select({ studentId: studentsTable.studentId })
      .from(studentsTable)
      .where(eq(studentsTable.schoolId, school.id));
    if (studentRows.length === 0) continue;

    // ---- Pull correlation inputs in one shot.
    // BQ flag per student, split by subject (ela / math / any).
    const fastRows = await db
      .select({
        studentId: studentFastScoresTable.studentId,
        subject: studentFastScoresTable.subject,
        priorYearBq: studentFastScoresTable.priorYearBq,
      })
      .from(studentFastScoresTable)
      .where(eq(studentFastScoresTable.schoolId, school.id));
    const bqAny = new Set<string>();
    const bqMath = new Set<string>();
    for (const fs of fastRows) {
      if (!fs.priorYearBq) continue;
      bqAny.add(fs.studentId);
      if (fs.subject === "math") bqMath.add(fs.studentId);
    }

    // Recent-30d negative PBIS count per student.
    const negRows = (
      await db.execute(
        sql`SELECT student_id, COUNT(*)::int AS c
            FROM pbis_entries
            WHERE school_id = ${school.id}
              AND polarity = 'negative'
              AND voided_at IS NULL
              AND created_at >= ${windowStartIso}
            GROUP BY student_id`,
      )
    ).rows as { student_id: string; c: number }[];
    const negCount = new Map<string, number>();
    for (const r of negRows) negCount.set(r.student_id, r.c);

    // Deterministic per-school RNG so reseeds reproduce the same dataset.
    const rng = makeRng(0xde40 + school.id * 8191);

    // ---- Group updates by combination so we issue at most ~24 UPDATEs
    // per school instead of N=cohort-size individual statements.
    type Combo = {
      ell: boolean;
      ese: boolean;
      is504: boolean;
      gender: "M" | "F" | null;
    };
    const buckets = new Map<string, { combo: Combo; ids: string[] }>();
    const keyOf = (c: Combo) =>
      `${c.ell ? 1 : 0}:${c.ese ? 1 : 0}:${c.is504 ? 1 : 0}:${c.gender ?? "U"}`;

    let countEll = 0;
    let countEse = 0;
    let count504 = 0;
    let countF = 0;
    let countM = 0;
    let countU = 0;

    for (const s of studentRows) {
      const isBqAny = bqAny.has(s.studentId);
      const isBqMath = bqMath.has(s.studentId);
      const negs = negCount.get(s.studentId) ?? 0;

      // ---- ELL: base 12% + 8pts if BQ-any + 6pts if recent-negs ≥ 3.
      let pEll = 0.12;
      if (isBqAny) pEll += 0.08;
      if (negs >= 3) pEll += 0.06;
      const ell = rng() < pEll;

      // ---- ESE (IEP): base 14% + 12pts if recent-negs ≥ 5 + 5pts if BQ.
      let pEse = 0.14;
      if (negs >= 5) pEse += 0.12;
      if (isBqAny) pEse += 0.05;
      const ese = rng() < pEse;

      // ---- 504: base 4% + 3pts if math BQ specifically.
      let p504 = 0.04;
      if (isBqMath) p504 += 0.03;
      const is504 = rng() < p504;

      // ---- Gender: M ~49.5% / F ~49.5% / NULL ~1%. No outcome correlation.
      const g = rng();
      const gender: "M" | "F" | null = g < 0.495 ? "M" : g < 0.99 ? "F" : null;

      const combo: Combo = { ell, ese, is504, gender };
      const k = keyOf(combo);
      let bucket = buckets.get(k);
      if (!bucket) {
        bucket = { combo, ids: [] };
        buckets.set(k, bucket);
      }
      bucket.ids.push(s.studentId);

      if (ell) countEll++;
      if (ese) countEse++;
      if (is504) count504++;
      if (gender === "F") countF++;
      else if (gender === "M") countM++;
      else countU++;
    }

    // ---- Issue one UPDATE per combination.
    for (const { combo, ids } of buckets.values()) {
      // Chunk WHERE student_id = ANY($) to keep the parameter under DB limits.
      const CHUNK = 1000;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        await db
          .update(studentsTable)
          .set({
            ell: combo.ell,
            ese: combo.ese,
            is504: combo.is504,
            gender: combo.gender,
          })
          .where(
            and(
              eq(studentsTable.schoolId, school.id),
              inArray(studentsTable.studentId, slice),
            ),
          );
      }
    }

    logger.info(
      {
        schoolId: school.id,
        cohort: studentRows.length,
        ell: countEll,
        ese: countEse,
        s504: count504,
        female: countF,
        male: countM,
        unknownGender: countU,
      },
      "[seed] student demographics seeded (ELL/ESE/504/gender)",
    );
  }
}

// -----------------------------------------------------------------------------
// seedStudentRaceIfEmpty: populate students.race + students.ethnicity so the
// Equity dashboard can disaggregate outcomes by race/ethnicity (the headline
// equity dimension district admins expect to see). Same two-stage idempotency
// contract as seedStudentDemographicsIfEmpty:
//   * Stage 1: skip school if any student already has race OR ethnicity set.
//   * Stage 2: skip school if no demo marker (school_accommodations empty),
//     so a real SIS-imported school is never overwritten with demo data.
//
// 7 race buckets matching K-12 SIS display compatibility (Skyward / Focus
// expose a single race column that can include Hispanic). The separate
// `ethnicity` field carries the federally-required Hispanic-origin Y/N flag
// independent of race per OMB Directive 15.
//
// IMPORTANT — DEMO-ONLY CORRELATIONS:
// Real district equity demos hinge on race-based disparity ratios looking
// realistic (1.3x–1.7x range). We apply mild perturbations to the base
// distribution based on existing risk signals (FAST BQ + recent-30d
// negative PBIS):
//   * Black students slightly over-represented among chronic-negative-PBIS
//     cohorts (mirrors documented K-12 discipline disparities).
//   * Hispanic-race students slightly over-represented among BQ + chronic-
//     negative cohorts (mirrors language-acquisition academic gap;
//     intentionally overlapping with the ELL bumps in
//     seedStudentDemographicsIfEmpty so the same students often carry both
//     flags — this is what real district data looks like).
//   * Asian students slightly under-represented in BQ cohorts (mirrors
//     documented K-12 academic-outcome gap, in the OPPOSITE direction).
//   * Multi / Native / Pacific kept tiny (<5%) to match real FL school
//     demographics; they'll often fall below MIN_GROUP_SIZE=10 and the
//     dashboard's flags table will suppress them.
//
// All correlations are *seed* artifacts. Real production data will reflect
// each district's actual demographics. The Equity dashboard footer carries
// a disclaimer to that effect.
// -----------------------------------------------------------------------------

type RaceKey =
  | "white"
  | "hispanic"
  | "black"
  | "asian"
  | "multi"
  | "native"
  | "pacific";

const RACE_KEYS: RaceKey[] = [
  "white",
  "hispanic",
  "black",
  "asian",
  "multi",
  "native",
  "pacific",
];

// FL composite race weights (out of 1000 — finer than percent for less
// rounding error on the cumulative-pick draw).
const HERNANDO_RACE_WEIGHTS: Record<RaceKey, number> = {
  white: 670,
  hispanic: 200,
  black: 60,
  multi: 40,
  asian: 20,
  native: 5,
  pacific: 5,
};
const PASCO_RACE_WEIGHTS: Record<RaceKey, number> = {
  white: 700,
  hispanic: 170,
  black: 50,
  multi: 40,
  asian: 30,
  native: 5,
  pacific: 5,
};

function pickWeightedRace(
  rng: () => number,
  weights: Record<RaceKey, number>,
): RaceKey {
  let total = 0;
  for (const k of RACE_KEYS) total += Math.max(0, weights[k]);
  if (total <= 0) return "white";
  let pick = rng() * total;
  for (const k of RACE_KEYS) {
    const w = Math.max(0, weights[k]);
    pick -= w;
    if (pick <= 0) return k;
  }
  return "white";
}

export async function seedStudentRaceIfEmpty() {
  const schools = await db
    .select({ id: schoolsTable.id, districtId: schoolsTable.districtId })
    .from(schoolsTable);
  if (schools.length === 0) return;

  // Map districtId → slug so we can pick race weights by district.
  const districtRows = await db.select().from(districtsTable);
  const slugByDistrictId = new Map<number, string>();
  for (const d of districtRows) slugByDistrictId.set(d.id, d.slug);

  const now = Date.now();
  const dayMs = 86400000;
  const windowStartIso = new Date(now - 30 * dayMs).toISOString();

  for (const school of schools) {
    // Stage 2 FIRST: skip schools without the demo marker (real
    // SIS-imported schools never get demo race/ethnicity). This is the
    // safety boundary that protects real district data.
    const [{ c: demoMarker }] = (
      await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM school_accommodations
            WHERE school_id = ${school.id}`,
      )
    ).rows as { c: number }[];
    if (demoMarker === 0) {
      logger.info(
        { schoolId: school.id },
        "[seed] skipping race seed — school has no demo marker (likely a real SIS-imported school)",
      );
      continue;
    }

    // Stage 1 (RESUMABLE — architect-flagged): only target students whose
    // race IS NULL. This way an interrupted seed (or a partial external
    // import that left some rows NULL) can be completed on the next boot
    // without overwriting any already-set values. If every student already
    // has race set we skip the school entirely (early-out optimization).
    const studentRows = await db
      .select({ studentId: studentsTable.studentId })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, school.id),
          isNull(studentsTable.race),
        ),
      );
    if (studentRows.length === 0) {
      logger.info(
        { schoolId: school.id },
        "[seed] skipping race seed — all students in school already have race set",
      );
      continue;
    }

    // Correlation inputs — same shape as seedStudentDemographicsIfEmpty.
    const fastRows = await db
      .select({
        studentId: studentFastScoresTable.studentId,
        priorYearBq: studentFastScoresTable.priorYearBq,
      })
      .from(studentFastScoresTable)
      .where(eq(studentFastScoresTable.schoolId, school.id));
    const bqAny = new Set<string>();
    for (const fs of fastRows) {
      if (fs.priorYearBq) bqAny.add(fs.studentId);
    }

    const negRows = (
      await db.execute(
        sql`SELECT student_id, COUNT(*)::int AS c
            FROM pbis_entries
            WHERE school_id = ${school.id}
              AND polarity = 'negative'
              AND voided_at IS NULL
              AND created_at >= ${windowStartIso}
            GROUP BY student_id`,
      )
    ).rows as { student_id: string; c: number }[];
    const negCount = new Map<string, number>();
    for (const r of negRows) negCount.set(r.student_id, r.c);

    // Pick base race distribution by district slug.
    const districtSlug = slugByDistrictId.get(school.districtId) ?? "";
    const baseWeights = /pasco/i.test(districtSlug)
      ? PASCO_RACE_WEIGHTS
      : HERNANDO_RACE_WEIGHTS;

    const rng = makeRng(0xface00 + school.id * 4099);

    type Combo = { race: RaceKey; ethnicity: "hispanic" | "non_hispanic" };
    const buckets = new Map<string, { combo: Combo; ids: string[] }>();
    const counts: Record<RaceKey, number> = {
      white: 0,
      hispanic: 0,
      black: 0,
      asian: 0,
      multi: 0,
      native: 0,
      pacific: 0,
    };
    let ethHisp = 0;

    for (const s of studentRows) {
      const isBq = bqAny.has(s.studentId);
      const negs = negCount.get(s.studentId) ?? 0;

      // Apply mild bumps as weight perturbations on a copy of the base
      // distribution so each student's draw is independently biased.
      const w: Record<RaceKey, number> = { ...baseWeights };
      if (negs >= 5) {
        // Chronic-negative students: shift +30 (3pp) from white to black.
        w.white -= 30;
        w.black += 30;
      }
      if (isBq && negs >= 3) {
        // BQ + chronic-negative: shift +30 (3pp) from white to hispanic.
        w.white -= 30;
        w.hispanic += 30;
      }
      if (isBq) {
        // Mild Asian under-representation in BQ cohort.
        const shift = Math.min(5, w.asian);
        w.asian -= shift;
        w.white += shift;
      }

      const race = pickWeightedRace(rng, w);
      counts[race] += 1;

      // Ethnicity correlated with race: race=hispanic → eth=hispanic ~95%,
      // else ~2% (matches real-world federal-Q1 variance: a small share of
      // non-Hispanic-race students still claim Hispanic origin).
      const ethnicity: "hispanic" | "non_hispanic" =
        race === "hispanic"
          ? rng() < 0.95
            ? "hispanic"
            : "non_hispanic"
          : rng() < 0.02
            ? "hispanic"
            : "non_hispanic";
      if (ethnicity === "hispanic") ethHisp += 1;

      const key = `${race}:${ethnicity}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { combo: { race, ethnicity }, ids: [] };
        buckets.set(key, bucket);
      }
      bucket.ids.push(s.studentId);
    }

    // Issue one UPDATE per (race × ethnicity) combination, chunked to keep
    // the parameter list under DB limits. ~14 combinations max per school.
    for (const { combo, ids } of buckets.values()) {
      const CHUNK = 1000;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        await db
          .update(studentsTable)
          .set({ race: combo.race, ethnicity: combo.ethnicity })
          .where(
            and(
              eq(studentsTable.schoolId, school.id),
              inArray(studentsTable.studentId, slice),
            ),
          );
      }
    }

    logger.info(
      {
        schoolId: school.id,
        cohort: studentRows.length,
        ...counts,
        ethnicityHispanic: ethHisp,
      },
      "[seed] student race/ethnicity seeded",
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
  // Per-period "counts toward parent on-time streak" toggle. Defaults
  // TRUE so existing schedules keep behaving (every period counted)
  // until a Core Team member opts a period out (e.g. lunch, passing).
  await db.execute(sql`
    ALTER TABLE bell_schedule_periods
    ADD COLUMN IF NOT EXISTS included_in_on_time_streak BOOLEAN NOT NULL DEFAULT TRUE
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
  await db.delete(studentAttendanceDayTable);
  await db.delete(weatherDayTable);
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
    const insertedStudents = await chunkedInsertReturning<
      typeof studentsTable.$inferSelect
    >(studentsTable, studentRows, 500);

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
    const insertedSections = await chunkedInsertReturning<
      typeof classSectionsTable.$inferSelect
    >(classSectionsTable, sectionRows, 500);

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

// -----------------------------------------------------------------------------
// Safety Plans demo seed.
//
// Two-step idempotent seed:
//   1. Library: every school gets the 7 default built-in items
//      (Clear backpack / No sharp objects / Escort to bathroom / etc).
//      Skipped per-school once any row exists.
//   2. Per-student plans: ~10% of each school's students get an active
//      plan, AND we guarantee each teacher in the school has at least
//      one student-with-plan on their roster (so the SP pill shows up
//      on every teacher's roster on day-1 of the demo).
//      Skipped per-school once any plan exists.
// -----------------------------------------------------------------------------

const DEFAULT_SAFETY_PLAN_LIBRARY: { label: string; sortOrder: number }[] = [
  { label: "Clear backpack required", sortOrder: 10 },
  { label: "No sharp objects (including pencils with metal points)", sortOrder: 20 },
  { label: "Escort to bathroom", sortOrder: 30 },
  { label: "Escort between classes", sortOrder: 40 },
  { label: "No outside food or drink", sortOrder: 50 },
  { label: "Daily check-in with counselor", sortOrder: 60 },
  { label: "Locker access restricted", sortOrder: 70 },
];

export async function seedSafetyPlanLibraryIfEmpty(): Promise<void> {
  const schools = await db.select({ id: schoolsTable.id }).from(schoolsTable);
  for (const s of schools) {
    const [{ n }] = (await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM safety_plan_library WHERE school_id = ${s.id}`,
    )).rows as { n: number }[];
    if (n > 0) continue;
    await db.insert(safetyPlanLibraryTable).values(
      DEFAULT_SAFETY_PLAN_LIBRARY.map((it) => ({
        schoolId: s.id,
        label: it.label,
        isBuiltIn: true,
        active: true,
        sortOrder: it.sortOrder,
      })),
    );
  }
  logger.info({ schools: schools.length }, "[seed] safety plan library ensured");
}

export async function seedSafetyPlansIfEmpty(): Promise<void> {
  const schools = await db.select({ id: schoolsTable.id }).from(schoolsTable);
  for (const s of schools) {
    const [{ n }] = (await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM safety_plans WHERE school_id = ${s.id}`,
    )).rows as { n: number }[];
    if (n > 0) continue;

    const rng = makeRng(0xa5a5a5 + s.id * 1009);

    // Library labels available to draw from. Falls back to defaults if
    // somehow not seeded (defensive — library seed runs first).
    const libRows = await db
      .select()
      .from(safetyPlanLibraryTable)
      .where(eq(safetyPlanLibraryTable.schoolId, s.id));
    const libLabels = libRows.length
      ? libRows.map((r) => r.label)
      : DEFAULT_SAFETY_PLAN_LIBRARY.map((d) => d.label);

    // All teacher staff for this school (anyone with a section).
    const teacherStaff = await db
      .selectDistinct({ teacherStaffId: classSectionsTable.teacherStaffId })
      .from(classSectionsTable)
      .where(eq(classSectionsTable.schoolId, s.id));

    // Pull the full roster (section -> studentId pairs) so we can find
    // one student per teacher.
    const rosterRows = await db
      .select({
        studentId: sectionRosterTable.studentId,
        teacherStaffId: classSectionsTable.teacherStaffId,
      })
      .from(sectionRosterTable)
      .innerJoin(
        classSectionsTable,
        eq(sectionRosterTable.sectionId, classSectionsTable.id),
      )
      .where(eq(sectionRosterTable.schoolId, s.id));

    const studentsByTeacher = new Map<number, string[]>();
    for (const r of rosterRows) {
      const list = studentsByTeacher.get(r.teacherStaffId) ?? [];
      list.push(r.studentId);
      studentsByTeacher.set(r.teacherStaffId, list);
    }

    const allStudents = await db
      .select({ studentId: studentsTable.studentId })
      .from(studentsTable)
      .where(eq(studentsTable.schoolId, s.id));

    const targetCount = Math.max(1, Math.round(allStudents.length * 0.10));
    const chosen = new Set<string>();

    // Step 1: guarantee one per teacher.
    for (const t of teacherStaff) {
      const roster = studentsByTeacher.get(t.teacherStaffId) ?? [];
      if (!roster.length) continue;
      // Find a student on this teacher's roster who isn't already chosen.
      const fresh = roster.find((sid) => !chosen.has(sid));
      chosen.add(fresh ?? roster[Math.floor(rng() * roster.length)]);
    }
    // Step 2: top up to ~10% with random picks.
    let safety = 0;
    while (chosen.size < targetCount && safety < allStudents.length * 3) {
      const pickIdx = Math.floor(rng() * allStudents.length);
      chosen.add(allStudents[pickIdx].studentId);
      safety += 1;
    }

    if (chosen.size === 0) continue;

    type PlanInsert = typeof safetyPlansTable.$inferInsert;
    const planRows: PlanInsert[] = [];
    for (const studentId of chosen) {
      // 2-4 active items per plan. Always include "Clear backpack"
      // when present so the demo plans look representative.
      const itemCount = 2 + Math.floor(rng() * 3);
      const shuffled = [...libLabels].sort(() => rng() - 0.5);
      const labels = shuffled.slice(0, Math.min(itemCount, shuffled.length));
      planRows.push({
        schoolId: s.id,
        studentId,
        status: "active",
        items: labels.map((label) => ({ label, active: true })),
        notes:
          rng() < 0.4
            ? "Plan in place; revisit at next IEP / 504 meeting."
            : "",
        createdByName: "Demo Seed",
        updatedByName: "Demo Seed",
      });
    }
    await db.insert(safetyPlansTable).values(planRows);
    logger.info(
      { schoolId: s.id, plans: planRows.length, teachers: teacherStaff.length },
      "[seed] safety plans seeded",
    );
  }
}

// -----------------------------------------------------------------------------
// seedWatchlistIfEmpty: per-school, deterministic, idempotent.
//
// Spread (same in every school):
//   - 20% of the school's roster gets watchlist activity.
//   - Of that 20%, ~3% are "high-concern" — multi-incident, severe, in cases,
//     witness statements pending. The other 97% split:
//     ~30% medium (2–3 incidents, mixed severity), ~67% low (1 incident,
//     usually peripheral / witness / low-severity note).
//   - 3–4 cases per school, anchored on the high-concern students and pulling
//     in mediums/lows as supporting players. Each case gets 2–3 notes.
//
// Skipped per-school once any interaction row exists for that school. Safe to
// re-run on existing schools without producing duplicates.
// -----------------------------------------------------------------------------
const WL_KINDS = [
  "fight",
  "verbal",
  "rumor",
  "property",
  "bullying",
  "peripheral_note",
  "other",
] as const;
const WL_LOCATIONS = [
  "Main hallway",
  "Cafeteria",
  "Bus loop",
  "Gym locker room",
  "Courtyard",
  "Stairwell B",
  "Bathroom near 200 wing",
  "Library",
  "Bus 14",
  "Parking lot",
];
const WL_ROLES_HIGH = ["direct", "target", "instigator"] as const;
const WL_ROLES_MED = ["direct", "rumor", "witness"] as const;
const WL_ROLES_LOW = ["peripheral", "witness", "deescalator"] as const;

const WL_CASE_TITLES = [
  "8th-grade hallway arc",
  "7th-grade cafeteria cluster",
  "6th-grade rumor thread",
  "Bus 14 escalation",
  "Locker room dispute",
];

function ymdDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export async function seedWatchlistIfEmpty(): Promise<void> {
  await ensureWatchlistSchema();
  const schools = await db.select().from(schoolsTable);
  for (const school of schools) {
    const [{ c }] = (
      await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM interactions WHERE school_id = ${school.id}`,
      )
    ).rows as { c: number }[];
    if (c > 0) continue;

    const studentRows = await db
      .select({
        studentId: studentsTable.studentId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
      })
      .from(studentsTable)
      .where(eq(studentsTable.schoolId, school.id));
    if (studentRows.length < 10) continue;

    const staffRows = await db
      .select({
        id: staffTable.id,
        displayName: staffTable.displayName,
        isBehaviorSpecialist: staffTable.isBehaviorSpecialist,
        isMtssCoordinator: staffTable.isMtssCoordinator,
        isCounselor: staffTable.isCounselor,
        isAdmin: staffTable.isAdmin,
        isDean: staffTable.isDean,
      })
      .from(staffTable)
      .where(eq(staffTable.schoolId, school.id));
    if (staffRows.length === 0) continue;

    const lead =
      staffRows.find((s) => s.isBehaviorSpecialist) ||
      staffRows.find((s) => s.isMtssCoordinator) ||
      staffRows.find((s) => s.isCounselor) ||
      staffRows.find((s) => s.isDean) ||
      staffRows.find((s) => s.isAdmin) ||
      staffRows[0];
    const loggers = staffRows.filter(
      (s) =>
        s.isBehaviorSpecialist ||
        s.isMtssCoordinator ||
        s.isCounselor ||
        s.isDean ||
        s.isAdmin,
    );
    const loggerPool = loggers.length > 0 ? loggers : [lead];

    const rng = makeRng(0x1377c1 + school.id * 1097);
    // Deterministic shuffle, then take 20%.
    const shuffled = [...studentRows]
      .map((s) => ({ s, k: rng() }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.s);
    const totalPicked = Math.max(8, Math.floor(shuffled.length * 0.2));
    const picked = shuffled.slice(0, totalPicked);
    // ~3% of the 20% are high-concern; floor to at least 2 so the cases
    // have enough anchors to look interesting on small demo schools.
    const highCount = Math.max(2, Math.floor(picked.length * 0.03 * 5));
    // ^ 0.03 * 5 = 15% of the 20% — matches "3% of all students = 0.6%
    // of school", but we lean a touch heavier so the High card on the Hub
    // actually shows movement. Adjust to taste.
    const medCount = Math.max(3, Math.floor(picked.length * 0.3));
    const high = picked.slice(0, highCount);
    const med = picked.slice(highCount, highCount + medCount);
    const low = picked.slice(highCount + medCount);

    // ---- Cases first so we can stamp case_id on the high-concern incidents.
    const numCases = Math.min(WL_CASE_TITLES.length - 1, Math.max(3, Math.ceil(high.length / 2)));
    const caseInserts: (typeof interactionCasesTable.$inferInsert)[] = [];
    for (let i = 0; i < numCases; i++) {
      caseInserts.push({
        schoolId: school.id,
        caseNumber: i + 1,
        schoolYearLabel: schoolYearLabelFor(new Date(), school.timezone),
        title: WL_CASE_TITLES[i] ?? `Case ${i + 1}`,
        status: i === 0 ? "escalated" : i === numCases - 1 ? "monitoring" : "open",
        leadStaffId: lead.id,
        leadStaffName: lead.displayName,
        summary:
          "Auto-seeded demo case linking related incidents across the watchlist.",
        createdByStaffId: lead.id,
        createdByName: lead.displayName,
      });
    }
    const insertedCases = await db
      .insert(interactionCasesTable)
      .values(caseInserts)
      .returning();

    // Distribute high-concern students across cases (round-robin), then add
    // a few medium / low players to each case as supporting roles.
    const caseRoster: { caseId: number; studentId: string; role: string }[] = [];
    high.forEach((stu, idx) => {
      const c = insertedCases[idx % insertedCases.length];
      caseRoster.push({
        caseId: c.id,
        studentId: stu.studentId,
        role: WL_ROLES_HIGH[idx % WL_ROLES_HIGH.length],
      });
    });
    med.slice(0, insertedCases.length * 2).forEach((stu, idx) => {
      const c = insertedCases[idx % insertedCases.length];
      caseRoster.push({
        caseId: c.id,
        studentId: stu.studentId,
        role: WL_ROLES_MED[idx % WL_ROLES_MED.length],
      });
    });

    // ---- Interactions + participants. We stage everything in memory and
    // batch insert at the end so the per-school write is just a few queries.
    type InteractionInsert = typeof interactionsTable.$inferInsert;
    type ParticipantInsert = typeof interactionParticipantsTable.$inferInsert;
    type WitnessInsert = typeof witnessStatementsTable.$inferInsert;
    type NoteInsert = typeof interactionCaseNotesTable.$inferInsert;

    const interactionInserts: InteractionInsert[] = [];
    // Track which participants belong to which staged interaction by index.
    const stagedParticipants: { interactionIdx: number; row: Omit<ParticipantInsert, "interactionId"> }[] = [];
    const stagedWitnesses: { interactionIdx: number; row: Omit<WitnessInsert, "interactionId"> }[] = [];

    function pushIncident(opts: {
      anchor: { studentId: string };
      anchorRole: string;
      coStudents: { studentId: string; role: string }[];
      severity: number;
      kind: string;
      daysAgo: number;
      caseId: number | null;
      summary: string;
      detail?: string;
      withWitnessFor?: { studentId: string }[];
    }) {
      const log = pick(rng, loggerPool);
      const idx = interactionInserts.length;
      const occurredDate = ymdDaysAgo(opts.daysAgo);
      interactionInserts.push({
        schoolId: school.id,
        occurredDate,
        kind: opts.kind,
        severity: opts.severity,
        location: pick(rng, WL_LOCATIONS),
        summary: opts.summary,
        detail: opts.detail ?? "",
        caseId: opts.caseId,
        loggedByStaffId: log.id,
        loggedByName: log.displayName,
        status: opts.severity >= 4 ? "open" : "open",
      });
      stagedParticipants.push({
        interactionIdx: idx,
        row: {
          schoolId: school.id,
          studentId: opts.anchor.studentId,
          role: opts.anchorRole,
          notes: "",
        },
      });
      for (const co of opts.coStudents) {
        stagedParticipants.push({
          interactionIdx: idx,
          row: {
            schoolId: school.id,
            studentId: co.studentId,
            role: co.role,
            notes: "",
          },
        });
      }
      for (const w of opts.withWitnessFor || []) {
        stagedWitnesses.push({
          interactionIdx: idx,
          row: {
            schoolId: school.id,
            studentId: w.studentId,
            status: "requested",
            requestedByStaffId: log.id,
            requestedByName: log.displayName,
            remindCount: 0,
            body: "",
          },
        });
      }
    }

    // Hard cap: every case gets exactly MAX_STMTS_PER_CASE statements,
    // one at each severity in CASE_SEVERITIES. Demo cases were previously
    // generated per-anchor (4–7 each × 2 anchors = 8–14 per case) which
    // overwhelmed the case detail view. The cap keeps the timeline
    // legible while still showing the full severity spread (5/4/3/2).
    const MAX_STMTS_PER_CASE = 4;
    const CASE_SEVERITIES = [5, 4, 3, 2];
    const flipRole = (base: string) =>
      base === "target" ? "instigator" : base === "instigator" ? "target" : "direct";
    const studentById = new Map(picked.map((s) => [s.studentId, s] as const));

    insertedCases.forEach((myCase) => {
      const members = caseRoster.filter((r) => r.caseId === myCase.id);
      if (members.length === 0) return;
      // Prefer the high-tier anchors as the primary actor on each statement;
      // fall back to any member if a case ended up with no high anchors.
      const anchors = members.filter((m) =>
        (WL_ROLES_HIGH as readonly string[]).includes(m.role),
      );
      const anchorPool = anchors.length > 0 ? anchors : members;

      for (let i = 0; i < MAX_STMTS_PER_CASE; i++) {
        const sev = CASE_SEVERITIES[i];
        const anchor = anchorPool[i % anchorPool.length];
        const stu = studentById.get(anchor.studentId);
        if (!stu) continue;
        const others = members.filter((m) => m.studentId !== anchor.studentId);
        // 1–2 mates per incident, rotated so every roster member surfaces
        // at least once across the 4 statements.
        const mateCount = Math.min(others.length, 1 + (i % 2));
        const mates: { studentId: string; role: string }[] = [];
        for (let j = 0; j < mateCount; j++) {
          const m = others[(i + j) % others.length];
          if (!m) continue;
          mates.push({ studentId: m.studentId, role: flipRole(m.role) });
        }
        pushIncident({
          anchor: { studentId: stu.studentId },
          anchorRole: anchor.role,
          coStudents: mates,
          severity: sev,
          kind: pick(rng, [...WL_KINDS].filter((k) => k !== "peripheral_note")),
          // Spread across the last ~3 weeks so the case timeline isn't
          // bunched on the same day.
          daysAgo: 1 + i * 5 + Math.floor(rng() * 3),
          caseId: myCase.id,
          summary: `${stu.firstName} ${stu.lastName.charAt(0)}. — ${pick(
            rng,
            ["physical", "verbal", "ongoing", "escalating"],
          )} incident; staff intervened.`,
          withWitnessFor: i === 0 && mates[0] ? [{ studentId: mates[0].studentId }] : undefined,
        });
      }
    });

    // NOTE: Loose (caseId: null) seed incidents for high-not-on-case,
    // medium, and low tiers were removed. They were padding the
    // "Loose / no case" cluster on the Schoolwide Behavior Network and
    // adding hundreds of node-spam to the Full School Web view. Demo
    // data now stays focused on the case-anchored incidents above. If
    // a future demo needs loose behavior data again, re-add a small
    // (e.g. 5–10 incident) cap rather than per-student counts.

    // ---- "Spotlight" anchors. See seedWatchlistSpotlightsIfMissing()
    // below for the rationale; this in-line block runs on the fresh
    // seed path so brand-new schools land with the spotlight cluster
    // already present. The standalone function handles backfill for
    // schools that were seeded before this change. Both paths use
    // the same `detail = 'spotlight-seed'` marker so they don't
    // double up.
    if (high.length >= 2 && insertedCases.length > 0) {
      const spotlightCount = Math.min(3, high.length);
      const spotlights = high.slice(0, spotlightCount);
      // Roughly +12, +9, +6 extra incidents — produces a clear size
      // hierarchy on the network view rather than three identical
      // big spheres.
      const EXTRA_PER_SPOTLIGHT = [12, 9, 6];
      // Mate pool = everyone in the picked watchlist except the
      // spotlight kid themselves. Heavy on med/low so the spotlight
      // doesn't drag every other high anchor up to the same size.
      const matePoolBase = [...med, ...low];
      for (let s = 0; s < spotlights.length; s++) {
        const star = spotlights[s];
        const extras = EXTRA_PER_SPOTLIGHT[s] ?? 6;
        // The star usually appears on one of the existing cases
        // (so the spotlight kid is a recognizable case anchor in
        // the case detail view), but ~30% of incidents are loose
        // so the network shows a healthy mix of case-attached and
        // floating activity around them.
        const homeCase =
          insertedCases[s % insertedCases.length] ?? insertedCases[0];
        for (let i = 0; i < extras; i++) {
          const attachToCase = rng() > 0.3;
          // 1–2 mates per spotlight incident; rotate so different
          // peers light up around the star instead of one sidekick
          // hogging all the edges.
          const mateCount = 1 + (i % 2);
          const mates: { studentId: string; role: string }[] = [];
          const seenMates = new Set<string>([star.studentId]);
          let guard = 0;
          while (mates.length < mateCount && guard < 12) {
            guard++;
            const cand = pick(rng, matePoolBase);
            if (!cand || seenMates.has(cand.studentId)) continue;
            seenMates.add(cand.studentId);
            mates.push({
              studentId: cand.studentId,
              role: pick(rng, [...WL_ROLES_LOW]),
            });
          }
          // Severity skewed toward 2–4 (the everyday range); leave
          // the 5s for the case-anchored spine above.
          const sev = 2 + Math.floor(rng() * 3);
          pushIncident({
            anchor: { studentId: star.studentId },
            anchorRole: pick(rng, [...WL_ROLES_HIGH]),
            coStudents: mates,
            severity: sev,
            kind: pick(
              rng,
              [...WL_KINDS].filter((k) => k !== "peripheral_note"),
            ),
            // Spread across days 1..25 so they all land inside the
            // default 30-day network window.
            daysAgo: 1 + Math.floor(rng() * 24),
            caseId: attachToCase ? homeCase.id : null,
            summary: `${star.firstName} ${star.lastName.charAt(0)}. — ${pick(
              rng,
              [
                "repeat hallway disruption",
                "verbal altercation in cafeteria",
                "ongoing peer conflict; staff redirected",
                "minor physical contact during transition",
                "off-task behavior escalating to refusal",
              ],
            )}.`,
            detail: "spotlight-seed",
          });
        }
      }
    }

    void high;
    void med;
    void low;
    void WL_ROLES_HIGH;
    void WL_ROLES_MED;
    void WL_ROLES_LOW;
    void WL_LOCATIONS;
    void WL_KINDS;

    const insertedInteractions = await chunkedInsertReturning<{ id: number }>(
      interactionsTable,
      interactionInserts,
      500,
    );

    // Coverage sweep: ensure every caseRoster member appears as a participant
    // on at least one incident for their case. Without this, medium / low-tier
    // roster members can end up with an empty peek modal even though they're
    // listed on the case.
    {
      // Build (caseId -> Set<studentId>) of who's already covered, plus
      // (caseId -> staged interaction indexes for that case).
      const coverage = new Map<number, Set<string>>();
      const incidentsByCase = new Map<number, number[]>();
      for (const sp of stagedParticipants) {
        const inc = interactionInserts[sp.interactionIdx];
        const cid = inc.caseId;
        if (cid == null) continue;
        let s = coverage.get(cid);
        if (!s) {
          s = new Set();
          coverage.set(cid, s);
        }
        s.add(sp.row.studentId);
      }
      for (let idx = 0; idx < interactionInserts.length; idx++) {
        const cid = interactionInserts[idx].caseId;
        if (cid == null) continue;
        let arr = incidentsByCase.get(cid);
        if (!arr) {
          arr = [];
          incidentsByCase.set(cid, arr);
        }
        arr.push(idx);
      }
      for (const r of caseRoster) {
        const have = coverage.get(r.caseId);
        if (have && have.has(r.studentId)) continue;
        const incs = incidentsByCase.get(r.caseId);
        if (!incs || incs.length === 0) continue;
        const targetIdx = incs[Math.floor(rng() * incs.length)];
        stagedParticipants.push({
          interactionIdx: targetIdx,
          row: {
            schoolId: school.id,
            studentId: r.studentId,
            role: r.role === "target" || r.role === "instigator" ? "witness" : "peripheral",
            notes: "",
          },
        });
        if (have) have.add(r.studentId);
        else coverage.set(r.caseId, new Set([r.studentId]));
      }
    }

    const participantRows: ParticipantInsert[] = stagedParticipants.map((p) => ({
      ...p.row,
      interactionId: insertedInteractions[p.interactionIdx].id,
    }));
    if (participantRows.length > 0) {
      // Drop accidental duplicates from the unique (interaction_id, student_id)
      // index — same student showing up twice on one incident is fine to merge.
      const seen = new Set<string>();
      const deduped: ParticipantInsert[] = [];
      for (const r of participantRows) {
        const k = `${r.interactionId}:${r.studentId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        deduped.push(r);
      }
      for (let i = 0; i < deduped.length; i += 500) {
        await db.insert(interactionParticipantsTable).values(deduped.slice(i, i + 500));
      }
    }

    const witnessRows: WitnessInsert[] = stagedWitnesses.map((w) => ({
      ...w.row,
      interactionId: insertedInteractions[w.interactionIdx].id,
    }));
    if (witnessRows.length > 0) {
      const seen = new Set<string>();
      const deduped: WitnessInsert[] = [];
      for (const r of witnessRows) {
        const k = `${r.interactionId}:${r.studentId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        deduped.push(r);
      }
      await db.insert(witnessStatementsTable).values(deduped);
    }

    // ---- 2–3 notes per case. Mix lead-staff + admin loggers so the timeline
    // shows multiple voices.
    const noteRows: NoteInsert[] = [];
    for (const c of insertedCases) {
      const noteCount = 2 + Math.floor(rng() * 2);
      for (let i = 0; i < noteCount; i++) {
        const author = pick(rng, loggerPool);
        noteRows.push({
          schoolId: school.id,
          caseId: c.id,
          body: pick(rng, [
            "Met with both students individually; restorative conversation scheduled for tomorrow.",
            "Looped in counselor; agreed to a check-in plan starting Monday.",
            "Family contact made; parent will reinforce expectations at home.",
            "Pattern is shifting — no new incidents this week, keep monitoring.",
            "Witness statements collected; consistent account from three students.",
          ]),
          authorStaffId: author.id,
          authorName: author.displayName,
        });
      }
    }
    if (noteRows.length > 0) {
      await db.insert(interactionCaseNotesTable).values(noteRows);
    }

    logger.info(
      {
        schoolId: school.id,
        students: picked.length,
        high: high.length,
        med: med.length,
        low: low.length,
        cases: insertedCases.length,
        incidents: insertedInteractions.length,
        notes: noteRows.length,
      },
      "[seed] watchlist seeded",
    );
  }
}

// -----------------------------------------------------------------------------
// ensureDataImporterRollbackSchema
//
// Three additive changes that unlock universal rollback for the Data
// Importer:
//   1. student_fast_scores.import_job_id (column add) — lets the FAST
//      importer tag every upserted row with the job that wrote it, so
//      rollback can DELETE WHERE import_job_id = :id.
//   2. student_import_snapshots (table create) — per-row "before"
//      snapshot for the roster importer's update path. Roster updates
//      capture prior column values here; rollback restores them.
//   3. school_settings.manual_roster_upload_enabled (column add) — the
//      per-school toggle that gates the Roster card in the wizard.
//      Default FALSE because most schools sync rosters from Classlink /
//      Clever (OneRoster) and a manual upload would conflict.
//
// All three follow the project convention of additive ALTER TABLE …
// IF NOT EXISTS / CREATE TABLE … IF NOT EXISTS at boot, sidestepping
// drizzle-kit's interactive rename prompt.
// -----------------------------------------------------------------------------
export async function ensureDataImporterRollbackSchema(): Promise<void> {
  await db.execute(
    sql`ALTER TABLE student_fast_scores ADD COLUMN IF NOT EXISTS import_job_id INTEGER`,
  );
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS student_import_snapshots (
      id SERIAL PRIMARY KEY,
      import_job_id INTEGER NOT NULL,
      school_id INTEGER NOT NULL,
      student_id TEXT NOT NULL,
      was_insert BOOLEAN NOT NULL,
      prior_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS student_import_snapshots_job_idx
      ON student_import_snapshots (import_job_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS student_import_snapshots_school_idx
      ON student_import_snapshots (school_id)
  `);
  await db.execute(
    sql`ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS manual_roster_upload_enabled BOOLEAN NOT NULL DEFAULT FALSE`,
  );
  await db.execute(
    sql`ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS strict_house_name_match BOOLEAN NOT NULL DEFAULT FALSE`,
  );
  // Class Composer post-PM banner dismissal token ("<sy>|<window>"),
  // nullable. See schoolSettings.ts comment for semantics.
  await db.execute(
    sql`ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS class_composer_banner_dismissed_sy TEXT`,
  );
}

// -----------------------------------------------------------------------------
// ensureStudentRetentionsSchema / seedStudentRetentionsIfEmpty
//
// Roster "R-in-a-circle" indicator. ~5% of each school's students get a
// retention record at a grade between 1 and 8. Then a per-teacher pass
// adds extra retentions until every teacher with a roster has at least
// 2 retained students. The 5% is a floor — the per-teacher rule may push
// it higher in small schools.
//
// Per-school skip: if the school already has any retention rows, the
// whole school is skipped so reseeds don't double up.
// -----------------------------------------------------------------------------
export async function ensureStudentRetentionsSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS student_retentions (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      student_id TEXT NOT NULL,
      grade_level INTEGER NOT NULL,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by_staff_id INTEGER,
      created_by_name TEXT
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS student_retentions_unique
      ON student_retentions (school_id, student_id, grade_level)
  `);
}

export async function seedStudentRetentionsIfEmpty(): Promise<void> {
  await ensureStudentRetentionsSchema();
  const schools = await db.select().from(schoolsTable);
  for (const school of schools) {
    const [{ c }] = (
      await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM student_retentions WHERE school_id = ${school.id}`,
      )
    ).rows as { c: number }[];
    if (c > 0) continue;

    const allStudents = await db
      .select({
        studentId: studentsTable.studentId,
        grade: studentsTable.grade,
      })
      .from(studentsTable)
      .where(eq(studentsTable.schoolId, school.id));
    if (allStudents.length === 0) continue;

    // Roster (studentId -> teacherStaffId[]). One row per (student, section).
    const rosterRows = await db
      .select({
        studentId: sectionRosterTable.studentId,
        teacherStaffId: classSectionsTable.teacherStaffId,
      })
      .from(sectionRosterTable)
      .innerJoin(
        classSectionsTable,
        eq(sectionRosterTable.sectionId, classSectionsTable.id),
      )
      .where(eq(sectionRosterTable.schoolId, school.id));

    const teachersByStudent = new Map<string, Set<number>>();
    const studentsByTeacher = new Map<number, string[]>();
    for (const r of rosterRows) {
      let s = teachersByStudent.get(r.studentId);
      if (!s) {
        s = new Set<number>();
        teachersByStudent.set(r.studentId, s);
      }
      s.add(r.teacherStaffId);
      const list = studentsByTeacher.get(r.teacherStaffId) ?? [];
      list.push(r.studentId);
      studentsByTeacher.set(r.teacherStaffId, list);
    }

    const rng = makeRng(0xfedcba + school.id * 7541);
    const studentInfo = new Map<string, number>(
      allStudents.map((s) => [s.studentId, s.grade]),
    );
    const chosen = new Set<string>();
    const retainedGrades = new Map<string, number[]>();
    const retainedCountByTeacher = new Map<number, number>();

    function pickRetentionGrade(currentGrade: number): number {
      // Prefer retention grades < currentGrade so the data is plausible
      // (you can't have repeated 5th if you're currently in 3rd). Cap at
      // 8 per the spec. If the student is too young, fall back to 1.
      const maxG = Math.min(8, Math.max(1, currentGrade - 1));
      if (maxG <= 1) return 1;
      return 1 + Math.floor(rng() * maxG);
    }

    function addRetention(studentId: string): boolean {
      if (chosen.has(studentId)) return false;
      const grade = studentInfo.get(studentId);
      if (grade === undefined) return false;
      const rGrade = pickRetentionGrade(grade);
      chosen.add(studentId);
      retainedGrades.set(studentId, [rGrade]);
      const teachers = teachersByStudent.get(studentId);
      if (teachers) {
        for (const tid of teachers) {
          retainedCountByTeacher.set(
            tid,
            (retainedCountByTeacher.get(tid) ?? 0) + 1,
          );
        }
      }
      return true;
    }

    // Step 1: ~5% baseline, random.
    const targetCount = Math.max(1, Math.round(allStudents.length * 0.05));
    const shuffled = [...allStudents]
      .map((s) => ({ s, k: rng() }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.s);
    for (const s of shuffled) {
      if (chosen.size >= targetCount) break;
      addRetention(s.studentId);
    }

    // Step 2: per-teacher minimum of 2. Iterate teachers; for any teacher
    // with < 2 retained students, retain additional kids from their
    // roster until the count hits 2 (or the roster is exhausted).
    for (const [teacherId, roster] of studentsByTeacher) {
      let cnt = retainedCountByTeacher.get(teacherId) ?? 0;
      if (cnt >= 2) continue;
      // Shuffle this teacher's roster for variety.
      const r = [...roster].map((sid) => ({ sid, k: rng() }))
        .sort((a, b) => a.k - b.k)
        .map((x) => x.sid);
      for (const sid of r) {
        if (cnt >= 2) break;
        if (addRetention(sid)) {
          cnt = retainedCountByTeacher.get(teacherId) ?? cnt;
        }
      }
    }

    // Step 3: ~10% of retained students get a SECOND retention (different
    // grade) so the hover popover sometimes shows multi-grade history.
    for (const sid of [...chosen]) {
      if (rng() >= 0.1) continue;
      const grade = studentInfo.get(sid);
      if (grade === undefined) continue;
      const list = retainedGrades.get(sid) ?? [];
      const existing = new Set(list);
      // Try a few times to find a different valid grade.
      for (let attempt = 0; attempt < 5; attempt++) {
        const g = pickRetentionGrade(grade);
        if (!existing.has(g)) {
          list.push(g);
          retainedGrades.set(sid, list);
          break;
        }
      }
    }

    if (chosen.size === 0) continue;

    type RetentionInsert = typeof studentRetentionsTable.$inferInsert;
    const inserts: RetentionInsert[] = [];
    for (const [sid, grades] of retainedGrades) {
      for (const g of grades) {
        inserts.push({
          schoolId: school.id,
          studentId: sid,
          gradeLevel: g,
          createdByName: "Demo Seed",
        });
      }
    }
    await db.insert(studentRetentionsTable).values(inserts);
    logger.info(
      {
        schoolId: school.id,
        students: chosen.size,
        rows: inserts.length,
        teachers: studentsByTeacher.size,
      },
      "[seed] student retentions seeded",
    );
  }
}

// seedWatchlistSpotlightsIfMissing: backfill for already-seeded schools.
//
// The base watchlist seed gives every "high concern" student roughly the
// same handful of incidents, so the Schoolwide Behavior Network's Full
// School Web ends up as a wall of equal-sized spheres. The intent of
// that view was to surface 2–3 students whose involvement clearly
// dominates — the kids you'd notice from across the room. This pass
// adds extra incidents to the top 3 most-active anchors per school so
// their spheres become visibly larger than the rest.
//
// Idempotent via a marker on `interactions.detail = 'spotlight-seed'`.
// Skips any school that already has a spotlight row, so it's safe to
// run on every boot. Newly seeded schools get spotlights from the
// inline block inside seedWatchlistIfEmpty (same marker), so there's
// no double-up.
export async function seedWatchlistSpotlightsIfMissing(): Promise<void> {
  const schools = await db.select().from(schoolsTable);
  for (const school of schools) {
    // Skip if already spotlighted.
    const [{ c: alreadyHas }] = (
      await db.execute(
        sql`SELECT COUNT(*)::int AS c
            FROM interactions
            WHERE school_id = ${school.id}
              AND detail = 'spotlight-seed'
            LIMIT 1`,
      )
    ).rows as { c: number }[];
    if (alreadyHas > 0) continue;

    // Need a base seed to backfill against. Pick the top 3 students by
    // existing case-attached participant count — those are the ones
    // already cast as case anchors, so making them stand out matches
    // the demo's existing narrative.
    const topRows = (
      await db.execute(sql`
        SELECT p.student_id AS "studentId", COUNT(*)::int AS c
        FROM interaction_participants p
        JOIN interactions i ON i.id = p.interaction_id AND i.school_id = p.school_id
        WHERE p.school_id = ${school.id}
          AND i.case_id IS NOT NULL
          AND p.role IN ('target', 'instigator', 'direct')
        GROUP BY p.student_id
        ORDER BY c DESC
        LIMIT 3
      `)
    ).rows as { studentId: string; c: number }[];
    if (topRows.length < 2) continue;

    // Mate pool: any other student who's already touched a case
    // interaction in this school. Keeps the spotlight cluster
    // connected to the existing graph instead of drifting off.
    const mateRows = (
      await db.execute(sql`
        SELECT DISTINCT p.student_id AS "studentId"
        FROM interaction_participants p
        JOIN interactions i ON i.id = p.interaction_id AND i.school_id = p.school_id
        WHERE p.school_id = ${school.id}
          AND i.case_id IS NOT NULL
      `)
    ).rows as { studentId: string }[];
    const spotlightIds = new Set(topRows.map((r) => r.studentId));
    const matePool = mateRows
      .map((r) => r.studentId)
      .filter((id) => !spotlightIds.has(id));
    if (matePool.length === 0) continue;

    // Reuse the existing demo cases as "home" cases for ~70% of the
    // extras; the remaining 30% are loose so the Loose / no case
    // cluster gets some movement around the spotlight kid too.
    const caseRows = (
      await db.execute(sql`
        SELECT id FROM interaction_cases
        WHERE school_id = ${school.id}
        ORDER BY id ASC
        LIMIT 12
      `)
    ).rows as { id: number }[];
    if (caseRows.length === 0) continue;

    // Pick a logger the same way the base seed does (any admin /
    // counselor / behavior staff). Falls back to any staff row.
    const staffRows = await db
      .select({
        id: staffTable.id,
        displayName: staffTable.displayName,
        isBehaviorSpecialist: staffTable.isBehaviorSpecialist,
        isMtssCoordinator: staffTable.isMtssCoordinator,
        isCounselor: staffTable.isCounselor,
        isAdmin: staffTable.isAdmin,
        isDean: staffTable.isDean,
      })
      .from(staffTable)
      .where(eq(staffTable.schoolId, school.id));
    if (staffRows.length === 0) continue;
    const loggerPool = staffRows.filter(
      (s) =>
        s.isBehaviorSpecialist ||
        s.isMtssCoordinator ||
        s.isCounselor ||
        s.isDean ||
        s.isAdmin,
    );
    const loggers = loggerPool.length > 0 ? loggerPool : staffRows;

    // Pull the spotlight students' display names so the summary text
    // reads naturally on the case timeline.
    const studentNameRows = await db
      .select({
        studentId: studentsTable.studentId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
      })
      .from(studentsTable)
      .where(eq(studentsTable.schoolId, school.id));
    const nameById = new Map(
      studentNameRows.map((s) => [s.studentId, s] as const),
    );

    const rng = makeRng(0x2900a1 + school.id * 1297);
    // Same hierarchy as the inline path: +12 / +9 / +6 extras.
    const EXTRAS = [12, 9, 6];

    type IncidentInsert = typeof interactionsTable.$inferInsert;
    type ParticipantInsert = typeof interactionParticipantsTable.$inferInsert;
    const incidents: IncidentInsert[] = [];
    const stagedParticipants: {
      idx: number;
      row: Omit<ParticipantInsert, "interactionId">;
    }[] = [];

    for (let s = 0; s < topRows.length; s++) {
      const star = topRows[s];
      const starName = nameById.get(star.studentId);
      if (!starName) continue;
      const extras = EXTRAS[s] ?? 6;
      const homeCase = caseRows[s % caseRows.length];
      for (let i = 0; i < extras; i++) {
        const log = pick(rng, loggers);
        const attachToCase = rng() > 0.3;
        const sev = 2 + Math.floor(rng() * 3);
        const idx = incidents.length;
        incidents.push({
          schoolId: school.id,
          occurredDate: ymdDaysAgo(1 + Math.floor(rng() * 24)),
          kind: pick(
            rng,
            [...WL_KINDS].filter((k) => k !== "peripheral_note"),
          ),
          severity: sev,
          location: pick(rng, [...WL_LOCATIONS]),
          summary: `${starName.firstName} ${starName.lastName.charAt(
            0,
          )}. — ${pick(rng, [
            "repeat hallway disruption",
            "verbal altercation in cafeteria",
            "ongoing peer conflict; staff redirected",
            "minor physical contact during transition",
            "off-task behavior escalating to refusal",
          ])}.`,
          detail: "spotlight-seed",
          caseId: attachToCase ? homeCase.id : null,
          loggedByStaffId: log.id,
          loggedByName: log.displayName,
          status: "open",
        });
        stagedParticipants.push({
          idx,
          row: {
            schoolId: school.id,
            studentId: star.studentId,
            role: pick(rng, [...WL_ROLES_HIGH]),
            notes: "",
          },
        });
        // 1–2 mates per incident, no duplicates within an incident.
        const mateCount = 1 + (i % 2);
        const seen = new Set<string>([star.studentId]);
        let guard = 0;
        let added = 0;
        while (added < mateCount && guard < 12) {
          guard++;
          const mid = pick(rng, matePool);
          if (!mid || seen.has(mid)) continue;
          seen.add(mid);
          stagedParticipants.push({
            idx,
            row: {
              schoolId: school.id,
              studentId: mid,
              role: pick(rng, [...WL_ROLES_LOW]),
              notes: "",
            },
          });
          added++;
        }
      }
    }

    if (incidents.length === 0) continue;
    const inserted = await chunkedInsertReturning<{ id: number }>(
      interactionsTable,
      incidents,
      500,
    );
    const participantRows: ParticipantInsert[] = stagedParticipants.map((p) => ({
      ...p.row,
      interactionId: inserted[p.idx].id,
    }));
    // Dedupe in case a mate landed twice via the random guard.
    const seenKey = new Set<string>();
    const deduped: ParticipantInsert[] = [];
    for (const r of participantRows) {
      const k = `${r.interactionId}:${r.studentId}`;
      if (seenKey.has(k)) continue;
      seenKey.add(k);
      deduped.push(r);
    }
    for (let i = 0; i < deduped.length; i += 500) {
      await db
        .insert(interactionParticipantsTable)
        .values(deduped.slice(i, i + 500));
    }

    logger.info(
      {
        schoolId: school.id,
        spotlightCount: topRows.length,
        incidentsAdded: incidents.length,
      },
      "[seed] watchlist spotlights backfilled",
    );
  }
}

// ---------------------------------------------------------------------------
// ensurePickupSchema — Parent Pick-Up Module
//
// Adds the dismissal_mode column to students, the cap_car_rider_monitor
// flag to staff, the show_pickup_queue toggle to display_playlists, and
// creates the two new tables (student_pickup_authorizations + the
// pickup_queue_events audit log). All ALTERs are IF NOT EXISTS so re-runs
// are no-ops; the partial unique index on (school_id, pickup_number)
// WHERE active is created explicitly because Drizzle's type-level helper
// can't model partial indexes.
// ---------------------------------------------------------------------------
export async function ensurePickupSchema(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE students
      ADD COLUMN IF NOT EXISTS dismissal_mode TEXT NOT NULL DEFAULT 'car_rider'
  `);
  await db.execute(sql`
    ALTER TABLE staff
      ADD COLUMN IF NOT EXISTS cap_car_rider_monitor BOOLEAN NOT NULL DEFAULT false
  `);
  await db.execute(sql`
    ALTER TABLE display_playlists
      ADD COLUMN IF NOT EXISTS show_pickup_queue BOOLEAN NOT NULL DEFAULT false
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS student_pickup_authorizations (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      parent_id INTEGER,
      guardian_label TEXT NOT NULL,
      pickup_number TEXT NOT NULL,
      restricted_from BOOLEAN NOT NULL DEFAULT false,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deactivated_at TIMESTAMPTZ
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS pickup_auth_number_per_school ON student_pickup_authorizations(school_id, pickup_number)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS pickup_auth_by_student ON student_pickup_authorizations(student_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS pickup_auth_by_parent ON student_pickup_authorizations(parent_id)`);
  // Partial unique: only the ACTIVE rows must have a unique number per
  // school. Retired numbers can be reused for a new tag without conflict.
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS pickup_auth_active_number_unique ON student_pickup_authorizations(school_id, pickup_number) WHERE active`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS pickup_queue_events (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      pickup_authorization_id INTEGER,
      actor_staff_id INTEGER NOT NULL,
      actor_display_name TEXT NOT NULL,
      action TEXT NOT NULL,
      note TEXT,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS pickup_events_by_school_date ON pickup_queue_events(school_id, occurred_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS pickup_events_by_student ON pickup_queue_events(student_id)`);

  // School-settings additions for the Pick-Up settings card.
  await db.execute(sql`
    ALTER TABLE school_settings
      ADD COLUMN IF NOT EXISTS pickup_cutoff_time TEXT NOT NULL DEFAULT '15:30'
  `);
  await db.execute(sql`
    ALTER TABLE school_settings
      ADD COLUMN IF NOT EXISTS pickup_teacher_view_scope TEXT NOT NULL DEFAULT 'all_students'
  `);
  // "In car" terminal step toggle + display-window for "walking out"
  // rows when the toggle is OFF. Additive — defaults preserve the
  // existing curb-tap-required workflow for every school.
  await db.execute(sql`
    ALTER TABLE school_settings
      ADD COLUMN IF NOT EXISTS pickup_in_car_step_enabled BOOLEAN NOT NULL DEFAULT TRUE
  `);
  await db.execute(sql`
    ALTER TABLE school_settings
      ADD COLUMN IF NOT EXISTS pickup_walked_out_display_seconds INTEGER NOT NULL DEFAULT 300
  `);
}

// ---------------------------------------------------------------------------
// AST (Alternate Schedule Time) schema. HCTA-contract earn/use bank with
// quarter-hour increments and a per-staff append-only ledger. See
// lib/db/src/schema/staffAst.ts for the state machine. Idempotent on every
// boot.
// ---------------------------------------------------------------------------
export async function ensureAstSchema(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE staff
      ADD COLUMN IF NOT EXISTS can_approve_ast BOOLEAN NOT NULL DEFAULT false
  `);
  // Backfill: anyone already flagged as an admin tier (school admin /
  // district admin / super user) gets approver rights for free. This is
  // a one-time idempotent set — admins demoted later don't lose AST
  // approval automatically (intentional: a building can decide its own
  // approver list independent of the admin role).
  await db.execute(sql`
    UPDATE staff
       SET can_approve_ast = true
     WHERE can_approve_ast = false
       AND (is_admin OR is_district_admin OR is_super_user)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS staff_ast_requests (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      staff_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending_preapproval',
      event_date TEXT,
      reason TEXT,
      quarter_hours_requested INTEGER NOT NULL,
      quarter_hours_actual INTEGER,
      use_start_at TIMESTAMPTZ,
      use_end_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      preapproved_at TIMESTAMPTZ,
      preapproved_by_staff_id INTEGER,
      preapproval_note TEXT,
      completion_submitted_at TIMESTAMPTZ,
      completion_note TEXT,
      confirmed_at TIMESTAMPTZ,
      confirmed_by_staff_id INTEGER,
      confirm_note TEXT,
      denied_at TIMESTAMPTZ,
      denied_by_staff_id INTEGER,
      deny_note TEXT,
      cancelled_at TIMESTAMPTZ,
      cancel_note TEXT,
      staff_acknowledged_at TIMESTAMPTZ
    )
  `);
  // Additive: older deployments missed staff_acknowledged_at.
  await db.execute(sql`
    ALTER TABLE staff_ast_requests
      ADD COLUMN IF NOT EXISTS staff_acknowledged_at TIMESTAMPTZ
  `);
  // Additive: AST category — set by admin at pre-approval time, never
  // by staff. Constrained to the AST_CATEGORIES enum at the app layer
  // (no CHECK constraint so the enum can evolve without a schema
  // migration). NULL → "Uncategorized" in the dashboard.
  await db.execute(sql`
    ALTER TABLE staff_ast_requests
      ADD COLUMN IF NOT EXISTS category TEXT
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS staff_ast_requests_school_staff_idx ON staff_ast_requests(school_id, staff_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS staff_ast_requests_school_state_idx ON staff_ast_requests(school_id, state)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS staff_ast_ledger (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      staff_id INTEGER NOT NULL,
      delta_quarter_hours INTEGER NOT NULL,
      kind TEXT NOT NULL,
      request_id INTEGER,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by_staff_id INTEGER
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS staff_ast_ledger_school_staff_idx ON staff_ast_ledger(school_id, staff_id)`);
}

// -----------------------------------------------------------------------------
// Feature licensing schema (Plans + per-school Overrides).
// Idempotent. Layered on top of the existing super_feature_* flags on
// school_settings — assigning a plan / applying overrides writes through
// to those booleans, so the runtime gating path is unchanged.
// Also seeds a default "enterprise" plan with every feature enabled and
// auto-assigns it to any school whose plan_id is still NULL, so existing
// tenants keep working after this rolls out.
// -----------------------------------------------------------------------------
// Two-phase migration: the column adds + plans table CREATE must happen
// BEFORE seedTenancy (which inserts into schools via Drizzle, with a
// schema definition that now includes plan_id). The backfill UPDATE
// runs AFTER seedTenancy so it has rows to update. Both phases are
// idempotent.
export async function ensureFeaturePlansColumns() {
  await db.execute(
    sql`ALTER TABLE schools ADD COLUMN IF NOT EXISTS plan_id INTEGER`,
  );
  await db.execute(
    sql`ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS super_feature_ast BOOLEAN NOT NULL DEFAULT TRUE`,
  );
  // Comp Time (FLSA) — additive column adds. Default ON for the
  // enterprise rollout; the route still hard-blocks staff whose
  // exempt_status != 'non_exempt' so teachers stay on AST.
  await db.execute(
    sql`ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS super_feature_comp_time BOOLEAN NOT NULL DEFAULT TRUE`,
  );
  await db.execute(
    sql`ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS workweek_start TEXT NOT NULL DEFAULT 'sunday'`,
  );
  await db.execute(
    sql`ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS comp_time_require_auth_form BOOLEAN NOT NULL DEFAULT TRUE`,
  );
  await db.execute(
    sql`ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS comp_time_auth_form_object_key TEXT`,
  );
  await db.execute(
    sql`ALTER TABLE staff ADD COLUMN IF NOT EXISTS exempt_status TEXT`,
  );
  await db.execute(
    sql`ALTER TABLE staff ADD COLUMN IF NOT EXISTS can_approve_comp_time BOOLEAN NOT NULL DEFAULT FALSE`,
  );
  await db.execute(
    sql`ALTER TABLE staff ADD COLUMN IF NOT EXISTS comp_time_paid_out_at TIMESTAMPTZ`,
  );
  // Four new descriptive role flags. Additive, idempotent.
  await db.execute(
    sql`ALTER TABLE staff ADD COLUMN IF NOT EXISTS is_non_exempt_role BOOLEAN NOT NULL DEFAULT FALSE`,
  );
  await db.execute(
    sql`ALTER TABLE staff ADD COLUMN IF NOT EXISTS is_front_office BOOLEAN NOT NULL DEFAULT FALSE`,
  );
  await db.execute(
    sql`ALTER TABLE staff ADD COLUMN IF NOT EXISTS is_sro BOOLEAN NOT NULL DEFAULT FALSE`,
  );
  await db.execute(
    sql`ALTER TABLE staff ADD COLUMN IF NOT EXISTS is_guardian BOOLEAN NOT NULL DEFAULT FALSE`,
  );
  // Backfill: any admin tier (school admin / district admin / super
  // user) gets canApproveCompTime so the rollout doesn't break.
  // Principals + Assistant Principals carry isAdmin, so this also
  // auto-elects them per spec.
  await db.execute(sql`
    UPDATE staff
       SET can_approve_comp_time = true
     WHERE can_approve_comp_time = false
       AND (is_admin = true OR is_district_admin = true OR is_super_user = true)
  `);
  // Comp Time tables. Additive, idempotent.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS staff_comp_requests (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      staff_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending_preapproval',
      week_start_date TEXT,
      reason TEXT,
      hours_worked_qh INTEGER,
      computed_credit_qh INTEGER,
      quarter_hours_requested INTEGER NOT NULL,
      quarter_hours_actual INTEGER,
      use_start_at TIMESTAMPTZ,
      use_end_at TIMESTAMPTZ,
      auth_form_object_key TEXT,
      timesheet_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
      prior_supervisor_approval_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      preapproved_at TIMESTAMPTZ,
      preapproved_by_staff_id INTEGER,
      preapproval_note TEXT,
      completion_submitted_at TIMESTAMPTZ,
      completion_note TEXT,
      confirmed_at TIMESTAMPTZ,
      confirmed_by_staff_id INTEGER,
      confirm_note TEXT,
      denied_at TIMESTAMPTZ,
      denied_by_staff_id INTEGER,
      deny_note TEXT,
      cancelled_at TIMESTAMPTZ,
      cancel_note TEXT,
      staff_acknowledged_at TIMESTAMPTZ
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS staff_comp_requests_school_staff_idx ON staff_comp_requests(school_id, staff_id)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS staff_comp_requests_school_state_idx ON staff_comp_requests(school_id, state)`,
  );
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS staff_comp_ledger (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      staff_id INTEGER NOT NULL,
      delta_quarter_hours INTEGER NOT NULL,
      kind TEXT NOT NULL,
      request_id INTEGER,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by_staff_id INTEGER
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS staff_comp_ledger_school_staff_idx ON staff_comp_ledger(school_id, staff_id)`,
  );
}

export async function ensureFeaturePlansSchema() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS plans (
      id SERIAL PRIMARY KEY,
      key TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT,
      features JSONB NOT NULL,
      quotas JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS plans_key_unique ON plans(key)`,
  );

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS school_feature_overrides (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      feature_key TEXT NOT NULL,
      enabled BOOLEAN NOT NULL,
      show_upsell BOOLEAN NOT NULL DEFAULT FALSE,
      quotas JSONB NOT NULL DEFAULT '{}'::jsonb,
      expires_at TIMESTAMPTZ,
      reason TEXT,
      granted_by_staff_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS school_feature_overrides_school_feature_unique ON school_feature_overrides(school_id, feature_key)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS school_feature_overrides_school_idx ON school_feature_overrides(school_id)`,
  );

  // Phase 2: licensing audit log. Append-only. Drives the expired-
  // override sweep's idempotency via a partial unique index on
  // override_id (one sweep audit row per override, ever).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS feature_licensing_audit_log (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      override_id INTEGER,
      feature_key TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      actor_staff_id INTEGER,
      actor_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS feature_licensing_audit_school_idx ON feature_licensing_audit_log(school_id, created_at)`,
  );
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS feature_licensing_audit_expired_sweep_unique ON feature_licensing_audit_log(override_id) WHERE action = 'override_expired_sweep'`,
  );

  // (Column adds for schools.plan_id + school_settings.super_feature_ast
  // happen earlier via ensureFeaturePlansColumns, before seedTenancy.)

  // Seed the default "enterprise" plan (everything on, no quotas).
  // The keys here match FEATURE_KEYS in
  // artifacts/api-server/src/lib/featureLicensing.ts — keep in sync.
  const enterpriseFeatures = {
    familyComm: true,
    pbis: true,
    schoolStore: true,
    accommodations: true,
    logIntervention: true,
    requestPullout: true,
    hallPasses: true,
    tardyPass: true,
    mtssPlans: true,
    behaviorSpecialist: true,
    issDashboard: true,
    displays: true,
    bellSchedule: true,
    earlyWarning: true,
    academics: true,
    dataImports: true,
    houses: true,
    parentPortal: true,
    ast: true,
    compTime: true,
  };
  await db.execute(sql`
    INSERT INTO plans (key, label, description, features, quotas)
    VALUES (
      'enterprise',
      'Enterprise',
      'All PulseEDU features. Default plan assigned to every school on rollout.',
      ${JSON.stringify(enterpriseFeatures)}::jsonb,
      '{}'::jsonb
    )
    ON CONFLICT (key) DO NOTHING
  `);

  // Backfill: any school still on plan_id IS NULL gets the enterprise
  // plan so the runtime behavior is unchanged after this migration.
  await db.execute(sql`
    UPDATE schools
    SET plan_id = (SELECT id FROM plans WHERE key = 'enterprise')
    WHERE plan_id IS NULL
  `);
}

// -----------------------------------------------------------------------------
// Hall pass kiosk activation cards (Phase 1).
//
// Adds the per-teacher enrollment-token table and the provenance /
// sub-flow columns on kiosk_activations. All additive + idempotent.
// -----------------------------------------------------------------------------
export async function ensureKioskCardsSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS kiosk_enroll_tokens (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      staff_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      pin_hash TEXT,
      label TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by_staff_id INTEGER,
      rotated_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      revoked_by_staff_id INTEGER,
      last_used_at TIMESTAMPTZ
    )
  `);
  // At most one live enrollment token per teacher per school.
  // "Reissue card" must revoke-then-insert in a single transaction so
  // this partial index never sees two live rows for the same teacher.
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS kiosk_enroll_tokens_one_live_per_staff ON kiosk_enroll_tokens(school_id, staff_id) WHERE revoked_at IS NULL`,
  );

  // Provenance / sub-flow columns on kiosk_activations. The new columns
  // are all NULL-tolerant so legacy rows (password-activated kiosks)
  // remain valid without backfill.
  await db.execute(
    sql`ALTER TABLE kiosk_activations ADD COLUMN IF NOT EXISTS enroll_token_id INTEGER`,
  );
  await db.execute(
    sql`ALTER TABLE kiosk_activations ADD COLUMN IF NOT EXISTS activated_by_staff_id INTEGER`,
  );
  await db.execute(
    sql`ALTER TABLE kiosk_activations ADD COLUMN IF NOT EXISTS proxy_for_staff_id INTEGER`,
  );
  await db.execute(
    sql`ALTER TABLE kiosk_activations ADD COLUMN IF NOT EXISTS session_kind TEXT`,
  );
}

// -----------------------------------------------------------------------------
// Kiosk "Sign in to class" + per-school welcome messages (Phase 3).
//
// Adds two columns to school_settings (default template + per-house
// override JSON map) and creates the class_signins append-only ledger.
// All additive + idempotent — safe to call on every boot.
// -----------------------------------------------------------------------------
export async function ensureKioskWelcomeSchema(): Promise<void> {
  await db.execute(
    sql`ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS kiosk_welcome_template TEXT NOT NULL DEFAULT 'Welcome, {firstName}!'`,
  );
  await db.execute(
    sql`ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS kiosk_welcome_messages JSONB NOT NULL DEFAULT '{}'::jsonb`,
  );
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS class_signins (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      kiosk_activation_id INTEGER,
      signed_in_by_staff_id INTEGER,
      signed_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS class_signins_school_day_idx ON class_signins(school_id, signed_in_at)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS class_signins_student_idx ON class_signins(school_id, student_id, signed_in_at)`,
  );
}

// -----------------------------------------------------------------------------
// Badge print event audit ledger (Phase 4 — badge reissue audit).
//
// One row per student per batch when an admin generates a badges PDF.
// Lets admins spot lost-badge / reissue patterns and provides a
// chain-of-custody for the printed credential.
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// Schools.timezone bootstrap (per-school IANA timezone).
//
// The schema TS file declares `timezone TEXT NOT NULL DEFAULT 'America/New_York'`,
// but production DBs onboarded before May 2026 won't have the column yet
// — add it idempotently via ALTER. Threaded through `getSchoolTimezone()`
// and used by the case-number year-label flow, AST lapse cron, and kiosk
// sign-in roll-call so a non-Eastern tenant computes day boundaries
// correctly.
// -----------------------------------------------------------------------------
export async function ensureSchoolsTimezoneColumn(): Promise<void> {
  await db.execute(
    sql`ALTER TABLE schools ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/New_York'`,
  );
}

// -----------------------------------------------------------------------------
// Student photo columns bootstrap (Packet B).
//
// `photo_object_key TEXT NULL` — object-storage key bound to the student's
// school via bindObjectToSchool. Null on legacy rows / schools without a
// yearbook ingest yet (renders the initials bubble).
// `photo_consent BOOLEAN NOT NULL DEFAULT true` — render gate. False
// suppresses the photo everywhere even when bytes are on disk; bytes are
// not deleted so the toggle is reversible.
// Schema TS declares both; the ALTERs handle DBs onboarded before May 2026.
// -----------------------------------------------------------------------------
export async function ensureStudentPhotoColumns(): Promise<void> {
  await db.execute(
    sql`ALTER TABLE students ADD COLUMN IF NOT EXISTS photo_object_key TEXT`,
  );
  await db.execute(
    sql`ALTER TABLE students ADD COLUMN IF NOT EXISTS photo_consent BOOLEAN NOT NULL DEFAULT true`,
  );
  // District-issued local SIS number (FAST file "Local ID"). Nullable;
  // canonical student_id is still the FLEID. Additive ALTER per the
  // "non-interactive schema change" convention.
  await db.execute(
    sql`ALTER TABLE students ADD COLUMN IF NOT EXISTS local_sis_id TEXT`,
  );
}

// Backfill local_sis_id for every student that is currently NULL.
// Derivation: strip the leading "FL" prefix and any subsequent leading
// zeros from the FLEID — "FL000008101387" → "8101387". This is the
// numeric portion FL districts use as the local SIS identifier on
// printed badges and parent-facing materials. Idempotent: only fills
// NULLs, so re-runs are a cheap UPDATE...WHERE NULL no-op once filled.
// FLEID remains the canonical internal identifier; this is purely the
// student-facing credential surface.
export async function ensureStudentLocalSisIdBackfill(): Promise<void> {
  await db.execute(sql`
    UPDATE students
       SET local_sis_id = REGEXP_REPLACE(
             REGEXP_REPLACE(student_id, '^FL', ''),
             '^0+',
             ''
           )
     WHERE local_sis_id IS NULL
       AND student_id IS NOT NULL
       AND student_id <> ''
  `);
}

// -----------------------------------------------------------------------------
// Per-student accommodations backfill.
//
// Why: the bulk multi-school seeder (seedMultiSchoolIfEmpty) was the only
// path that ever wrote rows into student_accommodations. Once any school
// has a school_accommodations catalog row, the bulk seeder short-circuits
// — so production tenants that onboarded after the initial seed (or any
// student inserted later via a roster import) end up with the ESE / 504 /
// ELL pill rendering but no per-student accommodations behind it. The
// Teacher Roster "Programs" hover therefore opens to an empty list.
//
// This backfill walks every school and, for each student whose
// demographic flag is set but who has zero ACTIVE (removedAt IS NULL)
// student_accommodations rows, assigns 2–4 category-matched
// accommodations drawn from MASTER_ACCS. Catalog rows are upserted into
// school_accommodations first via ON CONFLICT DO NOTHING on the
// (school_id, name) unique index so this is safe to run on schools that
// already have a partial or fully populated catalog.
//
// Idempotent: students that already have any active assignment are
// skipped. Re-running on a fully-backfilled tenant performs one cheap
// COUNT + the catalog upserts (also no-ops).
// -----------------------------------------------------------------------------
export async function ensureStudentAccommodationsBackfill(): Promise<void> {
  // 1. Per school, ensure the catalog rows exist.
  const schools = await db
    .select({ id: schoolsTable.id })
    .from(schoolsTable);
  for (const school of schools) {
    for (const a of MASTER_ACCS) {
      await db.execute(sql`
        INSERT INTO school_accommodations (school_id, name, category, active)
        VALUES (${school.id}, ${a.name}, ${a.category}, true)
        ON CONFLICT ON CONSTRAINT school_accommodations_school_id_name_unique
        DO NOTHING
      `);
    }

    // 2. Find students with at least one program flag set but no active
    // accommodations. We do this in one query per school.
    const orphanRows = (await db.execute(sql`
      SELECT s.student_id, s.ese, s.is_504, s.ell
        FROM students s
       WHERE s.school_id = ${school.id}
         AND (s.ese = true OR s.is_504 = true OR s.ell = true)
         AND NOT EXISTS (
               SELECT 1
                 FROM student_accommodations sa
                WHERE sa.school_id = s.school_id
                  AND sa.student_id = s.student_id
                  AND sa.removed_at IS NULL
             )
    `)).rows as Array<{
      student_id: string;
      ese: boolean;
      is_504: boolean;
      ell: boolean;
    }>;
    if (orphanRows.length === 0) continue;

    // 3. Load the school's catalog and bucket by category.
    const catalog = await db
      .select()
      .from(schoolAccommodationsTable)
      .where(eq(schoolAccommodationsTable.schoolId, school.id));
    const iepIds = catalog.filter((c) => c.category === "IEP").map((c) => c.id);
    const sec504Ids = catalog.filter((c) => c.category === "504").map((c) => c.id);
    const ellIds = catalog.filter((c) => c.category === "ELL").map((c) => c.id);

    // Pick an admin/SuperUser/teacher (in that order) to attribute the
    // backfill assignments to so the audit trail isn't NULL.
    const [attributable] = await db
      .select({ id: staffTable.id })
      .from(staffTable)
      .where(
        and(
          eq(staffTable.schoolId, school.id),
          eq(staffTable.active, true),
        ),
      )
      .orderBy(
        desc(staffTable.isSuperUser),
        desc(staffTable.isAdmin),
        asc(staffTable.id),
      )
      .limit(1);
    const assignedById = attributable?.id ?? null;

    // 4. Deterministic per-school RNG so a reseed produces the same set.
    const rng = makeRng(0xacc0 + school.id * 7919);
    type AssignInsert = typeof studentAccommodationsTable.$inferInsert;
    const rows: AssignInsert[] = [];
    for (const s of orphanRows) {
      // Pool from the student's actual flags. ESE → IEP catalog, etc.
      // Students with multiple flags draw from a merged pool.
      const pool: number[] = [];
      if (s.ese) pool.push(...iepIds);
      if (s.is_504) pool.push(...sec504Ids);
      if (s.ell) pool.push(...ellIds);
      if (pool.length === 0) continue;
      const count = Math.min(2 + Math.floor(rng() * 3), pool.length); // 2..4
      const chosen = shuffle(rng, pool).slice(0, count);
      for (const accId of chosen) {
        rows.push({
          schoolId: school.id,
          studentId: s.student_id,
          accommodationId: accId,
          assignedByStaffId: assignedById,
        });
      }
    }
    if (rows.length > 0) {
      await chunkedInsert(studentAccommodationsTable, rows, 1000);
      logger.info(
        {
          schoolId: school.id,
          students: orphanRows.length,
          assignments: rows.length,
        },
        "[seed] accommodations backfill",
      );
    }
  }
}

// -----------------------------------------------------------------------------
// ensureLocationAllowedDestinationsBackfill
//
// The bulk seed populates `location_allowed_destinations` only for freshly
// created schools (full origin×destination cross product). Schools onboarded
// before that block existed — including school 1 (Parrott) — have an empty
// LAD table, which leaves the kiosk's destination picker blank because
// `destinationOptions` intersects the school's destinations with the
// allowed-pair set for the kiosk's origin room.
//
// This idempotent backfill: for every school that has locations but zero
// rows in LAD, inserts the full origin×destination cross product. A school
// with even one existing pair is left alone (admins may have intentionally
// pruned the matrix).
// -----------------------------------------------------------------------------
export async function ensureLocationAllowedDestinationsBackfill(): Promise<void> {
  const schools = await db.select({ id: schoolsTable.id }).from(schoolsTable);
  for (const school of schools) {
    const [{ c: existing }] = (await db.execute(sql`
      SELECT COUNT(*)::int AS c
        FROM location_allowed_destinations
       WHERE school_id = ${school.id}
    `)).rows as Array<{ c: number }>;
    if (existing > 0) continue;

    const locs = await db
      .select()
      .from(locationsTable)
      .where(eq(locationsTable.schoolId, school.id));
    const origins = locs.filter((l) => l.isOrigin && l.active);
    const dests = locs.filter((l) => l.isDestination && l.active);
    if (origins.length === 0 || dests.length === 0) continue;

    const rows: {
      schoolId: number;
      originLocationId: number;
      destinationLocationId: number;
    }[] = [];
    for (const o of origins) {
      for (const d of dests) {
        rows.push({
          schoolId: school.id,
          originLocationId: o.id,
          destinationLocationId: d.id,
        });
      }
    }
    if (rows.length > 0) {
      await db.insert(locationAllowedDestinationsTable).values(rows);
      logger.info(
        { schoolId: school.id, pairs: rows.length },
        "[seed] LAD backfill",
      );
    }
  }
}

// -----------------------------------------------------------------------------
// ensureBenchmarkDeliveriesSchema
//
// Creates school_benchmarks (per-school standards catalog) and
// benchmark_deliveries (teacher-owned instructional log) idempotently.
// See lib/db/src/schema/{schoolBenchmarks,benchmarkDeliveries}.ts.
// -----------------------------------------------------------------------------
export async function ensureBenchmarkDeliveriesSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS school_benchmarks (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      code TEXT NOT NULL,
      category TEXT,
      label TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      source TEXT NOT NULL DEFAULT 'local',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS school_benchmarks_school_subject_idx
      ON school_benchmarks(school_id, subject)
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS school_benchmarks_school_subject_code_unique
      ON school_benchmarks(school_id, subject, code)
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS benchmark_deliveries (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      teacher_staff_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      benchmark_code TEXT NOT NULL,
      delivered_on DATE NOT NULL,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS benchmark_deliveries_teacher_idx
      ON benchmark_deliveries(school_id, teacher_staff_id, subject)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS benchmark_deliveries_benchmark_idx
      ON benchmark_deliveries(school_id, subject, benchmark_code)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS benchmark_deliveries_school_date_idx
      ON benchmark_deliveries(school_id, delivered_on)
  `);
}

// -----------------------------------------------------------------------------
// ensureSchoolBenchmarksCatalogBackfill
//
// For every school, derive distinct (subject, benchmark_code, category)
// triples from student_fast_item_responses and upsert into
// school_benchmarks (source='fast'). This is what makes the
// Instruction Log dropdown and the Instructional Coverage dashboard
// usable for ELA + Math out of the box without admins typing anything.
//
// Idempotent — uses ON CONFLICT DO NOTHING on the (school, subject,
// code) unique constraint so re-runs are no-ops. Locally-added or
// CSV-imported rows (source != 'fast') are never touched.
// -----------------------------------------------------------------------------
export async function ensureSchoolBenchmarksCatalogBackfill(): Promise<void> {
  await db.execute(sql`
    INSERT INTO school_benchmarks (school_id, subject, code, category, source)
    SELECT school_id, subject, benchmark_code, MAX(category), 'fast'
      FROM student_fast_item_responses
     GROUP BY school_id, subject, benchmark_code
    ON CONFLICT (school_id, subject, code) DO NOTHING
  `);
}

export async function ensureBadgePrintEventsSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS badge_print_events (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      printed_by_staff_id INTEGER,
      size TEXT NOT NULL,
      reason TEXT,
      batch_size INTEGER NOT NULL DEFAULT 1,
      printed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS badge_print_events_school_printed_at_idx ON badge_print_events(school_id, printed_at)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS badge_print_events_student_idx ON badge_print_events(school_id, student_id, printed_at)`,
  );
}

// =============================================================================
// ONE-SHOT: backfill benchmark_deliveries on the live demo school (school_id=1
// = D. S. Parrott Middle School). These rows were entered in the dev DB by
// accident and need to land in prod for the demo. Idempotent: if any
// benchmark_deliveries row already exists for school_id=1, this is a no-op.
// Safe to leave in seed.ts; can be deleted after the next prod boot.
// =============================================================================

interface BenchmarkDeliverySeedRow {
  t: string; // "__chris__" or staff.email
  s: string; // subject
  c: string; // benchmark_code
  d: string; // YYYY-MM-DD
  n: string | null; // notes
}

const DEMO_TEACHER_SEEDS: Array<{ email: string; displayName: string }> = [
  { email: "marcus.hayes.ela@dsparrott.test",    displayName: "Marcus Hayes ELA" },
  { email: "sarah.chen.ela@dsparrott.test",      displayName: "Sarah Chen ELA" },
  { email: "david.rodriguez.ela@dsparrott.test", displayName: "David Rodriguez ELA" },
  { email: "jennifer.park.ela@dsparrott.test",   displayName: "Jennifer Park ELA" },
  { email: "brian.walsh.ela@dsparrott.test",     displayName: "Brian Walsh ELA" },
  { email: "aisha.johnson.ela@dsparrott.test",   displayName: "Aisha Johnson ELA" },
  { email: "linda.foster.math@dsparrott.test",   displayName: "Linda Foster Math" },
  { email: "priya.patel.math@dsparrott.test",    displayName: "Priya Patel Math" },
  { email: "james.obrien.math@dsparrott.test",   displayName: "James OBrien Math" },
  { email: "kenji.tanaka.math@dsparrott.test",   displayName: "Kenji Tanaka Math" },
  { email: "maria.sanchez.math@dsparrott.test",  displayName: "Maria Sanchez Math" },
  { email: "tyrone.williams.math@dsparrott.test", displayName: "Tyrone Williams Math" },
];

export async function seedBenchmarkDeliveriesOnce(): Promise<void> {
  const SCHOOL_ID = 1;

  const existing = await db.execute<{ n: number }>(
    sql`SELECT COUNT(*)::int AS n FROM benchmark_deliveries WHERE school_id = ${SCHOOL_ID}`,
  );
  const existingCount = Number(existing.rows[0]?.n ?? 0);
  if (existingCount > 0) {
    return; // idempotent no-op
  }

  // 1) Upsert the 12 demo teachers (no-op if any already exist by email).
  for (const t of DEMO_TEACHER_SEEDS) {
    await db.execute(sql`
      INSERT INTO staff (email, password_hash, display_name, school_id, active, is_admin)
      VALUES (${t.email}, '!disabled!', ${t.displayName}, ${SCHOOL_ID}, true, false)
      ON CONFLICT (email) DO NOTHING
    `);
  }

  // 2) Build email/display_name → staff.id map for this school.
  const staffRows = await db.execute<{ id: number; email: string; display_name: string }>(sql`
    SELECT id, email, display_name FROM staff WHERE school_id = ${SCHOOL_ID}
  `);
  const idByEmail = new Map<string, number>();
  let chrisId: number | null = null;
  for (const r of staffRows.rows) {
    if (r.email) idByEmail.set(r.email, r.id);
    if (r.display_name === "Chris Clifford") chrisId = r.id;
  }

  const rows = benchmarkDeliveriesSeedJson as BenchmarkDeliverySeedRow[];
  let inserted = 0;
  let skipped = 0;
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const values = slice
      .map((r) => {
        const teacherId = r.t === "__chris__" ? chrisId : (idByEmail.get(r.t) ?? null);
        if (teacherId == null) {
          skipped++;
          return null;
        }
        const notesSql = r.n === null
          ? sql`NULL`
          : sql`${r.n}`;
        return sql`(${SCHOOL_ID}, ${teacherId}, ${r.s}, ${r.c}, ${r.d}::date, ${notesSql})`;
      })
      .filter((v): v is ReturnType<typeof sql> => v !== null);
    if (values.length === 0) continue;
    await db.execute(sql`
      INSERT INTO benchmark_deliveries
        (school_id, teacher_staff_id, subject, benchmark_code, delivered_on, notes)
      VALUES ${sql.join(values, sql`, `)}
    `);
    inserted += values.length;
  }
  logger.info(
    { inserted, skipped, total: rows.length },
    "[seed] benchmark_deliveries one-shot backfill complete",
  );
}

// Remap fictional demo-teacher deliveries onto the real Parrott teacher roster,
// matched by grade. Idempotent: no-op once the fictional staff own zero rows.
export async function remapBenchmarkDeliveriesToRealTeachersOnce(): Promise<void> {
  const SCHOOL_ID = 1;
  const REMAP: Array<[string, string]> = [
    ["Marcus Hayes ELA",     "David Wright - ELA G6"],
    ["Sarah Chen ELA",       "Carol Young - ELA G6"],
    ["David Rodriguez ELA",  "Kimberly King - ELA G7"],
    ["Jennifer Park ELA",    "Mark Rivera - ELA G7"],
    ["Brian Walsh ELA",      "Susan Adams - ELA G8"],
    ["Aisha Johnson ELA",    "Sandra Clark - ELA G8"],
    ["Linda Foster Math",    "Heather Martinez - Math G6"],
    ["Priya Patel Math",     "Steven Brown - Math G6"],
    ["James OBrien Math",    "Kevin Young - Math G7"],
    ["Kenji Tanaka Math",    "David Walker - Math G7"],
    ["Maria Sanchez Math",   "Jason Baker - Math G8"],
    ["Tyrone Williams Math", "Patricia Scott - Math G8"],
  ];

  const staffRows = await db.execute<{ id: number; display_name: string }>(sql`
    SELECT id, display_name FROM staff WHERE school_id = ${SCHOOL_ID}
  `);
  const idByName = new Map<string, number>();
  for (const r of staffRows.rows) idByName.set(r.display_name, r.id);

  const fictionalIds = REMAP.map(([from]) => idByName.get(from)).filter(
    (v): v is number => typeof v === "number",
  );
  if (fictionalIds.length === 0) return;

  const owned = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM benchmark_deliveries
     WHERE school_id = ${SCHOOL_ID}
       AND teacher_staff_id IN (${sql.join(fictionalIds.map((i) => sql`${i}`), sql`, `)})
  `);
  if (Number(owned.rows[0]?.n ?? 0) === 0) return;

  let updated = 0;
  for (const [fromName, toName] of REMAP) {
    const fromId = idByName.get(fromName);
    const toId = idByName.get(toName);
    if (fromId == null || toId == null) continue;
    const r = await db.execute<{ id: number }>(sql`
      UPDATE benchmark_deliveries
         SET teacher_staff_id = ${toId}
       WHERE school_id = ${SCHOOL_ID}
         AND teacher_staff_id = ${fromId}
      RETURNING id
    `);
    updated += r.rows.length;
  }
  logger.info({ updated }, "[seed] benchmark_deliveries remapped to real teachers");
}

// One-shot: give every Parrott (school_id=1) student a clean 7-period schedule
// (one teacher per period) so the tardy-pass flow (and any other code that
// joins through section_roster) has a section to land on. Idempotent: skips
// once every active student already has exactly 7 distinct period enrollments.
export async function fillStudentSchedulesAtParrottOnce(): Promise<void> {
  const SCHOOL_ID = 1;

  // Per-grade ordered subject layout: index i = period i+1.
  // Course names match existing class_sections.course_name verbatim.
  const SUBJECT_LAYOUT: Record<number, string[]> = {
    6: [
      "ELA — Grade 6", "Math — Grade 6", "Science — Grade 6",
      "Social Studies — Grade 6", "PE", "Art", "Music",
    ],
    7: [
      "ELA — Grade 7", "Math — Grade 7", "Science — Grade 7",
      "Social Studies — Grade 7", "PE", "Art", "Music",
    ],
    8: [
      "ELA — Grade 8", "Math — Grade 8", "Science — Grade 8",
      "Social Studies — Grade 8", "PE", "Art", "Music",
    ],
  };

  // Collect the teacher pool for each course (any teacher who already owns a
  // section of that course at school 1 is eligible).
  const teacherRows = await db.execute<{
    course_name: string;
    teacher_staff_id: number;
  }>(sql`
    SELECT DISTINCT course_name, teacher_staff_id
      FROM class_sections
     WHERE school_id = ${SCHOOL_ID} AND is_planning = false
  `);
  const teachersByCourse = new Map<string, number[]>();
  for (const r of teacherRows.rows) {
    const arr = teachersByCourse.get(r.course_name) ?? [];
    if (!arr.includes(r.teacher_staff_id)) arr.push(r.teacher_staff_id);
    teachersByCourse.set(r.course_name, arr);
  }
  for (const [, ids] of teachersByCourse) ids.sort((a, b) => a - b);

  // Ensure a section exists for every (period, course, teacher) we need.
  // The unique index is (teacher_staff_id, period), so a teacher gets ONE
  // section per period. If they already teach that period some other course
  // we keep that section and skip — we'll just not assign students to it.
  const sectionIdByKey = new Map<string, number>(); // `${period}|${teacher}` -> sectionId
  for (const grade of [6, 7, 8] as const) {
    const layout = SUBJECT_LAYOUT[grade];
    for (let i = 0; i < 7; i++) {
      const period = i + 1;
      const course = layout[i];
      const pool = teachersByCourse.get(course) ?? [];
      for (const teacherId of pool) {
        const ins = await db.execute<{ id: number }>(sql`
          INSERT INTO class_sections
            (school_id, teacher_staff_id, period, course_name, is_planning)
          VALUES (${SCHOOL_ID}, ${teacherId}, ${period}, ${course}, false)
          ON CONFLICT (teacher_staff_id, period) DO NOTHING
          RETURNING id
        `);
        let sid: number | null = ins.rows[0]?.id ?? null;
        if (sid == null) {
          const found = await db.execute<{ id: number; course_name: string }>(sql`
            SELECT id, course_name FROM class_sections
             WHERE school_id = ${SCHOOL_ID}
               AND teacher_staff_id = ${teacherId}
               AND period = ${period}
             LIMIT 1
          `);
          if (found.rows[0]?.course_name === course) {
            sid = found.rows[0].id;
          }
        }
        if (sid != null) sectionIdByKey.set(`${period}|${teacherId}`, sid);
      }
    }
  }

  // Pull students keyed for round-robin.
  const students = await db.execute<{ student_id: string; grade: string }>(sql`
    SELECT student_id, grade FROM students
     WHERE school_id = ${SCHOOL_ID}
     ORDER BY student_id
  `);
  if (students.rows.length === 0) return;

  // Idempotency check: if every student already has exactly 7 periods, bail.
  const cov = await db.execute<{ ok: number; total: number }>(sql`
    WITH per AS (
      SELECT sr.student_id, COUNT(DISTINCT cs.period) AS pc
        FROM section_roster sr
        JOIN class_sections cs ON cs.id = sr.section_id
       WHERE sr.school_id = ${SCHOOL_ID}
       GROUP BY sr.student_id
    )
    SELECT
      (SELECT COUNT(*) FROM per WHERE pc = 7)::int AS ok,
      (SELECT COUNT(*) FROM students WHERE school_id = ${SCHOOL_ID})::int AS total
  `);
  if (
    cov.rows[0] &&
    cov.rows[0].ok === cov.rows[0].total &&
    cov.rows[0].total > 0
  ) {
    return;
  }

  let perStudentInserts = 0;
  let perStudentDeletes = 0;
  const byGradeIdx: Record<number, number> = { 6: 0, 7: 0, 8: 0 };
  for (const s of students.rows) {
    const grade = Number(s.grade);
    if (!SUBJECT_LAYOUT[grade]) continue;
    const idx = byGradeIdx[grade]++;
    const layout = SUBJECT_LAYOUT[grade];

    // Wipe and rewrite this student's enrollments for school 1 so they end up
    // with exactly 7 sections (one per period 1..7).
    const del = await db.execute(sql`
      DELETE FROM section_roster
       WHERE school_id = ${SCHOOL_ID} AND student_id = ${s.student_id}
    `);
    perStudentDeletes += (del.rowCount ?? 0);

    const targetSectionIds: number[] = [];
    for (let i = 0; i < 7; i++) {
      const period = i + 1;
      const course = layout[i];
      const pool = teachersByCourse.get(course) ?? [];
      if (pool.length === 0) continue;
      const teacherId = pool[idx % pool.length];
      const sid = sectionIdByKey.get(`${period}|${teacherId}`);
      if (sid != null) targetSectionIds.push(sid);
    }
    if (targetSectionIds.length === 0) continue;
    const values = targetSectionIds.map(
      (sid) => sql`(${SCHOOL_ID}, ${sid}, ${s.student_id})`,
    );
    await db.execute(sql`
      INSERT INTO section_roster (school_id, section_id, student_id)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT ON CONSTRAINT section_roster_section_student_unique DO NOTHING
    `);
    perStudentInserts += targetSectionIds.length;
  }

  logger.info(
    { students: students.rows.length, perStudentInserts, perStudentDeletes },
    "[seed] Parrott student schedules filled (7 periods each)",
  );
}

// One-shot: rebalance Parrott (school_id=1) IEP/504/ELL flags to a realistic
// ~25% combined coverage — ~15% IEP, ~5% 504, ~5% ELL. Buckets are mutually
// exclusive (a student lands in at most one). Assignment is deterministic by
// sorted student_id so students-per-bucket aligns with the schedule
// round-robin, spreading flagged kids evenly across sections. Idempotent:
// skips when current rates are already within ±1pp of target.
export async function rebalanceFlagsAtParrottOnce(): Promise<void> {
  const SCHOOL_ID = 1;
  const TARGET_IEP_PCT = 0.15;
  const TARGET_504_PCT = 0.05;
  const TARGET_ELL_PCT = 0.05;
  const TOL_PP = 0.01;

  const cur = await db.execute<{
    total: number; iep: number; p504: number; ell: number;
  }>(sql`
    SELECT COUNT(*)::int AS total,
           SUM(CASE WHEN ese THEN 1 ELSE 0 END)::int AS iep,
           SUM(CASE WHEN is_504 THEN 1 ELSE 0 END)::int AS p504,
           SUM(CASE WHEN ell THEN 1 ELSE 0 END)::int AS ell
      FROM students WHERE school_id = ${SCHOOL_ID}
  `);
  const stats = cur.rows[0];
  if (!stats || stats.total === 0) return;
  const inTol = (
    Math.abs(stats.iep / stats.total - TARGET_IEP_PCT) <= TOL_PP &&
    Math.abs(stats.p504 / stats.total - TARGET_504_PCT) <= TOL_PP &&
    Math.abs(stats.ell / stats.total - TARGET_ELL_PCT) <= TOL_PP
  );
  if (inTol) return;

  const ids = await db.execute<{ student_id: string }>(sql`
    SELECT student_id FROM students WHERE school_id = ${SCHOOL_ID}
    ORDER BY student_id
  `);
  const total = ids.rows.length;
  const nIep  = Math.round(total * TARGET_IEP_PCT);
  const n504  = Math.round(total * TARGET_504_PCT);
  const nEll  = Math.round(total * TARGET_ELL_PCT);

  // Buckets are contiguous slices of the sorted student_id list. Since the
  // schedule round-robin also keys off sorted student_id, slicing this way
  // naturally distributes flagged kids across both teachers of every section.
  const iepIds  = ids.rows.slice(0, nIep).map((r) => r.student_id);
  const p504Ids = ids.rows.slice(nIep, nIep + n504).map((r) => r.student_id);
  const ellIds  = ids.rows.slice(nIep + n504, nIep + n504 + nEll).map((r) => r.student_id);

  // Clear all flags first, then set the target buckets.
  await db.execute(sql`
    UPDATE students SET ese = false, is_504 = false, ell = false
     WHERE school_id = ${SCHOOL_ID}
  `);

  async function setFlag(column: "ese" | "is_504" | "ell", studentIds: string[]) {
    if (studentIds.length === 0) return;
    const BATCH = 200;
    for (let i = 0; i < studentIds.length; i += BATCH) {
      const slice = studentIds.slice(i, i + BATCH);
      const list = sql.join(slice.map((s) => sql`${s}`), sql`, `);
      if (column === "ese") {
        await db.execute(sql`
          UPDATE students SET ese = true
           WHERE school_id = ${SCHOOL_ID} AND student_id IN (${list})
        `);
      } else if (column === "is_504") {
        await db.execute(sql`
          UPDATE students SET is_504 = true
           WHERE school_id = ${SCHOOL_ID} AND student_id IN (${list})
        `);
      } else {
        await db.execute(sql`
          UPDATE students SET ell = true
           WHERE school_id = ${SCHOOL_ID} AND student_id IN (${list})
        `);
      }
    }
  }

  await setFlag("ese", iepIds);
  await setFlag("is_504", p504Ids);
  await setFlag("ell", ellIds);

  logger.info(
    { total, iep: nIep, p504: n504, ell: nEll },
    "[seed] Parrott flags rebalanced to target distribution",
  );
}

// -----------------------------------------------------------------------------
// Class Composer "Master Plans" schema. Idempotent CREATE TABLE IF NOT EXISTS
// at boot per the project gotchas note (drizzle-kit push can't apply this
// non-interactively in this repo).
// -----------------------------------------------------------------------------
export async function ensureClassComposerPlansSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS class_composer_plans (
      id SERIAL PRIMARY KEY,
      school_id INTEGER NOT NULL,
      school_year TEXT NOT NULL,
      subject TEXT NOT NULL,
      grade INTEGER NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      public_id TEXT NOT NULL,
      created_by_staff_id INTEGER NOT NULL,
      finalized_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS class_composer_plans_school_idx ON class_composer_plans (school_id)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS class_composer_plans_school_subject_grade_idx ON class_composer_plans (school_id, subject, grade, school_year)`,
  );
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS class_composer_plan_groups (
      id SERIAL PRIMARY KEY,
      plan_id INTEGER NOT NULL,
      school_id INTEGER NOT NULL,
      group_index INTEGER NOT NULL,
      name TEXT NOT NULL,
      recipe JSONB NOT NULL,
      student_ids TEXT[] NOT NULL DEFAULT '{}',
      seats_per_section INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS class_composer_plan_groups_plan_idx ON class_composer_plan_groups (plan_id)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS class_composer_plan_groups_school_idx ON class_composer_plan_groups (school_id)`,
  );
}
