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
  staffTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { staffIdFromBearerToken } from "../lib/staffBearerAuth.js";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  let id = req.staffId ?? null;
  if (!id) {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      id = await staffIdFromBearerToken(auth.slice(7).trim());
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

const KINDS = new Set(["classroom", "common_area", "restroom", "office"]);

const GENDERS = new Set(["boys", "girls"]);

function parseLocationBody(body: unknown): {
  name?: string;
  kind?: string;
  isOrigin?: boolean;
  isDestination?: boolean;
  studentVisible?: boolean;
  active?: boolean;
  restroomArea?: string | null;
  gender?: string | null;
  schoolWideDefault?: boolean;
  error?: string;
} {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: {
    name?: string;
    kind?: string;
    isOrigin?: boolean;
    isDestination?: boolean;
    studentVisible?: boolean;
    active?: boolean;
    restroomArea?: string | null;
    gender?: string | null;
    schoolWideDefault?: boolean;
    error?: string;
  } = {};
  if ("name" in b) {
    if (typeof b.name !== "string" || !b.name.trim()) {
      out.error = "name must be a non-empty string";
      return out;
    }
    out.name = b.name.trim();
  }
  if ("kind" in b) {
    if (typeof b.kind !== "string" || !KINDS.has(b.kind)) {
      out.error = `kind must be one of ${Array.from(KINDS).join(", ")}`;
      return out;
    }
    out.kind = b.kind;
  }
  for (const f of ["isOrigin", "isDestination", "studentVisible", "active"] as const) {
    if (f in b) {
      if (typeof b[f] !== "boolean") {
        out.error = `${f} must be boolean`;
        return out;
      }
      out[f] = b[f] as boolean;
    }
  }
  // restroom_area: free text grouping; "" / null clears it.
  if ("restroomArea" in b) {
    if (b.restroomArea === null) {
      out.restroomArea = null;
    } else if (typeof b.restroomArea === "string") {
      const v = b.restroomArea.trim();
      out.restroomArea = v.length > 0 ? v : null;
    } else {
      out.error = "restroomArea must be a string or null";
      return out;
    }
  }
  // gender: 'boys' | 'girls' | null.
  if ("gender" in b) {
    if (b.gender === null) {
      out.gender = null;
    } else if (typeof b.gender === "string") {
      const v = b.gender.trim().toLowerCase();
      if (v.length === 0) {
        out.gender = null;
      } else if (GENDERS.has(v)) {
        out.gender = v;
      } else {
        out.error = "gender must be 'boys', 'girls', or null";
        return out;
      }
    } else {
      out.error = "gender must be a string or null";
      return out;
    }
  }
  if ("schoolWideDefault" in b) {
    if (typeof b.schoolWideDefault !== "boolean") {
      out.error = "schoolWideDefault must be boolean";
      return out;
    }
    out.schoolWideDefault = b.schoolWideDefault;
  }
  return out;
}

router.get("/locations", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const rows = await db
    .select()
    .from(locationsTable)
    .where(eq(locationsTable.schoolId, schoolId));
  rows.sort((a, b) => a.name.localeCompare(b.name));
  res.json(rows);
});

router.post("/locations", requireAdminOrSuper(), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const parsed = parseLocationBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  if (!parsed.name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  try {
    const [row] = await db
      .insert(locationsTable)
      .values({
        schoolId,
        name: parsed.name,
        kind: parsed.kind ?? "classroom",
        isOrigin: parsed.isOrigin ?? false,
        isDestination: parsed.isDestination ?? false,
        studentVisible: parsed.studentVisible ?? false,
        active: parsed.active ?? true,
        restroomArea: parsed.restroomArea ?? null,
        gender: parsed.gender ?? null,
        schoolWideDefault: parsed.schoolWideDefault ?? false,
      })
      .returning();
    res.status(201).json(row);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to create location";
    if (msg.toLowerCase().includes("unique")) {
      res.status(409).json({ error: "A location with that name already exists." });
      return;
    }
    res.status(500).json({ error: msg });
  }
});

// Bulk-wire helper: ensure every classroom is both an Origin and a Destination,
// and create allowed-destination pairings between every (origin, destination)
// pair of *active* classrooms (excluding self). Idempotent — existing rows are
// left alone. Useful after adding/renaming classrooms in bulk.
router.post(
  "/locations/wire-classrooms-mesh",
  requireAdminOrSuper(),
  async (req, res) => {
    try {
      const schoolId = req.schoolId;
      if (!schoolId) {
        res.status(401).json({ error: "Sign-in required" });
        return;
      }
      // D4: scope mesh-wiring to THIS school. Otherwise an admin could
      // create cross-school location pairs (and inserts would silently
      // pick DEFAULT 1 for school_id).
      const classrooms = await db
        .select()
        .from(locationsTable)
        .where(
          and(
            eq(locationsTable.kind, "classroom"),
            eq(locationsTable.schoolId, schoolId),
          ),
        );
      const active = classrooms.filter((c) => c.active);
      let flagsUpdated = 0;
      for (const c of active) {
        if (!c.isOrigin || !c.isDestination) {
          await db
            .update(locationsTable)
            .set({ isOrigin: true, isDestination: true })
            .where(
              and(
                eq(locationsTable.id, c.id),
                eq(locationsTable.schoolId, schoolId),
              ),
            );
          flagsUpdated++;
        }
      }
      const existing = await db
        .select({
          o: locationAllowedDestinationsTable.originLocationId,
          d: locationAllowedDestinationsTable.destinationLocationId,
        })
        .from(locationAllowedDestinationsTable)
        .where(eq(locationAllowedDestinationsTable.schoolId, schoolId));
      const have = new Set(existing.map((r) => `${r.o}->${r.d}`));
      const toInsert: Array<{
        schoolId: number;
        originLocationId: number;
        destinationLocationId: number;
      }> = [];
      for (const o of active) {
        for (const d of active) {
          if (o.id === d.id) continue;
          if (!have.has(`${o.id}->${d.id}`)) {
            toInsert.push({
              schoolId,
              originLocationId: o.id,
              destinationLocationId: d.id,
            });
          }
        }
      }
      let pairsCreated = 0;
      // Chunk inserts to avoid oversized parameter lists.
      const CHUNK = 500;
      for (let i = 0; i < toInsert.length; i += CHUNK) {
        const slice = toInsert.slice(i, i + CHUNK);
        if (slice.length === 0) continue;
        await db.insert(locationAllowedDestinationsTable).values(slice);
        pairsCreated += slice.length;
      }
      res.json({
        classroomsConsidered: active.length,
        flagsUpdated,
        pairsCreated,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Bulk wire failed";
      res.status(500).json({ error: msg });
    }
  },
);

router.delete("/locations/:id", requireAdminOrSuper(), async (req, res) => {
  const schoolId = req.schoolId;
  if (!schoolId) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  // Allowed-destination pairings cascade-delete via FK. Past hall passes,
  // tardies, kiosk events, etc. store the location *name* as text, so
  // historical records are unaffected by removing a row here. Scoped by
  // (id, school_id) so an admin can't delete another school's row by id.
  const result = await db
    .delete(locationsTable)
    .where(
      and(eq(locationsTable.id, id), eq(locationsTable.schoolId, schoolId)),
    )
    .returning();
  if (result.length === 0) {
    res.status(404).json({ error: "Location not found" });
    return;
  }
  res.status(204).end();
});

router.patch("/locations/:id", requireAdminOrSuper(), async (req, res) => {
  const schoolId = req.schoolId;
  if (!schoolId) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = parseLocationBody(req.body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const updates: Record<string, unknown> = {};
  for (const k of [
    "name",
    "kind",
    "isOrigin",
    "isDestination",
    "studentVisible",
    "active",
    "restroomArea",
    "gender",
    "schoolWideDefault",
  ] as const) {
    if (parsed[k] !== undefined) updates[k] = parsed[k];
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }
  try {
    const [row] = await db
      .update(locationsTable)
      .set(updates)
      .where(
        and(eq(locationsTable.id, id), eq(locationsTable.schoolId, schoolId)),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Location not found" });
      return;
    }
    res.json(row);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to update location";
    if (msg.toLowerCase().includes("unique")) {
      res.status(409).json({ error: "A location with that name already exists." });
      return;
    }
    res.status(500).json({ error: msg });
  }
});

export default router;
