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
  teacherDestinationAllowlistTable,
} from "@workspace/db";
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
    if (!staff.isAdmin) {
      res.status(403).json({ error: "Admin only" });
      return;
    }
    next();
  };
}

// All rows joined with location names. Signed-in users may read so the
// Create Pass modal can group destinations as near vs other.
router.get(
  "/teacher-allowlist",
  requireSignedIn(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const rows = await db
      .select({
        id: teacherDestinationAllowlistTable.id,
        staffName: teacherDestinationAllowlistTable.staffName,
        destinationLocationId:
          teacherDestinationAllowlistTable.destinationLocationId,
        destinationName: locationsTable.name,
      })
      .from(teacherDestinationAllowlistTable)
      .innerJoin(
        locationsTable,
        eq(
          locationsTable.id,
          teacherDestinationAllowlistTable.destinationLocationId,
        ),
      )
      .where(eq(teacherDestinationAllowlistTable.schoolId, schoolId));
    rows.sort((a, b) => {
      const s = a.staffName.localeCompare(b.staffName);
      if (s !== 0) return s;
      return a.destinationName.localeCompare(b.destinationName);
    });
    res.json(rows);
  },
);

// Replace the allowlist for a single teacher. Body: { destinations: string[] }
// where each entry is a location name.
router.put(
  "/teacher-allowlist/:staffName",
  requireAdmin(),
  async (req, res) => {
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

    await db.transaction(async (tx) => {
      await tx
        .delete(teacherDestinationAllowlistTable)
        .where(
          and(
            eq(teacherDestinationAllowlistTable.staffName, staffName),
            eq(teacherDestinationAllowlistTable.schoolId, schoolId),
          ),
        );

      if (locationIds.length > 0) {
        await tx.insert(teacherDestinationAllowlistTable).values(
          locationIds.map((destinationLocationId) => ({
            schoolId,
            staffName,
            destinationLocationId,
          })),
        );
      }
    });

    res.json({ ok: true, staffName, count: locationIds.length });
  },
);

export default router;
