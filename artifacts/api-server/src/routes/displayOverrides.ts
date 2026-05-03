// Per-display schedule overrides.
//
// A "display" in this codebase is `display_playlists.id` (the row whose
// public URL the TV opens). Its own items are the BASE loop. An override
// row says "on day X, between HH:MM and HH:MM, play items from this OTHER
// playlist instead". When an override window opens or closes the cycler
// hard-resets to item 1 of the new scope so the loop is predictable for
// staff (instead of resuming partway through).
//
// All endpoints in this file are admin-only (canManageDisplays). The
// public read of overrides happens via the existing
// /displays/public/playlists/:id endpoint, which we extend to include
// pre-resolved override windows + items.

import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  staffTable,
  displayPlaylistsTable,
  displayPlaylistOverridesTable,
} from "@workspace/db";
import { and, eq, asc } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const router: IRouter = Router();

// ---------- helpers (mirrors displays.ts; kept local to avoid coupling) -----

async function loadStaff(req: Request, res: Response) {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  return staff;
}

function isCoreTeamForDisplays(s: typeof staffTable.$inferSelect): boolean {
  return Boolean(
    s.isSuperUser ||
      s.isAdmin ||
      s.isMtssCoordinator ||
      s.isBehaviorSpecialist ||
      s.isDean,
  );
}

function canManageDisplays(s: typeof staffTable.$inferSelect): boolean {
  return isCoreTeamForDisplays(s) || s.capManageDisplays;
}

function activeSchoolId(s: typeof staffTable.$inferSelect): number {
  return s.activeSchoolOverride ?? s.schoolId;
}

// Loads the host playlist (the "display") and verifies caller can edit it.
async function loadDisplayForEdit(
  req: Request,
  res: Response,
  staff: typeof staffTable.$inferSelect,
) {
  const id = Number.parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid display id" });
    return null;
  }
  const [pl] = await db
    .select()
    .from(displayPlaylistsTable)
    .where(eq(displayPlaylistsTable.id, id));
  if (!pl) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  if (pl.schoolId !== activeSchoolId(staff)) {
    res.status(403).json({ error: "Not authorized" });
    return null;
  }
  if (
    !isCoreTeamForDisplays(staff) &&
    pl.ownerStaffId !== null &&
    pl.ownerStaffId !== staff.id
  ) {
    res.status(403).json({ error: "Not authorized" });
    return null;
  }
  return pl;
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Parses an optional ISO date (YYYY-MM-DD). Accepts null/undefined/"" as
// null. Returns { ok:false } on a malformed non-empty string. The cycler
// uses these as inclusive bounds — a row with both nulls recurs forever.
function parseOptionalDate(
  v: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  if (typeof v !== "string" || !DATE_RE.test(v)) {
    return { ok: false, error: "Date must be YYYY-MM-DD" };
  }
  // Reject impossible calendar dates like 2026-02-31. Date(y,m-1,d)
  // would silently roll those into the next month, which would then
  // mismatch what the cycler does when it re-stringifies "today".
  const [y, m, d] = v.split("-").map((n) => Number.parseInt(n, 10));
  const dt = new Date(y, m - 1, d);
  if (
    dt.getFullYear() !== y ||
    dt.getMonth() !== m - 1 ||
    dt.getDate() !== d
  ) {
    return { ok: false, error: "Date is not a real calendar date" };
  }
  return { ok: true, value: v };
}

function validateOverrideInput(body: unknown): {
  ok: true;
  value: {
    playlistId: number;
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    effectiveFrom: string | null;
    effectiveUntil: string | null;
  };
} | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const playlistId = Number.parseInt(String(b.playlistId ?? ""), 10);
  const dayOfWeek = Number.parseInt(String(b.dayOfWeek ?? ""), 10);
  const startTime = String(b.startTime ?? "");
  const endTime = String(b.endTime ?? "");
  if (!Number.isFinite(playlistId)) return { ok: false, error: "playlistId required" };
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    return { ok: false, error: "dayOfWeek must be 0–6" };
  }
  if (!HHMM_RE.test(startTime) || !HHMM_RE.test(endTime)) {
    return { ok: false, error: "startTime / endTime must be HH:MM" };
  }
  if (endTime <= startTime) {
    return {
      ok: false,
      error:
        "endTime must be after startTime. Split overnight windows into two rows (one each side of midnight).",
    };
  }
  const f = parseOptionalDate(b.effectiveFrom);
  if (!f.ok) return { ok: false, error: `effectiveFrom: ${f.error}` };
  const u = parseOptionalDate(b.effectiveUntil);
  if (!u.ok) return { ok: false, error: `effectiveUntil: ${u.error}` };
  if (f.value && u.value && u.value < f.value) {
    return { ok: false, error: "effectiveUntil must be on or after effectiveFrom" };
  }
  // Only the three documented modes are legal:
  //   (null,null)          → recurring weekly forever
  //   (d,d)                → one specific day
  //   (from,until) f<until → bounded date range
  // Reject one-sided bounds — they're ambiguous (does "from-only"
  // mean "from this date forever" or "starting this date for one
  // week"?) and would create rows the recurrence picker can't
  // round-trip.
  if ((f.value && !u.value) || (!f.value && u.value)) {
    return {
      ok: false,
      error:
        "effectiveFrom and effectiveUntil must both be set or both be null",
    };
  }
  return {
    ok: true,
    value: {
      playlistId,
      dayOfWeek,
      startTime,
      endTime,
      effectiveFrom: f.value,
      effectiveUntil: u.value,
    },
  };
}

// Confirms the override-target playlist exists and lives at the same
// school. (Cross-school overrides would leak content between buildings.)
async function verifyOverrideTarget(
  res: Response,
  hostSchoolId: number,
  playlistId: number,
): Promise<boolean> {
  const [target] = await db
    .select({ id: displayPlaylistsTable.id, schoolId: displayPlaylistsTable.schoolId })
    .from(displayPlaylistsTable)
    .where(eq(displayPlaylistsTable.id, playlistId));
  if (!target) {
    res.status(400).json({ error: "Override playlist does not exist" });
    return false;
  }
  if (target.schoolId !== hostSchoolId) {
    res.status(400).json({ error: "Override playlist must be at the same school" });
    return false;
  }
  return true;
}

// ---------- LIST ------------------------------------------------------------

router.get("/displays/playlists/:id/overrides", async (req, res) => {
  try {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    if (!canManageDisplays(staff)) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }
    const pl = await loadDisplayForEdit(req, res, staff);
    if (!pl) return;
    const rows = await db
      .select()
      .from(displayPlaylistOverridesTable)
      .where(eq(displayPlaylistOverridesTable.displayId, pl.id))
      .orderBy(
        asc(displayPlaylistOverridesTable.dayOfWeek),
        asc(displayPlaylistOverridesTable.startTime),
      );
    res.json({ overrides: rows });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[display-overrides] list failed", e);
    res.status(500).json({ error: "Failed to load overrides" });
  }
});

// ---------- CREATE one ------------------------------------------------------

router.post("/displays/playlists/:id/overrides", async (req, res) => {
  try {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    if (!canManageDisplays(staff)) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }
    const pl = await loadDisplayForEdit(req, res, staff);
    if (!pl) return;
    const v = validateOverrideInput(req.body);
    if (!v.ok) {
      res.status(400).json({ error: v.error });
      return;
    }
    if (!(await verifyOverrideTarget(res, pl.schoolId, v.value.playlistId))) return;
    const [inserted] = await db
      .insert(displayPlaylistOverridesTable)
      .values({
        displayId: pl.id,
        playlistId: v.value.playlistId,
        dayOfWeek: v.value.dayOfWeek,
        startTime: v.value.startTime,
        endTime: v.value.endTime,
        effectiveFrom: v.value.effectiveFrom,
        effectiveUntil: v.value.effectiveUntil,
      })
      .returning();
    res.status(201).json({ override: inserted });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[display-overrides] create failed", e);
    res.status(500).json({ error: "Failed to create override" });
  }
});

// ---------- BULK CREATE -----------------------------------------------------
// Accepts an array of override inputs in one call so the admin UI can offer
// "every weekday 8:30–9:00" without making the user click 5 times. Either
// every row is inserted or none are — we don't half-apply.
router.post("/displays/playlists/:id/overrides/bulk", async (req, res) => {
  try {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    if (!canManageDisplays(staff)) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }
    const pl = await loadDisplayForEdit(req, res, staff);
    if (!pl) return;
    const body = (req.body ?? {}) as {
      overrides?: unknown[];
      groupName?: unknown;
    };
    const list = body.overrides;
    if (!Array.isArray(list) || list.length === 0) {
      res.status(400).json({ error: "overrides[] required" });
      return;
    }
    if (list.length > 200) {
      res.status(400).json({ error: "Too many rows (max 200)" });
      return;
    }
    const validated: Array<{
      playlistId: number;
      dayOfWeek: number;
      startTime: string;
      endTime: string;
      effectiveFrom: string | null;
      effectiveUntil: string | null;
    }> = [];
    const targetIds = new Set<number>();
    for (let i = 0; i < list.length; i++) {
      const v = validateOverrideInput(list[i]);
      if (!v.ok) {
        res.status(400).json({ error: `Row ${i + 1}: ${v.error}` });
        return;
      }
      validated.push(v.value);
      targetIds.add(v.value.playlistId);
    }
    // Verify every distinct target once.
    for (const tid of targetIds) {
      if (!(await verifyOverrideTarget(res, pl.schoolId, tid))) return;
    }
    // Stamp every row with the same group_id so the UI can offer
    // "edit / delete the entire passing period". Admins may also
    // supply a friendly groupName ("1st period passing").
    const groupId = randomUUID();
    const groupName =
      typeof body.groupName === "string" && body.groupName.trim()
        ? body.groupName.trim().slice(0, 100)
        : null;
    const inserted = await db
      .insert(displayPlaylistOverridesTable)
      .values(
        validated.map((v) => ({
          displayId: pl.id,
          playlistId: v.playlistId,
          dayOfWeek: v.dayOfWeek,
          startTime: v.startTime,
          endTime: v.endTime,
          effectiveFrom: v.effectiveFrom,
          effectiveUntil: v.effectiveUntil,
          groupId,
          groupName,
        })),
      )
      .returning();
    res.status(201).json({ overrides: inserted, groupId, groupName });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[display-overrides] bulk failed", e);
    res.status(500).json({ error: "Failed to create overrides" });
  }
});

// ---------- PATCH one -------------------------------------------------------

router.patch(
  "/displays/playlists/:id/overrides/:overrideId",
  async (req, res) => {
    try {
      const staff = await loadStaff(req, res);
      if (!staff) return;
      if (!canManageDisplays(staff)) {
        res.status(403).json({ error: "Not authorized" });
        return;
      }
      const pl = await loadDisplayForEdit(req, res, staff);
      if (!pl) return;
      const overrideId = Number.parseInt(req.params.overrideId, 10);
      if (!Number.isFinite(overrideId)) {
        res.status(400).json({ error: "Invalid override id" });
        return;
      }
      const [existing] = await db
        .select()
        .from(displayPlaylistOverridesTable)
        .where(eq(displayPlaylistOverridesTable.id, overrideId));
      if (!existing || existing.displayId !== pl.id) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      // Merge incoming with existing, then re-validate the whole row so we
      // can never persist a half-changed invalid window (e.g. patch only
      // endTime past startTime).
      const merged = {
        playlistId: req.body?.playlistId ?? existing.playlistId,
        dayOfWeek: req.body?.dayOfWeek ?? existing.dayOfWeek,
        startTime: req.body?.startTime ?? existing.startTime,
        endTime: req.body?.endTime ?? existing.endTime,
        effectiveFrom:
          req.body?.effectiveFrom !== undefined
            ? req.body.effectiveFrom
            : existing.effectiveFrom,
        effectiveUntil:
          req.body?.effectiveUntil !== undefined
            ? req.body.effectiveUntil
            : existing.effectiveUntil,
      };
      const v = validateOverrideInput(merged);
      if (!v.ok) {
        res.status(400).json({ error: v.error });
        return;
      }
      if (
        v.value.playlistId !== existing.playlistId &&
        !(await verifyOverrideTarget(res, pl.schoolId, v.value.playlistId))
      ) {
        return;
      }
      const [updated] = await db
        .update(displayPlaylistOverridesTable)
        .set({
          playlistId: v.value.playlistId,
          dayOfWeek: v.value.dayOfWeek,
          startTime: v.value.startTime,
          endTime: v.value.endTime,
          effectiveFrom: v.value.effectiveFrom,
          effectiveUntil: v.value.effectiveUntil,
          updatedAt: new Date(),
        })
        .where(eq(displayPlaylistOverridesTable.id, overrideId))
        .returning();
      res.json({ override: updated });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[display-overrides] patch failed", e);
      res.status(500).json({ error: "Failed to update override" });
    }
  },
);

// ---------- PATCH whole group ----------------------------------------------
// Apply the same change (playlistId / startTime / endTime / groupName) to
// every row sharing this group_id under the same display. dayOfWeek is
// intentionally NOT patchable in bulk — the whole point of a passing-period
// group is that each row already targets a specific day.
router.patch(
  "/displays/playlists/:id/overrides/group/:groupId",
  async (req, res) => {
    try {
      const staff = await loadStaff(req, res);
      if (!staff) return;
      if (!canManageDisplays(staff)) {
        res.status(403).json({ error: "Not authorized" });
        return;
      }
      const pl = await loadDisplayForEdit(req, res, staff);
      if (!pl) return;
      const groupId = String(req.params.groupId);
      if (!groupId) {
        res.status(400).json({ error: "Invalid group id" });
        return;
      }
      // Load every row in the group so we can validate the merged
      // start/end window per row (each row keeps its own dayOfWeek).
      const existing = await db
        .select()
        .from(displayPlaylistOverridesTable)
        .where(
          and(
            eq(displayPlaylistOverridesTable.displayId, pl.id),
            eq(displayPlaylistOverridesTable.groupId, groupId),
          ),
        );
      if (existing.length === 0) {
        res.status(404).json({ error: "Group not found" });
        return;
      }
      const b = (req.body ?? {}) as Record<string, unknown>;
      const nextPlaylistId =
        b.playlistId !== undefined
          ? Number.parseInt(String(b.playlistId), 10)
          : existing[0].playlistId;
      const nextStartTime =
        typeof b.startTime === "string" ? b.startTime : existing[0].startTime;
      const nextEndTime =
        typeof b.endTime === "string" ? b.endTime : existing[0].endTime;
      const nextGroupName =
        b.groupName === undefined
          ? existing[0].groupName
          : typeof b.groupName === "string" && b.groupName.trim()
            ? b.groupName.trim().slice(0, 100)
            : null;
      // Group PATCH intentionally does NOT touch effectiveFrom /
      // effectiveUntil. Each row in the group keeps its own date
      // range — collapsing them all to one value would silently
      // rewrite per-row bounds the user can't see in this dialog.
      // (The recurrence picker is hidden in group-scope edit; we
      // also defensively ignore the fields if the client sends them.)
      // Validate by piggybacking on validateOverrideInput (we feed a
      // fake dayOfWeek=0 since it's not changing here, and pass
      // existing dates through so the validator doesn't reject).
      const v = validateOverrideInput({
        playlistId: nextPlaylistId,
        dayOfWeek: 0,
        startTime: nextStartTime,
        endTime: nextEndTime,
        effectiveFrom: existing[0].effectiveFrom,
        effectiveUntil: existing[0].effectiveUntil,
      });
      if (!v.ok) {
        res.status(400).json({ error: v.error });
        return;
      }
      if (
        nextPlaylistId !== existing[0].playlistId &&
        !(await verifyOverrideTarget(res, pl.schoolId, nextPlaylistId))
      ) {
        return;
      }
      const updated = await db
        .update(displayPlaylistOverridesTable)
        .set({
          playlistId: nextPlaylistId,
          startTime: nextStartTime,
          endTime: nextEndTime,
          groupName: nextGroupName,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(displayPlaylistOverridesTable.displayId, pl.id),
            eq(displayPlaylistOverridesTable.groupId, groupId),
          ),
        )
        .returning();
      res.json({ overrides: updated });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[display-overrides] group patch failed", e);
      res.status(500).json({ error: "Failed to update passing period" });
    }
  },
);

// ---------- DELETE whole group ---------------------------------------------
router.delete(
  "/displays/playlists/:id/overrides/group/:groupId",
  async (req, res) => {
    try {
      const staff = await loadStaff(req, res);
      if (!staff) return;
      if (!canManageDisplays(staff)) {
        res.status(403).json({ error: "Not authorized" });
        return;
      }
      const pl = await loadDisplayForEdit(req, res, staff);
      if (!pl) return;
      const groupId = String(req.params.groupId);
      if (!groupId) {
        res.status(400).json({ error: "Invalid group id" });
        return;
      }
      const result = await db
        .delete(displayPlaylistOverridesTable)
        .where(
          and(
            eq(displayPlaylistOverridesTable.displayId, pl.id),
            eq(displayPlaylistOverridesTable.groupId, groupId),
          ),
        )
        .returning({ id: displayPlaylistOverridesTable.id });
      if (result.length === 0) {
        res.status(404).json({ error: "Group not found" });
        return;
      }
      res.json({ ok: true, deleted: result.length });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[display-overrides] group delete failed", e);
      res.status(500).json({ error: "Failed to delete passing period" });
    }
  },
);

// ---------- DELETE one ------------------------------------------------------

router.delete(
  "/displays/playlists/:id/overrides/:overrideId",
  async (req, res) => {
    try {
      const staff = await loadStaff(req, res);
      if (!staff) return;
      if (!canManageDisplays(staff)) {
        res.status(403).json({ error: "Not authorized" });
        return;
      }
      const pl = await loadDisplayForEdit(req, res, staff);
      if (!pl) return;
      const overrideId = Number.parseInt(req.params.overrideId, 10);
      if (!Number.isFinite(overrideId)) {
        res.status(400).json({ error: "Invalid override id" });
        return;
      }
      const result = await db
        .delete(displayPlaylistOverridesTable)
        .where(
          and(
            eq(displayPlaylistOverridesTable.id, overrideId),
            eq(displayPlaylistOverridesTable.displayId, pl.id),
          ),
        )
        .returning({ id: displayPlaylistOverridesTable.id });
      if (result.length === 0) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[display-overrides] delete failed", e);
      res.status(500).json({ error: "Failed to delete override" });
    }
  },
);

// ---------- CALENDAR (cross-display rollup) --------------------------------
// "What is going to play across every display in my school over the next
// N days?". Walks dates from `fromDate` for `days` (max 56), and for each
// (date, display) returns the override windows that match
//   dayOfWeek === weekday(date)
//   AND date is within [effective_from, effective_until] (inclusive,
//       null bounds treated as open-ended)
// Server-side rollup keeps the client cheap (one fetch per modal open
// instead of one per display).
router.get("/displays/calendar", async (req, res) => {
  try {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    if (!canManageDisplays(staff)) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }
    const schoolId = activeSchoolId(staff);
    const fromDate = String(req.query.fromDate ?? "");
    const days = Math.min(
      Math.max(Number.parseInt(String(req.query.days ?? "28"), 10) || 28, 1),
      56,
    );
    const parsedFrom = parseOptionalDate(fromDate);
    if (!parsedFrom.ok || !parsedFrom.value) {
      res
        .status(400)
        .json({ error: "fromDate must be a real YYYY-MM-DD calendar date" });
      return;
    }
    // Load every display + every override at this school in parallel
    // along with playlist names for both base displays and override
    // targets.
    const [displays, overrides] = await Promise.all([
      db
        .select({
          id: displayPlaylistsTable.id,
          name: displayPlaylistsTable.name,
        })
        .from(displayPlaylistsTable)
        .where(eq(displayPlaylistsTable.schoolId, schoolId))
        .orderBy(asc(displayPlaylistsTable.name)),
      db
        .select()
        .from(displayPlaylistOverridesTable)
        .innerJoin(
          displayPlaylistsTable,
          eq(displayPlaylistOverridesTable.displayId, displayPlaylistsTable.id),
        )
        .where(eq(displayPlaylistsTable.schoolId, schoolId)),
    ]);
    // Override targets are themselves display_playlists at the same
    // school (verifyOverrideTarget enforces that), so we can label
    // each window from the `displays` list we already have.
    const targetNameById = new Map(displays.map((t) => [t.id, t.name] as const));
    const overrideRowsByDisplay = new Map<number, typeof overrides>();
    for (const row of overrides) {
      const did = row.display_playlist_overrides.displayId;
      const list = overrideRowsByDisplay.get(did) ?? [];
      list.push(row);
      overrideRowsByDisplay.set(did, list);
    }
    // Build the (date, display, windows) matrix.
    const [fy, fm, fd] = fromDate.split("-").map((n) => Number.parseInt(n, 10));
    const start = new Date(fy, fm - 1, fd);
    type Window = {
      overrideId: number;
      startTime: string;
      endTime: string;
      playlistName: string;
      groupName: string | null;
      isOneOff: boolean; // effective_from === effective_until
      isBoundedWeek: boolean; // both set, different
    };
    type DayCell = {
      date: string; // YYYY-MM-DD
      dayOfWeek: number;
      displayId: number;
      displayName: string;
      windows: Window[];
    };
    const cells: DayCell[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const dow = d.getDay();
      for (const display of displays) {
        const rows = overrideRowsByDisplay.get(display.id) ?? [];
        const windows: Window[] = [];
        for (const r of rows) {
          const o = r.display_playlist_overrides;
          if (o.dayOfWeek !== dow) continue;
          if (o.effectiveFrom && iso < o.effectiveFrom) continue;
          if (o.effectiveUntil && iso > o.effectiveUntil) continue;
          windows.push({
            overrideId: o.id,
            startTime: o.startTime,
            endTime: o.endTime,
            playlistName: targetNameById.get(o.playlistId) ?? `#${o.playlistId}`,
            groupName: o.groupName,
            isOneOff: !!(
              o.effectiveFrom &&
              o.effectiveUntil &&
              o.effectiveFrom === o.effectiveUntil
            ),
            isBoundedWeek: !!(
              o.effectiveFrom &&
              o.effectiveUntil &&
              o.effectiveFrom !== o.effectiveUntil
            ),
          });
        }
        windows.sort((a, b) => a.startTime.localeCompare(b.startTime));
        cells.push({
          date: iso,
          dayOfWeek: dow,
          displayId: display.id,
          displayName: display.name,
          windows,
        });
      }
    }
    res.json({ fromDate, days, displays, cells });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[display-overrides] calendar failed", e);
    res.status(500).json({ error: "Failed to load calendar" });
  }
});

export default router;
