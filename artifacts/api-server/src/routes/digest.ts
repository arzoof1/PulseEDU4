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
  sendDailyDigestEmailForSchool,
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
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

// Preview today's digest for the admin's own school. Admin only.
router.get(
  "/digest/today",
  requireAdmin(),
  async (req: Request, res: Response) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const d = await buildDailyDigest(new Date(), staff.schoolId);
    res.json(d);
  },
);

// Send today's digest for the admin's own school now. Admin only.
// Used for manual fire and testing.
router.post(
  "/digest/send-now",
  requireAdmin(),
  async (req: Request, res: Response) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const result = await sendDailyDigestEmailForSchool(
      new Date(),
      staff.schoolId,
    );
    res.json(result);
  },
);

export default router;
