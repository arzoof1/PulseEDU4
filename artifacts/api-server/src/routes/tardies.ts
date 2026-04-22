import { Router, type IRouter } from "express";
import { db, tardiesTable, staffTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/tardies", async (_req, res) => {
  const rows = await db.select().from(tardiesTable);
  res.json(rows);
});

router.post("/tardies", async (req, res) => {
  const {
    studentId,
    teacherName,
    period,
    reason,
    entryType,
    checkInWith,
    notes,
  } = req.body ?? {};

  const sessionStaffId = req.staffId;
  if (!sessionStaffId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const [sessionStaff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, sessionStaffId));
  if (!sessionStaff || !sessionStaff.active) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const serverCreatedBy = sessionStaff.displayName || sessionStaff.id;

  if (
    typeof studentId !== "string" ||
    typeof teacherName !== "string" ||
    typeof period !== "string"
  ) {
    res.status(400).json({
      error: "studentId, teacherName, and period are required",
    });
    return;
  }

  const type: "tardy" | "checkin" | "checkout" =
    entryType === "checkin"
      ? "checkin"
      : entryType === "checkout"
        ? "checkout"
        : "tardy";

  if (
    (type === "checkin" || type === "checkout") &&
    (typeof checkInWith !== "string" || !checkInWith)
  ) {
    res
      .status(400)
      .json({
        error: "checkInWith is required for check-in and check-out entries",
      });
    return;
  }

  const [tardy] = await db
    .insert(tardiesTable)
    .values({
      studentId,
      teacherName,
      period,
      reason: typeof reason === "string" ? reason : "",
      entryType: type,
      checkInWith:
        type === "checkin" || type === "checkout"
          ? (checkInWith as string)
          : null,
      notes: typeof notes === "string" ? notes : "",
      createdBy: serverCreatedBy,
      createdAt: new Date().toISOString(),
    })
    .returning();

  res.status(201).json(tardy);
});

export default router;
