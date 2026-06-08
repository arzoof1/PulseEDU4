import { Router, type IRouter, type Request } from "express";
import bcrypt from "bcryptjs";
import {
  db,
  staffTable,
  studentsTable,
  interactionsTable,
  interactionParticipantsTable,
  interactionCasesTable,
  interactionCasePlayerImpactTable,
  interactionCaseNotesTable,
  supportNotesTable,
  ossLogsTable,
  issAdminLogsTable,
  studentEmergencyContactsTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { verifyAuthToken } from "../lib/authToken.js";
import { runDspParrottReseed } from "../lib/dspParrottReseed.js";
import { rebuildDspSections } from "../lib/rebuildDspSections.js";
import { rebuildParrott } from "../lib/parrottRebuild.js";
import {
  seedBenchmarkDeliveriesOnce,
  remapBenchmarkDeliveriesToRealTeachersOnce,
} from "../seed.js";
import { studentAccommodationsTable } from "@workspace/db";
import { schoolYearLabelFor, DEFAULT_SCHOOL_TZ } from "../lib/schoolYear.js";

// Hardcoded so this bootstrap can ONLY ever reset chris.clifford's password.
// No body, no params — calling it for anyone else is structurally impossible.
const BOOTSTRAP_TARGET_EMAIL = "chris.clifford@hcsb.k12.fl.us";
const BOOTSTRAP_NEW_PASSWORD = "PulseDemo!";

const router: IRouter = Router();

async function loadStaff(req: Request) {
  let id = req.staffId ?? null;
  if (!id) {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      id = verifyAuthToken(auth.slice(7).trim());
    }
  }
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

// Finish-up pass after parrott-rebuild: seeds benchmark_deliveries (and
// remaps them onto the live teacher roster) and backfills accommodations
// for any flagged student (ESE/504/ELL) currently missing them. Idempotent.
router.post("/parrott-finish", async (req, res) => {
  const staff = await loadStaff(req);
  if (!staff) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!staff.isSuperUser) {
    res.status(403).json({ error: "superuser_required" });
    return;
  }
  const SCHOOL_ID = 1;
  try {
    // 1. Benchmark deliveries: idempotent seeder is a no-op if rows exist.
    await seedBenchmarkDeliveriesOnce();
    await remapBenchmarkDeliveriesToRealTeachersOnce();
    const dRes = await db.execute<{ n: number }>(
      sql`SELECT COUNT(*)::int AS n FROM benchmark_deliveries WHERE school_id = ${SCHOOL_ID}`,
    );
    const deliveries = Number(dRes.rows[0]?.n ?? 0);

    // 2. Accommodations backfill for any flagged student missing them
    // (catches the ELL cohort the original rebuild skipped, plus any
    // ESE/504 student that somehow ended up with zero). Deterministic
    // count of 2-4 per student, drawn from the school's active library.
    const libRes = await db.execute<{ id: number }>(
      sql`SELECT id FROM school_accommodations WHERE school_id = ${SCHOOL_ID} AND active = true`,
    );
    const accommIds = libRes.rows.map((r) => r.id);

    const missingRes = await db.execute<{ student_id: string }>(sql`
      SELECT s.student_id
      FROM students s
      WHERE s.school_id = ${SCHOOL_ID}
        AND (s.ese = true OR s.is_504 = true OR s.ell = true)
        AND NOT EXISTS (
          SELECT 1 FROM student_accommodations sa
          WHERE sa.school_id = s.school_id AND sa.student_id = s.student_id
        )
    `);
    const missingIds = missingRes.rows.map((r) => r.student_id);

    let addedAccommodations = 0;
    if (missingIds.length && accommIds.length) {
      // Deterministic by student_id hash so re-runs (after a wipe) produce
      // the same shape.
      const newRows: Array<typeof studentAccommodationsTable.$inferInsert> = [];
      for (const sid of missingIds) {
        let h = 0;
        for (let i = 0; i < sid.length; i++) h = (h * 31 + sid.charCodeAt(i)) >>> 0;
        const n = 2 + (h % 3); // 2, 3, or 4
        const start = h % accommIds.length;
        for (let k = 0; k < n; k++) {
          newRows.push({
            schoolId: SCHOOL_ID,
            studentId: sid,
            accommodationId: accommIds[(start + k) % accommIds.length]!,
          });
        }
      }
      for (let i = 0; i < newRows.length; i += 500) {
        await db.insert(studentAccommodationsTable).values(newRows.slice(i, i + 500));
      }
      addedAccommodations = newRows.length;
    }

    res.json({
      ok: true,
      benchmarkDeliveries: deliveries,
      backfilledStudents: missingIds.length,
      addedAccommodations,
    });
  } catch (err) {
    req.log.error({ err }, "parrott-finish failed");
    res.status(500).json({
      error: "finish_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

// Seed-only: wipe and rebuild benchmark_deliveries for Parrott (school 1)
// so that PM3 > PM1 students have visibly more lessons logged than flat /
// regressing students. Pure data — no aggregation / report logic touched.
// ELA + Math only.
router.post("/parrott-seed-deliveries", async (req, res) => {
  const staff = await loadStaff(req);
  if (!staff) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!staff.isSuperUser) {
    res.status(403).json({ error: "superuser_required" });
    return;
  }
  const SCHOOL_ID = 1;
  try {
    // -- 1. WIPE --------------------------------------------------------
    const wipedRes = await db.execute<{ n: number }>(sql`
      WITH d AS (
        DELETE FROM benchmark_deliveries WHERE school_id = ${SCHOOL_ID} RETURNING 1
      )
      SELECT COUNT(*)::int AS n FROM d
    `);
    const wiped = Number(wipedRes.rows[0]?.n ?? 0);

    // -- 2. LOAD ELA/MATH TEACHERS + their grade --------------------------
    // One row per (teacher, subject, grade). A teacher only ever owns one
    // (subject, grade) combo at Parrott per the rebuild naming.
    const teacherRes = await db.execute<{
      teacher_staff_id: number;
      subject: string;
      grade: number;
    }>(sql`
      SELECT DISTINCT
        cs.teacher_staff_id,
        LOWER(SPLIT_PART(cs.course_name, ' ', 1)) AS subject,
        NULLIF(REGEXP_REPLACE(cs.course_name, '.*Grade ([0-9]+).*', '\\1'), cs.course_name)::int AS grade
      FROM class_sections cs
      WHERE cs.school_id = ${SCHOOL_ID}
        AND cs.is_planning = false
        AND (cs.course_name ILIKE 'ELA%' OR cs.course_name ILIKE 'Math%')
    `);

    // -- 3. PM-IMPROVER % PER TEACHER -------------------------------------
    // For each teacher: across their rostered students with both PM1+PM3,
    // what fraction improved by ≥1 point? Drives the soft correlation
    // between "teacher delivered more often" and "students improved".
    const improverRes = await db.execute<{
      teacher_staff_id: number;
      subject: string;
      improver_pct: number;
    }>(sql`
      WITH roster AS (
        SELECT cs.teacher_staff_id,
               LOWER(SPLIT_PART(cs.course_name, ' ', 1)) AS subject,
               sr.student_id
        FROM section_roster sr
        JOIN class_sections cs ON cs.id = sr.section_id
        WHERE sr.school_id = ${SCHOOL_ID} AND cs.is_planning = false
          AND (cs.course_name ILIKE 'ELA%' OR cs.course_name ILIKE 'Math%')
      )
      SELECT
        r.teacher_staff_id,
        r.subject,
        COALESCE(
          AVG(CASE WHEN f.pm3 IS NOT NULL AND f.pm1 IS NOT NULL AND f.pm3 - f.pm1 >= 1
                   THEN 1.0 ELSE 0.0 END)
            FILTER (WHERE f.pm1 IS NOT NULL AND f.pm3 IS NOT NULL),
          0.4
        )::float AS improver_pct
      FROM roster r
      LEFT JOIN student_fast_scores f
        ON f.school_id = ${SCHOOL_ID}
       AND f.student_id = r.student_id
       AND f.subject = r.subject
      GROUP BY r.teacher_staff_id, r.subject
    `);
    const improverMap = new Map<string, number>();
    for (const r of improverRes.rows) {
      improverMap.set(`${r.teacher_staff_id}|${r.subject}`, Number(r.improver_pct));
    }

    // -- 4. LOAD BENCHMARK CATALOG by (subject, grade) --------------------
    const bRes = await db.execute<{ code: string; subject: string }>(sql`
      SELECT code, subject FROM school_benchmarks
      WHERE school_id = ${SCHOOL_ID} AND subject IN ('ela','math') AND active = true
    `);
    const catalog = new Map<string, string[]>(); // key = "subject|grade"
    for (const r of bRes.rows) {
      const parts = r.code.split(".");
      if (parts.length < 2) continue;
      const gTok = parts[1]!.toUpperCase();
      const g = gTok === "K" ? 0 : Number(gTok);
      if (!Number.isFinite(g)) continue;
      const key = `${r.subject}|${g}`;
      const arr = catalog.get(key) ?? [];
      arr.push(r.code);
      catalog.set(key, arr);
    }

    // -- 5. RNG helper ----------------------------------------------------
    function mkRng(seedStr: string): () => number {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < seedStr.length; i++) {
        h ^= seedStr.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      let a = h;
      return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    // -- 6. SCHOOL YEAR WEEKDAYS POOL ------------------------------------
    const yearStart = new Date(Date.UTC(2025, 7, 11));
    const yearEnd = new Date(Date.UTC(2026, 4, 22));
    const weekdays: string[] = [];
    for (
      let d = new Date(yearStart);
      d <= yearEnd;
      d = new Date(d.getTime() + 86400000)
    ) {
      const dow = d.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      weekdays.push(d.toISOString().slice(0, 10));
    }

    // -- 7. GENERATE ROWS at the (teacher, benchmark) level --------------
    // Each teacher rolls a per-benchmark count from this distribution
    // (no teacher would touch one standard 30+ times in one year):
    //   5%  -> 0   (didn't get to it / skipped)
    //   25% -> 1-2 (light touch)
    //   60% -> 3-7 (typical)
    //   10% -> 8-9 (heavy emphasis)
    // Teachers with a stronger improver % on their roster get nudged
    // toward the upper end of each band (boost ∈ [-1, +2]).
    type Row = typeof import("@workspace/db").benchmarkDeliveriesTable.$inferInsert;
    const out: Row[] = [];
    let skippedNoCatalog = 0;
    for (const t of teacherRes.rows) {
      const subject = t.subject;
      if (subject !== "ela" && subject !== "math") continue;
      const codes = catalog.get(`${subject}|${t.grade}`) ?? [];
      if (codes.length === 0) {
        skippedNoCatalog++;
        continue;
      }
      const improverPct =
        improverMap.get(`${t.teacher_staff_id}|${subject}`) ?? 0.4;
      // improverPct is roughly 0.2..0.7 in practice → boost from -1 to +2.
      const boost = Math.round((improverPct - 0.4) * 6);
      const rng = mkRng(`${t.teacher_staff_id}|${subject}`);
      for (const code of codes) {
        const roll = rng();
        let lo: number, hi: number;
        let bandBoost = boost;
        if (roll < 0.05) {
          continue; // 0 deliveries — skip insert
        } else if (roll < 0.40) {
          // Light-touch band (35%) — kept low even for high-improver
          // teachers so the histogram has a clear 1-3 tail.
          lo = 1; hi = 3;
          bandBoost = Math.min(boost, 0);
        } else if (roll < 0.92) {
          lo = 3; hi = 7;
        } else {
          lo = 8; hi = 9;
        }
        let count = lo + Math.floor(rng() * (hi - lo + 1)) + bandBoost;
        if (count < 1) count = 1;
        if (count > 9) count = 9; // hard cap — single digits only
        for (let i = 0; i < count; i++) {
          const day = weekdays[Math.floor(rng() * weekdays.length)]!;
          out.push({
            schoolId: SCHOOL_ID,
            teacherStaffId: t.teacher_staff_id,
            subject,
            benchmarkCode: code,
            deliveredOn: day,
            notes: null,
          });
        }
      }
    }

    // -- 8. BULK INSERT ------------------------------------------------
    const { benchmarkDeliveriesTable } = await import("@workspace/db");
    const CHUNK = 1000;
    for (let i = 0; i < out.length; i += CHUNK) {
      await db.insert(benchmarkDeliveriesTable).values(out.slice(i, i + CHUNK));
    }

    res.json({
      ok: true,
      wiped,
      teachers: teacherRes.rows.length,
      inserted: out.length,
      skippedNoCatalog,
    });
  } catch (err) {
    req.log.error({ err }, "parrott-seed-deliveries failed");
    res.status(500).json({
      error: "seed_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

// Seed-only: ensure every (teacher, period) section at Parrott has 1-3
// students on an active safety plan. Plans are per (school, student), so
// once a student is picked they appear on every teacher's roster they're
// in — but we drive selection per section so no period ends up empty.
// Wipes existing safety_plans + audit for school 1 first; safety plan
// library is preserved.
router.post("/parrott-seed-safety-plans", async (req, res) => {
  const staff = await loadStaff(req);
  if (!staff) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!staff.isSuperUser) {
    res.status(403).json({ error: "superuser_required" });
    return;
  }
  const SCHOOL_ID = 1;
  try {
    // -- 1. WIPE existing plans + audit (library preserved) --------------
    const wipedRes = await db.execute<{ n: number }>(sql`
      WITH d AS (
        DELETE FROM safety_plans WHERE school_id = ${SCHOOL_ID} RETURNING 1
      )
      SELECT COUNT(*)::int AS n FROM d
    `);
    const wiped = Number(wipedRes.rows[0]?.n ?? 0);
    await db.execute(sql`
      DELETE FROM safety_plan_audit WHERE school_id = ${SCHOOL_ID}
    `);

    // -- 2. LOAD library items (active only) -----------------------------
    const libRes = await db.execute<{ label: string }>(sql`
      SELECT label FROM safety_plan_library
      WHERE school_id = ${SCHOOL_ID} AND active = true
      ORDER BY sort_order ASC, id ASC
    `);
    const libLabels = libRes.rows.map((r) => r.label);
    if (libLabels.length === 0) {
      res.status(400).json({
        error: "no_library",
        message:
          "Safety plan library is empty for school 1 — run /parrott-rebuild first.",
      });
      return;
    }

    // -- 3. LOAD every non-planning section + its roster -----------------
    const secRes = await db.execute<{
      section_id: number;
      teacher_staff_id: number;
      period: number;
      student_id: string;
    }>(sql`
      SELECT cs.id AS section_id,
             cs.teacher_staff_id,
             cs.period,
             sr.student_id
      FROM class_sections cs
      JOIN section_roster sr ON sr.section_id = cs.id
      WHERE cs.school_id = ${SCHOOL_ID} AND cs.is_planning = false
    `);
    // Group by section.
    type Section = {
      sectionId: number;
      teacherStaffId: number;
      period: number;
      students: string[];
    };
    const sections = new Map<number, Section>();
    for (const r of secRes.rows) {
      let sec = sections.get(r.section_id);
      if (!sec) {
        sec = {
          sectionId: r.section_id,
          teacherStaffId: r.teacher_staff_id,
          period: r.period,
          students: [],
        };
        sections.set(r.section_id, sec);
      }
      sec.students.push(r.student_id);
    }

    // -- 4. Deterministic RNG (mulberry32) -------------------------------
    function mkRng(seedStr: string): () => number {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < seedStr.length; i++) {
        h ^= seedStr.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      let a = h;
      return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    // -- 5. Per-section pick: ensure 1-3 plan students per section -------
    // Iterate sections in stable order. Track which students already have
    // a plan; for each section, count its existing plan students and only
    // pick more if below this section's target.
    const planned = new Set<string>();
    const orderedSections = [...sections.values()].sort(
      (a, b) =>
        a.period - b.period ||
        a.teacherStaffId - b.teacherStaffId ||
        a.sectionId - b.sectionId,
    );
    for (const sec of orderedSections) {
      const rng = mkRng(`sp|${sec.sectionId}`);
      const target = 1 + Math.floor(rng() * 3); // 1, 2, or 3
      const existing = sec.students.filter((sid) => planned.has(sid)).length;
      let need = Math.max(0, target - existing);
      if (need === 0) continue;
      // Shuffle this section's students deterministically, then take the
      // first `need` who don't already have a plan.
      const pool = sec.students.slice();
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [pool[i], pool[j]] = [pool[j]!, pool[i]!];
      }
      for (const sid of pool) {
        if (need === 0) break;
        if (planned.has(sid)) continue;
        planned.add(sid);
        need--;
      }
    }

    // -- 6. Build safety_plans rows --------------------------------------
    type Row = typeof import("@workspace/db").safetyPlansTable.$inferInsert;
    const NOTE_POOL = [
      "Escort to dismissal; clear backpack check daily.",
      "Bathroom escort during instructional time; supervised lunch seating.",
      "Front-office sign-in each morning; restricted from auditorium during transitions.",
      "Buddy-system between classes; counselor check-in M/W/F.",
      "Separation from named peer (see counselor); modified PE participation.",
    ];
    const rows: Row[] = [];
    let idx = 0;
    for (const sid of planned) {
      const rng = mkRng(`sp-items|${sid}`);
      const itemCount = 2 + Math.floor(rng() * 3); // 2-4 items
      const shuffled = libLabels.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      const items = shuffled.slice(0, itemCount).map((label) => ({
        label,
        active: true,
      }));
      rows.push({
        schoolId: SCHOOL_ID,
        studentId: sid,
        status: "active",
        items,
        notes: NOTE_POOL[idx % NOTE_POOL.length]!,
      });
      idx++;
    }
    for (let i = 0; i < rows.length; i += 500) {
      await db
        .insert(
          (await import("@workspace/db")).safetyPlansTable,
        )
        .values(rows.slice(i, i + 500));
    }

    res.json({
      ok: true,
      wiped,
      sections: orderedSections.length,
      plansInserted: rows.length,
      libraryItems: libLabels.length,
    });
  } catch (err) {
    req.log.error({ err }, "parrott-seed-safety-plans failed");
    res.status(500).json({
      error: "seed_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

// Repair pass: fixes accommodation category mismatch (each flag category gets
// items from its own category in the library — ELL students get ELL items,
// 504 students get 504 items, ESE students get IEP items) AND re-owns
// benchmark_deliveries onto the active teacher roster by subject + grade
// (the seed.ts remap uses hardcoded display names from the original demo
// roster, which don't match the randomized Parrott rebuild names).
router.post("/parrott-repair", async (req, res) => {
  const staff = await loadStaff(req);
  if (!staff) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!staff.isSuperUser) {
    res.status(403).json({ error: "superuser_required" });
    return;
  }
  const SCHOOL_ID = 1;
  try {
    // ---------------- 1. Accommodations: category-aware reassign ----------
    // Library categories observed: '504', 'ELL', 'IEP', plus default 'Strategy'.
    // Mapping: ESE → IEP, 504 → 504, ELL → ELL. Strategy items used as
    // fallback if a category bucket is empty (defensive).
    const libRes = await db.execute<{ id: number; category: string }>(
      sql`SELECT id, category FROM school_accommodations WHERE school_id = ${SCHOOL_ID} AND active = true`,
    );
    const byCat = new Map<string, number[]>();
    for (const r of libRes.rows) {
      const k = (r.category || "Strategy").toUpperCase();
      const arr = byCat.get(k) ?? [];
      arr.push(r.id);
      byCat.set(k, arr);
    }
    const pickPool = (cat: "IEP" | "504" | "ELL"): number[] => {
      const direct = byCat.get(cat);
      if (direct && direct.length) return direct;
      return byCat.get("STRATEGY") ?? [];
    };

    // Wipe + rebuild for school 1.
    await db.execute(
      sql`DELETE FROM student_accommodations WHERE school_id = ${SCHOOL_ID}`,
    );

    const flagged = await db.execute<{
      student_id: string;
      ese: boolean;
      is_504: boolean;
      ell: boolean;
    }>(sql`
      SELECT student_id, ese, is_504, ell FROM students
      WHERE school_id = ${SCHOOL_ID} AND (ese = true OR is_504 = true OR ell = true)
      ORDER BY student_id
    `);

    const newAccoms: Array<typeof studentAccommodationsTable.$inferInsert> = [];
    const seen = new Set<string>(); // dedupe (student, accommodation) pairs
    for (const row of flagged.rows) {
      const sid = row.student_id;
      let h = 0;
      for (let i = 0; i < sid.length; i++) h = (h * 31 + sid.charCodeAt(i)) >>> 0;
      const total = 2 + (h % 3); // 2..4 accommodations total

      // Build the per-student pool: one item from EACH flag the student
      // carries, then fill the rest from any of their flag pools so the
      // total lands in 2..4.
      const pools: Array<{ cat: "IEP" | "504" | "ELL"; pool: number[] }> = [];
      if (row.ese) pools.push({ cat: "IEP", pool: pickPool("IEP") });
      if (row.is_504) pools.push({ cat: "504", pool: pickPool("504") });
      if (row.ell) pools.push({ cat: "ELL", pool: pickPool("ELL") });

      const picks: number[] = [];
      // Guarantee one item per flag the student carries (round 1).
      for (let i = 0; i < pools.length && picks.length < total; i++) {
        const p = pools[i]!;
        if (!p.pool.length) continue;
        const id = p.pool[(h + i) % p.pool.length]!;
        if (!picks.includes(id)) picks.push(id);
      }
      // Fill remaining slots, cycling through the student's flag pools.
      let cursor = 0;
      let safety = 0;
      while (picks.length < total && safety++ < 50) {
        const p = pools[cursor % pools.length]!;
        cursor++;
        if (!p.pool.length) continue;
        const id = p.pool[(h + cursor + 7) % p.pool.length]!;
        if (!picks.includes(id)) picks.push(id);
      }

      for (const accId of picks) {
        const key = `${sid}:${accId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        newAccoms.push({
          schoolId: SCHOOL_ID,
          studentId: sid,
          accommodationId: accId,
        });
      }
    }
    for (let i = 0; i < newAccoms.length; i += 500) {
      await db.insert(studentAccommodationsTable).values(newAccoms.slice(i, i + 500));
    }

    // ---------------- 2. Benchmark deliveries: re-own by subject + grade --
    // Build active teacher roster bucketed by subject + grade. Display name
    // suffix is "- ELA G6" / "- Math G7" from the rebuild.
    const teachers = await db.execute<{ id: number; display_name: string }>(sql`
      SELECT id, display_name FROM staff
      WHERE school_id = ${SCHOOL_ID} AND active = true
        AND (display_name LIKE '% - ELA G%' OR display_name LIKE '% - Math G%')
    `);
    const teachersByKey = new Map<string, number[]>(); // "ela:6" -> [ids]
    for (const t of teachers.rows) {
      const m = /- (ELA|Math) G(\d)/.exec(t.display_name);
      if (!m) continue;
      const key = `${m[1]!.toLowerCase()}:${m[2]}`;
      const arr = teachersByKey.get(key) ?? [];
      arr.push(t.id);
      teachersByKey.set(key, arr);
    }

    // Walk all deliveries; reassign each to a teacher of matching
    // subject+grade. Grade comes from segment 2 of the benchmark code
    // ("MA.6.AR..." / "ELA.7.R...").
    const deliveries = await db.execute<{
      id: number;
      subject: string;
      benchmark_code: string;
    }>(sql`
      SELECT id, subject, benchmark_code FROM benchmark_deliveries
      WHERE school_id = ${SCHOOL_ID}
    `);

    let updated = 0;
    let unmatched = 0;
    const cursorByKey = new Map<string, number>();
    for (const d of deliveries.rows) {
      const parts = d.benchmark_code.split(".");
      const grade = parts[1];
      if (!grade) {
        unmatched++;
        continue;
      }
      const key = `${d.subject}:${grade}`;
      const pool = teachersByKey.get(key);
      if (!pool || !pool.length) {
        unmatched++;
        continue;
      }
      const cur = cursorByKey.get(key) ?? 0;
      const tid = pool[cur % pool.length]!;
      cursorByKey.set(key, cur + 1);
      await db.execute(
        sql`UPDATE benchmark_deliveries SET teacher_staff_id = ${tid} WHERE id = ${d.id}`,
      );
      updated++;
    }

    res.json({
      ok: true,
      accommodations: { students: flagged.rows.length, rows: newAccoms.length },
      deliveries: {
        total: deliveries.rows.length,
        reassigned: updated,
        unmatched,
        teachersInRotation: teachers.rows.length,
      },
    });
  } catch (err) {
    req.log.error({ err }, "parrott-repair failed");
    res.status(500).json({
      error: "repair_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

router.post("/parrott-rebuild", async (req, res) => {
  const staff = await loadStaff(req);
  if (!staff) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!staff.isSuperUser) {
    res.status(403).json({ error: "superuser_required" });
    return;
  }
  req.log.warn({ staffId: staff.id }, "Parrott clean rebuild initiated");
  try {
    const result = await rebuildParrott();
    req.log.warn({ staffId: staff.id, summary: result.summary }, "Parrott clean rebuild completed");
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Parrott clean rebuild failed");
    res.status(500).json({
      error: "rebuild_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

router.post("/full-reseed", async (req, res) => {
  const staff = await loadStaff(req);
  if (!staff) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!staff.isSuperUser) {
    res.status(403).json({ error: "superuser_required" });
    return;
  }
  req.log.warn(
    { staffId: staff.id },
    "DSP Parrott full-reseed initiated (destructive)",
  );
  try {
    const result = await runDspParrottReseed();
    req.log.warn(
      { staffId: staff.id, summary: result.summary },
      "DSP Parrott full-reseed completed",
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    req.log.error({ err }, "DSP Parrott full-reseed failed");
    res
      .status(500)
      .json({ error: "reseed_failed", message: (err as Error).message });
  }
});

// One-shot, NO-AUTH bootstrap endpoint. Does TWO things atomically so the
// operator does not have to log in to trigger the reseed:
//   1. Resets ONLY the hardcoded SuperUser's password (so they can log in
//      after the data is wiped + re-seeded).
//   2. Runs the destructive DSP Parrott reseed.
// Both endpoints are removed in the next deploy.
router.post("/bootstrap-password", async (req, res) => {
  req.log.warn(
    { email: BOOTSTRAP_TARGET_EMAIL },
    "bootstrap-password + reseed initiated (destructive, no-auth)",
  );
  try {
    const passwordHash = await bcrypt.hash(BOOTSTRAP_NEW_PASSWORD, 10);
    const updated = await db
      .update(staffTable)
      .set({ passwordHash })
      .where(
        and(
          eq(staffTable.email, BOOTSTRAP_TARGET_EMAIL),
          eq(staffTable.isSuperUser, true),
        ),
      )
      .returning({ id: staffTable.id, email: staffTable.email });
    if (updated.length === 0) {
      res.status(404).json({ error: "target_not_found" });
      return;
    }
    const result = await runDspParrottReseed();
    req.log.warn(
      { summary: result.summary },
      "bootstrap-password + reseed completed",
    );
    res.json({
      ok: true,
      email: BOOTSTRAP_TARGET_EMAIL,
      tempPassword: BOOTSTRAP_NEW_PASSWORD,
      ...result,
    });
  } catch (err) {
    req.log.error({ err }, "bootstrap-password + reseed failed");
    res
      .status(500)
      .json({ error: "bootstrap_failed", message: (err as Error).message });
  }
});

// One-shot NO-AUTH endpoint: rebuilds teachers + 7-period schedule and fixes
// ESE/504 mutex. Non-destructive to students/FAST/accommodations. Removed in
// the next deploy.
router.post("/rebuild-sections", async (req, res) => {
  req.log.warn("rebuild-sections initiated (no-auth)");
  try {
    const result = await rebuildDspSections();
    req.log.warn({ result }, "rebuild-sections completed");
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "rebuild-sections failed");
    res
      .status(500)
      .json({ error: "rebuild_failed", message: (err as Error).message });
  }
});

// One-shot NO-AUTH endpoint: find any students whose name rendered as
// "[object Object]" during import and replace with realistic fake names.
// Idempotent — only touches rows that still match the broken pattern.
const FAKE_NAMES: Array<[string, string]> = [
  ["Aiden", "Thompson"], ["Ava", "Mitchell"], ["Mason", "Carter"],
  ["Olivia", "Roberts"], ["Liam", "Phillips"], ["Sophia", "Evans"],
  ["Noah", "Bennett"], ["Isabella", "Foster"], ["Lucas", "Reed"],
  ["Mia", "Cooper"], ["Ethan", "Ward"], ["Charlotte", "Brooks"],
  ["Caleb", "Hayes"], ["Amelia", "Russell"], ["Logan", "Murphy"],
  ["Harper", "Bailey"], ["Owen", "Rivera"], ["Evelyn", "Cox"],
  ["Henry", "Howard"], ["Abigail", "Ward"], ["Jack", "Torres"],
  ["Emily", "Peterson"], ["Daniel", "Gray"], ["Elizabeth", "Ramirez"],
  ["Sebastian", "James"], ["Sofia", "Watson"], ["Matthew", "Brooks"],
  ["Avery", "Kelly"], ["Joseph", "Sanders"], ["Ella", "Price"],
];

router.post("/fix-object-names", async (req, res) => {
  req.log.warn("fix-object-names initiated (no-auth)");
  try {
    const { db, studentsTable } = await import("@workspace/db");
    const { and, eq, or } = await import("drizzle-orm");

    const broken = await db
      .select({ id: studentsTable.id })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, 1),
          or(
            eq(studentsTable.lastName, "[object Object]"),
            eq(studentsTable.firstName, "[object Object]"),
          ),
        ),
      )
      .orderBy(studentsTable.id);

    let fixed = 0;
    for (let i = 0; i < broken.length; i++) {
      const [first, last] = FAKE_NAMES[i % FAKE_NAMES.length]!;
      await db
        .update(studentsTable)
        .set({ firstName: first, lastName: last })
        .where(eq(studentsTable.id, broken[i]!.id));
      fixed++;
    }
    req.log.warn({ fixed }, "fix-object-names completed");
    res.json({ ok: true, fixed, totalFound: broken.length });
  } catch (err) {
    req.log.error({ err }, "fix-object-names failed");
    res
      .status(500)
      .json({ error: "fix_failed", message: (err as Error).message });
  }
});

// One-shot NO-AUTH endpoint: ensure DSP Parrott (school 1) has a
// realistic set of classrooms and that every active teacher has a
// default_room + work_extension + staff_defaults row. The kiosk
// activation flow preloads `previewRoom` from
// staff_defaults.default_location_name, so without this seed every
// teacher would see an empty room box on first scan.
//
// Idempotent: existing locations are skipped (by name); existing
// staff rooms/extensions are NOT overwritten if already set.
router.post("/seed-rooms-staff", async (req, res) => {
  req.log.warn("seed-rooms-staff initiated (no-auth, all schools)");
  try {
    const {
      db,
      staffTable,
      locationsTable,
      staffDefaultsTable,
      schoolsTable,
    } = await import("@workspace/db");
    const { and, eq } = await import("drizzle-orm");

    // Derive a short, room-friendly prefix from a school. Prefer the
    // explicit `short_name` column; otherwise take the first
    // meaningful word of `name` (skipping common district-style
    // prefixes like "DSP", "The"); fallback to "School{id}".
    function prefixFor(s: {
      id: number;
      name: string;
      shortName: string | null;
    }): string {
      const SKIP = new Set(["dsp", "the", "a", "of"]);
      if (s.shortName && s.shortName.trim()) return s.shortName.trim();
      const tokens = (s.name || "")
        .split(/\s+/)
        .filter((t) => t && !SKIP.has(t.toLowerCase()));
      if (tokens.length > 0) return tokens[0]!;
      return `School${s.id}`;
    }

    const schools = await db
      .select({
        id: schoolsTable.id,
        name: schoolsTable.name,
        shortName: schoolsTable.shortName,
      })
      .from(schoolsTable)
      .orderBy(schoolsTable.id);

    type PerSchoolResult = {
      schoolId: number;
      schoolName: string;
      prefix: string;
      roomsInserted: number;
      teachers: number;
      staffUpdated: number;
      defaultsUpserted: number;
    };
    const perSchool: PerSchoolResult[] = [];
    let totals = {
      roomsInserted: 0,
      teachers: 0,
      staffUpdated: 0,
      defaultsUpserted: 0,
    };

    for (const school of schools) {
      const SCHOOL_ID = school.id;
      const prefix = prefixFor(school);

      // ---- 1. Classrooms --------------------------------------------
      // 3 floors × 12 rooms = 36 classrooms, e.g. "Parrott Room 101".
      const desiredRooms: string[] = [];
      for (const floor of [1, 2, 3]) {
        for (let n = 1; n <= 12; n++) {
          desiredRooms.push(
            `${prefix} Room ${floor}${n.toString().padStart(2, "0")}`,
          );
        }
      }
      const specialistRooms = [
        `${prefix} Library`,
        `${prefix} Counseling Office`,
        `${prefix} Front Office`,
        `${prefix} Music Room`,
        `${prefix} Art Room`,
        `${prefix} Science Lab`,
      ];

      // eslint-disable-next-line no-await-in-loop
      const existingRows = await db
        .select({ name: locationsTable.name })
        .from(locationsTable)
        .where(eq(locationsTable.schoolId, SCHOOL_ID));
      const existingNames = new Set(existingRows.map((r) => r.name));

      let roomsInserted = 0;
      for (const name of [...desiredRooms, ...specialistRooms]) {
        if (existingNames.has(name)) continue;
        // eslint-disable-next-line no-await-in-loop
        await db.insert(locationsTable).values({
          schoolId: SCHOOL_ID,
          name,
          kind: "classroom",
          isOrigin: true,
          isDestination: false,
          studentVisible: false,
          active: true,
        });
        roomsInserted++;
      }

      // ---- 2. Assign rooms + extensions to active staff ------------
      // eslint-disable-next-line no-await-in-loop
      const teachers = await db
        .select()
        .from(staffTable)
        .where(
          and(
            eq(staffTable.schoolId, SCHOOL_ID),
            eq(staffTable.active, true),
          ),
        )
        .orderBy(staffTable.id);

      const roomPool = [...desiredRooms];

      function extensionForRoom(roomName: string): string {
        const m = roomName.match(/Room\s+(\d+)/);
        if (m) return `1${m[1]}`;
        const idx = specialistRooms.indexOf(roomName);
        return `19${(idx + 1).toString().padStart(2, "0")}`;
      }

      let staffUpdated = 0;
      let defaultsUpserted = 0;
      let classroomCursor = 0;
      for (const t of teachers) {
        const name = (t.displayName || "").toLowerCase();
        let assignedRoom: string;
        if (name.includes("counsel") || name.includes("guidance")) {
          assignedRoom = `${prefix} Counseling Office`;
        } else if (
          name.includes("principal") ||
          name.includes("admin") ||
          name.includes("front office") ||
          name.includes("secretary")
        ) {
          assignedRoom = `${prefix} Front Office`;
        } else if (name.includes("librarian") || name.includes("media")) {
          assignedRoom = `${prefix} Library`;
        } else if (name.includes("music") || name.includes("band")) {
          assignedRoom = `${prefix} Music Room`;
        } else if (name.includes("art")) {
          assignedRoom = `${prefix} Art Room`;
        } else if (name.includes("science") && classroomCursor % 7 === 0) {
          assignedRoom = `${prefix} Science Lab`;
        } else {
          assignedRoom = roomPool[classroomCursor % roomPool.length]!;
          classroomCursor++;
        }
        const ext = extensionForRoom(assignedRoom);

        const updates: Record<string, string> = {};
        if (!t.defaultRoom) updates.defaultRoom = assignedRoom;
        if (!t.workExtension) updates.workExtension = ext;
        if (Object.keys(updates).length > 0) {
          // eslint-disable-next-line no-await-in-loop
          await db
            .update(staffTable)
            .set(updates)
            .where(eq(staffTable.id, t.id));
          staffUpdated++;
        }

        // Upsert staff_defaults (source of truth for kiosk previewRoom).
        // `staff_name` is GLOBALLY unique (not per-school) — so we look
        // up by name first to avoid unique-constraint violations when
        // the same display name exists in multiple schools (e.g.
        // "James Carter" at both schools). Resolution:
        //   - row with this name AND this staff_id  -> fill if empty
        //   - row with this name AND a different staff_id -> skip,
        //     because we cannot create a second row with the same
        //     name. The kiosk auto-skip will simply not fire for this
        //     teacher; admin can disambiguate later.
        //   - no row with this name -> insert.
        const targetRoom = t.defaultRoom ?? assignedRoom;
        // eslint-disable-next-line no-await-in-loop
        const [existingByName] = await db
          .select()
          .from(staffDefaultsTable)
          .where(eq(staffDefaultsTable.staffName, t.displayName));
        if (existingByName) {
          if (existingByName.staffId === t.id) {
            const patch: Record<string, unknown> = {};
            if (!existingByName.defaultLocationName) {
              patch.defaultLocationName = targetRoom;
            }
            if (existingByName.schoolId !== SCHOOL_ID) {
              patch.schoolId = SCHOOL_ID;
            }
            if (Object.keys(patch).length > 0) {
              // eslint-disable-next-line no-await-in-loop
              await db
                .update(staffDefaultsTable)
                .set(patch)
                .where(eq(staffDefaultsTable.id, existingByName.id));
              defaultsUpserted++;
            }
          }
          // else: name collision with another staff member — skip.
        } else {
          // eslint-disable-next-line no-await-in-loop
          await db.insert(staffDefaultsTable).values({
            schoolId: SCHOOL_ID,
            staffId: t.id,
            staffName: t.displayName,
            defaultLocationName: targetRoom,
          });
          defaultsUpserted++;
        }
      }

      perSchool.push({
        schoolId: SCHOOL_ID,
        schoolName: school.name,
        prefix,
        roomsInserted,
        teachers: teachers.length,
        staffUpdated,
        defaultsUpserted,
      });
      totals.roomsInserted += roomsInserted;
      totals.teachers += teachers.length;
      totals.staffUpdated += staffUpdated;
      totals.defaultsUpserted += defaultsUpserted;
    }

    const result = {
      ok: true,
      schools: schools.length,
      totals,
      perSchool,
    };
    req.log.warn(result, "seed-rooms-staff completed");
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "seed-rooms-staff failed");
    res
      .status(500)
      .json({ error: "seed_failed", message: (err as Error).message });
  }
});

// ------------------------------------------------------------------
// One-shot, NO-AUTH demo seeder: 3 investigation cases at Parrott
// (school_id=1) with realistic scenarios, roles, linked statements,
// and per-(case,student) impact ratings. Idempotent on title — if a
// case with one of the three titles already exists at Parrott, that
// case (and its players) is left alone.
// ------------------------------------------------------------------
router.post("/seed-demo-cases", async (req, res) => {
  const SCHOOL_ID = 1;
  const LEAD_EMAIL = "chris.clifford@hcsb.k12.fl.us";

  type PlayerSpec = {
    role:
      | "direct"
      | "target"
      | "instigator"
      | "rumor"
      | "witness"
      | "peripheral"
      | "deescalator";
    impact: 1 | 2 | 3 | 4; // 1=Minor,2=Contributing,3=Significant,4=Driver
    gradeHint?: number; // for picking from the roster
  };

  type StatementSpec = {
    daysAgo: number;
    kind:
      | "fight"
      | "verbal"
      | "rumor"
      | "property"
      | "class_disruption"
      | "peripheral_note"
      | "threat"
      | "other";
    severity: 1 | 2 | 3 | 4 | 5;
    location: string;
    summary: string;
    detail: string;
    // Indexes into the case's player list — first is the statement's
    // "anchor" (also recorded as witness_student on the interaction
    // row, so the case-detail timeline has an author).
    playerIdxs: number[];
  };

  type CaseSpec = {
    title: string;
    status: "open" | "monitoring" | "escalated";
    summary: string;
    notes: string[];
    players: PlayerSpec[];
    statements: StatementSpec[];
  };

  // 3 demo scenarios. Player count: 4 / 5 / 6.
  const CASES: CaseSpec[] = [
    {
      title: "Cafeteria insult cycle (Grade 7)",
      status: "open",
      summary:
        "Repeated lunch-table verbal jabs between two Grade 7 students with a small audience. Escalated from teasing to a thrown milk carton on day 3.",
      notes: [
        "Spoke with both moms on phone — agreed to a mediated lunch on Friday.",
        "Custodian flagged the milk-throw; cafeteria monitor reassigned tables.",
      ],
      players: [
        { role: "instigator", impact: 4, gradeHint: 7 },
        { role: "target", impact: 4, gradeHint: 7 },
        { role: "witness", impact: 2, gradeHint: 7 },
        { role: "witness", impact: 1, gradeHint: 7 },
      ],
      statements: [
        {
          daysAgo: 8,
          kind: "verbal",
          severity: 2,
          location: "Cafeteria",
          summary: "Name-calling across tables during 2nd lunch.",
          detail:
            "Witnesses report repeated 'loser' and shoe-comments aimed at target. Target tried to ignore but eventually walked away.",
          playerIdxs: [2, 0, 1],
        },
        {
          daysAgo: 4,
          kind: "verbal",
          severity: 3,
          location: "Cafeteria",
          summary: "Instigator stood up and yelled across the room.",
          detail:
            "Loud enough that monitor intervened. Target was visibly upset; left lunch early to counselor's office.",
          playerIdxs: [3, 0, 1, 2],
        },
        {
          daysAgo: 1,
          kind: "property",
          severity: 4,
          location: "Cafeteria",
          summary: "Milk carton thrown at target's tray.",
          detail:
            "Instigator threw a partially full milk carton; landed on the target's tray, splashed shirt. Cafeteria monitor witnessed.",
          playerIdxs: [1, 0, 2, 3],
        },
      ],
    },
    {
      title: "Bus stop rumor spread (Grade 8)",
      status: "monitoring",
      summary:
        "False rumor about target circulated by group chat after weekend bus-stop incident. Two students actively spreading; one stepped in to de-escalate.",
      notes: [
        "Reviewed chat screenshots provided by target's parent.",
        "Met with both rumor-spreaders separately; both denied authorship but admitted forwarding.",
      ],
      players: [
        { role: "instigator", impact: 4, gradeHint: 8 },
        { role: "rumor", impact: 3, gradeHint: 8 },
        { role: "rumor", impact: 3, gradeHint: 8 },
        { role: "target", impact: 4, gradeHint: 8 },
        { role: "deescalator", impact: 1, gradeHint: 8 },
      ],
      statements: [
        {
          daysAgo: 12,
          kind: "rumor",
          severity: 2,
          location: "Bus stop",
          summary: "Group chat screenshots surface to counselor.",
          detail:
            "Target's mother forwarded chat showing originating message from instigator, then forwards from two classmates.",
          playerIdxs: [3, 0, 1, 2],
        },
        {
          daysAgo: 9,
          kind: "verbal",
          severity: 3,
          location: "Hallway A wing",
          summary: "Target confronted in hallway about rumor.",
          detail:
            "Rumor-spreader asked target loudly about the rumor in front of class change. De-escalator pulled target aside to walk to class.",
          playerIdxs: [4, 1, 3],
        },
        {
          daysAgo: 5,
          kind: "rumor",
          severity: 2,
          location: "Library",
          summary: "Rumor resurfaces during media-center group work.",
          detail:
            "Second rumor-spreader brought it up during quiet study. Librarian moved seats.",
          playerIdxs: [2, 3, 1],
        },
      ],
    },
    {
      title: "Locker room shoving (Grade 6)",
      status: "escalated",
      summary:
        "Pre-PE locker room shoving match between two Grade 6 students with peripheral hangers-on. Pushed against locker bank; one minor scrape reported to clinic.",
      notes: [
        "Coach restructured locker-room supervision (2 staff during change-out).",
        "Parents of both directs notified; restorative meeting scheduled for next week.",
      ],
      players: [
        { role: "direct", impact: 4, gradeHint: 6 },
        { role: "direct", impact: 4, gradeHint: 6 },
        { role: "target", impact: 3, gradeHint: 6 },
        { role: "witness", impact: 2, gradeHint: 6 },
        { role: "witness", impact: 2, gradeHint: 6 },
        { role: "peripheral", impact: 1, gradeHint: 6 },
      ],
      statements: [
        {
          daysAgo: 10,
          kind: "peripheral_note",
          severity: 1,
          location: "PE locker room",
          summary: "Coach noted growing tension between two players.",
          detail:
            "Both directs were chest-bumping near locker 412 — no physical contact yet, but voices were raised.",
          playerIdxs: [3, 0, 1, 5],
        },
        {
          daysAgo: 6,
          kind: "fight",
          severity: 4,
          location: "PE locker room",
          summary: "Shove against locker bank during change-out.",
          detail:
            "Witness reports direct #1 shoved direct #2 into the locker; direct #2 shoved back. Target was between them and got knocked into locker — minor scrape on elbow, sent to clinic.",
          playerIdxs: [4, 0, 1, 2, 3],
        },
        {
          daysAgo: 2,
          kind: "verbal",
          severity: 3,
          location: "Hallway B wing",
          summary: "Re-engagement after class.",
          detail:
            "Trash-talk in the hall after 5th period. Peripheral student egging on direct #1.",
          playerIdxs: [3, 0, 1, 5],
        },
      ],
    },
  ];

  try {
    // ---- Lead staff ----
    const [lead] = await db
      .select()
      .from(staffTable)
      .where(
        and(
          eq(staffTable.schoolId, SCHOOL_ID),
          eq(staffTable.email, LEAD_EMAIL),
        ),
      );
    if (!lead) {
      res.status(404).json({
        error: "lead_not_found",
        message: `Could not find lead staff ${LEAD_EMAIL} at school ${SCHOOL_ID}`,
      });
      return;
    }

    // ---- Roster: pull all Parrott students once, bucket by grade ----
    const allStudents = await db
      .select({
        studentId: studentsTable.studentId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
      })
      .from(studentsTable)
      .where(eq(studentsTable.schoolId, SCHOOL_ID));

    function byGrade(g: number) {
      return allStudents.filter((s) => String(s.grade) === String(g));
    }

    // ---- Skip if all 3 cases already exist by title ----
    const existing = await db
      .select({
        id: interactionCasesTable.id,
        title: interactionCasesTable.title,
      })
      .from(interactionCasesTable)
      .where(
        and(
          eq(interactionCasesTable.schoolId, SCHOOL_ID),
          inArray(
            interactionCasesTable.title,
            CASES.map((c) => c.title),
          ),
        ),
      );
    const existingTitles = new Set(existing.map((r) => r.title));

    const yearLabel = schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ);

    // ---- Pick the next case_number once, then bump per insert ----
    const [{ nextStart }] = (
      await db.execute(sql`
        SELECT COALESCE(MAX(case_number), 0) + 1 AS "nextStart"
          FROM interaction_cases
         WHERE school_id = ${SCHOOL_ID}
           AND school_year_label = ${yearLabel}
      `)
    ).rows as { nextStart: number }[];
    let nextNumber = nextStart;

    const usedStudentIds = new Set<string>();
    // Pre-reserve students already in the existing-titled cases so we
    // don't double-assign them — collect from interaction_participants
    // for those caseIds.
    if (existing.length > 0) {
      const usedRows = await db
        .select({ studentId: interactionParticipantsTable.studentId })
        .from(interactionParticipantsTable)
        .innerJoin(
          interactionsTable,
          eq(interactionsTable.id, interactionParticipantsTable.interactionId),
        )
        .where(
          and(
            eq(interactionParticipantsTable.schoolId, SCHOOL_ID),
            inArray(
              interactionsTable.caseId,
              existing.map((c) => c.id),
            ),
          ),
        );
      for (const r of usedRows) usedStudentIds.add(r.studentId);
    }

    const perCase: Array<{
      title: string;
      status: "created" | "skipped";
      caseId?: number;
      caseNumber?: number;
      playerCount?: number;
      statementCount?: number;
    }> = [];

    for (const spec of CASES) {
      if (existingTitles.has(spec.title)) {
        perCase.push({ title: spec.title, status: "skipped" });
        continue;
      }

      // Pick fresh students for each player slot, preferring the
      // grade hint but falling back to any unused student.
      const chosen: Array<{
        studentId: string;
        firstName: string;
        lastName: string;
        role: PlayerSpec["role"];
        impact: PlayerSpec["impact"];
      }> = [];
      for (const p of spec.players) {
        const pool = (p.gradeHint ? byGrade(p.gradeHint) : allStudents).filter(
          (s) => !usedStudentIds.has(s.studentId),
        );
        const fallback = allStudents.filter(
          (s) => !usedStudentIds.has(s.studentId),
        );
        const pick = (pool.length ? pool : fallback)[0];
        if (!pick) {
          res.status(409).json({
            error: "roster_exhausted",
            message: `Not enough Parrott students to fill case "${spec.title}"`,
          });
          return;
        }
        usedStudentIds.add(pick.studentId);
        chosen.push({
          studentId: pick.studentId,
          firstName: pick.firstName,
          lastName: pick.lastName,
          role: p.role,
          impact: p.impact,
        });
      }

      // ---- Insert case ----
      const [caseRow] = await db
        .insert(interactionCasesTable)
        .values({
          schoolId: SCHOOL_ID,
          caseNumber: nextNumber,
          schoolYearLabel: yearLabel,
          title: spec.title,
          status: spec.status,
          leadStaffId: lead.id,
          leadStaffName: lead.displayName,
          summary: spec.summary,
          createdByStaffId: lead.id,
          createdByName: lead.displayName,
        })
        .returning();
      nextNumber += 1;

      // ---- Interactions + participants per statement ----
      let stmtCount = 0;
      for (const st of spec.statements) {
        const occurredDate = (() => {
          const d = new Date();
          d.setDate(d.getDate() - st.daysAgo);
          return d.toISOString().slice(0, 10);
        })();
        const anchor = chosen[st.playerIdxs[0]];
        const [intRow] = await db
          .insert(interactionsTable)
          .values({
            schoolId: SCHOOL_ID,
            occurredDate,
            kind: st.kind,
            severity: st.severity,
            location: st.location,
            summary: st.summary,
            detail: st.detail,
            caseId: caseRow.id,
            loggedByStaffId: lead.id,
            loggedByName: lead.displayName,
            witnessStudentId: anchor.studentId,
            witnessStudentName: `${anchor.firstName} ${anchor.lastName}`,
            status: "open",
          })
          .returning();

        for (const idx of st.playerIdxs) {
          const p = chosen[idx];
          await db.insert(interactionParticipantsTable).values({
            schoolId: SCHOOL_ID,
            interactionId: intRow.id,
            studentId: p.studentId,
            role: p.role,
            notes: "",
          });
        }
        stmtCount += 1;
      }

      // ---- Per-(case,student) impact ratings ----
      for (const p of chosen) {
        await db
          .insert(interactionCasePlayerImpactTable)
          .values({
            schoolId: SCHOOL_ID,
            caseId: caseRow.id,
            studentId: p.studentId,
            impact: p.impact,
            updatedByStaffId: lead.id,
            updatedByName: lead.displayName,
          })
          .onConflictDoNothing();
      }

      // ---- Case notes (narrative) ----
      for (const body of spec.notes) {
        await db.insert(interactionCaseNotesTable).values({
          schoolId: SCHOOL_ID,
          caseId: caseRow.id,
          body,
          authorStaffId: lead.id,
          authorName: lead.displayName,
        });
      }

      perCase.push({
        title: spec.title,
        status: "created",
        caseId: caseRow.id,
        caseNumber: caseRow.caseNumber,
        playerCount: chosen.length,
        statementCount: stmtCount,
      });
    }

    const result = {
      ok: true,
      schoolId: SCHOOL_ID,
      leadStaff: { id: lead.id, name: lead.displayName },
      schoolYearLabel: yearLabel,
      cases: perCase,
    };
    req.log.warn(result, "seed-demo-cases completed");
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "seed-demo-cases failed");
    res.status(500).json({
      error: "seed_demo_cases_failed",
      message: (err as Error).message,
    });
  }
});

// ---------------------------------------------------------------------------
// One-click demo seed for School 1. Idempotent end-to-end — safe to re-click.
// Covers what /seed-demo-cases does NOT: parent contact info, emergency
// contacts, support notes, OSS/ISS logs, plus 4 cases with deliberate
// student overlap (2 students in 2-3 cases) and 3 students with larger
// network spheres via side interactions.
// SuperUser only. Hardcoded to school 1 (Parrott) — no body, no params.
// ---------------------------------------------------------------------------
router.post("/seed-demo-school-1", async (req, res) => {
  const staff = await loadStaff(req);
  if (!staff) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!staff.isSuperUser) {
    res.status(403).json({ error: "superuser_required" });
    return;
  }

  const SCHOOL_ID = 1;
  const LEAD_EMAIL = "chris.clifford@hcsb.k12.fl.us";

  try {
    const out: {
      parentEmails: number;
      parentPhones: number;
      emergencyContacts: number;
      cases: Array<{
        title: string;
        status: "created" | "skipped";
        caseId?: number;
        caseNumber?: number;
        playerCount?: number;
        statementCount?: number;
      }>;
      sideInteractions: number;
      supportNotes: number;
      ossLogs: number;
      issAdminLogs: number;
      sphereTop: Array<{ name: string; coParticipants: number; cases: number }>;
    } = {
      parentEmails: 0,
      parentPhones: 0,
      emergencyContacts: 0,
      cases: [],
      sideInteractions: 0,
      supportNotes: 0,
      ossLogs: 0,
      issAdminLogs: 0,
      sphereTop: [],
    };

    // --- 1. Parent emails (~80% of empties) -------------------------------
    {
      const r = await db.execute(sql`
        UPDATE students
           SET parent_email = 'parent.' || student_id || '@example.com'
         WHERE school_id = ${SCHOOL_ID}
           AND (parent_email IS NULL OR parent_email = '')
           AND random() < 0.80
      `);
      out.parentEmails = r.rowCount ?? 0;
    }

    // --- 2. Parent phones (~68% of empties; ~15% fewer than emails) -------
    {
      const r = await db.execute(sql`
        UPDATE students
           SET parent_phone = '(555) '
                         || lpad((floor(random()*900+100))::int::text, 3, '0')
                         || '-'
                         || lpad((floor(random()*9000+1000))::int::text, 4, '0')
         WHERE school_id = ${SCHOOL_ID}
           AND (parent_phone IS NULL OR parent_phone = '')
           AND random() < 0.68
      `);
      out.parentPhones = r.rowCount ?? 0;
    }

    // --- 3. Emergency contacts — 2 per student ---------------------------
    {
      const r1 = await db.execute(sql`
        INSERT INTO student_emergency_contacts
          (school_id, student_id, slot, contact_name, relationship, phone, phone_label)
        SELECT ${SCHOOL_ID}, s.student_id, 1,
               COALESCE(s.parent_name, 'Guardian of ' || s.first_name),
               'Parent/Guardian',
               '(555) 2' || lpad((floor(random()*900))::int::text, 2, '0')
                         || '-' || lpad((floor(random()*9000+1000))::int::text, 4, '0'),
               'Mobile'
          FROM students s
         WHERE s.school_id = ${SCHOOL_ID}
        ON CONFLICT (school_id, student_id, slot) DO NOTHING
      `);
      out.emergencyContacts += r1.rowCount ?? 0;

      const r2 = await db.execute(sql`
        INSERT INTO student_emergency_contacts
          (school_id, student_id, slot, contact_name, relationship, phone, phone_label)
        SELECT ${SCHOOL_ID}, s.student_id, 2,
               'Emergency contact for ' || s.first_name,
               (ARRAY['Grandparent','Aunt','Uncle','Family Friend','Neighbor'])[1 + floor(random()*5)::int],
               '(555) 3' || lpad((floor(random()*900))::int::text, 2, '0')
                         || '-' || lpad((floor(random()*9000+1000))::int::text, 4, '0'),
               'Mobile'
          FROM students s
         WHERE s.school_id = ${SCHOOL_ID}
        ON CONFLICT (school_id, student_id, slot) DO NOTHING
      `);
      out.emergencyContacts += r2.rowCount ?? 0;
    }

    // --- 4. Cases with deliberate overlap --------------------------------
    // Pick 18 deterministic students (sorted by student_id) and assign:
    //   A = idx 0  → cases 1, 2, 4
    //   B = idx 1  → cases 2, 3
    //   C = idx 2  → case 2 + side interactions
    //   D = idx 3  → case 4 + side interactions
    //   idx 4-6    → case 1 fillers
    //   idx 7-10   → case 2 fillers
    //   idx 11-12  → case 3 fillers
    //   idx 13-15  → case 4 fillers
    //   idx 16-17  → reserved as side-interaction fillers
    //   idx 18-20  → additional side-interaction fillers
    const [lead] = await db
      .select()
      .from(staffTable)
      .where(
        and(
          eq(staffTable.schoolId, SCHOOL_ID),
          eq(staffTable.email, LEAD_EMAIL),
        ),
      );
    if (!lead) {
      res.status(404).json({
        error: "lead_not_found",
        message: `Could not find lead staff ${LEAD_EMAIL} at school ${SCHOOL_ID}`,
      });
      return;
    }

    const roster = await db
      .select({
        studentId: studentsTable.studentId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
      })
      .from(studentsTable)
      .where(eq(studentsTable.schoolId, SCHOOL_ID))
      .orderBy(studentsTable.studentId);
    if (roster.length < 21) {
      res.status(409).json({
        error: "roster_too_small",
        message: `Need at least 21 students; school ${SCHOOL_ID} has ${roster.length}.`,
      });
      return;
    }

    type Pick = { studentId: string; firstName: string; lastName: string };
    const pick = (i: number): Pick => roster[i]!;
    const nameOf = (p: Pick) => `${p.firstName} ${p.lastName}`;

    const A = pick(0), B = pick(1), C = pick(2), D = pick(3);
    const case1Fillers = [pick(4), pick(5), pick(6)];
    const case2Fillers = [pick(7), pick(8), pick(9), pick(10)];
    const case3Fillers = [pick(11), pick(12)];
    const case4Fillers = [pick(13), pick(14), pick(15)];
    const side1Others = [pick(16), pick(17)];
    const side2Others = [pick(18), pick(19)];
    const side3Other = pick(20);

    type Role =
      | "direct" | "target" | "instigator" | "rumor"
      | "witness" | "peripheral" | "deescalator";

    type StatementSpec = {
      occurredDate: string;
      kind: "fight" | "verbal" | "rumor" | "property" | "class_disruption" | "peripheral_note" | "threat" | "other";
      severity: number;
      location: string;
      summary: string;
      anchor: Pick;
      participants: Array<{ student: Pick; role: Role }>;
    };

    type CaseSpec = {
      title: string;
      status: "open" | "monitoring" | "escalated";
      summary: string;
      notes: string[];
      players: Array<{ student: Pick; impact: 1 | 2 | 3 | 4 }>;
      statements: StatementSpec[];
    };

    const CASES: CaseSpec[] = [
      {
        title: "Bus 14 afternoon arc",
        status: "open",
        summary: "Recurring afternoon-bus friction. Three statements over four weeks.",
        notes: [
          "Talked to Bus 14 driver — confirmed seating change Mon.",
          "Parent contact for two participants complete; seats split.",
        ],
        players: [
          { student: A, impact: 3 },
          { student: case1Fillers[0], impact: 4 },
          { student: case1Fillers[1], impact: 3 },
          { student: case1Fillers[2], impact: 2 },
        ],
        statements: [
          {
            occurredDate: "2026-04-15", kind: "verbal", severity: 2, location: "Bus 14",
            summary: "Yelling on bus 14 after dismissal",
            anchor: A,
            participants: [
              { student: A, role: "target" },
              { student: case1Fillers[0], role: "direct" },
              { student: case1Fillers[1], role: "direct" },
            ],
          },
          {
            occurredDate: "2026-04-22", kind: "verbal", severity: 2, location: "Bus 14",
            summary: "Spitballs from back row, ongoing",
            anchor: case1Fillers[2],
            participants: [
              { student: case1Fillers[2], role: "target" },
              { student: case1Fillers[0], role: "instigator" },
              { student: case1Fillers[1], role: "peripheral" },
            ],
          },
          {
            occurredDate: "2026-05-06", kind: "fight", severity: 3, location: "Bus loop",
            summary: "Shoving as bus pulled up",
            anchor: case1Fillers[0],
            participants: [
              { student: case1Fillers[0], role: "direct" },
              { student: case1Fillers[1], role: "direct" },
              { student: A, role: "witness" },
            ],
          },
        ],
      },
      {
        title: "8th hallway / locker bay",
        status: "monitoring",
        summary: "Locker bay friction across 8th hall. Four statements; theft + threat.",
        notes: [
          "Locker bay camera review scheduled w/ SRO.",
          "Mediation between two students — both agreed to space.",
          "Threat statement (5/12) escalated to admin.",
        ],
        players: [
          { student: A, impact: 4 },
          { student: B, impact: 3 },
          { student: C, impact: 4 },
          { student: case2Fillers[0], impact: 3 },
          { student: case2Fillers[1], impact: 2 },
          { student: case2Fillers[2], impact: 2 },
        ],
        statements: [
          {
            occurredDate: "2026-04-10", kind: "rumor", severity: 2, location: "8th hall lockers",
            summary: "Rumor about locker theft circulating",
            anchor: case2Fillers[2],
            participants: [
              { student: case2Fillers[2], role: "witness" },
              { student: C, role: "target" },
              { student: case2Fillers[0], role: "instigator" },
            ],
          },
          {
            occurredDate: "2026-04-17", kind: "verbal", severity: 2, location: "8th hall",
            summary: "Hallway shouting between two students",
            anchor: B,
            participants: [
              { student: B, role: "direct" },
              { student: C, role: "direct" },
              { student: A, role: "peripheral" },
            ],
          },
          {
            occurredDate: "2026-04-29", kind: "property", severity: 3, location: "8th hall lockers",
            summary: "Lock pried open, items missing",
            anchor: case2Fillers[0],
            participants: [
              { student: case2Fillers[0], role: "target" },
              { student: case2Fillers[1], role: "direct" },
              { student: case2Fillers[2], role: "witness" },
            ],
          },
          {
            occurredDate: "2026-05-12", kind: "threat", severity: 3, location: "8th hall",
            summary: "Verbal threat outside Room 214",
            anchor: A,
            participants: [
              { student: A, role: "direct" },
              { student: C, role: "target" },
              { student: B, role: "witness" },
              { student: case2Fillers[1], role: "peripheral" },
            ],
          },
        ],
      },
      {
        title: "Cafeteria 2nd lunch",
        status: "open",
        summary: "Tension at 2nd-lunch table — name-calling escalating to property.",
        notes: ["Moved one participant to 1st lunch as a cooldown."],
        players: [
          { student: B, impact: 4 },
          { student: case3Fillers[0], impact: 3 },
          { student: case3Fillers[1], impact: 2 },
        ],
        statements: [
          {
            occurredDate: "2026-04-20", kind: "verbal", severity: 2, location: "Cafeteria",
            summary: "Lunchroom name-calling between two students",
            anchor: case3Fillers[1],
            participants: [
              { student: case3Fillers[1], role: "witness" },
              { student: B, role: "direct" },
              { student: case3Fillers[0], role: "direct" },
            ],
          },
          {
            occurredDate: "2026-05-08", kind: "property", severity: 2, location: "Cafeteria",
            summary: "Food thrown across table",
            anchor: case3Fillers[0],
            participants: [
              { student: case3Fillers[0], role: "target" },
              { student: B, role: "instigator" },
              { student: case3Fillers[1], role: "witness" },
            ],
          },
        ],
      },
      {
        title: "Group chat → Friday fight",
        status: "escalated",
        summary: "Online group chat escalated to physical fight 5/8. Four statements.",
        notes: [
          "OSS assigned to both fight participants.",
          "Counselor scheduled for one target — restorative circle pending.",
          "Group chat exported + shared w/ guardians.",
        ],
        players: [
          { student: A, impact: 4 },
          { student: D, impact: 4 },
          { student: case4Fillers[0], impact: 2 },
          { student: case4Fillers[1], impact: 2 },
          { student: case4Fillers[2], impact: 3 },
        ],
        statements: [
          {
            occurredDate: "2026-04-25", kind: "rumor", severity: 2, location: "Online",
            summary: "Group chat screenshots circulating",
            anchor: case4Fillers[0],
            participants: [
              { student: case4Fillers[0], role: "witness" },
              { student: A, role: "direct" },
              { student: D, role: "direct" },
              { student: case4Fillers[1], role: "peripheral" },
            ],
          },
          {
            occurredDate: "2026-05-01", kind: "threat", severity: 3, location: "Online",
            summary: "Threat sent in group chat",
            anchor: case4Fillers[1],
            participants: [
              { student: case4Fillers[1], role: "witness" },
              { student: A, role: "instigator" },
              { student: D, role: "target" },
            ],
          },
          {
            occurredDate: "2026-05-08", kind: "fight", severity: 4, location: "Back parking lot",
            summary: "Friday fight after dismissal — three students involved",
            anchor: case4Fillers[2],
            participants: [
              { student: case4Fillers[2], role: "witness" },
              { student: A, role: "direct" },
              { student: D, role: "direct" },
              { student: case4Fillers[0], role: "peripheral" },
            ],
          },
          {
            occurredDate: "2026-05-11", kind: "verbal", severity: 3, location: "8th hall",
            summary: "Continued verbal escalation Monday",
            anchor: D,
            participants: [
              { student: D, role: "target" },
              { student: A, role: "instigator" },
              { student: case4Fillers[2], role: "peripheral" },
            ],
          },
        ],
      },
    ];

    const yearLabel = schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ);

    const existing = await db
      .select({
        id: interactionCasesTable.id,
        title: interactionCasesTable.title,
      })
      .from(interactionCasesTable)
      .where(
        and(
          eq(interactionCasesTable.schoolId, SCHOOL_ID),
          inArray(
            interactionCasesTable.title,
            CASES.map((c) => c.title),
          ),
        ),
      );
    const existingTitles = new Set(existing.map((r) => r.title));

    const [{ nextStart }] = (
      await db.execute(sql`
        SELECT COALESCE(MAX(case_number), 0) + 1 AS "nextStart"
          FROM interaction_cases
         WHERE school_id = ${SCHOOL_ID}
           AND school_year_label = ${yearLabel}
      `)
    ).rows as { nextStart: number }[];
    let nextNumber = nextStart;

    for (const spec of CASES) {
      if (existingTitles.has(spec.title)) {
        out.cases.push({ title: spec.title, status: "skipped" });
        continue;
      }
      const [caseRow] = await db
        .insert(interactionCasesTable)
        .values({
          schoolId: SCHOOL_ID,
          caseNumber: nextNumber,
          schoolYearLabel: yearLabel,
          title: spec.title,
          status: spec.status,
          leadStaffId: lead.id,
          leadStaffName: lead.displayName,
          summary: spec.summary,
          createdByStaffId: lead.id,
          createdByName: lead.displayName,
        })
        .returning();
      nextNumber += 1;

      let firstStmtId: number | null = null;
      let stmtCount = 0;
      for (const st of spec.statements) {
        const [intRow] = await db
          .insert(interactionsTable)
          .values({
            schoolId: SCHOOL_ID,
            occurredDate: st.occurredDate,
            kind: st.kind,
            severity: st.severity,
            location: st.location,
            summary: st.summary,
            caseId: caseRow.id,
            loggedByStaffId: lead.id,
            loggedByName: lead.displayName,
            witnessStudentId: st.anchor.studentId,
            witnessStudentName: nameOf(st.anchor),
            status: "open",
          })
          .returning();
        if (firstStmtId === null) firstStmtId = intRow.id;
        for (const p of st.participants) {
          await db.insert(interactionParticipantsTable).values({
            schoolId: SCHOOL_ID,
            interactionId: intRow.id,
            studentId: p.student.studentId,
            role: p.role,
            notes: "",
          }).onConflictDoNothing();
        }
        stmtCount += 1;
      }
      if (firstStmtId !== null) {
        await db
          .update(interactionCasesTable)
          .set({ leadStatementId: firstStmtId })
          .where(eq(interactionCasesTable.id, caseRow.id));
      }
      for (const pl of spec.players) {
        await db
          .insert(interactionCasePlayerImpactTable)
          .values({
            schoolId: SCHOOL_ID,
            caseId: caseRow.id,
            studentId: pl.student.studentId,
            impact: pl.impact,
            updatedByStaffId: lead.id,
            updatedByName: lead.displayName,
          })
          .onConflictDoNothing();
      }
      for (const body of spec.notes) {
        await db.insert(interactionCaseNotesTable).values({
          schoolId: SCHOOL_ID,
          caseId: caseRow.id,
          body,
          authorStaffId: lead.id,
          authorName: lead.displayName,
        });
      }
      out.cases.push({
        title: spec.title,
        status: "created",
        caseId: caseRow.id,
        caseNumber: caseRow.caseNumber,
        playerCount: spec.players.length,
        statementCount: stmtCount,
      });
    }

    // --- 5. Side interactions to bulk up spheres for C and D -------------
    // Only seed if NO loose (case_id IS NULL) interactions exist yet for
    // C's or D's student id — keeps re-clicks idempotent without a more
    // expensive title-style guard.
    {
      const existingSide = await db.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n
          FROM interactions i
          JOIN interaction_participants p ON p.interaction_id = i.id
         WHERE i.school_id = ${SCHOOL_ID}
           AND i.case_id IS NULL
           AND p.student_id IN (${C.studentId}, ${D.studentId})
      `);
      if ((existingSide.rows[0]?.n ?? 0) === 0) {
        const sideSpecs: StatementSpec[] = [
          {
            occurredDate: "2026-04-30", kind: "verbal", severity: 2, location: "8th hall lockers",
            summary: "Locker dispute outside class",
            anchor: C,
            participants: [
              { student: C, role: "target" },
              { student: side1Others[0], role: "direct" },
              { student: side1Others[1], role: "witness" },
            ],
          },
          {
            occurredDate: "2026-04-18", kind: "verbal", severity: 2, location: "PE locker room",
            summary: "PE locker room shoving",
            anchor: D,
            participants: [
              { student: D, role: "direct" },
              { student: side2Others[0], role: "direct" },
              { student: side2Others[1], role: "peripheral" },
            ],
          },
          {
            occurredDate: "2026-05-04", kind: "peripheral_note", severity: 1, location: "Cafeteria",
            summary: "Lunch back-and-forth, no escalation",
            anchor: side3Other,
            participants: [
              { student: side3Other, role: "witness" },
              { student: C, role: "direct" },
              { student: D, role: "direct" },
            ],
          },
        ];
        for (const st of sideSpecs) {
          const [intRow] = await db
            .insert(interactionsTable)
            .values({
              schoolId: SCHOOL_ID,
              occurredDate: st.occurredDate,
              kind: st.kind,
              severity: st.severity,
              location: st.location,
              summary: st.summary,
              loggedByStaffId: lead.id,
              loggedByName: lead.displayName,
              witnessStudentId: st.anchor.studentId,
              witnessStudentName: nameOf(st.anchor),
              status: "open",
            })
            .returning();
          for (const p of st.participants) {
            await db.insert(interactionParticipantsTable).values({
              schoolId: SCHOOL_ID,
              interactionId: intRow.id,
              studentId: p.student.studentId,
              role: p.role,
              notes: "",
            }).onConflictDoNothing();
          }
          out.sideInteractions += 1;
        }
      }
    }

    // --- 6. Support notes — ~4-6 per case-involved student ----------------
    const allCaseStudents = Array.from(
      new Set(CASES.flatMap((c) => c.players.map((p) => p.student.studentId))),
    );
    const noteTypes = [
      "check_in", "parent_contact", "counselor_meeting",
      "admin_meeting", "classroom_observation",
    ];
    const noteSnippets = [
      "Strong week — leading group work.",
      "Parent contact complete; agreed on next step.",
      "Counselor talked through conflict + repair plan.",
      "Reviewed incident w/ guardian.",
      "Re-engaged in classes after warm-up.",
      "Following safety plan boundaries this week.",
      "Asked to switch seats — approved.",
      "Returned Mon after OSS — calm; reviewed plan.",
    ];
    for (const sid of allCaseStudents) {
      const existing = await db.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n FROM support_notes
         WHERE school_id = ${SCHOOL_ID} AND student_id = ${sid}
      `);
      if ((existing.rows[0]?.n ?? 0) > 0) continue;
      // Deterministic 4-6 notes per student based on student_id hash
      let h = 0;
      for (let i = 0; i < sid.length; i++) h = (h * 31 + sid.charCodeAt(i)) >>> 0;
      const count = 4 + (h % 3);
      for (let k = 0; k < count; k++) {
        const dayOffset = 60 - (h + k * 7) % 60;
        const d = new Date(2026, 4, 1);
        d.setDate(d.getDate() - dayOffset);
        await db.insert(supportNotesTable).values({
          schoolId: SCHOOL_ID,
          studentId: sid,
          noteType: noteTypes[(h + k) % noteTypes.length]!,
          noteText: noteSnippets[(h + k * 3) % noteSnippets.length]!,
          staffName: lead.displayName,
          createdAt: d.toISOString().slice(0, 10),
        });
        out.supportNotes += 1;
      }
    }

    // --- 7. OSS logs — 4 entries, only if none exist for school 1 --------
    {
      const r = await db.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n FROM oss_logs WHERE school_id = ${SCHOOL_ID}
      `);
      if ((r.rows[0]?.n ?? 0) === 0) {
        const ossPlan: Array<{ student: Pick; reason: string; notes: string; days: number }> = [
          { student: A, reason: "Fighting on campus", notes: "5/8 Friday fight (case 4)", days: 3 },
          { student: D, reason: "Fighting on campus", notes: "5/8 Friday fight (case 4)", days: 3 },
          { student: case1Fillers[0], reason: "Repeated bus conduct", notes: "Third bus 14 incident", days: 1 },
          { student: case2Fillers[1], reason: "Property — locker theft", notes: "Locker bay (case 2)", days: 2 },
        ];
        for (const e of ossPlan) {
          await db.insert(ossLogsTable).values({
            schoolId: SCHOOL_ID,
            studentId: e.student.studentId,
            reasonText: e.reason,
            notes: e.notes,
            dayCount: e.days,
            createdById: lead.id,
            createdByName: lead.displayName,
          });
          out.ossLogs += 1;
        }
      }
    }

    // --- 8. ISS admin logs — 8 entries, only if none exist for school 1 --
    {
      const r = await db.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n FROM iss_admin_logs WHERE school_id = ${SCHOOL_ID}
      `);
      if ((r.rows[0]?.n ?? 0) === 0) {
        const issPlan: Array<{ student: Pick; reason: string; notes: string }> = [
          { student: A, reason: "Threat — verbal", notes: "5/12 hallway statement" },
          { student: C, reason: "Verbal conflict", notes: "Hallway shouting 4/17" },
          { student: B, reason: "Cafeteria disruption", notes: "Food thrown 5/8" },
          { student: case1Fillers[2], reason: "Bus conduct", notes: "Spitball incident — counseling" },
          { student: case2Fillers[0], reason: "Property — retaliation", notes: "After-locker incident" },
          { student: case2Fillers[2], reason: "Skipping class", notes: "Skipped 4th period 4/24" },
          { student: case4Fillers[0], reason: "Phone policy", notes: "Refused to put away phone" },
          { student: case4Fillers[2], reason: "Class disruption", notes: "Repeated callouts in ELA" },
        ];
        for (const e of issPlan) {
          await db.insert(issAdminLogsTable).values({
            schoolId: SCHOOL_ID,
            studentId: e.student.studentId,
            reasonText: e.reason,
            notes: e.notes,
            dayCount: 1,
            createdById: lead.id,
            createdByName: lead.displayName,
          });
          out.issAdminLogs += 1;
        }
      }
    }

    // --- 9. Sphere top-5 (degree across all interactions) ----------------
    {
      const r = await db.execute<{ name: string; co: number; cases: number }>(sql`
        SELECT s.first_name || ' ' || s.last_name AS name,
               COUNT(DISTINCT p2.student_id) FILTER (WHERE p2.student_id <> p.student_id)::int AS co,
               COUNT(DISTINCT i.case_id) FILTER (WHERE i.case_id IS NOT NULL)::int AS cases
          FROM interaction_participants p
          JOIN interactions i ON i.id = p.interaction_id
          JOIN interaction_participants p2 ON p2.interaction_id = i.id
          JOIN students s ON s.school_id = ${SCHOOL_ID} AND s.student_id = p.student_id
         WHERE p.school_id = ${SCHOOL_ID}
         GROUP BY s.first_name, s.last_name, p.student_id
         ORDER BY co DESC
         LIMIT 5
      `);
      out.sphereTop = r.rows.map((row) => ({
        name: row.name,
        coParticipants: row.co,
        cases: row.cases,
      }));
    }

    req.log.warn(out, "seed-demo-school-1 completed");
    res.json({ ok: true, ...out });
  } catch (err) {
    req.log.error({ err }, "seed-demo-school-1 failed");
    res.status(500).json({
      error: "seed_demo_school_1_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
