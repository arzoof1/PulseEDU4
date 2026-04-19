import { Router, type IRouter } from "express";
import { db, periodRosterTable } from "@workspace/db";

const router: IRouter = Router();

router.get("/schedule", async (_req, res) => {
  const rows = await db.select().from(periodRosterTable);
  const periodRoster: Record<number, string[]> = {};
  for (const row of rows) {
    if (!periodRoster[row.period]) periodRoster[row.period] = [];
    periodRoster[row.period].push(row.studentId);
  }
  res.json({ periodRoster });
});

export default router;
