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
  locationAllowedDestinationsTable,
  schoolSettingsTable,
  staffTable,
  teacherRestroomOverridesTable,
} from "@workspace/db";
import { alias } from "drizzle-orm/pg-core";
import { and, eq, inArray } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

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

// All active restroom-kind, destination-flagged locations for a school.
async function loadRestrooms(schoolId: number) {
  const rows = await db
    .select({ id: locationsTable.id, name: locationsTable.name })
    .from(locationsTable)
    .where(
      and(
        eq(locationsTable.schoolId, schoolId),
        eq(locationsTable.kind, "restroom"),
      ),
    );
  return rows;
}

// GET /restroom-access — everything the Create Pass modal + the admin
// editor need: the on/off flag, the restroom universe, per-room defaults
// (restroom rows of location_allowed_destinations), and per-teacher
// overrides. Signed-in staff may read so the modal can resolve the
// allowed restroom set reactively as origin room / teacher changes.
router.get("/restroom-access", requireSignedIn(), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const [settings] = await db
    .select({ enabled: schoolSettingsTable.restroomAccessControlEnabled })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  const enabled = Boolean(settings?.enabled);

  const restrooms = await loadRestrooms(schoolId);
  const restroomIdSet = new Set(restrooms.map((r) => r.id));
  const restroomNames = restrooms
    .map((r) => r.name)
    .sort((a, b) => a.localeCompare(b));

  // Per-room restroom defaults — restroom-kind rows of
  // location_allowed_destinations, constrained to active/flagged
  // endpoints so a deactivated restroom doesn't leak into the picker.
  const origin = alias(locationsTable, "origin_loc");
  const dest = alias(locationsTable, "dest_loc");
  const pairRows = await db
    .select({
      originName: origin.name,
      destinationName: dest.name,
      originActive: origin.active,
      originIsOrigin: origin.isOrigin,
      destActive: dest.active,
      destKind: dest.kind,
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

  const roomDefaults: Record<string, string[]> = {};
  for (const r of pairRows) {
    if (r.destKind !== "restroom") continue;
    if (!r.originActive || !r.originIsOrigin || !r.destActive) continue;
    if (!roomDefaults[r.originName]) roomDefaults[r.originName] = [];
    roomDefaults[r.originName].push(r.destinationName);
  }
  for (const k of Object.keys(roomDefaults)) {
    roomDefaults[k].sort((a, b) => a.localeCompare(b));
  }

  // Per-teacher overrides — only surface rows that still point at an
  // active restroom-kind location.
  const overrideRows = await db
    .select({
      staffName: teacherRestroomOverridesTable.staffName,
      restroomLocationId: teacherRestroomOverridesTable.restroomLocationId,
      restroomName: locationsTable.name,
      restroomActive: locationsTable.active,
    })
    .from(teacherRestroomOverridesTable)
    .innerJoin(
      locationsTable,
      and(
        eq(
          locationsTable.id,
          teacherRestroomOverridesTable.restroomLocationId,
        ),
        eq(locationsTable.schoolId, schoolId),
      ),
    )
    .where(eq(teacherRestroomOverridesTable.schoolId, schoolId));

  const teacherOverrides: Record<string, string[]> = {};
  for (const r of overrideRows) {
    if (!restroomIdSet.has(r.restroomLocationId)) continue;
    if (!r.restroomActive) continue;
    if (!teacherOverrides[r.staffName]) teacherOverrides[r.staffName] = [];
    teacherOverrides[r.staffName].push(r.restroomName);
  }
  for (const k of Object.keys(teacherOverrides)) {
    teacherOverrides[k].sort((a, b) => a.localeCompare(b));
  }

  res.json({
    enabled,
    restrooms: restrooms
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((r) => ({ id: r.id, name: r.name })),
    restroomNames,
    roomDefaults,
    teacherOverrides,
  });
});

function parseRestroomIds(body: unknown): number[] | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = b.restroomLocationIds;
  if (!Array.isArray(raw)) return null;
  const ids = Array.from(
    new Set(
      raw
        .map((x) => Number(x))
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  );
  return ids;
}

// PUT /restroom-access/room/:originId — replace the restroom default set
// for an origin room. Only restroom-kind pairings from this origin are
// touched; the classroom↔classroom mesh and any other destination
// pairings are left intact.
router.put(
  "/restroom-access/room/:originId",
  requireAdmin(),
  async (req, res): Promise<void> => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const originId = Number(req.params.originId);
    if (!Number.isInteger(originId) || originId <= 0) {
      res.status(400).json({ error: "Invalid origin id" });
      return;
    }
    const restroomIds = parseRestroomIds(req.body);
    if (restroomIds === null) {
      res
        .status(400)
        .json({ error: "restroomLocationIds must be an array of ids" });
      return;
    }

    // Origin must belong to this school.
    const [originLoc] = await db
      .select({ id: locationsTable.id })
      .from(locationsTable)
      .where(
        and(
          eq(locationsTable.id, originId),
          eq(locationsTable.schoolId, schoolId),
        ),
      );
    if (!originLoc) {
      res.status(404).json({ error: "Origin room not found" });
      return;
    }

    // Restroom universe for this school. Every requested id must be a
    // restroom-kind location here.
    const restrooms = await loadRestrooms(schoolId);
    const restroomIdSet = new Set(restrooms.map((r) => r.id));
    for (const id of restroomIds) {
      if (!restroomIdSet.has(id)) {
        res.status(400).json({
          error: "One or more ids is not a restroom in this school",
        });
        return;
      }
    }
    const allRestroomIds = restrooms.map((r) => r.id);

    await db.transaction(async (tx) => {
      if (allRestroomIds.length > 0) {
        await tx
          .delete(locationAllowedDestinationsTable)
          .where(
            and(
              eq(locationAllowedDestinationsTable.schoolId, schoolId),
              eq(
                locationAllowedDestinationsTable.originLocationId,
                originId,
              ),
              inArray(
                locationAllowedDestinationsTable.destinationLocationId,
                allRestroomIds,
              ),
            ),
          );
      }
      const toInsert = restroomIds.filter((id) => id !== originId);
      if (toInsert.length > 0) {
        await tx
          .insert(locationAllowedDestinationsTable)
          .values(
            toInsert.map((destinationLocationId) => ({
              schoolId,
              originLocationId: originId,
              destinationLocationId,
            })),
          )
          .onConflictDoNothing();
      }
    });

    res.json({ ok: true, originId, count: restroomIds.length });
  },
);

// PUT /restroom-access/teacher/:staffName — replace a teacher's restroom
// override. An empty array clears the override so the teacher inherits
// the origin room default again.
router.put(
  "/restroom-access/teacher/:staffName",
  requireAdmin(),
  async (req, res): Promise<void> => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staffName = String(req.params.staffName ?? "").trim();
    if (!staffName) {
      res.status(400).json({ error: "staffName is required" });
      return;
    }
    const restroomIds = parseRestroomIds(req.body);
    if (restroomIds === null) {
      res
        .status(400)
        .json({ error: "restroomLocationIds must be an array of ids" });
      return;
    }

    if (restroomIds.length > 0) {
      const restrooms = await loadRestrooms(schoolId);
      const restroomIdSet = new Set(restrooms.map((r) => r.id));
      for (const id of restroomIds) {
        if (!restroomIdSet.has(id)) {
          res.status(400).json({
            error: "One or more ids is not a restroom in this school",
          });
          return;
        }
      }
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(teacherRestroomOverridesTable)
        .where(
          and(
            eq(teacherRestroomOverridesTable.schoolId, schoolId),
            eq(teacherRestroomOverridesTable.staffName, staffName),
          ),
        );
      if (restroomIds.length > 0) {
        await tx.insert(teacherRestroomOverridesTable).values(
          restroomIds.map((restroomLocationId) => ({
            schoolId,
            staffName,
            restroomLocationId,
          })),
        );
      }
    });

    res.json({ ok: true, staffName, count: restroomIds.length });
  },
);

export default router;
