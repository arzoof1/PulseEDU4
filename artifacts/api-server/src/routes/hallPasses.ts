import { Router, type IRouter } from "express";
import { db, hallPassesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { config } from "../data/config";

const router: IRouter = Router();

router.get("/hall-passes", async (_req, res) => {
  const rows = await db.select().from(hallPassesTable);
  res.json(rows);
});

router.post("/hall-passes", async (req, res) => {
  const { studentId, destination, originRoom, teacherName } = req.body ?? {};

  if (
    typeof studentId !== "string" ||
    typeof destination !== "string" ||
    typeof originRoom !== "string" ||
    typeof teacherName !== "string"
  ) {
    res.status(400).json({
      error:
        "studentId, destination, originRoom, and teacherName are required",
    });
    return;
  }

  const [pass] = await db
    .insert(hallPassesTable)
    .values({
      studentId,
      destination,
      originRoom,
      teacherName,
      status: "active",
      createdAt: new Date().toISOString(),
      maxDurationMinutes: config.defaultHallPassDurationMinutes,
      endedAt: null,
    })
    .returning();
  res.status(201).json(pass);
});

router.patch("/hall-passes/:id/end", async (req, res) => {
  const id = Number(req.params.id);
  const system = req.body?.system === true;
  const [pass] = await db
    .update(hallPassesTable)
    .set({
      status: system ? "system_ended" : "ended",
      endedAt: new Date().toISOString(),
    })
    .where(eq(hallPassesTable.id, id))
    .returning();

  if (!pass) {
    res.status(404).json({ error: "Hall pass not found" });
    return;
  }
  res.json(pass);
});

export default router;
