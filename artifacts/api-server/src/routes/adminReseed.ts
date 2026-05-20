import { Router, type IRouter, type Request } from "express";
import bcrypt from "bcryptjs";
import { db, staffTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { verifyAuthToken } from "../lib/authToken.js";
import { runDspParrottReseed } from "../lib/dspParrottReseed.js";
import { rebuildDspSections } from "../lib/rebuildDspSections.js";

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

export default router;
