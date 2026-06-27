import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  locationsTable,
  staffTable,
  staffDefaultsTable,
  teacherDestinationAllowlistTable,
} from "@workspace/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import {
  loadRestroomAreas,
  loadSchoolWideDefaults,
} from "../lib/restroomAreas.js";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function requireSignedIn() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    next();
  };
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

// Resolve a display name to EXACTLY ONE active staff id in this school. Returns
// null when the name is unknown OR ambiguous (duplicate). The allowlist still
// stores the name for those rows; the email-based CSV importer is the path that
// disambiguates duplicates.
async function resolveStaffIdByName(
  schoolId: number,
  name: string,
): Promise<number | null> {
  const rows = await db
    .select({ id: staffTable.id })
    .from(staffTable)
    .where(
      and(
        eq(staffTable.schoolId, schoolId),
        eq(staffTable.displayName, name),
        eq(staffTable.active, true),
      ),
    );
  return rows.length === 1 ? rows[0].id : null;
}

// Replace a single teacher's allowlist inside one transaction. Always stores
// the canonical staffId when known + the current display name. Deletes any
// prior rows for this teacher addressed EITHER by staffId (SIS-safe) OR by the
// legacy null-staffId name fallback, so a rename never leaves a stale duplicate.
async function replaceTeacherAllowlist(opts: {
  schoolId: number;
  staffId: number | null;
  staffName: string;
  locationIds: number[];
}): Promise<void> {
  const { schoolId, staffId, staffName, locationIds } = opts;
  await db.transaction(async (tx) => {
    const matchTeacher =
      staffId != null
        ? or(
            eq(teacherDestinationAllowlistTable.staffId, staffId),
            and(
              isNull(teacherDestinationAllowlistTable.staffId),
              eq(teacherDestinationAllowlistTable.staffName, staffName),
            ),
          )
        : eq(teacherDestinationAllowlistTable.staffName, staffName);
    await tx
      .delete(teacherDestinationAllowlistTable)
      .where(
        and(
          eq(teacherDestinationAllowlistTable.schoolId, schoolId),
          matchTeacher,
        ),
      );
    if (locationIds.length > 0) {
      await tx.insert(teacherDestinationAllowlistTable).values(
        locationIds.map((destinationLocationId) => ({
          schoolId,
          staffId,
          staffName,
          destinationLocationId,
        })),
      );
    }
  });
}

// Restroom areas + school-wide facility defaults for the admin grid and the
// Create-Pass "near" grouping. Signed-in users may read.
router.get("/teacher-allowlist/meta", requireSignedIn(), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const [restroomAreas, schoolWideDefaults] = await Promise.all([
    loadRestroomAreas(schoolId),
    loadSchoolWideDefaults(schoolId),
  ]);
  res.json({
    restroomAreas,
    schoolWideDefaults: schoolWideDefaults.map((d) => d.name),
  });
});

// ---------------------------------------------------------------------------
// Bulk CSV round-trip (Phase 2).
//
// The admin downloads a pre-filled template (one row per active teacher with a
// LOCKED email matcher + current room + current restroom area), edits the
// "Restroom Area" column in Excel, and re-uploads. The client parses the CSV
// and posts plain rows so we need no CSV parser server-side (mirrors the
// staff-defaults bulk importer). Matching is by EMAIL first (exact, case-
// insensitive), then by an UNAMBIGUOUS display name. The upload replaces only
// the RESTROOM portion of each LISTED teacher's allowlist (manual common-area
// grants are preserved, and teachers not in the file are untouched). Facilities
// are school-wide defaults and never appear in the file.
// ---------------------------------------------------------------------------

type TeacherLite = { id: number; displayName: string; email: string | null };

async function loadActiveTeachers(schoolId: number): Promise<TeacherLite[]> {
  return db
    .select({
      id: staffTable.id,
      displayName: staffTable.displayName,
      email: staffTable.email,
    })
    .from(staffTable)
    .where(and(eq(staffTable.schoolId, schoolId), eq(staffTable.active, true)));
}

// Build email/name lookup maps + an ambiguous-name set (display names are not
// unique within a school, so a name-only match that resolves to >1 staff is
// treated as unmatched rather than silently assigned).
function indexTeachers(staff: TeacherLite[]) {
  const byEmail = new Map<string, TeacherLite>();
  const byName = new Map<string, TeacherLite>();
  const ambiguousNames = new Set<string>();
  for (const s of staff) {
    if (s.email) byEmail.set(s.email.trim().toLowerCase(), s);
    const nameLower = s.displayName.trim().toLowerCase();
    if (byName.has(nameLower)) ambiguousNames.add(nameLower);
    byName.set(nameLower, s);
  }
  return { byEmail, byName, ambiguousNames };
}

// Every allowlist row for the school joined to its location kind + area, so we
// can partition each teacher's current grants into restroom vs non-restroom.
type AllowRow = {
  staffId: number | null;
  staffName: string;
  locationId: number;
  kind: string;
  restroomArea: string | null;
};

async function loadAllowlistRows(schoolId: number): Promise<AllowRow[]> {
  return db
    .select({
      staffId: teacherDestinationAllowlistTable.staffId,
      staffName: teacherDestinationAllowlistTable.staffName,
      locationId: teacherDestinationAllowlistTable.destinationLocationId,
      kind: locationsTable.kind,
      restroomArea: locationsTable.restroomArea,
    })
    .from(teacherDestinationAllowlistTable)
    .innerJoin(
      locationsTable,
      and(
        eq(
          locationsTable.id,
          teacherDestinationAllowlistTable.destinationLocationId,
        ),
        eq(locationsTable.schoolId, schoolId),
      ),
    )
    .where(eq(teacherDestinationAllowlistTable.schoolId, schoolId));
}

// Filter the school-wide allowlist rows down to ONE teacher, matching either by
// canonical staffId OR the legacy null-staffId name fallback.
function rowsForTeacher(
  rows: AllowRow[],
  staffId: number,
  staffName: string,
): AllowRow[] {
  const nameLower = staffName.trim().toLowerCase();
  return rows.filter(
    (r) =>
      r.staffId === staffId ||
      (r.staffId == null && r.staffName.trim().toLowerCase() === nameLower),
  );
}

// Pre-filled template data. The client turns this into a downloadable CSV
// (with formula-injection neutralization). Returns one row per active teacher.
router.get(
  "/teacher-allowlist/template",
  requireAdmin(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;

    const [staff, allowRows, areas, rooms, zoneRules] = await Promise.all([
      loadActiveTeachers(schoolId),
      loadAllowlistRows(schoolId),
      loadRestroomAreas(schoolId),
      loadRoomsByTeacher(schoolId),
      loadZoneRules(schoolId),
    ]);

    const rows = staff
      .map((s) => {
        const mine = rowsForTeacher(allowRows, s.id, s.displayName);
        const currentAreas = Array.from(
          new Set(
            mine
              .filter((r) => r.kind === "restroom")
              .map((r) => (r.restroomArea ?? "").trim())
              .filter((a) => a.length > 0),
          ),
        );
        const room =
          rooms.byStaffId.get(s.id) ??
          rooms.byName.get(s.displayName.trim().toLowerCase()) ??
          "";
        // Pre-fill priority: the teacher's single current area → otherwise the
        // zone-rule suggestion for their room number → otherwise blank (mixed
        // or unknown, so the admin decides).
        const currentArea =
          currentAreas.length === 1 ? currentAreas[0] : "";
        const restroomArea =
          currentArea || suggestAreaForRoom(zoneRules, room) || "";
        return {
          staffName: s.displayName,
          email: s.email ?? "",
          room: room ?? "",
          restroomArea,
        };
      })
      .sort((a, b) => a.staffName.localeCompare(b.staffName));

    res.json({
      columns: ["Teacher", "Email", "Room", "Restroom Area"],
      rows,
      areas: areas.map((a) => ({ area: a.area, memberNames: a.memberNames })),
    });
  },
);

type BulkRow = { email?: unknown; name?: unknown; area?: unknown };

const AREA_CLEAR_TOKENS = new Set(["", "none", "(none)", "n/a", "na", "-"]);

type BulkApplyResult = {
  committed: boolean;
  applied: number;
  batchId: number | null;
  matched: Array<{ staffName: string; area: string; grants: number }>;
  unmatchedTeachers: string[];
  invalidAreas: Array<{ teacher: string; area: string }>;
  knownAreas: string[];
};

// Shared core for both the CSV upload (POST /bulk) and the zone-rule
// auto-assign (POST /zone-rules/auto-assign): match rows to teachers by
// email/name, replace ONLY their restroom grants (preserve manual room
// grants), and — on commit — snapshot the prior state into a rollback batch.
async function computeAndApplyBulk(
  schoolId: number,
  createdBy: number | null,
  rawRows: BulkRow[],
  commit: boolean,
): Promise<BulkApplyResult> {
  const [staff, allowRows, areas] = await Promise.all([
    loadActiveTeachers(schoolId),
    loadAllowlistRows(schoolId),
    loadRestroomAreas(schoolId),
  ]);
  const { byEmail, byName, ambiguousNames } = indexTeachers(staff);
  const areaByLower = new Map<string, (typeof areas)[number]>();
  for (const a of areas) areaByLower.set(a.area.trim().toLowerCase(), a);

  type Matched = {
    staffId: number;
    staffName: string;
    area: string; // "" means clear restrooms
    restroomLocationIds: number[];
    keptNonRestroomIds: number[];
    priorLocationIds: number[];
  };
  const matched: Matched[] = [];
  const unmatchedTeachers: string[] = [];
  const invalidAreas: Array<{ teacher: string; area: string }> = [];
  const seenStaff = new Set<number>();

  for (const r of rawRows) {
    const email = typeof r?.email === "string" ? r.email.trim() : "";
    const name = typeof r?.name === "string" ? r.name.trim() : "";
    const areaRaw = typeof r?.area === "string" ? r.area.trim() : "";
    const idKey = (email || name).trim();
    if (!idKey) continue;

    // Email wins; name only used when unambiguous.
    const emailLower = email.toLowerCase();
    const nameLower = name.toLowerCase();
    const s =
      (email ? byEmail.get(emailLower) : undefined) ??
      (name && !ambiguousNames.has(nameLower)
        ? byName.get(nameLower)
        : undefined);
    if (!s) {
      unmatchedTeachers.push(idKey);
      continue;
    }

    let restroomLocationIds: number[] = [];
    let areaName = "";
    if (!AREA_CLEAR_TOKENS.has(areaRaw.toLowerCase())) {
      const a = areaByLower.get(areaRaw.toLowerCase());
      if (!a) {
        invalidAreas.push({ teacher: idKey, area: areaRaw });
        continue;
      }
      restroomLocationIds = a.locationIds;
      areaName = a.area;
    }

    const mine = rowsForTeacher(allowRows, s.id, s.displayName);
    const priorLocationIds = Array.from(
      new Set(mine.map((m) => m.locationId)),
    );
    const keptNonRestroomIds = Array.from(
      new Set(
        mine.filter((m) => m.kind !== "restroom").map((m) => m.locationId),
      ),
    );

    const entry: Matched = {
      staffId: s.id,
      staffName: s.displayName,
      area: areaName,
      restroomLocationIds,
      keptNonRestroomIds,
      priorLocationIds,
    };
    // Last write wins if a teacher appears twice in the input.
    if (seenStaff.has(s.id)) {
      const idx = matched.findIndex((m) => m.staffId === s.id);
      if (idx >= 0) matched[idx] = entry;
    } else {
      seenStaff.add(s.id);
      matched.push(entry);
    }
  }

  let applied = 0;
  let batchId: number | null = null;
  if (commit && matched.length > 0) {
    // Snapshot keyed by stable staffId (an array, not a name-keyed map) so two
    // teachers sharing a display name each get their own restorable entry.
    const prior: Array<{
      staffId: number;
      staffName: string;
      locationIds: number[];
    }> = [];
    for (const m of matched) {
      const nextIds = Array.from(
        new Set([...m.keptNonRestroomIds, ...m.restroomLocationIds]),
      );
      await replaceTeacherAllowlist({
        schoolId,
        staffId: m.staffId,
        staffName: m.staffName,
        locationIds: nextIds,
      });
      prior.push({
        staffId: m.staffId,
        staffName: m.staffName,
        locationIds: m.priorLocationIds,
      });
      applied += 1;
    }
    const inserted = await db.execute(sql`
      INSERT INTO teacher_allowlist_import_batches
        (school_id, created_by, applied_count, prior_json)
      VALUES (
        ${schoolId},
        ${createdBy ?? null},
        ${applied},
        ${JSON.stringify(prior)}::jsonb
      )
      RETURNING id
    `);
    const idRow = (inserted.rows?.[0] ?? null) as { id?: number } | null;
    batchId = idRow?.id ?? null;
  }

  return {
    committed: commit,
    applied,
    batchId,
    matched: matched.map((m) => ({
      staffName: m.staffName,
      area: m.area,
      grants: m.restroomLocationIds.length,
    })),
    unmatchedTeachers,
    invalidAreas,
    knownAreas: areas.map((a) => a.area),
  };
}

// Preview (commit:false, default) or apply (commit:true) a bulk restroom-area
// assignment. Body: { rows: [{ email, name, area }], commit?: boolean }.
router.post("/teacher-allowlist/bulk", requireAdmin(), async (req, res) => {
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
  const result = await computeAndApplyBulk(
    schoolId,
    req.staffId ?? null,
    rawRows as BulkRow[],
    commit,
  );
  res.json(result);
});

// Most-recent rollback-able batch for this school (so the client can offer an
// "Undo last upload" button). Null when none or the latest is already undone.
router.get(
  "/teacher-allowlist/bulk/last",
  requireAdmin(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const result = await db.execute(sql`
      SELECT id, applied_count, created_at, rolled_back_at
        FROM teacher_allowlist_import_batches
       WHERE school_id = ${schoolId}
       ORDER BY created_at DESC
       LIMIT 1
    `);
    const row = (result.rows?.[0] ?? null) as
      | {
          id: number;
          applied_count: number;
          created_at: string;
          rolled_back_at: string | null;
        }
      | null;
    if (!row || row.rolled_back_at) {
      res.json({ batch: null });
      return;
    }
    res.json({
      batch: {
        id: row.id,
        appliedCount: row.applied_count,
        createdAt: row.created_at,
      },
    });
  },
);

// Restore every teacher's allowlist to the snapshot captured before a batch.
router.post(
  "/teacher-allowlist/bulk/:batchId/rollback",
  requireAdmin(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const batchId = Number(req.params.batchId);
    if (!Number.isInteger(batchId) || batchId <= 0) {
      res.status(400).json({ error: "Invalid batch id" });
      return;
    }
    const result = await db.execute(sql`
      SELECT id, prior_json, rolled_back_at
        FROM teacher_allowlist_import_batches
       WHERE id = ${batchId} AND school_id = ${schoolId}
    `);
    const row = (result.rows?.[0] ?? null) as
      | {
          id: number;
          prior_json: unknown;
          rolled_back_at: string | null;
        }
      | null;
    if (!row) {
      res.status(404).json({ error: "Batch not found" });
      return;
    }
    if (row.rolled_back_at) {
      res.status(409).json({ error: "This upload was already undone." });
      return;
    }
    // Snapshots are stored as an array of {staffId, staffName, locationIds}.
    // Tolerate any legacy name-keyed object form too.
    type Snap = {
      staffId: number | null;
      staffName: string;
      locationIds: number[];
    };
    const raw = row.prior_json;
    const snaps: Snap[] = Array.isArray(raw)
      ? (raw as Snap[])
      : Object.entries((raw ?? {}) as Record<string, Partial<Snap>>).map(
          ([staffName, snap]) => ({
            staffId: snap?.staffId ?? null,
            staffName,
            locationIds: Array.isArray(snap?.locationIds)
              ? snap!.locationIds!
              : [],
          }),
        );
    let restored = 0;
    for (const snap of snaps) {
      await replaceTeacherAllowlist({
        schoolId,
        staffId: snap.staffId ?? null,
        staffName: snap.staffName,
        locationIds: Array.isArray(snap.locationIds) ? snap.locationIds : [],
      });
      restored += 1;
    }
    await db.execute(sql`
      UPDATE teacher_allowlist_import_batches
         SET rolled_back_at = NOW()
       WHERE id = ${batchId} AND school_id = ${schoolId}
    `);
    res.json({ ok: true, restored });
  },
);

// ---------------------------------------------------------------------------
// Zone rules (Phase 3).
//
// A zone rule maps an inclusive room-NUMBER range to a restroom-area name. The
// first matching rule (by sort_order) wins. Rules drive two things: the
// template pre-fill (a suggested area for each teacher's room) and the
// one-click "auto-assign all" that applies every suggestion through the same
// shared bulk-apply path (so it is previewable + rollback-able).
// ---------------------------------------------------------------------------

type ZoneRule = {
  id: number;
  roomFrom: number;
  roomTo: number;
  restroomArea: string;
  sortOrder: number;
};

async function loadZoneRules(schoolId: number): Promise<ZoneRule[]> {
  const result = await db.execute(sql`
    SELECT id, room_from, room_to, restroom_area, sort_order
      FROM teacher_allowlist_zone_rules
     WHERE school_id = ${schoolId}
     ORDER BY sort_order ASC, id ASC
  `);
  return (result.rows ?? []).map((r) => {
    const row = r as {
      id: number;
      room_from: number;
      room_to: number;
      restroom_area: string;
      sort_order: number;
    };
    return {
      id: row.id,
      roomFrom: Number(row.room_from),
      roomTo: Number(row.room_to),
      restroomArea: row.restroom_area,
      sortOrder: Number(row.sort_order),
    };
  });
}

// Pull the first run of digits out of a free-text room label ("Room 214",
// "B-214", "214A" → 214). Returns null when there is no number to range-match.
function extractRoomNumber(room: string | null | undefined): number | null {
  if (!room) return null;
  const m = String(room).match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

// First rule whose inclusive range contains the room number wins.
function suggestAreaForRoom(
  rules: ZoneRule[],
  room: string | null | undefined,
): string {
  const n = extractRoomNumber(room);
  if (n == null) return "";
  for (const rule of rules) {
    const lo = Math.min(rule.roomFrom, rule.roomTo);
    const hi = Math.max(rule.roomFrom, rule.roomTo);
    if (n >= lo && n <= hi) return rule.restroomArea;
  }
  return "";
}

// Room (default-location) per teacher, keyed by staffId then lowercased name.
async function loadRoomsByTeacher(schoolId: number): Promise<{
  byStaffId: Map<number, string | null>;
  byName: Map<string, string | null>;
}> {
  const defaults = await db
    .select({
      staffId: staffDefaultsTable.staffId,
      staffName: staffDefaultsTable.staffName,
      room: staffDefaultsTable.defaultLocationName,
    })
    .from(staffDefaultsTable)
    .where(eq(staffDefaultsTable.schoolId, schoolId));
  const byStaffId = new Map<number, string | null>();
  const byName = new Map<string, string | null>();
  for (const d of defaults) {
    if (d.staffId != null) byStaffId.set(d.staffId, d.room);
    byName.set(d.staffName.trim().toLowerCase(), d.room);
  }
  return { byStaffId, byName };
}

router.get(
  "/teacher-allowlist/zone-rules",
  requireAdmin(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const [rules, areas] = await Promise.all([
      loadZoneRules(schoolId),
      loadRestroomAreas(schoolId),
    ]);
    res.json({
      rules: rules.map((r) => ({
        roomFrom: r.roomFrom,
        roomTo: r.roomTo,
        restroomArea: r.restroomArea,
      })),
      knownAreas: areas.map((a) => a.area),
    });
  },
);

// Replace the full rule set in one shot (the client edits a small list and
// saves the whole thing — simpler than per-row CRUD).
router.put(
  "/teacher-allowlist/zone-rules",
  requireAdmin(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const rawRules = Array.isArray(req.body?.rules) ? req.body.rules : null;
    if (!rawRules) {
      res.status(400).json({ error: "rules[] is required" });
      return;
    }
    if (rawRules.length > 500) {
      res.status(400).json({ error: "Too many rules (max 500)" });
      return;
    }
    const clean: Array<{ from: number; to: number; area: string }> = [];
    for (const r of rawRules) {
      const from = Number(r?.roomFrom);
      const to = Number(r?.roomTo);
      const area = typeof r?.restroomArea === "string"
        ? r.restroomArea.trim()
        : "";
      if (!Number.isInteger(from) || !Number.isInteger(to) || !area) continue;
      clean.push({ from, to, area });
    }
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        DELETE FROM teacher_allowlist_zone_rules WHERE school_id = ${schoolId}
      `);
      let order = 0;
      for (const c of clean) {
        await tx.execute(sql`
          INSERT INTO teacher_allowlist_zone_rules
            (school_id, room_from, room_to, restroom_area, sort_order)
          VALUES (${schoolId}, ${c.from}, ${c.to}, ${c.area}, ${order})
        `);
        order += 1;
      }
    });
    res.json({ ok: true, saved: clean.length });
  },
);

// Preview (commit:false) or apply (commit:true) the zone-rule suggestions to
// EVERY active teacher with a matching room. Skips teachers with no room number
// or no matching rule. Goes through the shared bulk-apply path so it is
// previewable, preserves manual grants, and is rollback-able.
router.post(
  "/teacher-allowlist/zone-rules/auto-assign",
  requireAdmin(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const commit = req.body?.commit === true;

    const [staff, rules, rooms] = await Promise.all([
      loadActiveTeachers(schoolId),
      loadZoneRules(schoolId),
      loadRoomsByTeacher(schoolId),
    ]);
    if (rules.length === 0) {
      res.status(400).json({ error: "No zone rules configured yet." });
      return;
    }

    const rows: BulkRow[] = [];
    let noRoom = 0;
    let noMatch = 0;
    for (const s of staff) {
      const room =
        rooms.byStaffId.get(s.id) ??
        rooms.byName.get(s.displayName.trim().toLowerCase()) ??
        "";
      if (extractRoomNumber(room) == null) {
        noRoom += 1;
        continue;
      }
      const area = suggestAreaForRoom(rules, room);
      if (!area) {
        noMatch += 1;
        continue;
      }
      // Email is the strongest matcher; fall back to display name.
      rows.push({ email: s.email ?? "", name: s.displayName, area });
    }

    const result = await computeAndApplyBulk(
      schoolId,
      req.staffId ?? null,
      rows,
      commit,
    );
    res.json({ ...result, skippedNoRoom: noRoom, skippedNoRule: noMatch });
  },
);

// All rows joined with location names. Signed-in users may read so the
// Create Pass modal can group destinations as near vs other. Carries the
// location id + restroom-area/gender + school-wide flag so the admin grid can
// render area columns and locked facility columns without a second fetch.
router.get("/teacher-allowlist", requireSignedIn(), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  // Defense-in-depth: also constrain the joined location to this school
  // so a stale row pointing at another school's location id can't bleed.
  const rows = await db
    .select({
      id: teacherDestinationAllowlistTable.id,
      staffId: teacherDestinationAllowlistTable.staffId,
      staffName: teacherDestinationAllowlistTable.staffName,
      destinationLocationId:
        teacherDestinationAllowlistTable.destinationLocationId,
      destinationName: locationsTable.name,
      restroomArea: locationsTable.restroomArea,
      gender: locationsTable.gender,
      schoolWideDefault: locationsTable.schoolWideDefault,
    })
    .from(teacherDestinationAllowlistTable)
    .innerJoin(
      locationsTable,
      and(
        eq(
          locationsTable.id,
          teacherDestinationAllowlistTable.destinationLocationId,
        ),
        eq(locationsTable.schoolId, schoolId),
      ),
    )
    .where(eq(teacherDestinationAllowlistTable.schoolId, schoolId));
  rows.sort((a, b) => {
    const s = a.staffName.localeCompare(b.staffName);
    if (s !== 0) return s;
    return a.destinationName.localeCompare(b.destinationName);
  });
  res.json(rows);
});

// Self-serve: a signed-in teacher replaces THEIR OWN allowlist. Keyed to the
// caller's canonical staff id (SIS-safe). Forbids classrooms — the self-serve
// picker only ever offers general-area / restroom / office destinations, so
// this is the server-side guard that keeps a crafted request from sneaking a
// classroom in. MUST stay above "/teacher-allowlist/:staffName" or ":staffName"
// would capture the literal "me".
router.put("/teacher-allowlist/me", requireSignedIn(), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staff = await loadStaff(req);
  if (!staff) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const staffName = staff.displayName.trim();
  if (!staffName) {
    res.status(400).json({ error: "Your profile has no display name" });
    return;
  }
  const body = req.body ?? {};
  const destinations: unknown = body.destinations;
  if (!Array.isArray(destinations)) {
    res.status(400).json({ error: "destinations must be an array of names" });
    return;
  }
  const names = Array.from(
    new Set(
      destinations
        .filter((d): d is string => typeof d === "string")
        .map((d) => d.trim())
        .filter((d) => d.length > 0),
    ),
  );

  let locationIds: number[] = [];
  if (names.length > 0) {
    const locs = await db
      .select({
        id: locationsTable.id,
        name: locationsTable.name,
        kind: locationsTable.kind,
      })
      .from(locationsTable)
      .where(
        and(
          inArray(locationsTable.name, names),
          eq(locationsTable.schoolId, schoolId),
        ),
      );
    if (locs.length !== names.length) {
      res.status(400).json({
        error: "One or more destination names did not match a location",
      });
      return;
    }
    const classroom = locs.find((l) => l.kind === "classroom");
    if (classroom) {
      res.status(400).json({
        error: `Classrooms can't be added here (${classroom.name}). Pick restrooms and common areas only.`,
      });
      return;
    }
    locationIds = locs.map((l) => l.id);
  }

  await replaceTeacherAllowlist({
    schoolId,
    staffId: staff.id,
    staffName,
    locationIds,
  });

  res.json({ ok: true, staffName, count: locationIds.length });
});

// Replace the allowlist for a single teacher. Body: { destinations: string[] }
// where each entry is a location name. Resolves + stores the canonical staffId
// when the name is unambiguous (else stores name-only, like before).
router.put("/teacher-allowlist/:staffName", requireAdmin(), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staffName = String(req.params.staffName ?? "").trim();
  if (!staffName) {
    res.status(400).json({ error: "staffName is required" });
    return;
  }
  const body = req.body ?? {};
  const destinations: unknown = body.destinations;
  if (!Array.isArray(destinations)) {
    res.status(400).json({ error: "destinations must be an array of names" });
    return;
  }
  const names = Array.from(
    new Set(
      destinations
        .filter((d): d is string => typeof d === "string")
        .map((d) => d.trim())
        .filter((d) => d.length > 0),
    ),
  );

  let locationIds: number[] = [];
  if (names.length > 0) {
    // Resolve names to locations within THIS school only.
    const locs = await db
      .select({ id: locationsTable.id, name: locationsTable.name })
      .from(locationsTable)
      .where(
        and(
          inArray(locationsTable.name, names),
          eq(locationsTable.schoolId, schoolId),
        ),
      );
    locationIds = locs.map((l) => l.id);
    if (locationIds.length !== names.length) {
      res.status(400).json({
        error: "One or more destination names did not match a location",
      });
      return;
    }
  }

  const staffId = await resolveStaffIdByName(schoolId, staffName);
  await replaceTeacherAllowlist({ schoolId, staffId, staffName, locationIds });

  res.json({ ok: true, staffName, count: locationIds.length });
});

export default router;
