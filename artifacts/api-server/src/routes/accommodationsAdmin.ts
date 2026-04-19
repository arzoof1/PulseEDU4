// ESE Coordinator + Admin routes for managing the school's accommodation
// master list and per-student assignments.

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import {
  db,
  schoolAccommodationsTable,
  studentAccommodationsTable,
  staffTable,
} from "@workspace/db";
import { and, eq, isNull, sql, desc, inArray } from "drizzle-orm";

const router: IRouter = Router();

async function requireEseOrAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const staffId = req.session.staffId;
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
  if (!staff.isAdmin && !staff.isEseCoordinator) {
    res.status(403).json({ error: "ESE coordinator or admin only" });
    return;
  }
  (req as Request & { staff: typeof staff }).staff = staff;
  next();
}

// ---- Master list ----

router.get("/school-accommodations", async (_req, res) => {
  const rows = await db
    .select()
    .from(schoolAccommodationsTable)
    .orderBy(schoolAccommodationsTable.category, schoolAccommodationsTable.name);
  // include in-use count
  const counts = await db
    .select({
      accommodationId: studentAccommodationsTable.accommodationId,
      n: sql<number>`count(*)::int`,
    })
    .from(studentAccommodationsTable)
    .where(isNull(studentAccommodationsTable.removedAt))
    .groupBy(studentAccommodationsTable.accommodationId);
  const byId = new Map(counts.map((c) => [c.accommodationId, c.n]));
  res.json(
    rows.map((r) => ({ ...r, inUseCount: byId.get(r.id) ?? 0 })),
  );
});

router.post("/school-accommodations", requireEseOrAdmin, async (req, res) => {
  const { name, category } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const cat =
    typeof category === "string" && category.trim() ? category.trim() : "Strategy";

  const existing = await db
    .select()
    .from(schoolAccommodationsTable)
    .where(eq(schoolAccommodationsTable.name, name.trim()));
  if (existing.length > 0) {
    res.status(409).json({ error: "Accommodation name already exists" });
    return;
  }

  const [row] = await db
    .insert(schoolAccommodationsTable)
    .values({ name: name.trim(), category: cat, active: true })
    .returning();
  res.status(201).json(row);
});

router.patch("/school-accommodations/:id", requireEseOrAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const { name, category, active } = req.body ?? {};
  const updates: Partial<typeof schoolAccommodationsTable.$inferInsert> = {};
  if (typeof name === "string" && name.trim()) updates.name = name.trim();
  if (typeof category === "string" && category.trim())
    updates.category = category.trim();
  if (typeof active === "boolean") updates.active = active;
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No updates" });
    return;
  }
  const [row] = await db
    .update(schoolAccommodationsTable)
    .set(updates)
    .where(eq(schoolAccommodationsTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(row);
});

// ---- Per-student assignments ----

// Returns current + history for one student. ESE coordinator or admin only,
// since this exposes full assignment history including removed entries.
router.get(
  "/students/:studentId/accommodations",
  requireEseOrAdmin,
  async (req, res) => {
    const studentId = req.params.studentId;
    const rows = await db
      .select({
        id: studentAccommodationsTable.id,
        accommodationId: studentAccommodationsTable.accommodationId,
        name: schoolAccommodationsTable.name,
        category: schoolAccommodationsTable.category,
        assignedAt: studentAccommodationsTable.assignedAt,
        assignedByStaffId: studentAccommodationsTable.assignedByStaffId,
        removedAt: studentAccommodationsTable.removedAt,
        removedByStaffId: studentAccommodationsTable.removedByStaffId,
      })
      .from(studentAccommodationsTable)
      .innerJoin(
        schoolAccommodationsTable,
        eq(
          studentAccommodationsTable.accommodationId,
          schoolAccommodationsTable.id,
        ),
      )
      .where(eq(studentAccommodationsTable.studentId, studentId))
      .orderBy(desc(studentAccommodationsTable.assignedAt));
    res.json(rows);
  },
);

// Assign one or more accommodations to a student. Idempotent: skips ones
// already actively assigned. Body: { accommodationIds: number[] }
router.post(
  "/students/:studentId/accommodations",
  requireEseOrAdmin,
  async (req, res) => {
    const staff = (req as Request & { staff: typeof staffTable.$inferSelect }).staff;
    const studentId = req.params.studentId;
    const { accommodationIds } = req.body ?? {};
    if (
      !Array.isArray(accommodationIds) ||
      accommodationIds.length === 0 ||
      !accommodationIds.every((n) => typeof n === "number")
    ) {
      res.status(400).json({ error: "accommodationIds (number[]) required" });
      return;
    }

    const existing = await db
      .select()
      .from(studentAccommodationsTable)
      .where(
        and(
          eq(studentAccommodationsTable.studentId, studentId),
          isNull(studentAccommodationsTable.removedAt),
          inArray(
            studentAccommodationsTable.accommodationId,
            accommodationIds as number[],
          ),
        ),
      );
    const alreadyActive = new Set(existing.map((e) => e.accommodationId));
    const toInsert = (accommodationIds as number[])
      .filter((id) => !alreadyActive.has(id))
      .map((id) => ({
        studentId,
        accommodationId: id,
        assignedByStaffId: staff.id,
      }));
    if (toInsert.length > 0) {
      await db.insert(studentAccommodationsTable).values(toInsert);
    }
    res.status(201).json({
      inserted: toInsert.length,
      skipped: alreadyActive.size,
    });
  },
);

// Soft-remove an active assignment.
router.delete(
  "/students/:studentId/accommodations/:assignmentId",
  requireEseOrAdmin,
  async (req, res) => {
    const staff = (req as Request & { staff: typeof staffTable.$inferSelect }).staff;
    const studentId = req.params.studentId;
    const assignmentId = Number(req.params.assignmentId);
    if (!Number.isInteger(assignmentId) || assignmentId < 1) {
      res.status(400).json({ error: "Invalid assignment id" });
      return;
    }
    const [row] = await db
      .update(studentAccommodationsTable)
      .set({
        removedAt: new Date(),
        removedByStaffId: staff.id,
      })
      .where(
        and(
          eq(studentAccommodationsTable.id, assignmentId),
          eq(studentAccommodationsTable.studentId, studentId),
          isNull(studentAccommodationsTable.removedAt),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found or already removed" });
      return;
    }
    res.json(row);
  },
);

export default router;
