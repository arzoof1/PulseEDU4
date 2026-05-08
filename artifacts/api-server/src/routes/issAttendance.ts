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

// Mark a row as "served" — the student was absent today but has been
// granted credit for the day (typically because admin reviewed the absence
// and decided not to roll it forward). Suppresses any future automatic
// rollover for this row.
router.post(
  "/iss-attendance/:id/mark-served",
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
    const [row] = await db
      .update(issAttendanceDayTable)
      .set({ markedServed: true, updatedAt: new Date() })
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

// Apply rollover for the given date (defaults to yesterday). For every
// admin-logged ISS row that day with no presentPeriods recorded and
// markedServed=false, copy the assignment forward to the next non-closed
// weekday, stamping rolledFromDate with the original day. Idempotent —
// a second call same day finds no candidates.
router.post(
  "/iss-attendance/rollover",
  requireAttendanceMW(),
  async (req: Request, res: Response) => {
    const schoolId = req.schoolId;
    if (!schoolId) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    const day =
      typeof req.body?.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.body.day)
        ? req.body.day
        : (() => {
            // Default to "yesterday" in school local time.
            const t = todayInSchoolTz();
            const d = new Date(`${t}T12:00:00`);
            d.setDate(d.getDate() - 1);
            return d.toISOString().slice(0, 10);
          })();

    // Closed days set for skipping when computing the next school day.
    const closedRows = (await db.execute(
      sql`SELECT day::text AS day FROM school_closed_days WHERE school_id = ${schoolId}`,
    )).rows as { day: string }[];
    const closedSet = new Set(closedRows.map((r) => r.day));
    const isWeekend = (ymd: string) => {
      const d = new Date(`${ymd}T12:00:00`);
      const dow = d.getDay();
      return dow === 0 || dow === 6;
    };
    const nextSchoolDay = (ymd: string): string => {
      const d = new Date(`${ymd}T12:00:00`);
      // Hard cap at 14 lookahead days to avoid runaway loops.
      for (let i = 0; i < 14; i++) {
        d.setDate(d.getDate() + 1);
        const out = d.toISOString().slice(0, 10);
        if (!isWeekend(out) && !closedSet.has(out)) return out;
      }
      return new Date(`${ymd}T12:00:00`).toISOString().slice(0, 10);
    };

    // Candidates: admin-logged rows on `day` that were "absent" (no
    // presentPeriods) and have not been marked served and have not
    // already been rolled (no descendant referencing this day).
    const candidates = await db
      .select()
      .from(issAttendanceDayTable)
      .where(
        and(
          eq(issAttendanceDayTable.schoolId, schoolId),
          eq(issAttendanceDayTable.day, day),
          eq(issAttendanceDayTable.source, "admin"),
          eq(issAttendanceDayTable.markedServed, false),
        ),
      );

    const rolled: Array<{ studentId: string; from: string; to: string }> = [];
    for (const c of candidates) {
      if ((c.presentPeriods ?? []).length > 0) continue;
      const target = nextSchoolDay(day);
      // Don't roll into a day they already have an ISS row for.
      const existing = await db
        .select({ id: issAttendanceDayTable.id })
        .from(issAttendanceDayTable)
        .where(
          and(
            eq(issAttendanceDayTable.schoolId, schoolId),
            eq(issAttendanceDayTable.studentId, c.studentId),
            eq(issAttendanceDayTable.day, target),
          ),
        );
      if (existing.length > 0) continue;
      await db.insert(issAttendanceDayTable).values({
        schoolId,
        studentId: c.studentId,
        day: target,
        source: "admin",
        adminLogId: c.adminLogId,
        rolledFromDate: day,
        notes: c.notes,
        addedById: c.addedById,
        addedByName: c.addedByName,
      });
      rolled.push({ studentId: c.studentId, from: day, to: target });
    }
    res.json({ day, rolledCount: rolled.length, rolled });
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
