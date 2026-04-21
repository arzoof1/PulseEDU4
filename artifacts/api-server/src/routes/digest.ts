import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { db, staffTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  buildDailyDigest,
  sendDailyDigestEmail,
} from "../lib/dailyDigest";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function requireAdmin() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!staff.isAdmin) {
      res.status(403).json({ error: "Admin only" });
      return;
    }
    next();
  };
}

// Preview today's digest without sending. Admin only.
router.get(
  "/digest/today",
  requireAdmin(),
  async (_req: Request, res: Response) => {
    const d = await buildDailyDigest(new Date());
    res.json(d);
  },
);

// Send the digest now. Admin only. Used for manual fire and testing.
router.post(
  "/digest/send-now",
  requireAdmin(),
  async (_req: Request, res: Response) => {
    const result = await sendDailyDigestEmail(new Date());
    res.json(result);
  },
);

export default router;
