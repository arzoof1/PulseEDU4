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

export default router;
