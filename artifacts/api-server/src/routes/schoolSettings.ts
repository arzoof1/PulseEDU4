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

router.put("/school-settings", async (req, res) => {
  const current = await getOrCreate();
  const { schoolName, fromName, emailSignature } = req.body ?? {};

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

  if (Object.keys(updates).length === 0) {
    return res.json(current);
  }

  const [updated] = await db
    .update(schoolSettingsTable)
    .set(updates)
    .where(eq(schoolSettingsTable.id, current.id))
    .returning();
  res.json(updated);
});

export default router;
