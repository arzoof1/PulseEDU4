// Classroom Intervention logging.
// GET  /api/interventions          -> list (any signed-in staff)
// POST /api/interventions          -> create one entry (any signed-in staff)
//
// Privileged readers (admin / behavior specialist) see school-wide rows.
// Other staff see only their own entries.

import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  interventionEntriesTable,
  interventionTypesTable,
  staffTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";

const router: IRouter = Router();

async function requireStaff(
  req: Request,
  res: Response,
  next: NextFunction,
) {
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

router.get("/interventions", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const isPrivileged = staff.isAdmin || staff.isBehaviorSpecialist;
  const rows = await db
    .select()
    .from(interventionEntriesTable)
    .where(
      isPrivileged
        ? undefined
        : eq(interventionEntriesTable.staffId, staff.id),
    )
    .orderBy(desc(interventionEntriesTable.createdAt))
    .limit(200);
  res.json(rows);
});

router.post("/interventions", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const { studentId, interventionTypeId, note } = req.body ?? {};

  if (typeof studentId !== "string" || !studentId.trim()) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  const typeId = Number(interventionTypeId);
  if (!Number.isInteger(typeId) || typeId < 1) {
    res
      .status(400)
      .json({ error: "interventionTypeId (positive integer) is required" });
    return;
  }
  const [type] = await db
    .select()
    .from(interventionTypesTable)
    .where(eq(interventionTypesTable.id, typeId));
  if (!type) {
    res.status(404).json({ error: "Intervention type not found" });
    return;
  }
  if (!type.active) {
    res.status(400).json({ error: "Intervention type is inactive" });
    return;
  }

  const noteText = typeof note === "string" ? note.trim() : "";
  if (type.requiresNote && !noteText) {
    res
      .status(400)
      .json({ error: `A note is required for "${type.name}".` });
    return;
  }

  const [row] = await db
    .insert(interventionEntriesTable)
    .values({
      studentId: studentId.trim(),
      interventionType: type.name,
      note: noteText || null,
      staffId: staff.id,
      staffName: staff.displayName,
      createdAt: new Date().toISOString(),
    })
    .returning();
  res.status(201).json(row);
});

export default router;
