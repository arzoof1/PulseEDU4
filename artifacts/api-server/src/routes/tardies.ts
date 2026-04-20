import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { db, tardiesTable, staffTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.session.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function requireStaffMW(check?: (s: StaffRow) => boolean, label = "Sign-in") {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (check && !check(staff)) {
      res.status(403).json({ error: `${label} only` });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

// List all tardy/check-in/check-out entries. Visible to anyone who can log
// tardies OR view student activity (Student Activity reuses this list).
router.get(
  "/tardies",
  requireStaffMW(
    (s) => s.capTardies || s.capStudentActivity,
    "Tardies or Student Activity",
  ),
  async (_req: Request, res: Response) => {
    const rows = await db.select().from(tardiesTable);
    res.json(rows);
  },
);

// Log a tardy / check-in / check-out. Requires capTardies. The recording
// teacher is always the signed-in staff member to prevent ownership
// spoofing via a client-supplied teacherName.
router.post(
  "/tardies",
  requireStaffMW((s) => s.capTardies, "Tardy logging"),
  async (req: Request, res: Response) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const { studentId, period, reason, entryType, checkInWith, notes } =
      req.body ?? {};

    if (typeof studentId !== "string" || typeof period !== "string") {
      res
        .status(400)
        .json({ error: "studentId and period are required" });
      return;
    }

    const teacherName = staff.displayName;

    const type: "tardy" | "checkin" | "checkout" =
      entryType === "checkin"
        ? "checkin"
        : entryType === "checkout"
          ? "checkout"
          : "tardy";

    if (
      (type === "checkin" || type === "checkout") &&
      (typeof checkInWith !== "string" || !checkInWith)
    ) {
      res.status(400).json({
        error: "checkInWith is required for check-in and check-out entries",
      });
      return;
    }

    const [tardy] = await db
      .insert(tardiesTable)
      .values({
        studentId,
        teacherName,
        period,
        reason: typeof reason === "string" ? reason : "",
        entryType: type,
        checkInWith:
          type === "checkin" || type === "checkout"
            ? (checkInWith as string)
            : null,
        notes: typeof notes === "string" ? notes : "",
        createdAt: new Date().toISOString(),
      })
      .returning();

    res.status(201).json(tardy);
  },
);

export default router;
