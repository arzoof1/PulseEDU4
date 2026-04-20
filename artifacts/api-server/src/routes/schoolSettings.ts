import { Router, type IRouter } from "express";
import { db, schoolSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

async function getOrCreate() {
  const [row] = await db.select().from(schoolSettingsTable).limit(1);
  if (row) return row;
  const [created] = await db
    .insert(schoolSettingsTable)
    .values({})
    .returning();
  return created;
}

router.get("/school-settings", async (_req, res) => {
  const row = await getOrCreate();
  res.json(row);
});

router.put("/school-settings", async (req, res): Promise<void> => {
  const current = await getOrCreate();
  const {
    schoolName,
    fromName,
    emailSignature,
    periodCount,
    hallPassMaxMinutes,
    hallPassDefaultMinutes,
  } = req.body ?? {};

  const updates: Partial<typeof schoolSettingsTable.$inferInsert> = {};
  if (typeof schoolName === "string" && schoolName.trim()) {
    updates.schoolName = schoolName.trim();
  }
  if (typeof fromName === "string" && fromName.trim()) {
    updates.fromName = fromName.trim();
  }
  if (typeof emailSignature === "string") {
    updates.emailSignature = emailSignature;
  }
  if (periodCount !== undefined) {
    if (
      typeof periodCount !== "number" ||
      !Number.isInteger(periodCount) ||
      periodCount < 1 ||
      periodCount > 12
    ) {
      res
        .status(400)
        .json({ error: "periodCount must be an integer between 1 and 12" });
      return;
    }
    updates.periodCount = periodCount;
  }
  if (hallPassMaxMinutes !== undefined) {
    if (
      typeof hallPassMaxMinutes !== "number" ||
      !Number.isInteger(hallPassMaxMinutes) ||
      hallPassMaxMinutes < 1 ||
      hallPassMaxMinutes > 240
    ) {
      res.status(400).json({
        error: "hallPassMaxMinutes must be an integer between 1 and 240",
      });
      return;
    }
    updates.hallPassMaxMinutes = hallPassMaxMinutes;
  }
  if (hallPassDefaultMinutes !== undefined) {
    if (
      typeof hallPassDefaultMinutes !== "number" ||
      !Number.isInteger(hallPassDefaultMinutes) ||
      hallPassDefaultMinutes < 1 ||
      hallPassDefaultMinutes > 240
    ) {
      res.status(400).json({
        error:
          "hallPassDefaultMinutes must be an integer between 1 and 240",
      });
      return;
    }
    updates.hallPassDefaultMinutes = hallPassDefaultMinutes;
  }

  if (Object.keys(updates).length === 0) {
    res.json(current);
    return;
  }

  const [updated] = await db
    .update(schoolSettingsTable)
    .set(updates)
    .where(eq(schoolSettingsTable.id, current.id))
    .returning();
  res.json(updated);
});

export default router;
