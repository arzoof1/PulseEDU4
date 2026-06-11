import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  staffDefaultsTable,
  staffTable,
  locationsTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function requireAdmin() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!staff.isAdmin && !staff.isSuperUser) {
      res.status(403).json({ error: "Admin only" });
      return;
    }
    next();
  };
}

// Read default-room rows for THIS school. staff_defaults rows now carry
// school_id directly (D2 backfill); we filter by it so school A doesn't
// see school B's teacher → room assignments.
router.get("/staff-defaults", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const rows = await db
    .select({
      id: staffDefaultsTable.id,
      staffId: staffDefaultsTable.staffId,
      staffName: staffDefaultsTable.staffName,
      defaultLocationName: staffDefaultsTable.defaultLocationName,
    })
    .from(staffDefaultsTable)
    .where(eq(staffDefaultsTable.schoolId, schoolId));
  res.json(rows);
});

// Upsert a teacher's default room. Always keyed by staffId when known
// (SIS-safe). Falls back to staffName for legacy rows that haven't been
// re-keyed yet. Validates the location exists & is an origin so we can't
// pin teachers to a non-existent or destination-only room.
router.put("/staff-defaults", requireAdmin(), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staffId = Number(req.body?.staffId);
  const defaultLocationName =
    typeof req.body?.defaultLocationName === "string"
      ? req.body.defaultLocationName.trim()
      : "";

  if (!Number.isFinite(staffId) || staffId <= 0) {
    res.status(400).json({ error: "staffId is required" });
    return;
  }

  // Target staff must belong to the same school as the calling admin —
  // an admin in school A must not be able to set school B's teacher's
  // default room.
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(and(eq(staffTable.id, staffId), eq(staffTable.schoolId, schoolId)));
  if (!staff) {
    res.status(404).json({ error: "Staff not found" });
    return;
  }

  let normalizedRoom: string | null = null;
  if (defaultLocationName) {
    // Origin location must also belong to this school.
    const [loc] = await db
      .select()
      .from(locationsTable)
      .where(
        and(
          eq(locationsTable.schoolId, schoolId),
          eq(locationsTable.name, defaultLocationName),
          eq(locationsTable.isOrigin, true),
          eq(locationsTable.active, true),
        ),
      );
    if (!loc) {
      res
        .status(400)
        .json({ error: `"${defaultLocationName}" is not a valid origin room` });
      return;
    }
    normalizedRoom = loc.name;
  }

  // Atomic upsert keyed by staff_id (canonical) with a partial unique index
  // staff_defaults_staff_id_unique. If a legacy name-keyed row exists with a
  // null staff_id we promote it first so the conflict target lines up.
  // The promotion update MUST AND-filter by schoolId — otherwise a school A
  // admin could promote (i.e. take ownership of) a legacy null-staffId row
  // that actually belongs to school B if the displayName collides.
  await db
    .update(staffDefaultsTable)
    .set({ staffId, schoolId })
    .where(
      and(
        eq(staffDefaultsTable.schoolId, schoolId),
        eq(staffDefaultsTable.staffName, staff.displayName),
        sql`${staffDefaultsTable.staffId} IS NULL`,
      ),
    );

  await db
    .insert(staffDefaultsTable)
    .values({
      schoolId,
      staffId,
      staffName: staff.displayName,
      defaultLocationName: normalizedRoom,
    })
    .onConflictDoUpdate({
      target: staffDefaultsTable.staffId,
      set: {
        schoolId,
        defaultLocationName: normalizedRoom,
        staffName: staff.displayName,
      },
    });

  res.json({ ok: true, staffId, defaultLocationName: normalizedRoom });
});

// Bulk-assign teacher -> room from an uploaded CSV. The client parses the
// CSV and posts plain rows so we don't need a CSV parser server-side.
//
//   body: { rows: [{ teacher, room }], commit?: boolean }
//
// Matching: each `teacher` is resolved within THIS school by email (exact,
// case-insensitive) first, then by display name (exact, case-insensitive).
// `room` must be an active origin location, or blank/"none" to clear the
// assignment (roaming staff). `commit:false` (default) returns a dry-run
// preview so the admin can eyeball matches before writing.
router.post("/staff-defaults/bulk", requireAdmin(), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const rawRows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rawRows) {
    res.status(400).json({ error: "rows[] is required" });
    return;
  }
  if (rawRows.length > 2000) {
    res.status(400).json({ error: "Too many rows (max 2000)" });
    return;
  }
  const commit = req.body?.commit === true;

  // Load this school's staff (for matching) and origin locations (for
  // validation) once.
  const staff = await db
    .select({
      id: staffTable.id,
      displayName: staffTable.displayName,
      email: staffTable.email,
    })
    .from(staffTable)
    .where(and(eq(staffTable.schoolId, schoolId), eq(staffTable.active, true)));

  const byEmail = new Map<string, (typeof staff)[number]>();
  const byName = new Map<string, (typeof staff)[number]>();
  // Display names are NOT unique within a school. Track collisions so a
  // name-only match that resolves to >1 staff is treated as ambiguous
  // (unmatched) rather than silently assigned to whichever row won the map.
  const ambiguousNames = new Set<string>();
  for (const s of staff) {
    if (s.email) byEmail.set(s.email.trim().toLowerCase(), s);
    const nameLower = s.displayName.trim().toLowerCase();
    if (byName.has(nameLower)) ambiguousNames.add(nameLower);
    byName.set(nameLower, s);
  }

  const origins = await db
    .select({ name: locationsTable.name })
    .from(locationsTable)
    .where(
      and(
        eq(locationsTable.schoolId, schoolId),
        eq(locationsTable.isOrigin, true),
        eq(locationsTable.active, true),
      ),
    );
  const originByLower = new Map<string, string>();
  for (const o of origins) originByLower.set(o.name.trim().toLowerCase(), o.name);

  const CLEAR_TOKENS = new Set(["", "none", "roaming", "(none)", "n/a", "na"]);

  type Matched = { staffId: number; staffName: string; room: string | null };
  const matched: Matched[] = [];
  const unmatchedTeachers: string[] = [];
  const invalidRooms: Array<{ teacher: string; room: string }> = [];
  const seenStaff = new Set<number>();

  for (const r of rawRows) {
    const teacher = typeof r?.teacher === "string" ? r.teacher.trim() : "";
    const roomRaw = typeof r?.room === "string" ? r.room.trim() : "";
    if (!teacher) continue;

    const tLower = teacher.toLowerCase();
    // Email is unique; name is only used when it unambiguously resolves.
    const s =
      byEmail.get(tLower) ??
      (ambiguousNames.has(tLower) ? undefined : byName.get(tLower));
    if (!s) {
      unmatchedTeachers.push(teacher);
      continue;
    }

    let room: string | null;
    if (CLEAR_TOKENS.has(roomRaw.toLowerCase())) {
      room = null;
    } else {
      const canonical = originByLower.get(roomRaw.toLowerCase());
      if (!canonical) {
        invalidRooms.push({ teacher, room: roomRaw });
        continue;
      }
      room = canonical;
    }

    // Last write wins if a teacher appears twice in the file.
    if (seenStaff.has(s.id)) {
      const idx = matched.findIndex((m) => m.staffId === s.id);
      if (idx >= 0) matched[idx] = { staffId: s.id, staffName: s.displayName, room };
    } else {
      seenStaff.add(s.id);
      matched.push({ staffId: s.id, staffName: s.displayName, room });
    }
  }

  let applied = 0;
  if (commit && matched.length > 0) {
    for (const m of matched) {
      await db
        .update(staffDefaultsTable)
        .set({ staffId: m.staffId, schoolId })
        .where(
          and(
            eq(staffDefaultsTable.schoolId, schoolId),
            eq(staffDefaultsTable.staffName, m.staffName),
            sql`${staffDefaultsTable.staffId} IS NULL`,
          ),
        );
      await db
        .insert(staffDefaultsTable)
        .values({
          schoolId,
          staffId: m.staffId,
          staffName: m.staffName,
          defaultLocationName: m.room,
        })
        .onConflictDoUpdate({
          target: staffDefaultsTable.staffId,
          set: {
            schoolId,
            defaultLocationName: m.room,
            staffName: m.staffName,
          },
        });
      applied += 1;
    }
  }

  res.json({
    committed: commit,
    applied,
    matched,
    unmatchedTeachers,
    invalidRooms,
  });
});

export default router;
