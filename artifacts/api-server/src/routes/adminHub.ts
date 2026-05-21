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
  schoolsTable,
  studentsTable,
  issAdminLogsTable,
  issAdminLogAuditTable,
  issAttendanceDayTable,
  ossLogsTable,
  ossLogDaysTable,
  schoolClosedDaysTable,
  schoolSettingsTable,
  disciplineReasonsTable,
  issAcknowledgementsTable,
} from "@workspace/db";
import { and, eq, gte, lte, or, sql, inArray, desc } from "drizzle-orm";
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
// active discipline_reasons row (school-scoped OR district-scoped for
// the school's district), or a free-text reasonText fallback.
async function resolveReason(
  schoolId: number,
  body: Record<string, unknown>,
): Promise<{ reasonId: number | null; reasonText: string | null } | string> {
  const rid = body.reasonId;
  if (rid !== undefined && rid !== null && rid !== "") {
    const n = typeof rid === "number" ? rid : Number(rid);
    if (!Number.isInteger(n) || n <= 0) return "reasonId must be a positive integer";
    // Look up the school's district once so we can accept a district-
    // scoped reason from the master list as well.
    const [school] = await db
      .select({ districtId: schoolsTable.districtId })
      .from(schoolsTable)
      .where(eq(schoolsTable.id, schoolId));
    const [r] = await db
      .select()
      .from(disciplineReasonsTable)
      .where(
        and(
          eq(disciplineReasonsTable.id, n),
          school?.districtId
            ? or(
                eq(disciplineReasonsTable.schoolId, schoolId),
                eq(disciplineReasonsTable.districtId, school.districtId),
              )
            : eq(disciplineReasonsTable.schoolId, schoolId),
        ),
      );
    if (!r) return "Reason not found";
    return { reasonId: r.id, reasonText: r.label };
  }
  const free = cleanText(body.reasonText, 200);
  return { reasonId: null, reasonText: free };
}

// Parse and clamp the admin-entered "days for reports" field. Returns
// `null` when absent/empty (treated as not specified), a positive int
// up to 60 when present, or an error string for malformed input.
function parseDayCount(raw: unknown): number | null | string {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 60) {
    return "dayCount must be an integer between 1 and 60";
  }
  return n;
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
            localSisId: studentsTable.localSisId,
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

    const dayCountOrErr = parseDayCount(body.dayCount);
    if (typeof dayCountOrErr === "string") {
      res.status(400).json({ error: dayCountOrErr });
      return;
    }
    const dayCount = dayCountOrErr;

    // Capacity check: hard-block always, soft-warn requires override.
    const [settings] = await db
      .select({
        capacity: schoolSettingsTable.issDailyCapacity,
        behavior: schoolSettingsTable.issCapacityBehavior,
      })
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId));
    if (settings?.capacity && settings.capacity > 0) {
      // Use the query builder's inArray() so each date becomes its own
      // bound parameter. The earlier `day = ANY(${dates})` form failed
      // at runtime — node-pg binds the array as a single parameter and
      // Postgres saw `ANY(($N))` (a row, not an array). Same caveat is
      // already documented for the recent-list query above.
      const usage = await db
        .select({
          day: issAttendanceDayTable.day,
          used: sql<number>`COUNT(DISTINCT ${issAttendanceDayTable.studentId})::int`,
        })
        .from(issAttendanceDayTable)
        .where(
          and(
            eq(issAttendanceDayTable.schoolId, schoolId),
            inArray(issAttendanceDayTable.day, dates),
          ),
        )
        .groupBy(issAttendanceDayTable.day);
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
        dayCount,
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

// ---------- ISS log: audit trail ---------------------------------------
// Returns every edit/trim/delete event ever recorded for an assignment,
// newest first. Used by the Admin Hub detail drawer's "History" tab.
router.get(
  "/admin-hub/iss-logs/:id/audit",
  requireAdminHubMW(),
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const rows = await db
      .select()
      .from(issAdminLogAuditTable)
      .where(
        and(
          eq(issAdminLogAuditTable.adminLogId, id),
          eq(issAdminLogAuditTable.schoolId, schoolId),
        ),
      )
      .orderBy(desc(issAdminLogAuditTable.createdAt));
    res.json({ rows });
  },
);

// ---------- ISS edit helpers -------------------------------------------

// A day row counts as "served" if it has ANY signal that the kid showed
// up or was processed against it. Per replit.md:
//   - present_periods has at least one period, OR
//   - marked_served = true, OR
//   - rolled_from_date is not null (means an earlier day cascaded into
//     this one, so the assignment is mid-flight)
function isDayServed(d: typeof issAttendanceDayTable.$inferSelect): boolean {
  return (
    (d.presentPeriods?.length ?? 0) > 0 ||
    d.markedServed === true ||
    d.rolledFromDate !== null
  );
}

function validateEditReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t.length < 5) return null;
  return t.length > 500 ? t.slice(0, 500) : t;
}

// ---------- ISS log: edit reason / notes -------------------------------
// Editable on any non-cancelled assignment regardless of served status —
// reason and notes are administrative metadata, not date-bound facts.
router.patch(
  "/admin-hub/iss-logs/:id",
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
    const body = (req.body ?? {}) as Record<string, unknown>;
    const editReason = validateEditReason(body.editReason);
    if (!editReason) {
      res
        .status(400)
        .json({ error: "editReason is required (min 5 chars)" });
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
    if (log.cancelledAt) {
      res
        .status(409)
        .json({ error: "Cannot edit a cancelled assignment" });
      return;
    }

    // Build the patch. Only fields explicitly present in the body
    // mutate; missing keys are left alone (PATCH semantics).
    const patch: Partial<typeof issAdminLogsTable.$inferInsert> = {};
    const audits: Array<{
      action: string;
      beforeJson: Record<string, unknown>;
      afterJson: Record<string, unknown>;
    }> = [];

    if ("reasonId" in body || "reasonText" in body) {
      const reason = await resolveReason(schoolId, body);
      if (typeof reason === "string") {
        res.status(400).json({ error: reason });
        return;
      }
      if (
        reason.reasonId !== log.reasonId ||
        reason.reasonText !== log.reasonText
      ) {
        patch.reasonId = reason.reasonId;
        patch.reasonText = reason.reasonText;
        audits.push({
          action: "edit_reason",
          beforeJson: {
            reasonId: log.reasonId,
            reasonText: log.reasonText,
          },
          afterJson: {
            reasonId: reason.reasonId,
            reasonText: reason.reasonText,
          },
        });
      }
    }

    if ("notes" in body) {
      const newNotes = cleanText(body.notes, 4000);
      if (newNotes !== log.notes) {
        patch.notes = newNotes;
        audits.push({
          action: "edit_notes",
          beforeJson: { notes: log.notes },
          afterJson: { notes: newNotes },
        });
      }
    }

    if (Object.keys(patch).length === 0) {
      res.json({ log, changed: false });
      return;
    }

    const updated = await db.transaction(async (tx) => {
      const [u] = await tx
        .update(issAdminLogsTable)
        .set(patch)
        .where(
          and(
            eq(issAdminLogsTable.id, id),
            eq(issAdminLogsTable.schoolId, schoolId),
          ),
        )
        .returning();
      for (const a of audits) {
        await tx.insert(issAdminLogAuditTable).values({
          schoolId,
          adminLogId: id,
          actorStaffId: staff.id,
          actorDisplayName: staff.displayName,
          action: a.action,
          beforeJson: a.beforeJson,
          afterJson: a.afterJson,
          editReason,
        });
      }
      return u;
    });

    res.json({ log: updated, changed: true });
  },
);

// ---------- ISS log: edit dates (trim future + add days) ---------------
// Body: { editReason, dates: string[] }
// `dates` is the FULL desired set of days for the assignment. The
// server diffs against current rows:
//   - days in current but not in `dates`: removed (must be future or
//     today-unserved; any attempt to remove a served day → 409)
//   - days in `dates` but not in current: added (must be >= today)
// Days that have already been served are immutable and MUST appear
// in the new `dates` set unchanged.
router.patch(
  "/admin-hub/iss-logs/:id/dates",
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
    const body = (req.body ?? {}) as Record<string, unknown>;
    const editReason = validateEditReason(body.editReason);
    if (!editReason) {
      res
        .status(400)
        .json({ error: "editReason is required (min 5 chars)" });
      return;
    }
    const datesOrErr = parseDates(body.dates);
    if (typeof datesOrErr === "string") {
      res.status(400).json({ error: datesOrErr });
      return;
    }
    const desiredDates = new Set(datesOrErr);
    const today = new Date().toISOString().slice(0, 10);

    // Concurrency-safe: lock the parent log and all current day rows
    // inside the tx via SELECT ... FOR UPDATE, re-read state under the
    // lock, validate, mutate, then audit from the *actual* post-state.
    // Prevents the "served-between-validation-and-delete" TOCTOU that
    // would otherwise allow removing a day someone just marked served.
    let result:
      | { ok: true; changed: boolean; added: string[]; removed: string[] }
      | { ok: false; status: number; body: Record<string, unknown> };
    try {
      result = await db.transaction(async (tx) => {
        const [log] = await tx
          .select()
          .from(issAdminLogsTable)
          .where(
            and(
              eq(issAdminLogsTable.id, id),
              eq(issAdminLogsTable.schoolId, schoolId),
            ),
          )
          .for("update");
        if (!log) {
          return {
            ok: false as const,
            status: 404,
            body: { error: "Not found" },
          };
        }
        if (log.cancelledAt) {
          return {
            ok: false as const,
            status: 409,
            body: { error: "Cannot edit a cancelled assignment" },
          };
        }

        const currentDays = await tx
          .select()
          .from(issAttendanceDayTable)
          .where(
            and(
              eq(issAttendanceDayTable.adminLogId, id),
              eq(issAttendanceDayTable.schoolId, schoolId),
            ),
          )
          .for("update");

        const currentByDay = new Map(currentDays.map((d) => [d.day, d]));
        const currentDaySet = new Set(currentDays.map((d) => d.day));

        const servedDays = currentDays.filter(isDayServed).map((d) => d.day);
        const servedMissing = servedDays.filter((d) => !desiredDates.has(d));
        if (servedMissing.length > 0) {
          return {
            ok: false as const,
            status: 409,
            body: {
              error: "Cannot remove served days",
              servedDays: servedMissing,
            },
          };
        }

        const toAdd = [...desiredDates].filter((d) => !currentDaySet.has(d));
        const pastAdds = toAdd.filter((d) => d < today);
        if (pastAdds.length > 0) {
          return {
            ok: false as const,
            status: 400,
            body: { error: "Cannot add past dates", pastDates: pastAdds },
          };
        }

        const toRemove = [...currentDaySet].filter(
          (d) => !desiredDates.has(d),
        );
        const illegalRemoves = toRemove.filter((d) => {
          const row = currentByDay.get(d)!;
          if (d > today) return false;
          if (d === today && !isDayServed(row)) return false;
          return true;
        });
        if (illegalRemoves.length > 0) {
          return {
            ok: false as const,
            status: 409,
            body: {
              error: "Cannot remove past or served days",
              illegalDates: illegalRemoves,
            },
          };
        }

        if (toAdd.length === 0 && toRemove.length === 0) {
          return {
            ok: true as const,
            changed: false,
            added: [],
            removed: [],
          };
        }

        const before = currentDays.map((d) => d.day).sort();

        // .returning() so we audit what *actually* changed in the DB,
        // not what we intended — handles concurrent walk-in inserts
        // that hit the unique (school, student, day) index.
        const actuallyRemoved: string[] = [];
        if (toRemove.length > 0) {
          const deleted = await tx
            .delete(issAttendanceDayTable)
            .where(
              and(
                eq(issAttendanceDayTable.schoolId, schoolId),
                eq(issAttendanceDayTable.adminLogId, id),
                inArray(issAttendanceDayTable.day, toRemove),
              ),
            )
            .returning({ day: issAttendanceDayTable.day });
          for (const d of deleted) actuallyRemoved.push(d.day);
        }

        const actuallyAdded: string[] = [];
        for (const day of toAdd) {
          const inserted = await tx
            .insert(issAttendanceDayTable)
            .values({
              schoolId,
              studentId: log.studentId,
              day,
              source: "admin",
              adminLogId: id,
              notes: log.notes,
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
            .returning({ day: issAttendanceDayTable.day });
          for (const r of inserted) actuallyAdded.push(r.day);
        }

        if (actuallyRemoved.length === 0 && actuallyAdded.length === 0) {
          return {
            ok: true as const,
            changed: false,
            added: [],
            removed: [],
          };
        }

        // Audit from actual post-mutation state, not intent.
        const finalDays = await tx
          .select({ day: issAttendanceDayTable.day })
          .from(issAttendanceDayTable)
          .where(
            and(
              eq(issAttendanceDayTable.adminLogId, id),
              eq(issAttendanceDayTable.schoolId, schoolId),
            ),
          );
        const after = finalDays.map((r) => r.day).sort();

        if (actuallyRemoved.length > 0) {
          await tx.insert(issAdminLogAuditTable).values({
            schoolId,
            adminLogId: id,
            actorStaffId: staff.id,
            actorDisplayName: staff.displayName,
            action: "trim_days",
            beforeJson: { days: before, removed: actuallyRemoved.sort() },
            afterJson: { days: after },
            editReason,
          });
        }
        if (actuallyAdded.length > 0) {
          await tx.insert(issAdminLogAuditTable).values({
            schoolId,
            adminLogId: id,
            actorStaffId: staff.id,
            actorDisplayName: staff.displayName,
            action: "edit_dates",
            beforeJson: { days: before, added: actuallyAdded.sort() },
            afterJson: { days: after },
            editReason,
          });
        }

        return {
          ok: true as const,
          changed: true,
          added: actuallyAdded,
          removed: actuallyRemoved,
        };
      });
    } catch (e) {
      req.log.error({ err: e }, "iss-log dates edit failed");
      res.status(500).json({ error: "Edit failed" });
      return;
    }

    if (!result.ok) {
      res.status(result.status).json(result.body);
      return;
    }
    res.json({
      ok: true,
      changed: result.changed,
      added: result.added,
      removed: result.removed,
    });
  },
);

// ---------- ISS log: delete entire assignment --------------------------
// Body: { editReason }
// Only allowed when NO day on this assignment has been served (no
// present_periods, no marked_served, no rolled_from_date anywhere).
// Audit retention for partially-served assignments is intentional —
// use trim_days for that path instead.
router.delete(
  "/admin-hub/iss-logs/:id",
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
    const body = (req.body ?? {}) as Record<string, unknown>;
    const editReason = validateEditReason(body.editReason);
    if (!editReason) {
      res
        .status(400)
        .json({ error: "editReason is required (min 5 chars)" });
      return;
    }

    // Concurrency-safe: SELECT ... FOR UPDATE on both the parent log
    // and its day rows inside the tx, recheck zero-served under the
    // lock, then delete. Prevents the "served-between-check-and-delete"
    // TOCTOU where a parallel "mark served" could lose its only record.
    let result:
      | { ok: true }
      | { ok: false; status: number; body: Record<string, unknown> };
    try {
      result = await db.transaction(async (tx) => {
        const [log] = await tx
          .select()
          .from(issAdminLogsTable)
          .where(
            and(
              eq(issAdminLogsTable.id, id),
              eq(issAdminLogsTable.schoolId, schoolId),
            ),
          )
          .for("update");
        if (!log) {
          return {
            ok: false as const,
            status: 404,
            body: { error: "Not found" },
          };
        }
        const currentDays = await tx
          .select()
          .from(issAttendanceDayTable)
          .where(
            and(
              eq(issAttendanceDayTable.adminLogId, id),
              eq(issAttendanceDayTable.schoolId, schoolId),
            ),
          )
          .for("update");
        const servedDays = currentDays.filter(isDayServed).map((d) => d.day);
        if (servedDays.length > 0) {
          return {
            ok: false as const,
            status: 409,
            body: {
              error:
                "Cannot delete an assignment with served days. Trim future days instead.",
              servedDays,
            },
          };
        }
        const before = {
          log: {
            reasonId: log.reasonId,
            reasonText: log.reasonText,
            notes: log.notes,
            createdById: log.createdById,
            createdByName: log.createdByName,
            createdAt: log.createdAt,
          },
          days: currentDays.map((d) => d.day).sort(),
        };
        await tx
          .delete(issAttendanceDayTable)
          .where(
            and(
              eq(issAttendanceDayTable.schoolId, schoolId),
              eq(issAttendanceDayTable.adminLogId, id),
            ),
          );
        await tx
          .delete(issAdminLogsTable)
          .where(
            and(
              eq(issAdminLogsTable.id, id),
              eq(issAdminLogsTable.schoolId, schoolId),
            ),
          );
        // Audit row points at the now-deleted log id. The audit table
        // has no FK, so this is fine — auditors can still trace what
        // was deleted, by whom, and why.
        await tx.insert(issAdminLogAuditTable).values({
          schoolId,
          adminLogId: id,
          actorStaffId: staff.id,
          actorDisplayName: staff.displayName,
          action: "delete_assignment",
          beforeJson: before,
          afterJson: null,
          editReason,
        });
        return { ok: true as const };
      });
    } catch (e) {
      req.log.error({ err: e }, "iss-log delete failed");
      res.status(500).json({ error: "Delete failed" });
      return;
    }

    if (!result.ok) {
      res.status(result.status).json(result.body);
      return;
    }
    res.json({ ok: true, deleted: id });
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

    const dayCountOrErr = parseDayCount(body.dayCount);
    if (typeof dayCountOrErr === "string") {
      res.status(400).json({ error: dayCountOrErr });
      return;
    }
    const dayCount = dayCountOrErr;

    const [log] = await db
      .insert(ossLogsTable)
      .values({
        schoolId,
        studentId,
        reasonId: reason.reasonId,
        reasonText: reason.reasonText,
        notes,
        dayCount,
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
    // class_sections's teacher FK column is `teacher_staff_id` (renamed
    // when staff replaced legacy teachers). And we cannot use
    // `student_id = ANY(${sids})` because node-pg collapses the array
    // into a single parameter — expand the IN list explicitly via
    // sql.join so each id binds to its own placeholder.
    const sidsList = sql.join(
      sids.map((s) => sql`${s}`),
      sql`, `,
    );
    const expected = (await db.execute(
      sql`SELECT sr.student_id AS student_id,
                 st.local_sis_id AS local_sis_id,
                 cs.teacher_staff_id AS teacher_id,
                 cs.period AS period,
                 s.display_name AS teacher_name,
                 TRIM(CONCAT_WS(' ', st.first_name, st.last_name)) AS student_name
            FROM section_roster sr
            JOIN class_sections cs ON cs.id = sr.section_id
            JOIN staff s ON s.id = cs.teacher_staff_id
            LEFT JOIN students st
              ON st.school_id = cs.school_id
             AND st.student_id = sr.student_id
           WHERE cs.school_id = ${schoolId}
             AND sr.student_id IN (${sidsList})
             AND cs.period IS NOT NULL`,
    )).rows as {
      student_id: string;
      local_sis_id: string | null;
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
      localSisId: string | null;
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
        localSisId: e.local_sis_id ?? null,
        studentName: (e.student_name ?? "").trim() || (e.local_sis_id ?? ""),
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
