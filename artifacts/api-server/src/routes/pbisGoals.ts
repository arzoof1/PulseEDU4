// Per-student PBIS goals.
// GET  /api/pbis-goals[?studentId=...] -> list active goals (signed-in staff)
// POST /api/pbis-goals                  -> create
// POST /api/pbis-goals/:id/archive      -> archive (creator OR admin/PBIS coord)

import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { db, pbisGoalsTable, staffTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

const PERIOD_TYPES = new Set(["week", "month", "quarter", "all"]);

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

router.get("/pbis-goals", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const studentId =
    typeof req.query.studentId === "string" ? req.query.studentId.trim() : "";
  const conds = [
    isNull(pbisGoalsTable.archivedAt),
    eq(pbisGoalsTable.schoolId, schoolId),
  ];
  if (studentId) conds.push(eq(pbisGoalsTable.studentId, studentId));
  const rows = await db
    .select()
    .from(pbisGoalsTable)
    .where(and(...conds));
  res.json(rows);
});

router.post("/pbis-goals", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const { studentId, reason, targetPoints, periodType } = req.body ?? {};
  if (typeof studentId !== "string" || !studentId.trim()) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  const target = Number(targetPoints);
  if (!Number.isInteger(target) || target < 1) {
    res
      .status(400)
      .json({ error: "targetPoints must be a positive integer" });
    return;
  }
  if (typeof periodType !== "string" || !PERIOD_TYPES.has(periodType)) {
    res
      .status(400)
      .json({ error: "periodType must be week, month, quarter, or all" });
    return;
  }
  const reasonText =
    typeof reason === "string" && reason.trim() ? reason.trim() : null;

  const [row] = await db
    .insert(pbisGoalsTable)
    .values({
      schoolId,
      studentId: studentId.trim(),
      reason: reasonText,
      targetPoints: target,
      periodType,
      createdById: staff.id,
      createdByName: staff.displayName,
      createdAt: new Date().toISOString(),
    })
    .returning();
  res.status(201).json(row);
});

router.post("/pbis-goals/:id/archive", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const [goal] = await db
    .select()
    .from(pbisGoalsTable)
    .where(
      and(eq(pbisGoalsTable.id, id), eq(pbisGoalsTable.schoolId, schoolId)),
    );
  if (!goal) {
    res.status(404).json({ error: "Goal not found" });
    return;
  }
  if (goal.archivedAt) {
    res.status(400).json({ error: "Already archived" });
    return;
  }
  const isOwner = goal.createdById !== null && goal.createdById === staff.id;
  if (
    !staff.isSuperUser &&
    !staff.isAdmin &&
    !staff.isPbisCoordinator &&
    !isOwner
  ) {
    res.status(403).json({ error: "Not your goal" });
    return;
  }
  const [updated] = await db
    .update(pbisGoalsTable)
    .set({ archivedAt: new Date().toISOString() })
    .where(eq(pbisGoalsTable.id, id))
    .returning();
  res.json(updated);
});

export default router;
