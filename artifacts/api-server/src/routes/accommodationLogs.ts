import { Router, type IRouter } from "express";
import { db, accommodationLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/accommodation-logs", async (req, res) => {
  const { studentId } = req.query;
  if (typeof studentId === "string" && studentId) {
    const rows = await db
      .select()
      .from(accommodationLogsTable)
      .where(eq(accommodationLogsTable.studentId, studentId));
    res.json(rows);
    return;
  }
  const rows = await db.select().from(accommodationLogsTable);
  res.json(rows);
});

router.post("/accommodation-logs", async (req, res) => {
  const { studentId, accommodation, period, staffName } = req.body ?? {};

  if (typeof studentId !== "string" || !studentId) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  if (typeof accommodation !== "string" || !accommodation) {
    res.status(400).json({ error: "accommodation is required" });
    return;
  }

  const periodValue =
    typeof period === "number"
      ? period
      : typeof period === "string" && period
        ? Number(period)
        : null;

  const [log] = await db
    .insert(accommodationLogsTable)
    .values({
      studentId,
      accommodation,
      period: periodValue,
      staffName: typeof staffName === "string" ? staffName : "",
      createdAt: new Date().toISOString(),
    })
    .returning();

  res.status(201).json(log);
});

export default router;
