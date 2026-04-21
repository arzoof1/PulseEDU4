// Per-student daily hall-pass limits. Created by behavior specialists,
// typically at parental request. Used by the hall-pass and kiosk pass
// creation endpoints to block additional passes once a student has hit
// their daily cap.

import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  studentHallPassLimitsTable,
  studentsTable,
  staffTable,
  hallPassesTable,
  schoolSettingsTable,
} from "@workspace/db";
import { and, eq, gte, lte } from "drizzle-orm";

const router: IRouter = Router();

async function loadStaff(req: Request, res: Response) {
  const sessionId = req.staffId;
  const queryRaw = req.query.staffId;
  const queryId =
    typeof queryRaw === "string" && Number.isFinite(Number(queryRaw))
      ? Number(queryRaw)
      : null;
  const bodyRaw = (req.body as { staffId?: unknown } | undefined)?.staffId;
  const bodyId =
    typeof bodyRaw === "number" && Number.isFinite(bodyRaw)
      ? bodyRaw
      : typeof bodyRaw === "string" && Number.isFinite(Number(bodyRaw))
        ? Number(bodyRaw)
        : null;
  const staffId = sessionId ?? queryId ?? bodyId;
  if (!staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  return staff;
}

function requireBsAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  void loadStaff(req, res).then((staff) => {
    if (!staff) return;
    if (!staff.isAdmin && !staff.isBehaviorSpecialist) {
      res.status(403).json({ error: "Behavior specialist or admin only" });
      return;
    }
    (req as Request & { staff: typeof staff }).staff = staff;
    next();
  });
}

// ---- Helpers ----

/**
 * Returns the active per-student daily limit row for `studentId`, or null.
 */
export async function getActiveStudentLimit(studentId: string) {
  const trimmed = studentId.trim();
  if (!trimmed) return null;
  const [row] = await db
    .select()
    .from(studentHallPassLimitsTable)
    .where(
      and(
        eq(studentHallPassLimitsTable.studentId, trimmed),
        eq(studentHallPassLimitsTable.active, true),
      ),
    )
    .limit(1);
  return row ?? null;
}

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
function endOfTodayIso(): string {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

/**
 * Returns how many hall passes `studentId` has had today (any status).
 */
export async function countPassesToday(studentId: string): Promise<number> {
  const trimmed = studentId.trim();
  if (!trimmed) return 0;
  const rows = await db
    .select({ id: hallPassesTable.id })
    .from(hallPassesTable)
    .where(
      and(
        eq(hallPassesTable.studentId, trimmed),
        gte(hallPassesTable.createdAt, startOfTodayIso()),
        lte(hallPassesTable.createdAt, endOfTodayIso()),
      ),
    );
  return rows.length;
}

/**
 * Returns the effective daily limit for a student (per-student override, else
 * global), or null if no limit applies.
 */
export async function getEffectiveDailyLimit(
  studentId: string,
): Promise<{ limit: number; source: "student" | "global" } | null> {
  const studentRow = await getActiveStudentLimit(studentId);
  if (studentRow && studentRow.dailyLimit > 0) {
    return { limit: studentRow.dailyLimit, source: "student" };
  }
  const [settings] = await db
    .select()
    .from(schoolSettingsTable)
    .limit(1);
  const g = settings?.globalDailyHallPassLimit;
  if (typeof g === "number" && g > 0) {
    return { limit: g, source: "global" };
  }
  return null;
}

export async function findDailyLimitConflict(studentId: string): Promise<{
  used: number;
  limit: number;
  source: "student" | "global";
} | null> {
  const eff = await getEffectiveDailyLimit(studentId);
  if (!eff) return null;
  const used = await countPassesToday(studentId);
  if (used >= eff.limit) {
    return { used, limit: eff.limit, source: eff.source };
  }
  return null;
}

export function dailyLimitConflictMessage(c: {
  used: number;
  limit: number;
  source: "student" | "global";
}): string {
  return c.source === "student"
    ? `This student has reached their daily hall-pass limit (${c.used}/${c.limit}). A behavior specialist can adjust the limit on the Hall Pass Management page.`
    : `This student has reached the school's daily hall-pass limit (${c.used}/${c.limit}).`;
}

// ---- Routes ----

router.get(
  "/student-hall-pass-limits",
  requireBsAdmin,
  async (_req, res) => {
    const rows = await db
      .select({
        id: studentHallPassLimitsTable.id,
        studentId: studentHallPassLimitsTable.studentId,
        dailyLimit: studentHallPassLimitsTable.dailyLimit,
        note: studentHallPassLimitsTable.note,
        parentApproved: studentHallPassLimitsTable.parentApproved,
        active: studentHallPassLimitsTable.active,
        createdByStaffId: studentHallPassLimitsTable.createdByStaffId,
        createdByName: studentHallPassLimitsTable.createdByName,
        createdAt: studentHallPassLimitsTable.createdAt,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
      })
      .from(studentHallPassLimitsTable)
      .leftJoin(
        studentsTable,
        eq(studentHallPassLimitsTable.studentId, studentsTable.studentId),
      )
      .where(eq(studentHallPassLimitsTable.active, true));
    res.json(rows);
  },
);

router.post(
  "/student-hall-pass-limits",
  requireBsAdmin,
  async (req, res): Promise<void> => {
    const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
      .staff;
    const { studentId, dailyLimit, note, parentApproved } = req.body ?? {};
    if (typeof studentId !== "string" || !studentId.trim()) {
      res.status(400).json({ error: "studentId is required" });
      return;
    }
    if (
      typeof dailyLimit !== "number" ||
      !Number.isInteger(dailyLimit) ||
      dailyLimit < 1 ||
      dailyLimit > 100
    ) {
      res.status(400).json({
        error: "dailyLimit must be an integer between 1 and 100",
      });
      return;
    }
    const trimmedNote =
      typeof note === "string" && note.trim() ? note.trim() : null;

    // Verify student exists.
    const [stu] = await db
      .select()
      .from(studentsTable)
      .where(eq(studentsTable.studentId, studentId.trim()));
    if (!stu) {
      res.status(404).json({ error: "Student not found" });
      return;
    }

    // Soft-deactivate any existing active limit for this student.
    await db
      .update(studentHallPassLimitsTable)
      .set({ active: false })
      .where(
        and(
          eq(studentHallPassLimitsTable.studentId, studentId.trim()),
          eq(studentHallPassLimitsTable.active, true),
        ),
      );

    const [created] = await db
      .insert(studentHallPassLimitsTable)
      .values({
        studentId: studentId.trim(),
        dailyLimit,
        note: trimmedNote,
        parentApproved: parentApproved === true,
        active: true,
        createdByStaffId: staff.id,
        createdByName: `${staff.firstName} ${staff.lastName}`.trim(),
      })
      .returning();
    res.status(201).json(created);
  },
);

router.delete(
  "/student-hall-pass-limits/:id",
  requireBsAdmin,
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [updated] = await db
      .update(studentHallPassLimitsTable)
      .set({ active: false })
      .where(eq(studentHallPassLimitsTable.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Limit not found" });
      return;
    }
    res.json({ ok: true });
  },
);

export default router;
