import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { db, locationsTable, staffTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

async function requireSignedIn(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const staffId = req.session.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  next();
}

// Locations list is the destination picker for hall passes and the kiosk
// origin list. Any signed-in staff may read.
router.get("/locations", requireSignedIn, async (_req, res) => {
  const rows = await db.select().from(locationsTable);
  rows.sort((a, b) => a.name.localeCompare(b.name));
  res.json(rows);
});

export default router;
