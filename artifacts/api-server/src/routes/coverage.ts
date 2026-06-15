// Staff -> destination coverage for one-way hall passes.
//
//   GET /hall-passes/my-coverage          -> covered location names (any staff)
//   GET /staff-received-locations          -> all assignments (admin)
//   PUT /staff-received-locations          -> replace a staff's assignments (admin)
//
// "Heading to me" on the staff app scopes active non-restroom passes to the
// destinations the signed-in staff covers (their own room + admin-assigned
// locations). See lib/oneWayPass.ts for the coverage resolution.

import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  staffTable,
  locationsTable,
  staffReceivedLocationsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { isAdminOrSuperUser } from "../lib/coreTeam.js";
import { loadStaffCoverage } from "../lib/oneWayPass.js";

const router: IRouter = Router();

async function requireStaff(req: Request, res: Response, next: NextFunction) {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  (req as Request & { staff: typeof staff }).staff = staff;
  next();
}

// Covered destination location names for the signed-in staff member. The
// client uses this to scope its "Heading to me" hall-pass list.
router.get("/hall-passes/my-coverage", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const covered = await loadStaffCoverage(schoolId, staff.id);
  res.json({ locations: Array.from(covered) });
});

// All coverage assignments for the school (admin). Returns one entry per
// staff member that has at least one assigned location.
router.get("/staff-received-locations", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  if (!isAdminOrSuperUser(staff)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  const rows = await db
    .select({
      staffId: staffReceivedLocationsTable.staffId,
      locationId: staffReceivedLocationsTable.locationId,
    })
    .from(staffReceivedLocationsTable)
    .where(eq(staffReceivedLocationsTable.schoolId, schoolId));
  const byStaff = new Map<number, number[]>();
  for (const r of rows) {
    if (!byStaff.has(r.staffId)) byStaff.set(r.staffId, []);
    byStaff.get(r.staffId)!.push(r.locationId);
  }
  res.json(
    Array.from(byStaff.entries()).map(([sid, locationIds]) => ({
      staffId: sid,
      locationIds,
    })),
  );
});

// Replace one staff member's set of covered locations (admin). Sends the full
// desired locationIds array; the server diffs and rewrites.
router.put("/staff-received-locations", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  const actor = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  if (!isAdminOrSuperUser(actor)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  const { staffId, locationIds } = req.body ?? {};
  const targetStaffId = Number(staffId);
  if (!Number.isFinite(targetStaffId) || targetStaffId <= 0) {
    res.status(400).json({ error: "staffId is required" });
    return;
  }
  if (
    !Array.isArray(locationIds) ||
    locationIds.some((x) => !Number.isFinite(Number(x)))
  ) {
    res.status(400).json({ error: "locationIds must be an array of numbers" });
    return;
  }
  const desired = Array.from(
    new Set(locationIds.map((x) => Number(x))),
  ) as number[];

  // Confirm the target staff belongs to this school.
  const [target] = await db
    .select({ id: staffTable.id })
    .from(staffTable)
    .where(and(eq(staffTable.id, targetStaffId), eq(staffTable.schoolId, schoolId)));
  if (!target) {
    res.status(404).json({ error: "Staff member not found" });
    return;
  }

  // Validate every locationId belongs to this school (tenant isolation).
  if (desired.length > 0) {
    const valid = await db
      .select({ id: locationsTable.id })
      .from(locationsTable)
      .where(eq(locationsTable.schoolId, schoolId));
    const validIds = new Set(valid.map((v) => v.id));
    const bad = desired.filter((id) => !validIds.has(id));
    if (bad.length > 0) {
      res
        .status(400)
        .json({ error: `Unknown location id(s): ${bad.join(", ")}` });
      return;
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(staffReceivedLocationsTable)
      .where(
        and(
          eq(staffReceivedLocationsTable.schoolId, schoolId),
          eq(staffReceivedLocationsTable.staffId, targetStaffId),
        ),
      );
    if (desired.length > 0) {
      await tx.insert(staffReceivedLocationsTable).values(
        desired.map((locationId) => ({
          schoolId,
          staffId: targetStaffId,
          locationId,
        })),
      );
    }
  });

  res.json({ staffId: targetStaffId, locationIds: desired });
});

export default router;
