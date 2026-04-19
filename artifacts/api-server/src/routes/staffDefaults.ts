import { Router, type IRouter } from "express";
import { db, staffDefaultsTable } from "@workspace/db";

const router: IRouter = Router();

router.get("/staff-defaults", async (_req, res) => {
  const rows = await db.select().from(staffDefaultsTable);
  res.json(rows);
});

export default router;
