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

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.session.staffId;
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
    if (!staff.isAdmin) {
      res.status(403).json({ error: "Admin only" });
      return;
    }
    next();
  };
}

// Read every default-room row joined with the (optional) staff record so
// the client can render an admin grid without a second round-trip.
router.get("/staff-defaults", async (_req, res) => {
  const rows = await db
    .select({
      id: staffDefaultsTable.id,
      staffId: staffDefaultsTable.staffId,
      staffName: staffDefaultsTable.staffName,
      defaultLocationName: staffDefaultsTable.defaultLocationName,
    })
    .from(staffDefaultsTable);
  res.json(rows);
});

// Upsert a teacher's default room. Always keyed by staffId when known
// (SIS-safe). Falls back to staffName for legacy rows that haven't been
// re-keyed yet. Validates the location exists & is an origin so we can't
// pin teachers to a non-existent or destination-only room.
router.put("/staff-defaults", requireAdmin(), async (req, res) => {
  const staffId = Number(req.body?.staffId);
  const defaultLocationName =
    typeof req.body?.defaultLocationName === "string"
      ? req.body.defaultLocationName.trim()
      : "";

  if (!Number.isFinite(staffId) || staffId <= 0) {
    res.status(400).json({ error: "staffId is required" });
    return;
  }

  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff) {
    res.status(404).json({ error: "Staff not found" });
    return;
  }

  let normalizedRoom: string | null = null;
  if (defaultLocationName) {
    const [loc] = await db
      .select()
      .from(locationsTable)
      .where(
        and(
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
  await db
    .update(staffDefaultsTable)
    .set({ staffId })
    .where(
      and(
        eq(staffDefaultsTable.staffName, staff.displayName),
        sql`${staffDefaultsTable.staffId} IS NULL`,
      ),
    );

  await db
    .insert(staffDefaultsTable)
    .values({
      staffId,
      staffName: staff.displayName,
      defaultLocationName: normalizedRoom,
    })
    .onConflictDoUpdate({
      target: staffDefaultsTable.staffId,
      set: {
        defaultLocationName: normalizedRoom,
        staffName: staff.displayName,
      },
    });

  res.json({ ok: true, staffId, defaultLocationName: normalizedRoom });
});

export default router;
