import { Router, type IRouter } from "express";
import { db, pbisEntriesTable } from "@workspace/db";

const router: IRouter = Router();

router.get("/pbis", async (_req, res) => {
  const rows = await db.select().from(pbisEntriesTable);
  res.json(rows);
});

router.post("/pbis", async (req, res) => {
  const { studentId, reason, points, staffName } = req.body ?? {};

  if (typeof studentId !== "string" || !studentId) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  if (typeof reason !== "string" || !reason) {
    res.status(400).json({ error: "reason is required" });
    return;
  }
  const pts = Number(points);
  if (!Number.isFinite(pts)) {
    res.status(400).json({ error: "points must be a number" });
    return;
  }

  const [entry] = await db
    .insert(pbisEntriesTable)
    .values({
      studentId,
      reason,
      points: pts,
      staffName: typeof staffName === "string" ? staffName : "",
      createdAt: new Date().toISOString(),
    })
    .returning();

  res.status(201).json(entry);
});

export default router;
