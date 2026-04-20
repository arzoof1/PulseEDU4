import { Router, type IRouter } from "express";
import { db, tardiesTable } from "@workspace/db";

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
      createdAt: new Date().toISOString(),
    })
    .returning();

  res.status(201).json(tardy);
});

export default router;
