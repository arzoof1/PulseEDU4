import { Router, type IRouter } from "express";
import { db, studentsTable } from "@workspace/db";

const router: IRouter = Router();

router.get("/students", async (_req, res) => {
  const rows = await db.select().from(studentsTable).orderBy(studentsTable.id);
  res.json(rows);
});

export default router;
