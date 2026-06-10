/* eslint-disable no-console */
// =============================================================================
// seedMtssProgress — seed ~2 months of realistic Tier 2 + Tier 3 MTSS progress
// data for D. S. Parrott Middle School (school_id=1) so the MTSS Reports page
// has something to review.
//
// The Parrott reseed creates student_mtss_plans (T2 + T3) but intentionally
// SKIPS the progress tables, so the reports render empty. This script fills:
//   - tier2_intervention_entries  (presence = weekly completion)
//   - tier3_weekly_records        (mon-fri 1..5 scores + PRIDE + goalScores)
// and backdates plan openedAt into a ~9-week window so the trend has history.
//
// Realistic structure baked in (so the new report panels actually show
// something interesting):
//   - Per-teacher fidelity for T2 (some teachers reliably log, some lag).
//   - Midweek-heavy log-day distribution (which weekday teachers log on).
//   - T3 day-of-week effect (Mondays/Fridays worse, Wednesday best).
//   - T3 per-(student,teacher) offset (a student does better in some classes).
//   - T3 trend over time: most students improve, some plateau, a few decline.
//   - Occasional absent days; PRIDE 0..2 correlated with the day score.
//
// Idempotent: wipes school-1 progress rows + re-backdates openedAt each run.
// Deterministic: all randomness is seeded, so re-runs reproduce the same data.
//
// Run: pnpm --filter @workspace/scripts run seed-mtss
// =============================================================================

import {
  classSectionsTable,
  db,
  pool,
  schoolsTable,
  sectionRosterTable,
  studentMtssPlansTable,
  tier2InterventionEntriesTable,
  tier3GoalsTable,
  tier3WeeklyRecordsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

const SCHOOL_ID = 1;
const WEEKS = 9; // ~2 months of Mon-Fri weeks

// ---------------- deterministic RNG ----------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Stable string hash → uint32, so per-entity randomness is reproducible.
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// A stable [0,1) value for an entity, derived from a label.
function unit(label: string): number {
  return mulberry32(hashStr(label))();
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ---------------- date helpers (school-local, timezone-safe text) ----------

function isoDate(d: Date): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  const dow = d.getDay();
  const shift = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + shift);
  return isoDate(d);
}

// Build the list of Monday week-start strings, oldest first.
function buildWeeks(): string[] {
  const todayMon = mondayOf(isoDate(new Date()));
  const weeks: string[] = [];
  for (let i = WEEKS - 1; i >= 0; i--) {
    weeks.push(addDays(todayMon, -7 * i));
  }
  return weeks;
}

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri"] as const;
type DayKey = (typeof DAY_KEYS)[number];

// ---------------- main ----------------

async function main(): Promise<void> {
  // 1. Assert we're targeting Parrott.
  const [school] = await db
    .select()
    .from(schoolsTable)
    .where(eq(schoolsTable.id, SCHOOL_ID));
  if (!school) throw new Error(`School ${SCHOOL_ID} not found`);
  if (!/parrott/i.test(school.name)) {
    throw new Error(
      `Refusing to run: school ${SCHOOL_ID} is "${school.name}", not Parrott`,
    );
  }
  console.log(`Seeding MTSS progress for "${school.name}" (id=${SCHOOL_ID})`);

  const weeks = buildWeeks();
  const windowStart = weeks[0]!;
  const windowEnd = addDays(weeks[weeks.length - 1]!, 4); // last Friday
  console.log(`Window: ${windowStart} … ${windowEnd} (${weeks.length} weeks)`);

  // 2. Load every plan at the school.
  const plans = await db
    .select()
    .from(studentMtssPlansTable)
    .where(eq(studentMtssPlansTable.schoolId, SCHOOL_ID));
  console.log(`Plans: ${plans.length}`);

  // 3. Backdate openedAt: most plans open at window start; ~25% staggered
  //    into the first few weeks for a realistic ramp. Deterministic.
  for (const p of plans) {
    const r = unit(`open:${p.id}`);
    let openDay: string;
    if (r < 0.75) {
      // Open at/just before the window starts.
      openDay = addDays(windowStart, -Math.floor(unit(`openjit:${p.id}`) * 4));
    } else {
      // Staggered start within the first 3 weeks.
      const wkIdx = 1 + Math.floor(unit(`openwk:${p.id}`) * 3);
      openDay = weeks[Math.min(wkIdx, weeks.length - 1)]!;
    }
    const openedAt = new Date(`${openDay}T13:00:00Z`);
    await db
      .update(studentMtssPlansTable)
      .set({ openedAt, closedAt: null })
      .where(eq(studentMtssPlansTable.id, p.id));
    // Keep the in-memory copy in sync — the generation loop below reads
    // p.openedAt to decide which weeks a plan is open for.
    p.openedAt = openedAt;
  }

  // 4. Wipe existing progress rows (idempotent).
  await db
    .delete(tier2InterventionEntriesTable)
    .where(eq(tier2InterventionEntriesTable.schoolId, SCHOOL_ID));
  await db
    .delete(tier3WeeklyRecordsTable)
    .where(eq(tier3WeeklyRecordsTable.schoolId, SCHOOL_ID));
  console.log("Cleared existing T2 entries + T3 records.");

  // 5. Effective teachers per student (schedule, excluding planning periods).
  const studentIds = Array.from(new Set(plans.map((p) => p.studentId)));
  const scheduleRows = await db
    .selectDistinct({
      studentId: sectionRosterTable.studentId,
      teacherStaffId: classSectionsTable.teacherStaffId,
    })
    .from(sectionRosterTable)
    .innerJoin(
      classSectionsTable,
      eq(classSectionsTable.id, sectionRosterTable.sectionId),
    )
    .where(
      and(
        eq(sectionRosterTable.schoolId, SCHOOL_ID),
        eq(classSectionsTable.isPlanning, false),
        inArray(sectionRosterTable.studentId, studentIds),
      ),
    );
  const teachersByStudent = new Map<string, number[]>();
  for (const r of scheduleRows) {
    const arr = teachersByStudent.get(r.studentId);
    if (arr) arr.push(r.teacherStaffId);
    else teachersByStudent.set(r.studentId, [r.teacherStaffId]);
  }

  function effectiveTeachers(p: (typeof plans)[number]): number[] {
    if (!p.autoAssignScheduleTeachers) {
      return (p.assignedTeacherIds || "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
    }
    const excluded = new Set(
      (p.excludedTeacherIds || "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter(Boolean),
    );
    const additional = (p.additionalInterventionistIds || "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    const merged = new Set<number>();
    for (const t of teachersByStudent.get(p.studentId) ?? [])
      if (!excluded.has(t)) merged.add(t);
    for (const t of additional) if (!excluded.has(t)) merged.add(t);
    return Array.from(merged).sort((a, b) => a - b);
  }

  // Per-teacher T2 fidelity baseline (some lag). ~25% < 0.6 → flags.
  function teacherFidelity(teacherId: number): number {
    const r = unit(`fid:${teacherId}`);
    if (r < 0.25) return 0.45 + r; // 0.45..0.70 (laggards)
    return 0.7 + (r - 0.25) * 0.36; // 0.70..0.97 (reliable)
  }

  // T2 log-day weights (midweek-heavy).
  const T2_DAY_WEIGHTS: Record<DayKey, number> = {
    mon: 0.12,
    tue: 0.26,
    wed: 0.28,
    thu: 0.22,
    fri: 0.12,
  };
  function pickLogDay(rng: () => number): DayKey {
    const roll = rng();
    let acc = 0;
    for (const d of DAY_KEYS) {
      acc += T2_DAY_WEIGHTS[d];
      if (roll <= acc) return d;
    }
    return "wed";
  }
  const DAY_OFFSET: Record<DayKey, number> = {
    mon: 0,
    tue: 1,
    wed: 2,
    thu: 3,
    fri: 4,
  };

  // T3 day-of-week behavior delta (Mon/Fri worse, Wed best).
  const T3_DAY_DELTA: Record<DayKey, number> = {
    mon: -0.5,
    tue: 0.1,
    wed: 0.45,
    thu: 0.1,
    fri: -0.45,
  };

  // Active goal slot → goalId for each T3 student (largest effectiveFrom).
  const tier3StudentIds = plans
    .filter((p) => p.tier === 3)
    .map((p) => p.studentId);
  const goalRows =
    tier3StudentIds.length === 0
      ? []
      : await db
          .select()
          .from(tier3GoalsTable)
          .where(
            and(
              eq(tier3GoalsTable.schoolId, SCHOOL_ID),
              inArray(tier3GoalsTable.studentId, tier3StudentIds),
            ),
          );
  // student → slot → goalId (keep the most recent effectiveFrom per slot)
  const activeGoalByStudentSlot = new Map<string, Map<number, number>>();
  const bestEffFrom = new Map<string, string>();
  for (const g of goalRows) {
    const key = `${g.studentId}:${g.slot}`;
    const prev = bestEffFrom.get(key);
    if (!prev || g.effectiveFrom >= prev) {
      bestEffFrom.set(key, g.effectiveFrom);
      let slots = activeGoalByStudentSlot.get(g.studentId);
      if (!slots) {
        slots = new Map();
        activeGoalByStudentSlot.set(g.studentId, slots);
      }
      slots.set(g.slot, g.id);
    }
  }

  // ---- generate T2 rows ----
  type T2Insert = typeof tier2InterventionEntriesTable.$inferInsert;
  type T3Insert = typeof tier3WeeklyRecordsTable.$inferInsert;
  const t2Rows: T2Insert[] = [];
  const t3Rows: T3Insert[] = [];

  for (const p of plans) {
    const openMon = mondayOf(isoDate(p.openedAt));
    const teachers = effectiveTeachers(p);
    if (teachers.length === 0) continue;

    for (let wi = 0; wi < weeks.length; wi++) {
      const wk = weeks[wi]!;
      if (wk < openMon) continue; // plan not open yet
      // Fidelity ramp: completion improves a touch over the window.
      const ramp = 0.04 * wi;

      if (p.tier === 2) {
        const subType = p.interventionSubType ?? "cico";
        for (const tid of teachers) {
          const rng = mulberry32(hashStr(`t2:${p.id}:${tid}:${wk}`));
          const prob = clamp(teacherFidelity(tid) + ramp, 0, 0.98);
          if (rng() > prob) continue; // not logged this week
          const day = pickLogDay(rng);
          const entryDate = addDays(wk, DAY_OFFSET[day]);
          t2Rows.push({
            schoolId: SCHOOL_ID,
            studentId: p.studentId,
            teacherStaffId: tid,
            entryDate,
            subType,
            notes: "",
            createdAt: new Date(`${entryDate}T17:00:00Z`),
          });
        }
      } else if (p.tier === 3) {
        // Student behavior profile.
        const studentBase = 2.5 + unit(`base:${p.studentId}`) * 1.2; // 2.5..3.7
        const trendRoll = unit(`trend:${p.studentId}`);
        // ~70% improve, ~20% plateau, ~10% decline.
        const trendPerWeek =
          trendRoll < 0.7
            ? 0.06 + unit(`tup:${p.studentId}`) * 0.05
            : trendRoll < 0.9
              ? 0
              : -(0.04 + unit(`tdn:${p.studentId}`) * 0.04);
        const trend = trendPerWeek * wi;

        const slots = activeGoalByStudentSlot.get(p.studentId);
        const goalVersionIds: Record<string, number> = {};
        const slotCount = Math.max(1, Math.min(p.tier3GoalSlots || 2, 5));
        if (slots) {
          for (let s = 1; s <= slotCount; s++) {
            const gid = slots.get(s);
            if (gid != null) goalVersionIds[String(s)] = gid;
          }
        }

        for (const tid of teachers) {
          const rng = mulberry32(hashStr(`t3:${p.id}:${tid}:${wk}`));
          // Some weeks a teacher just doesn't submit (rare).
          if (rng() < 0.06) continue;
          const teacherOffset =
            -0.6 + unit(`toff:${p.studentId}:${tid}`) * 1.3; // -0.6..+0.7

          const dayScore: Record<DayKey, number | null> = {
            mon: null,
            tue: null,
            wed: null,
            thu: null,
            fri: null,
          };
          const absentDays: Record<string, boolean> = {};
          const pride: Record<DayKey, number | null> = {
            mon: null,
            tue: null,
            wed: null,
            thu: null,
            fri: null,
          };
          const goalScores: Record<string, Record<string, number | null>> = {};
          for (let s = 1; s <= slotCount; s++) goalScores[String(s)] = {};

          for (const day of DAY_KEYS) {
            if (rng() < 0.04) {
              absentDays[day] = true;
              for (let s = 1; s <= slotCount; s++)
                goalScores[String(s)]![day] = null;
              continue;
            }
            const noise = (rng() - 0.5) * 1.0;
            const raw =
              studentBase +
              teacherOffset +
              T3_DAY_DELTA[day] +
              trend +
              noise;
            const score = Math.round(clamp(raw, 1, 5));
            dayScore[day] = score;
            pride[day] = Math.round(clamp((score / 5) * 2 + (rng() - 0.5), 0, 2));
            for (let s = 1; s <= slotCount; s++) {
              const gj = Math.round(clamp(score + (rng() - 0.5) * 1.2, 1, 5));
              goalScores[String(s)]![day] = gj;
            }
          }

          const friday = addDays(wk, 4);
          t3Rows.push({
            schoolId: SCHOOL_ID,
            studentId: p.studentId,
            teacherStaffId: tid,
            weekStartDate: wk,
            monScore: dayScore.mon,
            tueScore: dayScore.tue,
            wedScore: dayScore.wed,
            thuScore: dayScore.thu,
            friScore: dayScore.fri,
            weeklyComment: "",
            prideMon: p.trackSchoolWideExpectations ? pride.mon : null,
            prideTue: p.trackSchoolWideExpectations ? pride.tue : null,
            prideWed: p.trackSchoolWideExpectations ? pride.wed : null,
            prideThu: p.trackSchoolWideExpectations ? pride.thu : null,
            prideFri: p.trackSchoolWideExpectations ? pride.fri : null,
            goalVersionIds,
            goalScores,
            absentDays,
            submittedAt: new Date(`${friday}T18:00:00Z`),
            createdAt: new Date(`${friday}T18:00:00Z`),
          });
        }
      }
    }
  }

  // 6. Insert in batches.
  async function batchInsert<T>(
    rows: T[],
    insertFn: (chunk: T[]) => Promise<unknown>,
    size = 500,
  ): Promise<void> {
    for (let i = 0; i < rows.length; i += size) {
      await insertFn(rows.slice(i, i + size));
    }
  }
  await batchInsert(t2Rows, (chunk) =>
    db.insert(tier2InterventionEntriesTable).values(chunk),
  );
  await batchInsert(t3Rows, (chunk) =>
    db.insert(tier3WeeklyRecordsTable).values(chunk),
  );

  console.log(`Inserted ${t2Rows.length} T2 entries, ${t3Rows.length} T3 records.`);
  console.log("Done.");
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
