// Classroom Intervention logging.
// GET  /api/interventions          -> list (any signed-in staff)
// POST /api/interventions          -> create one entry (any signed-in staff)
//
// Privileged readers (admin / behavior specialist) see school-wide rows.
// Other staff see only their own entries.

import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  interventionEntriesTable,
  interventionTypesTable,
  pbisEntriesTable,
  pbisReasonsTable,
  schoolSettingsTable,
  staffTable,
  studentsTable,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam } from "../lib/coreTeam.js";
import { processMilestonesForStudent } from "../lib/pbisMilestones.js";

const router: IRouter = Router();

// "What has worked before for this student" effectiveness window. An
// intervention counts as having WORKED if the behavior it targeted did not
// recur for that student within this many days after it was logged. The window
// is school-configurable on the Negative Behaviors tab
// (school_settings.intervention_effectiveness_days); this is the fallback used
// when a school has no row / unset value.
const DEFAULT_EFFECTIVENESS_WINDOW_DAYS = 14;

// Resolve the per-school effectiveness window (days), falling back to the
// default when no setting is present.
async function effectivenessWindowDays(schoolId: number): Promise<number> {
  const [row] = await db
    .select({ days: schoolSettingsTable.interventionEffectivenessDays })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  const n = row?.days;
  return typeof n === "number" && Number.isInteger(n) && n > 0
    ? n
    : DEFAULT_EFFECTIVENESS_WINDOW_DAYS;
}

type Outcome = "worked" | "recurred" | "pending";

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// Given when an intervention was logged and the timestamps of every (same
// behavior, same student) negative behavior occurrence, decide whether the
// intervention worked. ISO-8601 UTC strings sort lexicographically, so plain
// string comparison is safe here (all timestamps are `new Date().toISOString()`).
function deriveOutcome(
  interventionCreatedAt: string,
  behaviorTimestamps: string[],
  nowIso: string,
  windowDays: number,
): Outcome {
  const windowEnd = addDaysIso(interventionCreatedAt, windowDays);
  const recurred = behaviorTimestamps.some(
    (t) => t > interventionCreatedAt && t <= windowEnd,
  );
  if (recurred) return "recurred";
  if (nowIso < windowEnd) return "pending";
  return "worked";
}

async function requireStaff(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const staffId = req.staffId;
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

router.get("/interventions", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const isPrivileged =
    staff.isSuperUser || staff.isAdmin || staff.isBehaviorSpecialist;
  const scope = eq(interventionEntriesTable.schoolId, schoolId);
  const rows = await db
    .select()
    .from(interventionEntriesTable)
    .where(
      isPrivileged
        ? scope
        : and(scope, eq(interventionEntriesTable.staffId, staff.id)),
    )
    .orderBy(desc(interventionEntriesTable.createdAt))
    .limit(200);
  res.json(rows);
});

router.post("/interventions", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId === null) return;
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const { studentId, interventionTypeId, note, behaviorReason } =
    req.body ?? {};

  if (typeof studentId !== "string" || !studentId.trim()) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  const typeId = Number(interventionTypeId);
  if (!Number.isInteger(typeId) || typeId < 1) {
    res
      .status(400)
      .json({ error: "interventionTypeId (positive integer) is required" });
    return;
  }
  // Intervention type must belong to the caller's school — without this AND
  // a teacher in school A could attach a school B intervention type id to
  // their intervention entry, polluting cross-school analytics and
  // bypassing school B's curated list.
  const [type] = await db
    .select()
    .from(interventionTypesTable)
    .where(
      and(
        eq(interventionTypesTable.id, typeId),
        eq(interventionTypesTable.schoolId, schoolId),
      ),
    );
  if (!type) {
    res.status(404).json({ error: "Intervention type not found" });
    return;
  }
  if (!type.active) {
    res.status(400).json({ error: "Intervention type is inactive" });
    return;
  }

  const noteText = typeof note === "string" ? note.trim() : "";
  if (type.requiresNote && !noteText) {
    res
      .status(400)
      .json({ error: `A note is required for "${type.name}".` });
    return;
  }

  const [row] = await db
    .insert(interventionEntriesTable)
    .values({
      studentId: studentId.trim(),
      interventionType: type.name,
      behaviorReason:
        typeof behaviorReason === "string" && behaviorReason.trim()
          ? behaviorReason.trim()
          : null,
      note: noteText || null,
      staffId: staff.id,
      staffName: staff.displayName,
      schoolId,
      createdAt: new Date().toISOString(),
    })
    .returning();
  res.status(201).json(row);
});

// POST /interventions/quick-log
// Atomically record a behavior + the classroom intervention(s) tried for it in
// a single action (the roster quick-log). Writes one negative PBIS entry and
// one intervention_entries row per selected type — all in one transaction so a
// partial failure never leaves a behavior without its interventions (or vice
// versa). Body: { studentId, reasonId, interventionTypeIds: number[], note? }.
router.post(
  "/interventions/quick-log",
  requireStaff,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
      .staff;
    const { studentId, reasonId, note, interventionTypeIds } = req.body ?? {};

    if (typeof studentId !== "string" || !studentId.trim()) {
      res.status(400).json({ error: "studentId is required" });
      return;
    }
    const sid = studentId.trim();
    const rid = Number(reasonId);
    if (!Number.isInteger(rid) || rid < 1) {
      res
        .status(400)
        .json({ error: "reasonId (positive integer) is required" });
      return;
    }
    if (
      !Array.isArray(interventionTypeIds) ||
      interventionTypeIds.length === 0
    ) {
      res
        .status(400)
        .json({ error: "interventionTypeIds (non-empty array) is required" });
      return;
    }
    const uniqueTypeIds = [
      ...new Set(interventionTypeIds.map((t) => Number(t))),
    ];
    if (uniqueTypeIds.some((t) => !Number.isInteger(t) || t < 1)) {
      res
        .status(400)
        .json({ error: "interventionTypeIds must be positive integers" });
      return;
    }

    // Student must belong to this school (cross-school protection).
    const [studentRow] = await db
      .select({ id: studentsTable.id })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.studentId, sid),
          eq(studentsTable.schoolId, schoolId),
        ),
      );
    if (!studentRow) {
      res.status(404).json({ error: "Student not found in this school" });
      return;
    }

    // Behavior reason must belong to this school.
    const [reason] = await db
      .select()
      .from(pbisReasonsTable)
      .where(
        and(
          eq(pbisReasonsTable.id, rid),
          eq(pbisReasonsTable.schoolId, schoolId),
        ),
      );
    if (!reason) {
      res.status(404).json({ error: "Behavior not found" });
      return;
    }

    // All intervention types must belong to this school, be active, and have a
    // note when required.
    const types = await db
      .select()
      .from(interventionTypesTable)
      .where(
        and(
          eq(interventionTypesTable.schoolId, schoolId),
          inArray(interventionTypesTable.id, uniqueTypeIds),
        ),
      );
    if (types.length !== uniqueTypeIds.length) {
      res
        .status(404)
        .json({ error: "One or more intervention types were not found" });
      return;
    }
    const noteText = typeof note === "string" ? note.trim() : "";
    for (const t of types) {
      if (!t.active) {
        res
          .status(400)
          .json({ error: `Intervention "${t.name}" is inactive` });
        return;
      }
      if (t.requiresNote && !noteText) {
        res
          .status(400)
          .json({ error: `A note is required for "${t.name}".` });
        return;
      }
    }

    // Mirror POST /pbis polarity + points handling so the behavior entry is
    // consistent with the rest of the system.
    const polarity: "positive" | "negative" =
      reason.polarity === "negative" ? "negative" : "positive";
    let storedPoints = Math.abs(reason.defaultPoints);
    if (polarity === "negative") {
      const [settingsRow] = await db
        .select()
        .from(schoolSettingsTable)
        .where(eq(schoolSettingsTable.schoolId, schoolId));
      const subtract = settingsRow?.pbisNegativeAffectsTotal ?? false;
      storedPoints = subtract ? -Math.abs(reason.defaultPoints) : 0;
    }
    const cleanNote = noteText ? noteText.slice(0, 500) : null;
    const nowIso = new Date().toISOString();
    const byId = new Map(types.map((t) => [t.id, t]));

    const result = await db.transaction(async (tx) => {
      const [entry] = await tx
        .insert(pbisEntriesTable)
        .values({
          schoolId,
          studentId: sid,
          reason: reason.name,
          points: storedPoints,
          polarity,
          staffId: staff.id,
          staffName: staff.displayName,
          createdAt: nowIso,
          note: cleanNote,
        })
        .returning();
      const interventions = [];
      for (const tid of uniqueTypeIds) {
        const t = byId.get(tid);
        if (!t) continue;
        const [iv] = await tx
          .insert(interventionEntriesTable)
          .values({
            studentId: sid,
            interventionType: t.name,
            behaviorReason: reason.name,
            note: cleanNote,
            staffId: staff.id,
            staffName: staff.displayName,
            schoolId,
            createdAt: nowIso,
          })
          .returning();
        interventions.push(iv);
      }
      return { entry, interventions };
    });

    // Parity with POST /pbis: recompute the student's PBIS milestones after a
    // behavior is logged so quick-log entries don't silently bypass milestone
    // updates/notifications.
    let milestoneResults;
    try {
      milestoneResults = await processMilestonesForStudent(sid, schoolId);
    } catch (err) {
      req.log.error({ err }, "quick-log milestone processing failed");
    }

    res.status(201).json({ ...result, milestoneResults });
  },
);

// GET /interventions/effectiveness?studentId&behaviorReason
// "What has worked before for THIS student" — derived effectiveness for each
// intervention type previously tried against the given behavior. School-wide
// across teachers (so a teacher sees what a colleague already found works).
router.get(
  "/interventions/effectiveness",
  requireStaff,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const studentId = String(req.query.studentId ?? "").trim();
    const behaviorReason = String(req.query.behaviorReason ?? "").trim();
    if (!studentId || !behaviorReason) {
      res
        .status(400)
        .json({ error: "studentId and behaviorReason are required" });
      return;
    }

    const interventions = await db
      .select({
        interventionType: interventionEntriesTable.interventionType,
        createdAt: interventionEntriesTable.createdAt,
      })
      .from(interventionEntriesTable)
      .where(
        and(
          eq(interventionEntriesTable.schoolId, schoolId),
          eq(interventionEntriesTable.studentId, studentId),
          eq(interventionEntriesTable.behaviorReason, behaviorReason),
        ),
      );

    const behaviors = await db
      .select({ createdAt: pbisEntriesTable.createdAt })
      .from(pbisEntriesTable)
      .where(
        and(
          eq(pbisEntriesTable.schoolId, schoolId),
          eq(pbisEntriesTable.studentId, studentId),
          eq(pbisEntriesTable.reason, behaviorReason),
          eq(pbisEntriesTable.polarity, "negative"),
          isNull(pbisEntriesTable.voidedAt),
        ),
      );
    const behaviorTs = behaviors
      .map((b) => b.createdAt)
      .filter((t): t is string => Boolean(t));

    const windowDays = await effectivenessWindowDays(schoolId);
    const nowIso = new Date().toISOString();
    const byType: Record<
      string,
      { worked: number; recurred: number; pending: number }
    > = {};
    for (const iv of interventions) {
      const outcome = deriveOutcome(iv.createdAt, behaviorTs, nowIso, windowDays);
      const slot = (byType[iv.interventionType] ??= {
        worked: 0,
        recurred: 0,
        pending: 0,
      });
      slot[outcome] += 1;
    }

    res.json({ windowDays, byType });
  },
);

// GET /interventions/student-report/:studentId  (Core Team only)
// Per-student admin report: every negative behavior across all teachers, every
// intervention logged (by teacher) with its derived outcome, and a per-type
// effectiveness summary ("what's worked").
router.get(
  "/interventions/student-report/:studentId",
  requireStaff,
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (schoolId === null) return;
    const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
      .staff;
    if (!isCoreTeam(staff)) {
      res.status(403).json({ error: "Core Team access required" });
      return;
    }
    const studentId = String(req.params.studentId ?? "").trim();
    if (!studentId) {
      res.status(400).json({ error: "studentId is required" });
      return;
    }

    const [student] = await db
      .select({
        studentId: studentsTable.studentId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        localSisId: studentsTable.localSisId,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.studentId, studentId),
          eq(studentsTable.schoolId, schoolId),
        ),
      );
    if (!student) {
      res.status(404).json({ error: "Student not found" });
      return;
    }

    const behaviors = await db
      .select({
        reason: pbisEntriesTable.reason,
        staffName: pbisEntriesTable.staffName,
        note: pbisEntriesTable.note,
        createdAt: pbisEntriesTable.createdAt,
      })
      .from(pbisEntriesTable)
      .where(
        and(
          eq(pbisEntriesTable.schoolId, schoolId),
          eq(pbisEntriesTable.studentId, studentId),
          eq(pbisEntriesTable.polarity, "negative"),
          isNull(pbisEntriesTable.voidedAt),
        ),
      )
      .orderBy(desc(pbisEntriesTable.createdAt))
      .limit(300);

    const interventionRows = await db
      .select({
        interventionType: interventionEntriesTable.interventionType,
        behaviorReason: interventionEntriesTable.behaviorReason,
        note: interventionEntriesTable.note,
        staffName: interventionEntriesTable.staffName,
        createdAt: interventionEntriesTable.createdAt,
      })
      .from(interventionEntriesTable)
      .where(
        and(
          eq(interventionEntriesTable.schoolId, schoolId),
          eq(interventionEntriesTable.studentId, studentId),
        ),
      )
      .orderBy(desc(interventionEntriesTable.createdAt))
      .limit(300);

    // Build reason -> behavior timestamps so each linked intervention can be
    // scored against the recurrence of the specific behavior it targeted.
    const tsByReason = new Map<string, string[]>();
    for (const b of behaviors) {
      if (!b.reason || !b.createdAt) continue;
      const arr = tsByReason.get(b.reason) ?? [];
      arr.push(b.createdAt);
      tsByReason.set(b.reason, arr);
    }

    const windowDays = await effectivenessWindowDays(schoolId);
    const nowIso = new Date().toISOString();
    const interventions = interventionRows.map((iv) => {
      const outcome: Outcome | "na" = iv.behaviorReason
        ? deriveOutcome(
            iv.createdAt,
            tsByReason.get(iv.behaviorReason) ?? [],
            nowIso,
            windowDays,
          )
        : "na";
      return { ...iv, outcome };
    });

    const summary: Record<
      string,
      { used: number; worked: number; recurred: number; pending: number }
    > = {};
    for (const iv of interventions) {
      const slot = (summary[iv.interventionType] ??= {
        used: 0,
        worked: 0,
        recurred: 0,
        pending: 0,
      });
      slot.used += 1;
      if (iv.outcome !== "na") slot[iv.outcome] += 1;
    }

    res.json({
      windowDays,
      student,
      behaviors,
      interventions,
      summary,
    });
  },
);

export default router;
