// Admin Hub — central place for ISS / OSS multi-day discipline logging.
//
// Visible to: SuperUser, DistrictAdmin, Admin, Dean, BehaviorSpecialist,
// MTSSCoordinator. (Print Overall Report adds SchoolPsychologist +
// GuidanceCounselor — that gate lives on the report route, not here.)
//
// Endpoints:
//   GET  /api/admin-hub/recent          — combined ISS + OSS recent assignments
//   GET  /api/admin-hub/iss-logs/:id    — single ISS assignment with day rows
//   POST /api/admin-hub/iss-logs        — create N-day ISS assignment
//   POST /api/admin-hub/iss-logs/:id/cancel — soft-cancel an ISS assignment
//   GET  /api/admin-hub/oss-logs/:id    — single OSS assignment with day rows
//   POST /api/admin-hub/oss-logs        — create N-day OSS assignment
//   POST /api/admin-hub/oss-logs/:id/cancel — soft-cancel an OSS assignment
//   GET  /api/admin-hub/iss-capacity    — per-day usage in [from, to] window
//   GET  /api/admin-hub/acknowledgements — yesterday/today ISS-prep rollup
import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  staffTable,
  studentsTable,
  issAdminLogsTable,
  issAttendanceDayTable,
  ossLogsTable,
  ossLogDaysTable,
  schoolClosedDaysTable,
  schoolSettingsTable,
  disciplineReasonsTable,
  issAcknowledgementsTable,
} from "@workspace/db";
import { and, eq, gte, lte, sql, inArray, desc } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

// Admin Hub access — anyone whose job involves logging discipline.
function canUseAdminHub(s: StaffRow): boolean {
  return Boolean(
    s.isSuperUser ||
      s.isDistrictAdmin ||
      s.isAdmin ||
      s.isDean ||
      s.isBehaviorSpecialist ||
      s.isMtssCoordinator,
  );
}

function requireAdminHubMW() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!canUseAdminHub(staff)) {
      res.status(403).json({ error: "Admin Hub role required" });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

// ---------- helpers ----------------------------------------------------

function isYmd(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function cleanText(s: unknown, max = 4000): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

// Look up the student card the modal needs. Scoped by schoolId per the
// multi-tenancy gotcha.
async function resolveStudent(schoolId: number, studentId: string) {
  const [stu] = await db
    .select()
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, studentId),
        eq(studentsTable.schoolId, schoolId),
      ),
    );
  return stu ?? null;
}

// Resolve & validate `reason` body field. Either reasonId pointing at an
// active discipline_reasons row, or a free-text reasonText fallback.
async function resolveReason(
  schoolId: number,
  body: Record<string, unknown>,
): Promise<{ reasonId: number | null; reasonText: string | null } | string> {
  const rid = body.reasonId;
  if (rid !== undefined && rid !== null && rid !== "") {
    const n = typeof rid === "number" ? rid : Number(rid);
    if (!Number.isInteger(n) || n <= 0) return "reasonId must be a positive integer";
    const [r] = await db
      .select()
      .from(disciplineReasonsTable)
      .where(
        and(
          eq(disciplineReasonsTable.id, n),
          eq(disciplineReasonsTable.schoolId, schoolId),
        ),
      );
    if (!r) return "Reason not found";
    return { reasonId: r.id, reasonText: r.label };
  }
  const free = cleanText(body.reasonText, 200);
  return { reasonId: null, reasonText: free };
}

// Validate the body's `dates` array → unique YYYY-MM-DD list.
function parseDates(raw: unknown): string[] | string {
  if (!Array.isArray(raw) || raw.length === 0) {
    return "dates must be a non-empty array of YYYY-MM-DD strings";
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (!isYmd(v)) return `Invalid date "${String(v)}" (expected YYYY-MM-DD)`;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  out.sort();
  return out;
}

// ---------- ISS capacity (per-day usage in a window) -------------------
router.get(
  "/admin-hub/iss-capacity",
  requireAdminHubMW(),
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const from = String(req.query.from ?? "");
    const to = String(req.query.to ?? "");
    if (!isYmd(from) || !isYmd(to)) {
      res
        .status(400)
        .json({ error: "from and to query params required (YYYY-MM-DD)" });
      return;
    }

    const [settings] = await db
      .select({
        capacity: schoolSettingsTable.issDailyCapacity,
        behavior: schoolSettingsTable.issCapacityBehavior,
      })
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId));

    // Count unique student-days per day across all sources.
    const rows = (await db.execute(
      sql`SELECT day::text AS day, COUNT(DISTINCT student_id)::int AS used
          FROM iss_attendance_day
          WHERE school_id = ${schoolId}
            AND day BETWEEN ${from} AND ${to}
          GROUP BY day`,
    )).rows as { day: string; used: number }[];

    // Closed days in the window so the modal can grey them out.
    const closed = await db
      .select({ day: schoolClosedDaysTable.day, label: schoolClosedDaysTable.label })
      .from(schoolClosedDaysTable)
      .where(
        and(
          eq(schoolClosedDaysTable.schoolId, schoolId),
          gte(schoolClosedDaysTable.day, from),
          lte(schoolClosedDaysTable.day, to),
        ),
      );

    res.json({
      capacity: settings?.capacity ?? null,
      behavior: settings?.behavior ?? "soft",
      usage: rows,
      closedDays: closed,
    });
  },
);

// ---------- Recent feed (combined ISS + OSS) ---------------------------
router.get(
  "/admin-hub/recent",
  requireAdminHubMW(),
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const limit = Math.min(
      Math.max(Number(req.query.limit ?? 25) || 25, 1),
      100,
    );

    const issLogs = await db
      .select()
      .from(issAdminLogsTable)
      .where(eq(issAdminLogsTable.schoolId, schoolId))
      .orderBy(desc(issAdminLogsTable.createdAt))
      .limit(limit);
    const ossLogs = await db
      .select()
      .from(ossLogsTable)
      .where(eq(ossLogsTable.schoolId, schoolId))
      .orderBy(desc(ossLogsTable.createdAt))
      .limit(limit);

    // Day-row counts so the recent list can show "3 days" without a
    // second client round trip.
    // Day-row counts via the drizzle query builder. The earlier raw
    // `ANY(${array})` form failed at runtime — node-pg binds the array
    // as a single parameter, so Postgres saw `ANY(($2))` (a row, not an
    // array) and rejected the query. `inArray()` expands to an IN list
    // with one placeholder per id, which is correct and well-typed.
    const issIds = issLogs.map((l) => l.id);
    const issDayRows = issIds.length
      ? await db
          .select({
            id: issAttendanceDayTable.adminLogId,
            days: sql<number>`COUNT(*)::int`,
          })
          .from(issAttendanceDayTable)
          .where(
            and(
              eq(issAttendanceDayTable.schoolId, schoolId),
              inArray(issAttendanceDayTable.adminLogId, issIds),
            ),
          )
          .groupBy(issAttendanceDayTable.adminLogId)
      : [];
    const issDayMap = new Map(
      issDayRows
        .filter((r): r is { id: number; days: number } => r.id !== null)
        .map((r) => [r.id, r.days]),
    );

    const ossIds = ossLogs.map((l) => l.id);
    const ossDayRows = ossIds.length
      ? await db
          .select({
            id: ossLogDaysTable.logId,
            days: sql<number>`COUNT(*) FILTER (WHERE NOT cancelled)::int`,
          })
          .from(ossLogDaysTable)
          .where(
            and(
              eq(ossLogDaysTable.schoolId, schoolId),
              inArray(ossLogDaysTable.logId, ossIds),
            ),
          )
          .groupBy(ossLogDaysTable.logId)
      : [];
    const ossDayMap = new Map(ossDayRows.map((r) => [r.id, r.days]));

    // Hydrate student names so the list reads naturally.
    const sids = Array.from(
      new Set([...issLogs, ...ossLogs].map((l) => l.studentId)),
    );
    const students = sids.length
      ? await db
          .select({
            studentId: studentsTable.studentId,
            firstName: studentsTable.firstName,
            lastName: studentsTable.lastName,
            grade: studentsTable.grade,
          })
          .from(studentsTable)
          .where(
            and(
              eq(studentsTable.schoolId, schoolId),
              inArray(studentsTable.studentId, sids),
            ),
          )
      : [];
    const stuMap = new Map(students.map((s) => [s.studentId, s]));

    const merged = [
      ...issLogs.map((l) => ({
        kind: "iss" as const,
        id: l.id,
        studentId: l.studentId,
        student: stuMap.get(l.studentId) ?? null,
        reasonText: l.reasonText,
        notes: l.notes,
        createdById: l.createdById,
        createdByName: l.createdByName,
        cancelledAt: l.cancelledAt,
        createdAt: l.createdAt,
        dayCount: issDayMap.get(l.id) ?? 0,
      })),
      ...ossLogs.map((l) => ({
        kind: "oss" as const,
        id: l.id,
        studentId: l.studentId,
        student: stuMap.get(l.studentId) ?? null,
        reasonText: l.reasonText,
        notes: l.notes,
        createdById: l.createdById,
        createdByName: l.createdByName,
        cancelledAt: l.cancelledAt,
        createdAt: l.createdAt,
        dayCount: ossDayMap.get(l.id) ?? 0,
      })),
    ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    res.json({ rows: merged.slice(0, limit) });
  },
);

// ---------- ISS log: detail --------------------------------------------
router.get(
  "/admin-hub/iss-logs/:id",
  requireAdminHubMW(),
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [log] = await db
      .select()
      .from(issAdminLogsTable)
      .where(
        and(
          eq(issAdminLogsTable.id, id),
          eq(issAdminLogsTable.schoolId, schoolId),
        ),
      );
    if (!log) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const days = await db
      .select()
      .from(issAttendanceDayTable)
      .where(
        and(
          eq(issAttendanceDayTable.adminLogId, id),
          eq(issAttendanceDayTable.schoolId, schoolId),
        ),
      );
    res.json({ log, days });
  },
);

// ---------- ISS log: create --------------------------------------------
router.post(
  "/admin-hub/iss-logs",
  requireAdminHubMW(),
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: StaffRow }).staff;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const studentId = cleanText(body.studentId, 64);
    if (!studentId) {
      res.status(400).json({ error: "studentId is required" });
      return;
    }
    const stu = await resolveStudent(schoolId, studentId);
    if (!stu) {
      res.status(404).json({ error: "Student not found" });
      return;
    }

    const reason = await resolveReason(schoolId, body);
    if (typeof reason === "string") {
      res.status(400).json({ error: reason });
      return;
    }

    const datesOrErr = parseDates(body.dates);
    if (typeof datesOrErr === "string") {
      res.status(400).json({ error: datesOrErr });
      return;
    }
    const dates = datesOrErr;

    const notes = cleanText(body.notes, 4000);
    const overrideCapacity = Boolean(body.overrideCapacity);

    // Capacity check: hard-block always, soft-warn requires override.
    const [settings] = await db
      .select({
        capacity: schoolSettingsTable.issDailyCapacity,
        behavior: schoolSettingsTable.issCapacityBehavior,
      })
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId));
    if (settings?.capacity && settings.capacity > 0) {
      const usage = (await db.execute(
        sql`SELECT day::text AS day, COUNT(DISTINCT student_id)::int AS used
            FROM iss_attendance_day
            WHERE school_id = ${schoolId}
              AND day = ANY(${dates})
            GROUP BY day`,
      )).rows as { day: string; used: number }[];
      const overflow = usage
        .filter((u) => u.used >= (settings.capacity as number))
        .map((u) => u.day);
      if (overflow.length > 0) {
        if (settings.behavior === "hard") {
          res.status(409).json({
            error: "ISS capacity full",
            overflowDates: overflow,
            capacity: settings.capacity,
            behavior: "hard",
          });
          return;
        }
        if (!overrideCapacity) {
          res.status(409).json({
            error: "ISS capacity warning",
            overflowDates: overflow,
            capacity: settings.capacity,
            behavior: "soft",
            requiresConfirm: true,
          });
          return;
        }
      }
    }

    // Insert parent log row + per-day attendance rows. Each day row is
    // upserted so re-saving an existing day is a no-op rather than a
    // dupe-key crash. Days that are already on the ISS roster (e.g. an
    // ISS Teacher walk-in earlier today) keep their original source.
    const [log] = await db
      .insert(issAdminLogsTable)
      .values({
        schoolId,
        studentId,
        reasonId: reason.reasonId,
        reasonText: reason.reasonText,
        notes,
        createdById: staff.id,
        createdByName: staff.displayName,
      })
      .returning();

    const inserted: number[] = [];
    const skipped: string[] = [];
    for (const day of dates) {
      const result = await db
        .insert(issAttendanceDayTable)
        .values({
          schoolId,
          studentId,
          day,
          source: "admin",
          adminLogId: log.id,
          notes,
          addedById: staff.id,
          addedByName: staff.displayName,
        })
        .onConflictDoNothing({
          target: [
            issAttendanceDayTable.studentId,
            issAttendanceDayTable.day,
            issAttendanceDayTable.schoolId,
          ],
        })
        .returning({ id: issAttendanceDayTable.id });
      if (result.length > 0) inserted.push(result[0].id);
      else skipped.push(day);
    }

    res.status(201).json({
      log,
      insertedDayIds: inserted,
      skippedDates: skipped,
    });
  },
);

// ---------- ISS log: cancel --------------------------------------------
router.post(
  "/admin-hub/iss-logs/:id/cancel",
  requireAdminHubMW(),
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: StaffRow }).staff;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    // Only delete future / not-yet-arrived day rows. Past days are
    // historical record. Today's row stays so the ISS Teacher's
    // dashboard isn't yanked out from under them.
    const today = new Date().toISOString().slice(0, 10);
    await db
      .delete(issAttendanceDayTable)
      .where(
        and(
          eq(issAttendanceDayTable.schoolId, schoolId),
          eq(issAttendanceDayTable.adminLogId, id),
          gte(issAttendanceDayTable.day, today),
          eq(issAttendanceDayTable.markedServed, false),
        ),
      );
    const [updated] = await db
      .update(issAdminLogsTable)
      .set({
        cancelledAt: new Date(),
        cancelledById: staff.id,
        cancelledByName: staff.displayName,
      })
      .where(
        and(
          eq(issAdminLogsTable.id, id),
          eq(issAdminLogsTable.schoolId, schoolId),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ ok: true, log: updated });
  },
);

// ---------- OSS log: detail --------------------------------------------
router.get(
  "/admin-hub/oss-logs/:id",
  requireAdminHubMW(),
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [log] = await db
      .select()
      .from(ossLogsTable)
      .where(and(eq(ossLogsTable.id, id), eq(ossLogsTable.schoolId, schoolId)));
    if (!log) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const days = await db
      .select()
      .from(ossLogDaysTable)
      .where(
        and(eq(ossLogDaysTable.logId, id), eq(ossLogDaysTable.schoolId, schoolId)),
      );
    res.json({ log, days });
  },
);

// ---------- OSS log: create --------------------------------------------
router.post(
  "/admin-hub/oss-logs",
  requireAdminHubMW(),
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: StaffRow }).staff;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const studentId = cleanText(body.studentId, 64);
    if (!studentId) {
      res.status(400).json({ error: "studentId is required" });
      return;
    }
    const stu = await resolveStudent(schoolId, studentId);
    if (!stu) {
      res.status(404).json({ error: "Student not found" });
      return;
    }

    const reason = await resolveReason(schoolId, body);
    if (typeof reason === "string") {
      res.status(400).json({ error: reason });
      return;
    }

    const datesOrErr = parseDates(body.dates);
    if (typeof datesOrErr === "string") {
      res.status(400).json({ error: datesOrErr });
      return;
    }
    const dates = datesOrErr;
    const notes = cleanText(body.notes, 4000);

    const [log] = await db
      .insert(ossLogsTable)
      .values({
        schoolId,
        studentId,
        reasonId: reason.reasonId,
        reasonText: reason.reasonText,
        notes,
        createdById: staff.id,
        createdByName: staff.displayName,
      })
      .returning();

    const skipped: string[] = [];
    const inserted: number[] = [];
    for (const day of dates) {
      const result = await db
        .insert(ossLogDaysTable)
        .values({ schoolId, logId: log.id, studentId, day })
        .onConflictDoNothing({
          target: [
            ossLogDaysTable.schoolId,
            ossLogDaysTable.studentId,
            ossLogDaysTable.day,
          ],
        })
        .returning({ id: ossLogDaysTable.id });
      if (result.length > 0) inserted.push(result[0].id);
      else skipped.push(day);
    }

    res.status(201).json({
      log,
      insertedDayIds: inserted,
      skippedDates: skipped,
    });
  },
);

// ---------- OSS log: cancel --------------------------------------------
router.post(
  "/admin-hub/oss-logs/:id/cancel",
  requireAdminHubMW(),
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: StaffRow }).staff;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    await db
      .update(ossLogDaysTable)
      .set({ cancelled: true })
      .where(
        and(
          eq(ossLogDaysTable.schoolId, schoolId),
          eq(ossLogDaysTable.logId, id),
          gte(ossLogDaysTable.day, today),
        ),
      );
    const [updated] = await db
      .update(ossLogsTable)
      .set({
        cancelledAt: new Date(),
        cancelledById: staff.id,
        cancelledByName: staff.displayName,
      })
      .where(and(eq(ossLogsTable.id, id), eq(ossLogsTable.schoolId, schoolId)))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ ok: true, log: updated });
  },
);

// ---------- Acknowledgement rollup -------------------------------------
// "Yesterday's ISS prep: 4 of 5 teachers acknowledged" — and which ones
// did not. Compares the set of distinct (teacher, period) pairs whose
// students were on the admin-logged ISS roster on `date` against the
// acknowledgements table.
router.get(
  "/admin-hub/acknowledgements",
  requireAdminHubMW(),
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const date =
      typeof req.query.date === "string" && isYmd(req.query.date)
        ? req.query.date
        : new Date().toISOString().slice(0, 10);

    // Students on admin-logged ISS for the date.
    const issStudents = (await db.execute(
      sql`SELECT DISTINCT student_id FROM iss_attendance_day
          WHERE school_id = ${schoolId}
            AND day = ${date}
            AND source = 'admin'`,
    )).rows as { student_id: string }[];
    const sids = issStudents.map((r) => r.student_id);
    if (sids.length === 0) {
      res.json({ date, students: [], totalExpected: 0, totalAcknowledged: 0 });
      return;
    }

    // (student × teacher × period) pairs from class_sections + section_roster
    // that the teacher should ack today. Joined to staff for display name
    // and students for the student's display name.
    const expected = (await db.execute(
      sql`SELECT sr.student_id AS student_id,
                 cs.teacher_id AS teacher_id,
                 cs.period AS period,
                 s.display_name AS teacher_name,
                 TRIM(CONCAT_WS(' ', st.first_name, st.last_name)) AS student_name
            FROM section_roster sr
            JOIN class_sections cs ON cs.id = sr.section_id
            JOIN staff s ON s.id = cs.teacher_id
            LEFT JOIN students st
              ON st.school_id = cs.school_id
             AND st.student_id = sr.student_id
           WHERE cs.school_id = ${schoolId}
             AND sr.student_id = ANY(${sids})
             AND cs.period IS NOT NULL`,
    )).rows as {
      student_id: string;
      teacher_id: number;
      period: number;
      teacher_name: string;
      student_name: string | null;
    }[];

    const acks = await db
      .select()
      .from(issAcknowledgementsTable)
      .where(
        and(
          eq(issAcknowledgementsTable.schoolId, schoolId),
          eq(issAcknowledgementsTable.day, date),
          inArray(issAcknowledgementsTable.studentId, sids),
        ),
      );
    const ackKey = (s: string, t: number, p: number) => `${s}|${t}|${p}`;
    const ackSet = new Set(
      acks.map((a) => ackKey(a.studentId, a.teacherStaffId, a.period)),
    );

    type Row = {
      studentId: string;
      studentName: string;
      teacherId: number;
      teacherName: string;
      period: number;
      acknowledged: boolean;
      method: string | null;
    };
    const rows: Row[] = expected.map((e) => {
      const ack = acks.find(
        (a) =>
          a.studentId === e.student_id &&
          a.teacherStaffId === e.teacher_id &&
          a.period === e.period,
      );
      return {
        studentId: e.student_id,
        studentName: (e.student_name ?? "").trim() || e.student_id,
        teacherId: e.teacher_id,
        teacherName: e.teacher_name,
        period: e.period,
        acknowledged: ackSet.has(ackKey(e.student_id, e.teacher_id, e.period)),
        method: ack?.method ?? null,
      };
    });

    res.json({
      date,
      students: rows,
      totalExpected: rows.length,
      totalAcknowledged: rows.filter((r) => r.acknowledged).length,
    });
  },
);

export default router;
