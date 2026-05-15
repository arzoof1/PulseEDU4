// Digital-signage / "Displays" feature.
//
// Two audiences:
//   - Authenticated admins / core team / display-capable teachers,
//     who CRUD playlists + items.
//   - Smart TVs / hallway kiosks, which open the *public* endpoints
//     with no auth header at all and just want the cycler to work.
//
// Capability gate for editing:
//   isSuperUser || isAdmin || isMtssCoordinator
//   || isBehaviorSpecialist || isDean || capManageDisplays
//
// Visibility for editing:
//   - Core team can see/edit every playlist at their school.
//   - A capability-only teacher can only see/edit playlists they own
//     (owner_staff_id = staff.id).
//
// Public endpoints (`/api/displays/public/...`) are intentionally
// unauthenticated. The media endpoint scopes the auth bypass to
// objects that are referenced by a real `display_playlist_items`
// row — random GCS object IDs still go through the normal
// auth-gated `/api/storage/objects/*` route.

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import {
  db,
  staffTable,
  studentsTable,
  housesTable,
  pbisEntriesTable,
  hallPassesTable,
  displayPlaylistsTable,
  displayPlaylistItemsTable,
  displayPlaylistOverridesTable,
  classSectionsTable,
  sectionRosterTable,
  pickupQueueEventsTable,
} from "@workspace/db";
import { and, eq, gte, sql, desc, asc, inArray } from "drizzle-orm";
import {
  ObjectStorageService,
  ObjectNotFoundError,
} from "../lib/objectStorage.js";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

// ---------- helpers ---------------------------------------------------

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

// MIME → kind. Anything we don't recognize is rejected so the cycler
// never has to guess at render time.
function detectKind(mimeType: string): "image" | "video" | "audio" | "pdf" | null {
  const m = mimeType.toLowerCase();
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  return null;
}

// Lightweight URL validator. We allow http/https only — `file://`
// and other schemes have no place on a hallway TV. We also reject
// localhost / loopback / private-network hostnames so an admin can't
// (accidentally or otherwise) embed an internal admin panel that
// might be reachable from the TV's switch port.
function isValidEmbedUrl(s: string): boolean {
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "0.0.0.0" ||
      host.endsWith(".localhost") ||
      // IPv4 loopback + RFC1918 private ranges
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      // IPv6 loopback / link-local / unique-local
      host === "::1" ||
      host.startsWith("fe80:") ||
      host.startsWith("fc") ||
      host.startsWith("fd")
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Look up a playlist and confirm the caller can edit it. Returns the
// row on success, or null after writing the appropriate error response.
async function loadPlaylistForEdit(
  req: Request,
  res: Response,
  staff: typeof staffTable.$inferSelect,
): Promise<typeof displayPlaylistsTable.$inferSelect | null> {
  const id = Number.parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid playlist id" });
    return null;
  }
  const [pl] = await db
    .select()
    .from(displayPlaylistsTable)
    .where(eq(displayPlaylistsTable.id, id));
  if (!pl || pl.schoolId !== activeSchoolId(staff)) {
    // 404 not 403 — don't leak existence across schools.
    res.status(404).json({ error: "Not found" });
    return null;
  }
  // Capability-only teachers can only touch their own playlists.
  // Core team can touch every playlist at their school.
  if (!isCoreTeamForDisplays(staff) && pl.ownerStaffId !== staff.id) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  return pl;
}

async function bumpUpdatedAt(playlistId: number) {
  await db
    .update(displayPlaylistsTable)
    .set({ updatedAt: new Date() })
    .where(eq(displayPlaylistsTable.id, playlistId));
}

// ---------- GET: list playlists ---------------------------------------

router.get("/displays/playlists", async (req, res) => {
  try {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    if (!canManageDisplays(staff)) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }
    const schoolId = activeSchoolId(staff);

    // Core team sees every playlist at the school. Capability-only
    // teachers only see their own (so a teacher never sees the
    // principal's "Lobby TV" playlist in their own list page).
    const baseQuery = db
      .select({
        id: displayPlaylistsTable.id,
        schoolId: displayPlaylistsTable.schoolId,
        ownerStaffId: displayPlaylistsTable.ownerStaffId,
        ownerDisplayName: staffTable.displayName,
        name: displayPlaylistsTable.name,
        defaultDurationSeconds: displayPlaylistsTable.defaultDurationSeconds,
        showPbisHousePage: displayPlaylistsTable.showPbisHousePage,
        showActiveHallPasses: displayPlaylistsTable.showActiveHallPasses,
        showPickupQueue: displayPlaylistsTable.showPickupQueue,
        showHeartbeat: displayPlaylistsTable.showHeartbeat,
        scheduleEnabled: displayPlaylistsTable.scheduleEnabled,
        scheduleStartTime: displayPlaylistsTable.scheduleStartTime,
        scheduleEndTime: displayPlaylistsTable.scheduleEndTime,
        scheduleDaysOfWeek: displayPlaylistsTable.scheduleDaysOfWeek,
        active: displayPlaylistsTable.active,
        createdAt: displayPlaylistsTable.createdAt,
        updatedAt: displayPlaylistsTable.updatedAt,
        itemCount: sql<number>`(
          SELECT COUNT(*)::int
          FROM ${displayPlaylistItemsTable}
          WHERE ${displayPlaylistItemsTable.playlistId} = ${displayPlaylistsTable.id}
        )`,
      })
      .from(displayPlaylistsTable)
      .leftJoin(
        staffTable,
        eq(staffTable.id, displayPlaylistsTable.ownerStaffId),
      );

    const rows = isCoreTeamForDisplays(staff)
      ? await baseQuery
          .where(eq(displayPlaylistsTable.schoolId, schoolId))
          .orderBy(desc(displayPlaylistsTable.updatedAt))
      : await baseQuery
          .where(
            and(
              eq(displayPlaylistsTable.schoolId, schoolId),
              eq(displayPlaylistsTable.ownerStaffId, staff.id),
            ),
          )
          .orderBy(desc(displayPlaylistsTable.updatedAt));

    res.json({ playlists: rows });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[displays] list failed", e);
    res.status(500).json({ error: "Failed to load playlists" });
  }
});

// ---------- POST: create playlist -------------------------------------

router.post("/displays/playlists", async (req, res) => {
  try {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    if (!canManageDisplays(staff)) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }
    const schoolId = activeSchoolId(staff);

    const name =
      typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 80) : "";
    if (!name) {
      res.status(400).json({ error: "Name is required" });
      return;
    }
    const defaultDuration = Number.parseInt(
      String(req.body?.defaultDurationSeconds ?? 10),
      10,
    );
    const dur =
      Number.isFinite(defaultDuration) && defaultDuration >= 2 && defaultDuration <= 600
        ? defaultDuration
        : 10;
    const showPbis = Boolean(req.body?.showPbisHousePage);

    // Core team can pin a playlist to a specific teacher (or leave it
    // school-level). Capability-only teachers can only create their
    // own — server forces ownerStaffId to their id regardless of body.
    let ownerStaffId: number | null;
    if (isCoreTeamForDisplays(staff)) {
      const raw = req.body?.ownerStaffId;
      if (raw === null || raw === undefined || raw === "") {
        ownerStaffId = null;
      } else {
        const parsed = Number.parseInt(String(raw), 10);
        if (!Number.isFinite(parsed)) {
          res.status(400).json({ error: "Invalid ownerStaffId" });
          return;
        }
        // Confirm the target staff is at the same school + active.
        const [tgt] = await db
          .select({ id: staffTable.id })
          .from(staffTable)
          .where(
            and(
              eq(staffTable.id, parsed),
              eq(staffTable.schoolId, schoolId),
              eq(staffTable.active, true),
            ),
          );
        if (!tgt) {
          res.status(404).json({ error: "Owner not found at this school" });
          return;
        }
        ownerStaffId = parsed;
      }
    } else {
      ownerStaffId = staff.id;
    }

    const [inserted] = await db
      .insert(displayPlaylistsTable)
      .values({
        schoolId,
        ownerStaffId,
        name,
        defaultDurationSeconds: dur,
        showPbisHousePage: showPbis,
      })
      .returning();
    res.status(201).json({ playlist: inserted });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[displays] create failed", e);
    res.status(500).json({ error: "Failed to create playlist" });
  }
});

// ---------- GET: single playlist (with items) ------------------------

router.get("/displays/playlists/:id", async (req, res) => {
  try {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    if (!canManageDisplays(staff)) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }
    const pl = await loadPlaylistForEdit(req, res, staff);
    if (!pl) return;
    const items = await db
      .select()
      .from(displayPlaylistItemsTable)
      .where(eq(displayPlaylistItemsTable.playlistId, pl.id))
      .orderBy(asc(displayPlaylistItemsTable.orderIndex));
    res.json({ playlist: pl, items });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[displays] get failed", e);
    res.status(500).json({ error: "Failed to load playlist" });
  }
});

// ---------- PATCH: edit playlist (incl. reorder via itemOrder) ------

router.patch("/displays/playlists/:id", async (req, res) => {
  try {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    if (!canManageDisplays(staff)) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }
    const pl = await loadPlaylistForEdit(req, res, staff);
    if (!pl) return;

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (req.body?.name !== undefined) {
      const n = typeof req.body.name === "string" ? req.body.name.trim() : "";
      if (!n) {
        res.status(400).json({ error: "Name is required" });
        return;
      }
      update.name = n.slice(0, 80);
    }
    if (req.body?.defaultDurationSeconds !== undefined) {
      const d = Number.parseInt(String(req.body.defaultDurationSeconds), 10);
      if (!Number.isFinite(d) || d < 2 || d > 600) {
        res.status(400).json({
          error: "defaultDurationSeconds must be between 2 and 600",
        });
        return;
      }
      update.defaultDurationSeconds = d;
    }
    if (req.body?.showPbisHousePage !== undefined) {
      update.showPbisHousePage = Boolean(req.body.showPbisHousePage);
    }
    // Manual kill switch — toggling this OFF makes the public cycler
    // serve "off-air" immediately and hides the display from the
    // cross-display calendar. Items and overrides are preserved.
    if (req.body?.active !== undefined) {
      update.active = Boolean(req.body.active);
    }
    if (req.body?.showActiveHallPasses !== undefined) {
      update.showActiveHallPasses = Boolean(req.body.showActiveHallPasses);
    }
    if (req.body?.showPickupQueue !== undefined) {
      update.showPickupQueue = Boolean(req.body.showPickupQueue);
    }
    if (req.body?.showHeartbeat !== undefined) {
      update.showHeartbeat = Boolean(req.body.showHeartbeat);
    }
    if (req.body?.scheduleEnabled !== undefined) {
      update.scheduleEnabled = Boolean(req.body.scheduleEnabled);
    }
    // "HH:MM" 24h. Empty string clears the field. Anything malformed
    // is rejected so the client can surface a validation error.
    if (req.body?.scheduleStartTime !== undefined) {
      const v = req.body.scheduleStartTime;
      if (v === null || v === "") {
        update.scheduleStartTime = null;
      } else if (
        typeof v === "string" &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(v)
      ) {
        update.scheduleStartTime = v;
      } else {
        res.status(400).json({ error: "scheduleStartTime must be HH:MM" });
        return;
      }
    }
    if (req.body?.scheduleEndTime !== undefined) {
      const v = req.body.scheduleEndTime;
      if (v === null || v === "") {
        update.scheduleEndTime = null;
      } else if (
        typeof v === "string" &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(v)
      ) {
        update.scheduleEndTime = v;
      } else {
        res.status(400).json({ error: "scheduleEndTime must be HH:MM" });
        return;
      }
    }
    // CSV of weekday integers, 0-6. We re-canonicalize (sort + dedupe)
    // so persisted values are stable regardless of how the client sent
    // them, but we strictly reject any token that isn't a single 0-6
    // digit — silently dropping garbage tokens like "1x" or "abc" can
    // mask client bugs.
    if (req.body?.scheduleDaysOfWeek !== undefined) {
      const v = req.body.scheduleDaysOfWeek;
      if (v === null || v === "") {
        update.scheduleDaysOfWeek = null;
      } else if (typeof v === "string") {
        // Validate every raw token (after trim). We deliberately do NOT
        // drop empty tokens with `.filter(Boolean)` — strings like
        // "1,,2" or ",1" are malformed and should error rather than
        // silently parse, since silent fixups can mask client bugs.
        const tokens = v.split(",").map((s) => s.trim());
        for (const t of tokens) {
          if (!/^[0-6]$/.test(t)) {
            res.status(400).json({
              error:
                "scheduleDaysOfWeek must be CSV of 0-6 weekday integers",
            });
            return;
          }
        }
        const days = Array.from(new Set(tokens.map((t) => Number(t)))).sort(
          (a, b) => a - b,
        );
        update.scheduleDaysOfWeek = days.length ? days.join(",") : null;
      } else {
        res.status(400).json({
          error: "scheduleDaysOfWeek must be CSV of 0-6 weekday integers",
        });
        return;
      }
    }

    // Optional: itemOrder is an array of item IDs in their new order.
    // We renumber inside a transaction so the public cycler never
    // observes a half-renumbered state.
    const itemOrder: unknown = req.body?.itemOrder;
    if (Array.isArray(itemOrder)) {
      const ids = itemOrder
        .map((x) => Number.parseInt(String(x), 10))
        .filter((n) => Number.isFinite(n));
      await db.transaction(async (tx) => {
        // Confirm every id belongs to this playlist; reject otherwise
        // so a client bug can't shuffle in foreign rows.
        const owned = await tx
          .select({ id: displayPlaylistItemsTable.id })
          .from(displayPlaylistItemsTable)
          .where(eq(displayPlaylistItemsTable.playlistId, pl.id));
        const ownedSet = new Set(owned.map((r) => r.id));
        for (const id of ids) {
          if (!ownedSet.has(id)) {
            throw new Error(`Item ${id} not in playlist`);
          }
        }
        for (let i = 0; i < ids.length; i++) {
          await tx
            .update(displayPlaylistItemsTable)
            .set({ orderIndex: i + 1 })
            .where(eq(displayPlaylistItemsTable.id, ids[i]));
        }
      });
    }

    const [updated] = await db
      .update(displayPlaylistsTable)
      .set(update)
      .where(eq(displayPlaylistsTable.id, pl.id))
      .returning();
    res.json({ playlist: updated });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[displays] patch failed", e);
    res.status(500).json({ error: "Failed to update playlist" });
  }
});

// ---------- DELETE: playlist ------------------------------------------

router.delete("/displays/playlists/:id", async (req, res) => {
  try {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    if (!canManageDisplays(staff)) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }
    const pl = await loadPlaylistForEdit(req, res, staff);
    if (!pl) return;
    // Items go with it via ON DELETE CASCADE on the FK.
    await db
      .delete(displayPlaylistsTable)
      .where(eq(displayPlaylistsTable.id, pl.id));
    res.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[displays] delete failed", e);
    res.status(500).json({ error: "Failed to delete playlist" });
  }
});

// ---------- POST: add item to playlist --------------------------------

router.post("/displays/playlists/:id/items", async (req, res) => {
  try {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    if (!canManageDisplays(staff)) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }
    const pl = await loadPlaylistForEdit(req, res, staff);
    if (!pl) return;

    // Two payload shapes:
    //   - upload  → { objectPath, originalFilename, mimeType, sizeBytes }
    //   - url     → { kind: "url", url, originalFilename? }
    // We branch up front so callers don't have to provide unused fields.
    const isUrl =
      req.body?.kind === "url" || typeof req.body?.url === "string";

    let durationSeconds: number | null = null;
    if (req.body?.durationSeconds !== undefined && req.body.durationSeconds !== null) {
      const d = Number.parseInt(String(req.body.durationSeconds), 10);
      if (!Number.isFinite(d) || d < 2 || d > 600) {
        res.status(400).json({
          error: "durationSeconds must be between 2 and 600",
        });
        return;
      }
      durationSeconds = d;
    }

    // Append to the end. We renumber on reorder so a max+1 here is
    // safe even if there are gaps from prior deletes.
    const [{ maxIdx } = { maxIdx: 0 }] = await db
      .select({
        maxIdx: sql<number>`COALESCE(MAX(${displayPlaylistItemsTable.orderIndex}), 0)::int`,
      })
      .from(displayPlaylistItemsTable)
      .where(eq(displayPlaylistItemsTable.playlistId, pl.id));

    let inserted;
    if (isUrl) {
      const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
      if (!isValidEmbedUrl(url)) {
        res.status(400).json({ error: "url must be a valid http(s) URL" });
        return;
      }
      const label =
        typeof req.body?.originalFilename === "string" && req.body.originalFilename.trim()
          ? req.body.originalFilename.trim().slice(0, 200)
          : url.slice(0, 200);
      [inserted] = await db
        .insert(displayPlaylistItemsTable)
        .values({
          playlistId: pl.id,
          orderIndex: maxIdx + 1,
          kind: "url",
          objectPath: null,
          originalFilename: label,
          mimeType: "text/url",
          sizeBytes: 0,
          url,
          durationSeconds,
          enabled: true,
        })
        .returning();
    } else {
      const objectPath =
        typeof req.body?.objectPath === "string" ? req.body.objectPath : "";
      const originalFilename =
        typeof req.body?.originalFilename === "string"
          ? req.body.originalFilename.slice(0, 200)
          : "";
      const mimeType =
        typeof req.body?.mimeType === "string" ? req.body.mimeType : "";
      const sizeBytesRaw = Number.parseInt(String(req.body?.sizeBytes ?? 0), 10);
      const sizeBytes = Number.isFinite(sizeBytesRaw) && sizeBytesRaw > 0 ? sizeBytesRaw : 0;
      if (!objectPath.startsWith("/objects/") || !mimeType || !originalFilename) {
        res.status(400).json({
          error: "objectPath, mimeType, and originalFilename are required",
        });
        return;
      }
      const kind = detectKind(mimeType);
      if (!kind) {
        res.status(400).json({
          error: `Unsupported file type: ${mimeType}. Allowed: PNG/JPG, MP4, WAV/MP3, PDF.`,
        });
        return;
      }
      [inserted] = await db
        .insert(displayPlaylistItemsTable)
        .values({
          playlistId: pl.id,
          orderIndex: maxIdx + 1,
          kind,
          objectPath,
          originalFilename,
          mimeType,
          sizeBytes,
          durationSeconds,
          enabled: true,
        })
        .returning();
    }
    await bumpUpdatedAt(pl.id);
    res.status(201).json({ item: inserted });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[displays] add item failed", e);
    res.status(500).json({ error: "Failed to add item" });
  }
});

// ---------- PATCH: edit item ------------------------------------------

router.patch("/displays/playlists/:id/items/:itemId", async (req, res) => {
  try {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    if (!canManageDisplays(staff)) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }
    const pl = await loadPlaylistForEdit(req, res, staff);
    if (!pl) return;
    const itemId = Number.parseInt(req.params.itemId, 10);
    if (!Number.isFinite(itemId)) {
      res.status(400).json({ error: "Invalid item id" });
      return;
    }

    const [item] = await db
      .select()
      .from(displayPlaylistItemsTable)
      .where(eq(displayPlaylistItemsTable.id, itemId));
    if (!item || item.playlistId !== pl.id) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const update: Record<string, unknown> = {};
    if (req.body?.durationSeconds !== undefined) {
      if (req.body.durationSeconds === null || req.body.durationSeconds === "") {
        update.durationSeconds = null;
      } else {
        const d = Number.parseInt(String(req.body.durationSeconds), 10);
        if (!Number.isFinite(d) || d < 2 || d > 600) {
          res.status(400).json({
            error: "durationSeconds must be between 2 and 600",
          });
          return;
        }
        update.durationSeconds = d;
      }
    }
    if (req.body?.enabled !== undefined) {
      update.enabled = Boolean(req.body.enabled);
    }

    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    const [updated] = await db
      .update(displayPlaylistItemsTable)
      .set(update)
      .where(eq(displayPlaylistItemsTable.id, itemId))
      .returning();
    await bumpUpdatedAt(pl.id);
    res.json({ item: updated });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[displays] patch item failed", e);
    res.status(500).json({ error: "Failed to update item" });
  }
});

// ---------- DELETE: item ----------------------------------------------

router.delete("/displays/playlists/:id/items/:itemId", async (req, res) => {
  try {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    if (!canManageDisplays(staff)) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }
    const pl = await loadPlaylistForEdit(req, res, staff);
    if (!pl) return;
    const itemId = Number.parseInt(req.params.itemId, 10);
    if (!Number.isFinite(itemId)) {
      res.status(400).json({ error: "Invalid item id" });
      return;
    }
    const [item] = await db
      .select()
      .from(displayPlaylistItemsTable)
      .where(eq(displayPlaylistItemsTable.id, itemId));
    if (!item || item.playlistId !== pl.id) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await db
      .delete(displayPlaylistItemsTable)
      .where(eq(displayPlaylistItemsTable.id, itemId));
    await bumpUpdatedAt(pl.id);
    res.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[displays] delete item failed", e);
    res.status(500).json({ error: "Failed to delete item" });
  }
});

// ---------- helpers: active hall passes (public-safe shape) ----------

// Fetch active hall passes for a school, joined to student first/last so the
// signage screen can render a friendly "Ada R. → Office" line. Sanitized:
// no district student id, no teacher email, no notes — only fields the
// front-of-school TV is OK to show. Computes `minutesOpen` server-side so
// the cycler doesn't need a synced clock with the database.
// Pickup queue, optionally filtered to one teacher's class roster.
// Mirrors the derivation in /api/pickup/queue (today's append-only
// event log, terminal events remove the student) but joins through
// section_roster so a classroom-mounted TV only shows that teacher's
// students. When ownerStaffId is null (commons display) the school-
// wide queue is returned. Public endpoint — no PII (first name + last
// initial only, same convention as the hall-passes slide).
async function loadPickupQueueForOwner(
  schoolId: number,
  ownerStaffId: number | null,
) {
  // School-local "today" boundary, matching the pickup route helper.
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
    0,
  );

  const events = await db
    .select({
      studentId: pickupQueueEventsTable.studentId,
      action: pickupQueueEventsTable.action,
      occurredAt: pickupQueueEventsTable.occurredAt,
    })
    .from(pickupQueueEventsTable)
    .where(
      and(
        eq(pickupQueueEventsTable.schoolId, schoolId),
        gte(pickupQueueEventsTable.occurredAt, startOfToday),
      ),
    )
    .orderBy(asc(pickupQueueEventsTable.occurredAt));

  const TERMINAL = new Set(["in_car", "auto_cleared", "walker_released"]);
  type Entry = {
    studentId: number;
    addedAt: Date;
    status: "in_queue" | "walking_out";
  };
  const byStudent = new Map<number, Entry>();
  for (const e of events) {
    if (TERMINAL.has(e.action)) {
      byStudent.delete(e.studentId);
      continue;
    }
    if (e.action === "added") {
      byStudent.set(e.studentId, {
        studentId: e.studentId,
        addedAt: e.occurredAt,
        status: "in_queue",
      });
    } else if (e.action === "released_to_walk") {
      const ex = byStudent.get(e.studentId);
      if (ex) ex.status = "walking_out";
    }
  }

  let entries = Array.from(byStudent.values()).sort(
    (a, b) => a.addedAt.getTime() - b.addedAt.getTime(),
  );

  // Owner-roster filter. section_roster.studentId is the TEXT district
  // code, not the integer PK, so we have to join through students to
  // translate. Returns the set of student integer PKs the owner teaches
  // across all of their non-planning sections.
  if (ownerStaffId !== null && entries.length > 0) {
    const rosterRows = await db
      .select({ id: studentsTable.id })
      .from(classSectionsTable)
      .innerJoin(
        sectionRosterTable,
        eq(sectionRosterTable.sectionId, classSectionsTable.id),
      )
      .innerJoin(
        studentsTable,
        and(
          eq(studentsTable.studentId, sectionRosterTable.studentId),
          eq(studentsTable.schoolId, classSectionsTable.schoolId),
        ),
      )
      .where(
        and(
          eq(classSectionsTable.schoolId, schoolId),
          eq(classSectionsTable.teacherStaffId, ownerStaffId),
          eq(classSectionsTable.isPlanning, false),
        ),
      );
    const allowed = new Set(rosterRows.map((r) => r.id));
    entries = entries.filter((e) => allowed.has(e.studentId));
  }

  // Hydrate names + grade for the surviving set.
  const ids = entries.map((e) => e.studentId);
  let nameById = new Map<
    number,
    { firstName: string; lastName: string; grade: number }
  >();
  if (ids.length > 0) {
    const rows = await db
      .select({
        id: studentsTable.id,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          inArray(studentsTable.id, ids),
        ),
      );
    nameById = new Map(
      rows.map((r) => [
        r.id,
        { firstName: r.firstName, lastName: r.lastName, grade: r.grade },
      ]),
    );
  }

  const queue = entries.map((e, idx) => {
    const s = nameById.get(e.studentId);
    const firstName = s?.firstName ?? "Student";
    const lastInitial = s?.lastName ? `${s.lastName.charAt(0)}.` : "";
    return {
      position: idx + 1,
      studentLabel: lastInitial ? `${firstName} ${lastInitial}` : firstName,
      grade: s?.grade ?? null,
      addedAt: e.addedAt.toISOString(),
      status: e.status,
    };
  });

  return {
    queue,
    ownerFiltered: ownerStaffId !== null,
    generatedAt: new Date().toISOString(),
  };
}

async function loadActiveHallPasses(schoolId: number) {
  const rows = await db
    .select({
      id: hallPassesTable.id,
      studentId: hallPassesTable.studentId,
      destination: hallPassesTable.destination,
      originRoom: hallPassesTable.originRoom,
      maxDurationMinutes: hallPassesTable.maxDurationMinutes,
      createdAt: hallPassesTable.createdAt,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
    })
    .from(hallPassesTable)
    .leftJoin(
      studentsTable,
      and(
        eq(studentsTable.studentId, hallPassesTable.studentId),
        eq(studentsTable.schoolId, hallPassesTable.schoolId),
      ),
    )
    .where(
      and(
        eq(hallPassesTable.schoolId, schoolId),
        eq(hallPassesTable.status, "active"),
      ),
    )
    .orderBy(desc(hallPassesTable.createdAt));

  const now = Date.now();
  const passes = rows.map((r) => {
    const startedMs = Date.parse(r.createdAt);
    const minutesOpen = Number.isFinite(startedMs)
      ? Math.max(0, Math.round((now - startedMs) / 60_000))
      : 0;
    // First name + last initial. If we don't have a join row (rare —
    // student record deleted but pass kept), fall back to a generic
    // label so we never expose a raw district id on a hallway TV.
    const firstName = r.firstName ?? "Student";
    const lastInitial = r.lastName ? `${r.lastName.charAt(0)}.` : "";
    return {
      id: r.id,
      studentLabel: lastInitial ? `${firstName} ${lastInitial}` : firstName,
      destination: r.destination,
      originRoom: r.originRoom,
      maxDurationMinutes: r.maxDurationMinutes,
      minutesOpen,
      isOverdue: minutesOpen > r.maxDurationMinutes,
    };
  });
  return { passes, generatedAt: new Date().toISOString() };
}

// ---------- PUBLIC endpoints (no auth) --------------------------------

// Returns playlist + enabled items, with `mediaUrl` rewritten to the
// public media route below. `houseData` is hydrated only when the
// playlist has the toggle on, so we don't pay for the joins on every
// poll for playlists that don't need it.
router.get("/displays/public/playlists/:id", async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [pl] = await db
      .select()
      .from(displayPlaylistsTable)
      .where(eq(displayPlaylistsTable.id, id));
    if (!pl) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    // Manual kill switch — return a minimal off-air payload (no items,
    // no synthetic slides, no media) so the cycler renders its own
    // "Off-air" card. We still 200 so the TV doesn't break its poll.
    if (!pl.active) {
      res.json({
        playlist: {
          id: pl.id,
          name: pl.name,
          defaultDurationSeconds: pl.defaultDurationSeconds,
          showPbisHousePage: false,
          showActiveHallPasses: false,
          showPickupQueue: false,
          showHeartbeat: false,
          scheduleEnabled: false,
          scheduleStartTime: null,
          scheduleEndTime: null,
          scheduleDaysOfWeek: null,
          updatedAt: pl.updatedAt,
          active: false,
        },
        items: [],
        overrides: [],
        houseData: null,
        pickupQueueData: null,
      });
      return;
    }
    const items = await db
      .select({
        id: displayPlaylistItemsTable.id,
        kind: displayPlaylistItemsTable.kind,
        mimeType: displayPlaylistItemsTable.mimeType,
        durationSeconds: displayPlaylistItemsTable.durationSeconds,
        orderIndex: displayPlaylistItemsTable.orderIndex,
        url: displayPlaylistItemsTable.url,
      })
      .from(displayPlaylistItemsTable)
      .where(
        and(
          eq(displayPlaylistItemsTable.playlistId, pl.id),
          eq(displayPlaylistItemsTable.enabled, true),
        ),
      )
      .orderBy(asc(displayPlaylistItemsTable.orderIndex));

    let houseData: unknown = null;
    if (pl.showPbisHousePage) {
      // House totals: sum of points per house this school year.
      // We approximate "this school year" as the current academic
      // year window the rest of the app uses (Aug 1 → Jul 31).
      const now = new Date();
      // pbis_entries.created_at is stored as ISO text (not a timestamp
      // column), so we compare lexically against an ISO string. Aug 1
      // → Jul 31 academic year window.
      const yearStartIso = (
        now.getUTCMonth() >= 7
          ? new Date(Date.UTC(now.getUTCFullYear(), 7, 1))
          : new Date(Date.UTC(now.getUTCFullYear() - 1, 7, 1))
      ).toISOString();

      // Two separate queries (cheaper and dodges drizzle's
      // unqualified-column rendering in correlated subqueries):
      //   1. all houses for this school
      //   2. point totals grouped by house_id
      // Then we merge in JS.
      const housesRows = await db
        .select({
          id: housesTable.id,
          name: housesTable.name,
          color: housesTable.color,
          motto: housesTable.motto,
        })
        .from(housesTable)
        .where(eq(housesTable.schoolId, pl.schoolId))
        .orderBy(housesTable.name);

      const totalsRows = await db.execute<{
        house_id: number;
        total_points: number;
      }>(sql`
        SELECT s.house_id AS house_id,
               SUM(pe.points)::int AS total_points
        FROM pbis_entries pe
        INNER JOIN students s
          ON s.student_id = pe.student_id
          AND s.school_id = pe.school_id
        WHERE pe.school_id = ${pl.schoolId}
          AND s.house_id IS NOT NULL
          AND pe.created_at >= ${yearStartIso}
        GROUP BY s.house_id
      `);

      const totalByHouseId = new Map<number, number>();
      for (const r of totalsRows.rows) {
        totalByHouseId.set(r.house_id, r.total_points);
      }
      const houses = housesRows.map((h) => ({
        ...h,
        totalPoints: totalByHouseId.get(h.id) ?? 0,
      }));

      // Recent pop recognitions: last 10 PBIS entries with notes.
      const recent = await db
        .select({
          id: pbisEntriesTable.id,
          studentId: pbisEntriesTable.studentId,
          firstName: studentsTable.firstName,
          lastName: studentsTable.lastName,
          points: pbisEntriesTable.points,
          note: pbisEntriesTable.note,
          createdAt: pbisEntriesTable.createdAt,
          houseName: housesTable.name,
          houseColor: housesTable.color,
        })
        .from(pbisEntriesTable)
        .innerJoin(
          studentsTable,
          and(
            eq(studentsTable.studentId, pbisEntriesTable.studentId),
            eq(studentsTable.schoolId, pbisEntriesTable.schoolId),
          ),
        )
        .leftJoin(housesTable, eq(housesTable.id, studentsTable.houseId))
        .where(eq(pbisEntriesTable.schoolId, pl.schoolId))
        .orderBy(desc(pbisEntriesTable.createdAt))
        .limit(10);

      houseData = { houses, recent };
    }

    // Active hall passes (v2 toggle). Same shape as the standalone
    // /api/displays/public/passes/:schoolId endpoint below — kept in
    // sync intentionally so the cycler can render either one.
    let hallPassData: unknown = null;
    if (pl.showActiveHallPasses) {
      hallPassData = await loadActiveHallPasses(pl.schoolId);
    }

    // Pickup queue (v2 toggle). Filtered to the playlist owner's
    // class roster so a classroom-mounted TV only shows that
    // teacher's students. When the playlist has no owner (e.g. a
    // commons display), the toggle still works but renders the
    // school-wide queue.
    let pickupQueueData: unknown = null;
    if (pl.showPickupQueue) {
      pickupQueueData = await loadPickupQueueForOwner(
        pl.schoolId,
        pl.ownerStaffId,
      );
    }

    // Per-display schedule overrides. Each override row points at ANOTHER
    // playlist whose items get cycled in place of the base loop during a
    // (dayOfWeek, startTime, endTime) window. We pre-resolve the items
    // here so the public TV doesn't need to do N+1 fetches.
    const overrideRows = await db
      .select()
      .from(displayPlaylistOverridesTable)
      .where(eq(displayPlaylistOverridesTable.displayId, pl.id))
      .orderBy(
        asc(displayPlaylistOverridesTable.dayOfWeek),
        asc(displayPlaylistOverridesTable.startTime),
      );

    const overrideTargetIds = Array.from(
      new Set(overrideRows.map((o) => o.playlistId)),
    );
    const overrideItemsByPlaylistId = new Map<
      number,
      Array<{
        id: number;
        kind: "image" | "video" | "audio" | "pdf" | "url";
        mimeType: string | null;
        durationSeconds: number | null;
        orderIndex: number;
        mediaUrl: string;
        url: string | null;
      }>
    >();
    if (overrideTargetIds.length > 0) {
      const allOverrideItems = (await db
        .select({
          id: displayPlaylistItemsTable.id,
          playlistId: displayPlaylistItemsTable.playlistId,
          kind: displayPlaylistItemsTable.kind,
          mimeType: displayPlaylistItemsTable.mimeType,
          durationSeconds: displayPlaylistItemsTable.durationSeconds,
          orderIndex: displayPlaylistItemsTable.orderIndex,
          url: displayPlaylistItemsTable.url,
        })
        .from(displayPlaylistItemsTable)
        .where(
          and(
            inArray(displayPlaylistItemsTable.playlistId, overrideTargetIds),
            eq(displayPlaylistItemsTable.enabled, true),
          ),
        )
        .orderBy(asc(displayPlaylistItemsTable.orderIndex))) as Array<{
          id: number;
          playlistId: number;
          kind: "image" | "video" | "audio" | "pdf" | "url";
          mimeType: string | null;
          durationSeconds: number | null;
          orderIndex: number;
          url: string | null;
        }>;
      for (const it of allOverrideItems) {
        let bucket = overrideItemsByPlaylistId.get(it.playlistId);
        if (!bucket) {
          bucket = [];
          overrideItemsByPlaylistId.set(it.playlistId, bucket);
        }
        bucket.push({
          id: it.id,
          kind: it.kind,
          mimeType: it.mimeType,
          durationSeconds: it.durationSeconds,
          orderIndex: it.orderIndex,
          mediaUrl: `/api/displays/public/media/${it.id}`,
          url: it.url,
        });
      }
    }

    res.json({
      playlist: {
        id: pl.id,
        // schoolId is needed by the cycler so it can build the
        // ?schoolId=N URL for the embedded Heartbeat slide. (No PII —
        // schoolId is a public number already used in other signage
        // URLs.)
        schoolId: pl.schoolId,
        name: pl.name,
        defaultDurationSeconds: pl.defaultDurationSeconds,
        showPbisHousePage: pl.showPbisHousePage,
        showActiveHallPasses: pl.showActiveHallPasses,
        showPickupQueue: pl.showPickupQueue,
        showHeartbeat: pl.showHeartbeat,
        scheduleEnabled: pl.scheduleEnabled,
        scheduleStartTime: pl.scheduleStartTime,
        scheduleEndTime: pl.scheduleEndTime,
        scheduleDaysOfWeek: pl.scheduleDaysOfWeek,
      },
      items: items.map((it) => ({
        id: it.id,
        kind: it.kind,
        mimeType: it.mimeType,
        durationSeconds: it.durationSeconds,
        orderIndex: it.orderIndex,
        // Always serve via the public media endpoint, never the
        // raw `/api/storage/objects/*` path (that one is auth-gated).
        mediaUrl: `/api/displays/public/media/${it.id}`,
        // For kind=url items the cycler embeds this directly; null
        // for uploaded media.
        url: it.url,
      })),
      overrides: overrideRows.map((o) => ({
        id: o.id,
        playlistId: o.playlistId,
        dayOfWeek: o.dayOfWeek,
        startTime: o.startTime,
        endTime: o.endTime,
        // Date-range gating. Both null = the override recurs every
        // matching dayOfWeek forever. The cycler must drop a row whose
        // bounds don't include "today" (in school-local time).
        effectiveFrom: o.effectiveFrom,
        effectiveUntil: o.effectiveUntil,
        items: overrideItemsByPlaylistId.get(o.playlistId) ?? [],
      })),
      houseData,
      hallPassData,
      pickupQueueData,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[displays] public playlist failed", e);
    res.status(500).json({ error: "Failed to load playlist" });
  }
});

// Public active hall passes for a school. Designed to be embedded in
// signage (iframe) OR opened directly on a hallway TV. No auth — only
// returns the sanitized shape from `loadActiveHallPasses` (no district
// student id, no teacher email, no notes). schoolId is required as a
// path param so we can never accidentally aggregate across the district.
router.get("/displays/public/passes/:schoolId", async (req, res) => {
  try {
    const schoolId = Number.parseInt(req.params.schoolId, 10);
    if (!Number.isFinite(schoolId)) {
      res.status(400).json({ error: "Invalid school id" });
      return;
    }
    const data = await loadActiveHallPasses(schoolId);
    // Short cache to keep TVs near-realtime without hammering the DB.
    res.setHeader("Cache-Control", "public, max-age=10");
    res.json(data);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[displays] public passes failed", e);
    res.status(500).json({ error: "Failed to load active passes" });
  }
});

// Public media stream. The auth bypass is narrowly scoped: we look
// up the item by id, then stream the GCS object it points at. A
// random object id (not in any playlist) still has to go through the
// auth-gated `/api/storage/objects/*` route.
router.get("/displays/public/media/:itemId", async (req, res) => {
  try {
    const itemId = Number.parseInt(req.params.itemId, 10);
    if (!Number.isFinite(itemId)) {
      res.status(400).json({ error: "Invalid item id" });
      return;
    }
    const [item] = await db
      .select({
        kind: displayPlaylistItemsTable.kind,
        objectPath: displayPlaylistItemsTable.objectPath,
        mimeType: displayPlaylistItemsTable.mimeType,
      })
      .from(displayPlaylistItemsTable)
      .where(eq(displayPlaylistItemsTable.id, itemId));
    if (!item) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    // url-kind items have no backing object — the cycler embeds the
    // page directly via iframe, so this endpoint should never be hit
    // for them. Return 404 instead of crashing on a null object_path.
    if (item.kind === "url" || !item.objectPath) {
      res.status(404).json({ error: "No media for this item" });
      return;
    }
    try {
      const file = await objectStorageService.getObjectEntityFile(item.objectPath);
      // 1 hour cache — playlists rarely change individual files in
      // place, and the cycler reloads the playlist meta every minute
      // anyway so a new item shows up there.
      const downloaded = await objectStorageService.downloadObject(file, 3600);
      const r = downloaded as unknown as globalThis.Response;
      r.headers.forEach((value, key) => res.setHeader(key, value));
      // Force the right content type even if GCS metadata is stale,
      // so smart TVs that sniff by MIME pick the correct decoder.
      if (item.mimeType) res.setHeader("Content-Type", item.mimeType);
      if (!r.body) {
        res.end();
        return;
      }
      const reader = r.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) res.write(value);
      }
      res.end();
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "Media not found" });
        return;
      }
      throw err;
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[displays] public media failed", e);
    res.status(500).json({ error: "Failed to load media" });
  }
});

export default router;
