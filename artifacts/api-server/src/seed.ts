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
} from "@workspace/db";
import bcrypt from "bcryptjs";
import { eq, sql, and, inArray, isNull } from "drizzle-orm";
import { logger } from "./lib/logger";
import { fetchWeatherForLocation } from "./lib/weatherFetcher";

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

  // ---- discipline_reasons (school-managed list) ----
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
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS discipline_reasons_school_label_uq ON discipline_reasons(school_id, label)`,
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
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS interaction_cases_school_number_idx ON interaction_cases(school_id, case_number)`);

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
  await ensureAdminHubSchema();
  await ensureTierPresetsSchema();
  await ensureOnboardingChecklistSchema();
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
        detail: "",
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

    // Any high-concern student who isn't anchored on a case still gets a
    // single off-case incident so they show up on the orbit / alerts feed
    // without inflating any case beyond MAX_STMTS_PER_CASE.
    const anchoredOnCase = new Set(
      caseRoster
        .filter((r) => (WL_ROLES_HIGH as readonly string[]).includes(r.role))
        .map((r) => r.studentId),
    );
    high.forEach((stu) => {
      if (anchoredOnCase.has(stu.studentId)) return;
      pushIncident({
        anchor: stu,
        anchorRole: WL_ROLES_HIGH[0],
        coStudents: [],
        severity: 4,
        kind: pick(rng, [...WL_KINDS].filter((k) => k !== "peripheral_note")),
        daysAgo: 2 + Math.floor(rng() * 14),
        caseId: null,
        summary: `${stu.firstName} ${stu.lastName.charAt(0)}. — ongoing concern; not yet linked to a case.`,
      });
    });

    // Medium incidents are intentionally NEVER attached to a case so the
    // MAX_STMTS_PER_CASE cap above stays a true ceiling. They still feed
    // the orbit / alerts views and the loose-escalation rule.
    med.forEach((stu) => {
      const incidentCount = 2 + Math.floor(rng() * 2);
      for (let i = 0; i < incidentCount; i++) {
        const sev = rng() < 0.25 ? 4 : rng() < 0.6 ? 3 : 2;
        pushIncident({
          anchor: stu,
          anchorRole: WL_ROLES_MED[i % WL_ROLES_MED.length],
          coStudents: [],
          severity: sev,
          kind: pick(rng, [...WL_KINDS]),
          daysAgo: 2 + Math.floor(rng() * 28),
          caseId: null,
          summary: `${stu.firstName} ${stu.lastName.charAt(0)}. — ${pick(rng, ["raised voices", "name-calling", "shoving", "rumor reported"])} in ${pick(rng, WL_LOCATIONS)}.`,
        });
      }
    });

    // Low: 1 incident each, usually peripheral / witness / observation.
    low.forEach((stu, sIdx) => {
      const sev = rng() < 0.15 ? 3 : rng() < 0.5 ? 2 : 1;
      pushIncident({
        anchor: stu,
        anchorRole: WL_ROLES_LOW[sIdx % WL_ROLES_LOW.length],
        coStudents: [],
        severity: sev,
        kind: sev === 1 ? "peripheral_note" : pick(rng, [...WL_KINDS]),
        daysAgo: 3 + Math.floor(rng() * 35),
        caseId: null,
        summary: `${stu.firstName} ${stu.lastName.charAt(0)}. — ${sev === 1 ? "noted on the periphery; flagged for awareness only." : "minor incident logged for awareness."}`,
      });
    });

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
