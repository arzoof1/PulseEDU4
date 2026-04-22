import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  issAttendanceDayTable,
  staffTable,
  studentsTable,
  bellSchedulesTable,
  bellSchedulePeriodsTable,
} from "@workspace/db";
import { eq, and, asc, sql } from "drizzle-orm";
import { todayInSchoolTz } from "../lib/issDate";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

const canViewAttendance = (s: StaffRow) =>
  s.isSuperUser ||
  s.isAdmin ||
  s.isIssTeacher ||
  s.isBehaviorSpecialist ||
  s.isDean ||
  s.isMtssCoordinator;

function requireAttendanceMW() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!canViewAttendance(staff)) {
      res.status(403).json({ error: "ISS dashboard role required" });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

router.get(
  "/iss-attendance",
  requireAttendanceMW(),
  async (req: Request, res: Response) => {
    const schoolId = req.schoolId;
    if (!schoolId) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    const dateParam =
      typeof req.query.date === "string" && req.query.date.trim()
        ? req.query.date.trim()
        : todayInSchoolTz();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      res.status(400).json({ error: "date must be YYYY-MM-DD" });
      return;
    }
    // D5: only return attendance rows for the caller's school. Otherwise
    // a dean in school A would see school B's roster on the same day.
    const rows = await db
      .select()
      .from(issAttendanceDayTable)
      .where(
        and(
          eq(issAttendanceDayTable.day, dateParam),
          eq(issAttendanceDayTable.schoolId, schoolId),
        ),
      );
    res.json({ date: dateParam, rows });
  },
);

// Read-only endpoint giving today's bell-schedule periods to anyone with
// ISS-dashboard access (the main /bell-schedules endpoint is gated to
// admin/MTSS/BehaviorSpec only, which excludes IssTeacher/Dean).
router.get(
  "/iss-attendance/today-periods",
  requireAttendanceMW(),
  async (req: Request, res: Response) => {
    const schoolId = req.schoolId;
    if (!schoolId) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    // Bell schedule is per-school (D4): only consider schedules for the
    // caller's active school, otherwise an ISS dean in school A would see
    // school B's "today" periods.
    const schedules = await db
      .select()
      .from(bellSchedulesTable)
      .where(
        and(
          eq(bellSchedulesTable.active, true),
          eq(bellSchedulesTable.schoolId, schoolId),
        ),
      );
    const def =
      schedules.find((s) => s.isDefault) ?? schedules[0] ?? null;
    if (!def) {
      res.json({ scheduleId: null, scheduleName: null, periods: [] });
      return;
    }
    const periods = await db
      .select()
      .from(bellSchedulePeriodsTable)
      .where(eq(bellSchedulePeriodsTable.scheduleId, def.id))
      .orderBy(asc(bellSchedulePeriodsTable.periodNumber));
    res.json({ scheduleId: def.id, scheduleName: def.name, periods });
  },
);

router.put(
  "/iss-attendance/:id",
  requireAttendanceMW(),
  async (req: Request, res: Response) => {
    const schoolId = req.schoolId;
    if (!schoolId) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const body = req.body ?? {};
    const update: {
      presentPeriods?: number[];
      notes?: string | null;
      updatedAt: Date;
    } = { updatedAt: new Date() };
    if (body.presentPeriods !== undefined) {
      if (!Array.isArray(body.presentPeriods)) {
        res
          .status(400)
          .json({ error: "presentPeriods must be an array of integers 1-20" });
        return;
      }
      const cleaned: number[] = [];
      for (const raw of body.presentPeriods) {
        const n = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 20) {
          res.status(400).json({
            error: `presentPeriods entries must be integers 1-20 (got ${String(raw)})`,
          });
          return;
        }
        cleaned.push(n);
      }
      update.presentPeriods = Array.from(new Set(cleaned)).sort(
        (a, b) => a - b,
      );
    }
    if (body.notes === null) {
      update.notes = null;
    } else if (typeof body.notes === "string") {
      update.notes = body.notes.trim() || null;
    } else if (body.notes !== undefined) {
      res.status(400).json({ error: "notes must be a string or null" });
      return;
    }
    const [row] = await db
      .update(issAttendanceDayTable)
      .set(update)
      .where(
        and(
          eq(issAttendanceDayTable.id, id),
          eq(issAttendanceDayTable.schoolId, schoolId),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Attendance row not found" });
      return;
    }
    res.json(row);
  },
);

// Helper used by other routes (manual roster add, pullout arrival).
// schoolId is required so the inserted row is stamped to the correct
// tenant — callers pass it from req.schoolId or staff.schoolId.
export async function upsertIssAttendance(opts: {
  studentId: string;
  schoolId: number;
  source: "manual" | "pullout";
  pulloutId?: number | null;
  dispatchedByName?: string | null;
  verifiedByName?: string | null;
  addedById?: number | null;
  addedByName?: string | null;
  notes?: string | null;
}): Promise<void> {
  const day = todayInSchoolTz();
  // Atomic upsert: insert if not present, do nothing on conflict.
  await db
    .insert(issAttendanceDayTable)
    .values({
      studentId: opts.studentId,
      schoolId: opts.schoolId,
      day,
      source: opts.source,
      pulloutId: opts.pulloutId ?? null,
      dispatchedByName: opts.dispatchedByName ?? null,
      verifiedByName: opts.verifiedByName ?? null,
      presentPeriods: [],
      notes: opts.notes ?? null,
      addedById: opts.addedById ?? null,
      addedByName: opts.addedByName ?? null,
    })
    .onConflictDoNothing({
      // D5: conflict target must include schoolId — matches the
      // (student_id, day, school_id) unique index. Without it, two schools
      // would collide on the same student+day even though they're separate
      // tenants.
      target: [
        issAttendanceDayTable.studentId,
        issAttendanceDayTable.day,
        issAttendanceDayTable.schoolId,
      ],
    });
  // If a pullout arrival comes in for a row that started manual, enrich it
  // with pullout details (only fills nullable pullout fields). Scoped by
  // schoolId so a pullout in school A can't enrich school B's manual row.
  if (opts.source === "pullout" && opts.pulloutId) {
    await db
      .update(issAttendanceDayTable)
      .set({
        source: "pullout",
        pulloutId: opts.pulloutId,
        dispatchedByName: sql`COALESCE(${issAttendanceDayTable.dispatchedByName}, ${opts.dispatchedByName ?? null})`,
        verifiedByName: sql`COALESCE(${issAttendanceDayTable.verifiedByName}, ${opts.verifiedByName ?? null})`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(issAttendanceDayTable.studentId, opts.studentId),
          eq(issAttendanceDayTable.day, day),
          eq(issAttendanceDayTable.source, "manual"),
          eq(issAttendanceDayTable.schoolId, opts.schoolId),
        ),
      );
  }
}

// Re-export for type completeness.
export const _studentsTableRef = studentsTable;

export default router;
