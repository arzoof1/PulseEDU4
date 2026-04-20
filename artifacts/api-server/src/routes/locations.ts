import { Router, type IRouter } from "express";
import { db, locationsTable } from "@workspace/db";

const router: IRouter = Router();

router.get("/locations", async (_req, res) => {
  const rows = await db.select().from(locationsTable);
  rows.sort((a, b) => a.name.localeCompare(b.name));
  res.json(rows);
});

export default router;
