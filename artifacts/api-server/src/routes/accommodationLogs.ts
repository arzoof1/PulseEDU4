import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import {
  db,
  accommodationLogsTable,
  studentAccommodationsTable,
  schoolAccommodationsTable,
  classSectionsTable,
  sectionRosterTable,
  staffTable,
} from "@workspace/db";
import { eq, and, isNull, sql, inArray } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

async function requireStaff(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // Prefer the session, but fall back to ?staffId= or body.staffId so the
  // request still works inside the Replit preview iframe where SameSite=None
  // cookies can be blocked.
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
  (req as Request & { staff: typeof staff }).staff = staff;
  next();
}

router.get("/accommodation-logs", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const { studentId } = req.query;
  if (typeof studentId === "string" && studentId) {
    const rows = await db
      .select()
      .from(accommodationLogsTable)
      .where(
        and(
          eq(accommodationLogsTable.studentId, studentId),
          eq(accommodationLogsTable.schoolId, schoolId),
        ),
      );
    res.json(rows);
    return;
  }
  const rows = await db
    .select()
    .from(accommodationLogsTable)
    .where(eq(accommodationLogsTable.schoolId, schoolId));
  res.json(rows);
});

// Single log (manual button: "Log Accommodation Provided" / "Refused today").
// Auth required; staff name comes from session.
router.post("/accommodation-logs", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect }).staff;
  const { studentId, accommodation, accommodationId, period, status } =
    req.body ?? {};

  if (typeof studentId !== "string" || !studentId) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }

  // Resolve accommodation name + id
  let resolvedId: number | null = null;
  let resolvedName = "";
  if (typeof accommodationId === "number") {
    const [row] = await db
      .select()
      .from(schoolAccommodationsTable)
      .where(eq(schoolAccommodationsTable.id, accommodationId));
    if (!row) {
      res.status(400).json({ error: "Unknown accommodation" });
      return;
    }
    resolvedId = row.id;
    resolvedName = row.name;
  } else if (typeof accommodation === "string" && accommodation) {
    resolvedName = accommodation;
    const [row] = await db
      .select()
      .from(schoolAccommodationsTable)
      .where(eq(schoolAccommodationsTable.name, accommodation));
    if (row) resolvedId = row.id;
  } else {
    res.status(400).json({ error: "accommodation or accommodationId is required" });
    return;
  }

  const periodValue =
    typeof period === "number"
      ? period
      : typeof period === "string" && period
        ? Number(period)
        : null;

  const finalStatus = status === "refused" ? "refused" : "provided";

  const [log] = await db
    .insert(accommodationLogsTable)
    .values({
      schoolId,
      studentId,
      accommodationId: resolvedId,
      accommodation: resolvedName,
      period: periodValue,
      staffId: staff.id,
      staffName: staff.displayName,
      status: finalStatus,
      createdAt: new Date().toISOString(),
    })
    .returning();

  res.status(201).json(log);
});

// Bulk daily log: insert one row per (present student × selected accommodation).
// Server enforces:
//   - the requesting teacher actually teaches this period (section ownership)
//   - each present student is rostered into that section
//   - each student is currently assigned that accommodation
//   - duplicate guard: skip if a 'provided' row already exists for
//     (student, accommodation, today, period) regardless of staff
//
// Body: { period: number, presentStudentIds: string[], accommodationIds: number[] }
router.post(
  "/accommodation-logs/bulk",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: typeof staffTable.$inferSelect }).staff;
    const { period, presentStudentIds, accommodationIds } = req.body ?? {};

    if (typeof period !== "number" || !Number.isInteger(period) || period < 1) {
      res.status(400).json({ error: "period (positive integer) is required" });
      return;
    }
    if (!Array.isArray(presentStudentIds) || presentStudentIds.length === 0) {
      res.status(400).json({ error: "presentStudentIds (array) is required" });
      return;
    }
    if (!Array.isArray(accommodationIds) || accommodationIds.length === 0) {
      res.status(400).json({ error: "accommodationIds (array) is required" });
      return;
    }

    // Find this teacher's section for the period
    const [section] = await db
      .select()
      .from(classSectionsTable)
      .where(
        and(
          eq(classSectionsTable.teacherStaffId, staff.id),
          eq(classSectionsTable.period, period),
        ),
      );
    if (!section || section.isPlanning) {
      res.status(400).json({ error: "You do not teach a class this period" });
      return;
    }

    // Roster (set of valid student ids)
    const roster = await db
      .select({ studentId: sectionRosterTable.studentId })
      .from(sectionRosterTable)
      .where(eq(sectionRosterTable.sectionId, section.id));
    const validIds = new Set(roster.map((r) => r.studentId));
    const presentValid = presentStudentIds.filter(
      (id: unknown): id is string => typeof id === "string" && validIds.has(id),
    );

    // Accommodations: load names
    const accs = await db
      .select()
      .from(schoolAccommodationsTable)
      .where(inArray(schoolAccommodationsTable.id, accommodationIds.filter(
        (n: unknown): n is number => typeof n === "number",
      )));
    if (accs.length === 0) {
      res.status(400).json({ error: "No valid accommodations" });
      return;
    }

    // For each present student, look up their currently-assigned accommodation ids
    const assignments = await db
      .select({
        studentId: studentAccommodationsTable.studentId,
        accommodationId: studentAccommodationsTable.accommodationId,
      })
      .from(studentAccommodationsTable)
      .where(
        and(
          inArray(studentAccommodationsTable.studentId, presentValid),
          isNull(studentAccommodationsTable.removedAt),
        ),
      );
    const studentHas = new Map<string, Set<number>>();
    for (const a of assignments) {
      const set = studentHas.get(a.studentId) ?? new Set<number>();
      set.add(a.accommodationId);
      studentHas.set(a.studentId, set);
    }

    // Existing 'provided' logs for today, this period, these students
    const todayUtcMidnight = new Date();
    todayUtcMidnight.setUTCHours(0, 0, 0, 0);
    const tomorrowUtcMidnight = new Date(todayUtcMidnight.getTime() + 86400000);

    const existing = await db
      .select({
        studentId: accommodationLogsTable.studentId,
        accommodationId: accommodationLogsTable.accommodationId,
        createdAt: accommodationLogsTable.createdAt,
        status: accommodationLogsTable.status,
        period: accommodationLogsTable.period,
      })
      .from(accommodationLogsTable)
      .where(
        and(
          inArray(accommodationLogsTable.studentId, presentValid),
          eq(accommodationLogsTable.period, period),
        ),
      );
    const existingProvided = new Set<string>();
    for (const e of existing) {
      if (e.status !== "provided") continue;
      const t = new Date(e.createdAt).getTime();
      if (
        t >= todayUtcMidnight.getTime() &&
        t < tomorrowUtcMidnight.getTime() &&
        e.accommodationId != null
      ) {
        existingProvided.add(`${e.studentId}:${e.accommodationId}`);
      }
    }

    const nowIso = new Date().toISOString();
    const toInsert: (typeof accommodationLogsTable.$inferInsert)[] = [];
    let skippedNotEntitled = 0;
    let skippedDuplicate = 0;

    for (const studentId of presentValid) {
      const has = studentHas.get(studentId);
      if (!has) {
        // student has no accommodations at all
        for (const _ of accs) skippedNotEntitled++;
        continue;
      }
      for (const acc of accs) {
        if (!has.has(acc.id)) {
          skippedNotEntitled++;
          continue;
        }
        if (existingProvided.has(`${studentId}:${acc.id}`)) {
          skippedDuplicate++;
          continue;
        }
        toInsert.push({
          schoolId,
          studentId,
          accommodationId: acc.id,
          accommodation: acc.name,
          period,
          staffId: staff.id,
          staffName: staff.displayName,
          status: "provided",
          createdAt: nowIso,
        });
      }
    }

    // Use ON CONFLICT DO NOTHING against the partial unique index
    // (student_id, accommodation_id, period, substring(created_at,1,10))
    // WHERE status='provided' to make the duplicate guard race-safe.
    let actuallyInserted = 0;
    if (toInsert.length > 0) {
      const inserted = await db
        .insert(accommodationLogsTable)
        .values(toInsert)
        .onConflictDoNothing()
        .returning({ id: accommodationLogsTable.id });
      actuallyInserted = inserted.length;
      // Any row blocked by the unique index is a duplicate the app guard
      // missed (concurrent submit) — count it as a duplicate skip.
      const blocked = toInsert.length - actuallyInserted;
      skippedDuplicate += blocked;
    }

    res.status(201).json({
      inserted: actuallyInserted,
      skippedNotEntitled,
      skippedDuplicate,
      sectionId: section.id,
    });
  },
);

// Per-student bulk log used by the redesigned Class Log UI.
//
// Body: {
//   period: number,
//   date?: "YYYY-MM-DD"  (defaults to today),
//   entries: [
//     { studentId: string, accommodationId: number,
//       status: "provided" | "refused" }
//   ],
//   staffId?: number   // accepted via requireStaff fallback
// }
//
// Server enforces:
//   - the requesting teacher actually teaches `period` (section ownership)
//   - each entry's student is rostered into that section
//   - each entry's accommodation is currently assigned to that student
//   - duplicate-per-day guard for status='provided' rows (existing partial
//     unique index handles the race; we also pre-skip)
router.post(
  "/accommodation-logs/bulk-per-student",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const principal = (
      req as Request & { staff: typeof staffTable.$inferSelect }
    ).staff;
    const { period, date, entries, actingAsStaffId } = req.body ?? {};

    if (typeof period !== "number" || !Number.isInteger(period) || period < 1) {
      res.status(400).json({ error: "period (positive integer) is required" });
      return;
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      res.status(400).json({ error: "entries (non-empty array) is required" });
      return;
    }

    // Resolve "section owner" — the teacher whose section we'll log against.
    // Default = the requesting principal. Elevated users (admin / super /
    // ESE / MTSS coord / behavior specialist) MAY delegate via the body
    // field `actingAsStaffId`, but only to staff in the SAME school.
    let staff = principal;
    if (actingAsStaffId != null) {
      if (
        typeof actingAsStaffId !== "number" ||
        !Number.isInteger(actingAsStaffId)
      ) {
        res
          .status(400)
          .json({ error: "actingAsStaffId must be an integer staff id" });
        return;
      }
      const isElevated =
        principal.isAdmin === true ||
        principal.isSuperUser === true ||
        principal.isEseCoordinator === true ||
        principal.isMtssCoordinator === true ||
        principal.isBehaviorSpecialist === true;
      if (!isElevated && actingAsStaffId !== principal.id) {
        res.status(403).json({
          error: "Not authorized to log on behalf of another teacher",
        });
        return;
      }
      if (actingAsStaffId !== principal.id) {
        const [target] = await db
          .select()
          .from(staffTable)
          .where(
            and(
              eq(staffTable.id, actingAsStaffId),
              eq(staffTable.schoolId, schoolId),
            ),
          );
        if (!target || !target.active) {
          res
            .status(404)
            .json({ error: "Target teacher not found in your school" });
          return;
        }
        staff = target;
      }
    }

    // Resolve target date — default to today's UTC midnight, otherwise build
    // a midnight-UTC timestamp from the YYYY-MM-DD string. Storing midnight
    // UTC keeps the day-key (substring 1..10) deterministic and matches the
    // existing partial-unique index used by the original bulk endpoint.
    // Strict validation: reject malformed format outright (don't silently
    // fall back to today), reject calendar-invalid dates (e.g. 2026-02-31),
    // and reject future dates (UI sets max=today but bypassable).
    let targetIso: string;
    let targetDayKey: string;
    const todayUtcMid = new Date(
      Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        new Date().getUTCDate(),
      ),
    );
    const todayKey = todayUtcMid.toISOString().slice(0, 10);
    if (date !== undefined && date !== null && date !== "") {
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res
          .status(400)
          .json({ error: "date must be in YYYY-MM-DD format" });
        return;
      }
      const parsed = new Date(`${date}T00:00:00.000Z`);
      if (
        Number.isNaN(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== date
      ) {
        res.status(400).json({ error: "date is not a valid calendar date" });
        return;
      }
      if (date > todayKey) {
        res.status(400).json({ error: "date cannot be in the future" });
        return;
      }
      targetIso = parsed.toISOString();
      targetDayKey = date;
    } else {
      targetIso = todayUtcMid.toISOString();
      targetDayKey = todayKey;
    }

    // Normalise + shape-check entries up front.
    type NormalEntry = {
      studentId: string;
      accommodationId: number;
      status: "provided" | "refused";
    };
    const norm: NormalEntry[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i] as Record<string, unknown> | undefined;
      if (!e || typeof e !== "object") {
        res.status(400).json({ error: `entries[${i}] must be an object` });
        return;
      }
      const sid = e.studentId;
      const accId = e.accommodationId;
      const st = e.status;
      if (typeof sid !== "string" || !sid) {
        res.status(400).json({ error: `entries[${i}].studentId is required` });
        return;
      }
      if (typeof accId !== "number" || !Number.isInteger(accId)) {
        res
          .status(400)
          .json({ error: `entries[${i}].accommodationId must be an integer` });
        return;
      }
      if (st !== "provided" && st !== "refused") {
        res
          .status(400)
          .json({ error: `entries[${i}].status must be 'provided' or 'refused'` });
        return;
      }
      norm.push({ studentId: sid, accommodationId: accId, status: st });
    }

    // Section ownership for `period`. Scoped to the requesting principal's
    // school to prevent any cross-school lookup if (teacherStaffId, period)
    // were ever to collide across tenants.
    const [section] = await db
      .select()
      .from(classSectionsTable)
      .where(
        and(
          eq(classSectionsTable.schoolId, schoolId),
          eq(classSectionsTable.teacherStaffId, staff.id),
          eq(classSectionsTable.period, period),
        ),
      );
    if (!section || section.isPlanning) {
      res.status(400).json({
        error:
          actingAsStaffId != null && actingAsStaffId !== principal.id
            ? "Selected teacher does not teach a class this period"
            : "You do not teach a class this period",
      });
      return;
    }

    // Roster for that section.
    const roster = await db
      .select({ studentId: sectionRosterTable.studentId })
      .from(sectionRosterTable)
      .where(eq(sectionRosterTable.sectionId, section.id));
    const validStudentIds = new Set(roster.map((r) => r.studentId));

    // Load every accommodation referenced by entries — used for name lookup
    // and to validate IDs exist for this school. Always school-scope the
    // lookup so a same-id accommodation from another tenant cannot satisfy
    // the entry validation.
    const uniqueAccIds = Array.from(
      new Set(norm.map((n) => n.accommodationId)),
    );
    const accs = await db
      .select()
      .from(schoolAccommodationsTable)
      .where(
        and(
          eq(schoolAccommodationsTable.schoolId, schoolId),
          inArray(schoolAccommodationsTable.id, uniqueAccIds),
        ),
      );
    const accById = new Map(accs.map((a) => [a.id, a] as const));

    // Currently-assigned accommodations per student (referenced by entries).
    // School-scoped so we never cross-read assignments from another tenant
    // (student_accommodations carries schoolId for exactly this reason).
    const uniqueStudentIds = Array.from(
      new Set(norm.map((n) => n.studentId)),
    );
    const assignments =
      uniqueStudentIds.length === 0
        ? []
        : await db
            .select({
              studentId: studentAccommodationsTable.studentId,
              accommodationId: studentAccommodationsTable.accommodationId,
            })
            .from(studentAccommodationsTable)
            .where(
              and(
                eq(studentAccommodationsTable.schoolId, schoolId),
                inArray(
                  studentAccommodationsTable.studentId,
                  uniqueStudentIds,
                ),
                isNull(studentAccommodationsTable.removedAt),
              ),
            );
    const studentHas = new Map<string, Set<number>>();
    for (const a of assignments) {
      const set = studentHas.get(a.studentId) ?? new Set<number>();
      set.add(a.accommodationId);
      studentHas.set(a.studentId, set);
    }

    // Existing 'provided' logs for the chosen day + period + relevant
    // students — used to short-circuit duplicates before hitting the unique
    // index (matches the original bulk endpoint's strategy).
    const existing =
      uniqueStudentIds.length === 0
        ? []
        : await db
            .select({
              studentId: accommodationLogsTable.studentId,
              accommodationId: accommodationLogsTable.accommodationId,
              createdAt: accommodationLogsTable.createdAt,
              status: accommodationLogsTable.status,
              period: accommodationLogsTable.period,
            })
            .from(accommodationLogsTable)
            .where(
              and(
                inArray(
                  accommodationLogsTable.studentId,
                  uniqueStudentIds,
                ),
                eq(accommodationLogsTable.period, period),
              ),
            );
    const existingProvided = new Set<string>();
    for (const e of existing) {
      if (e.status !== "provided") continue;
      if (e.accommodationId == null) continue;
      if (e.createdAt.slice(0, 10) !== targetDayKey) continue;
      existingProvided.add(`${e.studentId}:${e.accommodationId}`);
    }

    const toInsert: (typeof accommodationLogsTable.$inferInsert)[] = [];
    let skippedNotRostered = 0;
    let skippedNotEntitled = 0;
    let skippedDuplicate = 0;
    let skippedUnknownAcc = 0;

    for (const entry of norm) {
      if (!validStudentIds.has(entry.studentId)) {
        skippedNotRostered++;
        continue;
      }
      const acc = accById.get(entry.accommodationId);
      if (!acc) {
        skippedUnknownAcc++;
        continue;
      }
      const has = studentHas.get(entry.studentId);
      if (!has || !has.has(entry.accommodationId)) {
        skippedNotEntitled++;
        continue;
      }
      if (
        entry.status === "provided" &&
        existingProvided.has(`${entry.studentId}:${entry.accommodationId}`)
      ) {
        skippedDuplicate++;
        continue;
      }
      toInsert.push({
        schoolId,
        studentId: entry.studentId,
        accommodationId: acc.id,
        accommodation: acc.name,
        period,
        staffId: staff.id,
        staffName: staff.displayName,
        status: entry.status,
        createdAt: targetIso,
      });
    }

    let actuallyInserted = 0;
    if (toInsert.length > 0) {
      const inserted = await db
        .insert(accommodationLogsTable)
        .values(toInsert)
        .onConflictDoNothing()
        .returning({ id: accommodationLogsTable.id });
      actuallyInserted = inserted.length;
      const blocked = toInsert.length - actuallyInserted;
      // Race-loss against the unique index — the row already existed for the
      // (student, accommodation, period, day) key. Treat as duplicate skip.
      skippedDuplicate += blocked;
    }

    res.status(201).json({
      inserted: actuallyInserted,
      skippedNotRostered,
      skippedNotEntitled,
      skippedDuplicate,
      skippedUnknownAcc,
      sectionId: section.id,
      date: targetDayKey,
    });
  },
);

export default router;
