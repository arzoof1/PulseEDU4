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

function validateOverrideInput(body: unknown): {
  ok: true;
  value: {
    playlistId: number;
    dayOfWeek: number;
    startTime: string;
    endTime: string;
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
  return { ok: true, value: { playlistId, dayOfWeek, startTime, endTime } };
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
    const list = (req.body as { overrides?: unknown[] })?.overrides;
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
    const inserted = await db
      .insert(displayPlaylistOverridesTable)
      .values(
        validated.map((v) => ({
          displayId: pl.id,
          playlistId: v.playlistId,
          dayOfWeek: v.dayOfWeek,
          startTime: v.startTime,
          endTime: v.endTime,
        })),
      )
      .returning();
    res.status(201).json({ overrides: inserted });
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

export default router;
