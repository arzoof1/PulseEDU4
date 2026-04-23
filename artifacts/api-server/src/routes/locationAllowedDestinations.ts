import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  locationAllowedDestinationsTable,
  locationsTable,
  staffTable,
} from "@workspace/db";
import { alias } from "drizzle-orm/pg-core";
import { and, eq } from "drizzle-orm";
import { verifyAuthToken } from "../lib/authToken.js";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
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

function requireAdminOrSuper() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!staff.isAdmin && !staff.isSuperUser) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    next();
  };
}

router.get("/location-allowed-destinations", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const origin = alias(locationsTable, "origin_loc");
  const dest = alias(locationsTable, "dest_loc");

  // Defense-in-depth: also constrain both joined locations to this school
  // so a stale pairing pointing at another school's location id can't bleed
  // a name through. The pairing table is already school-scoped.
  const rows = await db
    .select({
      id: locationAllowedDestinationsTable.id,
      originLocationId: locationAllowedDestinationsTable.originLocationId,
      destinationLocationId:
        locationAllowedDestinationsTable.destinationLocationId,
      originName: origin.name,
      destinationName: dest.name,
      originActive: origin.active,
      destinationActive: dest.active,
      originIsOrigin: origin.isOrigin,
      destinationIsDestination: dest.isDestination,
    })
    .from(locationAllowedDestinationsTable)
    .innerJoin(
      origin,
      and(
        eq(origin.id, locationAllowedDestinationsTable.originLocationId),
        eq(origin.schoolId, schoolId),
      ),
    )
    .innerJoin(
      dest,
      and(
        eq(dest.id, locationAllowedDestinationsTable.destinationLocationId),
        eq(dest.schoolId, schoolId),
      ),
    )
    .where(eq(locationAllowedDestinationsTable.schoolId, schoolId));

  // Hide pairs where either side has been deactivated, or where the origin is
  // no longer flagged as an origin / the destination as a destination.
  // Existing passes/tardies tied to those names stay intact in their own
  // tables — we just don't offer the location in pickers anymore.
  const visible = rows.filter(
    (r) =>
      r.originActive &&
      r.destinationActive &&
      r.originIsOrigin &&
      r.destinationIsDestination,
  );

  visible.sort((a, b) => {
    const o = a.originName.localeCompare(b.originName);
    if (o !== 0) return o;
    return a.destinationName.localeCompare(b.destinationName);
  });

  res.json(
    visible.map((r) => ({
      id: r.id,
      originLocationId: r.originLocationId,
      destinationLocationId: r.destinationLocationId,
      originName: r.originName,
      destinationName: r.destinationName,
    })),
  );
});

router.post(
  "/location-allowed-destinations",
  requireAdminOrSuper(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const originId = Number(b.originLocationId);
    const destId = Number(b.destinationLocationId);
    if (!Number.isInteger(originId) || originId <= 0) {
      res.status(400).json({ error: "originLocationId is required" });
      return;
    }
    if (!Number.isInteger(destId) || destId <= 0) {
      res.status(400).json({ error: "destinationLocationId is required" });
      return;
    }
    if (originId === destId) {
      res
        .status(400)
        .json({ error: "Origin and destination must differ." });
      return;
    }
    // Both endpoints must belong to this school.
    const ends = await db
      .select({ id: locationsTable.id })
      .from(locationsTable)
      .where(
        and(
          eq(locationsTable.schoolId, schoolId),
        ),
      );
    const okIds = new Set(ends.map((r) => r.id));
    if (!okIds.has(originId) || !okIds.has(destId)) {
      res
        .status(400)
        .json({ error: "Origin and destination must belong to this school." });
      return;
    }
    try {
      const [row] = await db
        .insert(locationAllowedDestinationsTable)
        .values({
          schoolId,
          originLocationId: originId,
          destinationLocationId: destId,
        })
        .returning();
      res.status(201).json(row);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to add pairing";
      if (msg.toLowerCase().includes("unique")) {
        res.status(409).json({ error: "That pairing already exists." });
        return;
      }
      res.status(500).json({ error: msg });
    }
  },
);

router.delete(
  "/location-allowed-destinations/:id",
  requireAdminOrSuper(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const result = await db
      .delete(locationAllowedDestinationsTable)
      .where(
        and(
          eq(locationAllowedDestinationsTable.id, id),
          eq(locationAllowedDestinationsTable.schoolId, schoolId),
        ),
      )
      .returning();
    if (result.length === 0) {
      res.status(404).json({ error: "Pairing not found" });
      return;
    }
    res.status(204).end();
  },
);

// Convenience: clear all pairings for a given origin (used by the admin UI
// when bulk-replacing the destination set).
router.delete(
  "/location-allowed-destinations/by-origin/:originId",
  requireAdminOrSuper(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = Number(req.params.originId);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    await db
      .delete(locationAllowedDestinationsTable)
      .where(
        and(
          eq(locationAllowedDestinationsTable.originLocationId, id),
          eq(locationAllowedDestinationsTable.schoolId, schoolId),
        ),
      );
    res.status(204).end();
  },
);

// Silence unused-import warning for `and` in some lints.
void and;

export default router;
