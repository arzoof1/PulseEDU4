// Tier 3 weekly tracking + versioned goals.
//
// Routes:
//   GET    /api/tier3-goals?studentId=        → all goal versions for a
//                                                student (ordered by slot,
//                                                then effectiveFrom DESC).
//   POST   /api/tier3-goals                   → write a new goal version
//                                                (creates a row; never
//                                                mutates older rows). Core
//                                                Team only.
//   GET    /api/tier3-records?studentId=&teacherStaffId=&weekStartDate=
//                                              → list weekly records.
//                                                Teachers see own only.
//   POST   /api/tier3-records                 → upsert one record (one
//                                                row per student+teacher+
//                                                weekStartDate). Returns
//                                                the upserted row.
//   PATCH  /api/tier3-records/:id             → update day scores /
//                                                comments / strategy
//                                                checklist on an existing
//                                                row.
//   DELETE /api/tier3-records/:id             → Core Team only.
//
// On every record write, the route snapshots the active goal_version_id
// for each declared slot (1..plan.tier3GoalSlots) into goalVersionIds so
// reports always pair each score with the goal text it was scored against.

import { Router, type IRouter } from "express";
import {
  db,
  staffTable,
  studentsTable,
  studentMtssPlansTable,
  tier3GoalsTable,
  tier3WeeklyRecordsTable,
  tier3StrategiesTable,
  tier3StrategyUsageTable,
} from "@workspace/db";
import { and, desc, eq, sql, inArray } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import {
  isAcademicTier3,
  academicVisibleDays,
  normalizeAcademicMinutes,
  mondayOf,
} from "../lib/academicMinutes.js";
import { DEFAULT_SCHOOL_TZ } from "../lib/schoolYear.js";
import { computeAcademicWeeksForTeacher } from "./interventionsBell.js";
import { isCoreTeam } from "../lib/coreTeam.js";

const router: IRouter = Router();

const DAYS = ["mon", "tue", "wed", "thu", "fri"] as const;
type DayKey = (typeof DAYS)[number];
const DAY_SET = new Set<string>(DAYS);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function loadStaff(
  req: import("express").Request,
  res: import("express").Response,
) {
  const staffId = req.staffId;
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

// `undefined` here means "the caller didn't send this key at all" —
// callers that only push the per-goal `goalScores` map intentionally
// omit the legacy day-level monScore..friScore fields. Treat that as
// "leave alone" rather than a validation failure. Explicit `null` or
// "" still means "clear the value"; out-of-range non-null values are
// the only thing that should be rejected as "BAD".
function clampScore15(v: unknown): number | null | "BAD" | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 5) return "BAD";
  return n;
}
function clampPride02(v: unknown): number | null | "BAD" | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 2) return "BAD";
  return n;
}
function clampComment(v: unknown): string | null {
  if (v === undefined) return null;
  if (typeof v !== "string") return "";
  return v.trim().slice(0, 1000);
}

// `weekStartDate` is required to be a Monday in school-local time. We do
// the validation client-side as well, but defensive-check here.
function isMonday(yyyymmdd: string): boolean {
  if (!DATE_RE.test(yyyymmdd)) return false;
  // Construct as UTC then read getUTCDay so we don't pull in Node's TZ.
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d));
  return dt.getUTCDay() === 1;
}

// For each slot 1..maxSlot, return the currently-active goal id (the
// row with the largest effective_from <= today). Slots without any goal
// row are simply omitted from the returned record.
async function snapshotActiveGoalIds(
  schoolId: number,
  studentId: string,
  maxSlot: number,
  today: string,
): Promise<Record<string, number>> {
  if (maxSlot < 1) return {};
  const slots = Array.from({ length: maxSlot }, (_, i) => i + 1);
  const rows = await db
    .select({
      id: tier3GoalsTable.id,
      slot: tier3GoalsTable.slot,
      effectiveFrom: tier3GoalsTable.effectiveFrom,
    })
    .from(tier3GoalsTable)
    .where(
      and(
        eq(tier3GoalsTable.schoolId, schoolId),
        eq(tier3GoalsTable.studentId, studentId),
        inArray(tier3GoalsTable.slot, slots),
        sql`${tier3GoalsTable.effectiveFrom} <= ${today}`,
      ),
    )
    .orderBy(desc(tier3GoalsTable.effectiveFrom), desc(tier3GoalsTable.id));

  const out: Record<string, number> = {};
  for (const r of rows) {
    const key = String(r.slot);
    if (!(key in out)) out[key] = r.id;
  }
  return out;
}

// =================================================================
// GOALS
// =================================================================
router.get("/tier3-goals", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const studentId =
    typeof req.query.studentId === "string" ? req.query.studentId.trim() : "";
  if (!studentId) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  const rows = await db
    .select()
    .from(tier3GoalsTable)
    .where(
      and(
        eq(tier3GoalsTable.schoolId, schoolId),
        eq(tier3GoalsTable.studentId, studentId),
      ),
    )
    .orderBy(tier3GoalsTable.slot, desc(tier3GoalsTable.effectiveFrom));
  res.json(rows);
});

router.post("/tier3-goals", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  if (!isCoreTeam(staff)) {
    res.status(403).json({ error: "Core Team only" });
    return;
  }
  const { studentId, slot, text, effectiveFrom } = req.body ?? {};
  const cleanStudentId =
    typeof studentId === "string" ? studentId.trim() : "";
  const slotN = Number(slot);
  const cleanText = typeof text === "string" ? text.trim().slice(0, 800) : "";
  if (!cleanStudentId) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  if (!Number.isInteger(slotN) || slotN < 1 || slotN > 5) {
    res.status(400).json({ error: "slot must be 1..5" });
    return;
  }
  if (!cleanText) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  const eff =
    typeof effectiveFrom === "string" && DATE_RE.test(effectiveFrom)
      ? effectiveFrom
      : new Date().toISOString().slice(0, 10);

  const [student] = await db
    .select({ studentId: studentsTable.studentId })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, cleanStudentId),
        eq(studentsTable.schoolId, schoolId),
      ),
    );
  if (!student) {
    res.status(404).json({ error: "Student not found in this school" });
    return;
  }

  const [row] = await db
    .insert(tier3GoalsTable)
    .values({
      schoolId,
      studentId: cleanStudentId,
      slot: slotN,
      text: cleanText,
      effectiveFrom: eff,
      createdByStaffId: staff.id,
      createdByName: staff.displayName,
    })
    .returning();
  res.status(201).json(row);
});

// =================================================================
// WEEKLY RECORDS
// =================================================================
router.get("/tier3-records", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const studentId =
    typeof req.query.studentId === "string" ? req.query.studentId.trim() : "";
  const week =
    typeof req.query.weekStartDate === "string" &&
    DATE_RE.test(req.query.weekStartDate)
      ? req.query.weekStartDate
      : "";
  const teacherStaffId =
    typeof req.query.teacherStaffId === "string"
      ? Number(req.query.teacherStaffId)
      : NaN;

  const conds = [eq(tier3WeeklyRecordsTable.schoolId, schoolId)];
  if (studentId) {
    conds.push(eq(tier3WeeklyRecordsTable.studentId, studentId));
  }
  if (week) {
    conds.push(eq(tier3WeeklyRecordsTable.weekStartDate, week));
  }
  if (!isCoreTeam(staff)) {
    conds.push(eq(tier3WeeklyRecordsTable.teacherStaffId, staff.id));
  } else if (Number.isInteger(teacherStaffId) && teacherStaffId > 0) {
    conds.push(eq(tier3WeeklyRecordsTable.teacherStaffId, teacherStaffId));
  }

  const records = await db
    .select()
    .from(tier3WeeklyRecordsTable)
    .where(and(...conds))
    .orderBy(desc(tier3WeeklyRecordsTable.weekStartDate))
    .limit(500);

  // Hydrate strategy usage for each record so the client can render
  // the checklist without an extra round-trip.
  const recordIds = records.map((r) => r.id);
  let usage: Array<typeof tier3StrategyUsageTable.$inferSelect> = [];
  if (recordIds.length > 0) {
    usage = await db
      .select()
      .from(tier3StrategyUsageTable)
      .where(inArray(tier3StrategyUsageTable.weeklyRecordId, recordIds));
  }
  const usageByRecord = new Map<number, typeof usage>();
  for (const u of usage) {
    const list = usageByRecord.get(u.weeklyRecordId) ?? [];
    list.push(u);
    usageByRecord.set(u.weeklyRecordId, list);
  }
  res.json(
    records.map((r) => ({
      ...r,
      strategyUsage: usageByRecord.get(r.id) ?? [],
    })),
  );
});

// Academic Tier 3 week selector. Returns the met/owed/excused status for
// every week from the plan's start (floored at the rework ship date)
// through the current week, for a single student + responsible teacher.
// Powers the weekly form's week picker + needs-attention strip.
router.get("/tier3-academic-weeks", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const studentId =
    typeof req.query.studentId === "string" ? req.query.studentId.trim() : "";
  if (!studentId) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  const wantedTeacher =
    typeof req.query.teacherStaffId === "string"
      ? Number(req.query.teacherStaffId)
      : NaN;
  let teacherStaffId = staff.id;
  if (Number.isInteger(wantedTeacher) && wantedTeacher > 0) {
    if (wantedTeacher !== staff.id && !isCoreTeam(staff)) {
      res
        .status(403)
        .json({ error: "Only Core Team can view another teacher" });
      return;
    }
    teacherStaffId = wantedTeacher;
  }

  // Find the active Tier 3 academic plan for this student.
  const [plan] = await db
    .select()
    .from(studentMtssPlansTable)
    .where(
      and(
        eq(studentMtssPlansTable.schoolId, schoolId),
        eq(studentMtssPlansTable.studentId, studentId),
        sql`${studentMtssPlansTable.closedAt} IS NULL`,
        eq(studentMtssPlansTable.tier, 3),
      ),
    )
    .limit(1);
  if (!plan || !isAcademicTier3(plan)) {
    res.status(404).json({ error: "No active academic Tier 3 plan" });
    return;
  }

  const todayLocal = new Date().toLocaleDateString("en-CA", {
    timeZone: DEFAULT_SCHOOL_TZ,
  });
  const monday = mondayOf(todayLocal);

  const weeks = await computeAcademicWeeksForTeacher(
    schoolId,
    teacherStaffId,
    plan,
    monday,
  );
  res.json({
    studentId,
    teacherStaffId,
    minutesTarget: plan.academicMinutesTarget,
    academicAnyDay: plan.academicAnyDay,
    fastSubject: plan.fastSubject,
    visibleDays: academicVisibleDays(plan),
    weeks,
  });
});

// Upsert a weekly record. If one already exists for the (student, teacher,
// week), we PATCH it; otherwise we INSERT. The strategy checklist is
// replaced wholesale based on the supplied `strategyUsage` array (when
// provided).
router.post("/tier3-records", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const {
    studentId,
    teacherStaffId,
    weekStartDate,
    monScore,
    tueScore,
    wedScore,
    thuScore,
    friScore,
    monComment,
    tueComment,
    wedComment,
    thuComment,
    friComment,
    weeklyComment,
    prideMon,
    prideTue,
    prideWed,
    prideThu,
    prideFri,
    strategyUsage,
    goalScores,
    absentDays,
    submitted,
  } = req.body ?? {};

  const cleanStudentId =
    typeof studentId === "string" ? studentId.trim() : "";
  if (!cleanStudentId) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  if (!isMonday(weekStartDate)) {
    res
      .status(400)
      .json({ error: "weekStartDate must be a Monday (YYYY-MM-DD)" });
    return;
  }
  // Resolve teacher.
  let resolvedTeacherId = staff.id;
  if (Number.isInteger(Number(teacherStaffId)) && Number(teacherStaffId) > 0) {
    const wantedId = Number(teacherStaffId);
    if (wantedId !== staff.id) {
      if (!isCoreTeam(staff)) {
        res
          .status(403)
          .json({ error: "Only Core Team can log on behalf of others" });
        return;
      }
      const [t] = await db
        .select({ id: staffTable.id })
        .from(staffTable)
        .where(
          and(eq(staffTable.id, wantedId), eq(staffTable.schoolId, schoolId)),
        );
      if (!t) {
        res
          .status(404)
          .json({ error: "Teacher not found in this school" });
        return;
      }
      resolvedTeacherId = wantedId;
    }
  }
  // Student must be in this school.
  const [student] = await db
    .select({ studentId: studentsTable.studentId })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, cleanStudentId),
        eq(studentsTable.schoolId, schoolId),
      ),
    );
  if (!student) {
    res.status(404).json({ error: "Student not found in this school" });
    return;
  }

  // Validate scores + pride. Sentinel value 'BAD' means the input was
  // present but malformed; undefined means the caller didn't send the
  // key (we leave the existing column alone on update / set null on
  // insert).
  function readScore(v: unknown): number | null | "BAD" | undefined {
    return clampScore15(v);
  }
  function readPride(v: unknown): number | null | "BAD" | undefined {
    return clampPride02(v);
  }
  const scoreFields = {
    monScore: readScore(monScore),
    tueScore: readScore(tueScore),
    wedScore: readScore(wedScore),
    thuScore: readScore(thuScore),
    friScore: readScore(friScore),
  };
  const prideFields = {
    prideMon: readPride(prideMon),
    prideTue: readPride(prideTue),
    prideWed: readPride(prideWed),
    prideThu: readPride(prideThu),
    prideFri: readPride(prideFri),
  };
  for (const [k, v] of Object.entries({ ...scoreFields, ...prideFields })) {
    if (v === "BAD") {
      res.status(400).json({ error: `${k} must be in valid range` });
      return;
    }
  }

  // Per-goal-per-day score map. Shape on the wire:
  //   { "1": { "mon":5,"tue":4, ... }, "2": { ... } }
  // Slots outside 1..5 and unknown days are dropped silently. Any
  // value that isn't a 1..5 integer becomes null. When the caller
  // sends a `goalScores` payload we ALSO derive the day-overall
  // mon..fri columns as the rounded average across goals so the
  // existing analytics keep working without a schema migration on
  // every dashboard query.
  const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri"] as const;
  type DayKey = (typeof DAY_KEYS)[number];

  // Per-day absence map { mon:true, ... }. Only mon..fri keys are
  // honored; values coerced to boolean. We need the parsed value
  // BEFORE deriving the day-overall scores so absent days stay null
  // even when the teacher accidentally left a score on them.
  let parsedAbsent: Record<DayKey, boolean> | undefined;
  if ("absentDays" in (req.body ?? {})) {
    const out: Record<DayKey, boolean> = {
      mon: false,
      tue: false,
      wed: false,
      thu: false,
      fri: false,
    };
    if (absentDays && typeof absentDays === "object") {
      for (const d of DAY_KEYS) {
        out[d] = Boolean((absentDays as Record<string, unknown>)[d]);
      }
    }
    parsedAbsent = out;
  }

  let parsedGoalScores:
    | Record<string, Record<DayKey, number | null>>
    | undefined;
  if ("goalScores" in (req.body ?? {})) {
    parsedGoalScores = {};
    if (goalScores && typeof goalScores === "object") {
      for (const [slotKey, perDay] of Object.entries(
        goalScores as Record<string, unknown>,
      )) {
        const slotN = Number(slotKey);
        if (!Number.isInteger(slotN) || slotN < 1 || slotN > 5) continue;
        if (!perDay || typeof perDay !== "object") continue;
        const cleanedDays: Record<DayKey, number | null> = {
          mon: null,
          tue: null,
          wed: null,
          thu: null,
          fri: null,
        };
        for (const d of DAY_KEYS) {
          const raw = (perDay as Record<string, unknown>)[d];
          const v = clampScore15(raw);
          cleanedDays[d] = v === "BAD" || v === undefined ? null : v;
        }
        parsedGoalScores[String(slotN)] = cleanedDays;
      }
    }
    // Derive overall day score = rounded mean across goals that have
    // a score for that day. This OVERRIDES any explicit monScore..
    // friScore that came in the same request body. Absent days are
    // forced to null so they're excluded from the % of points calc.
    for (const d of DAY_KEYS) {
      const colName =
        d === "mon"
          ? "monScore"
          : d === "tue"
            ? "tueScore"
            : d === "wed"
              ? "wedScore"
              : d === "thu"
                ? "thuScore"
                : "friScore";
      if (parsedAbsent && parsedAbsent[d]) {
        scoreFields[colName as keyof typeof scoreFields] = null;
        continue;
      }
      const values: number[] = [];
      for (const slot of Object.values(parsedGoalScores)) {
        const v = slot[d];
        if (typeof v === "number") values.push(v);
      }
      if (values.length > 0) {
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        scoreFields[colName as keyof typeof scoreFields] = Math.round(mean);
      } else {
        scoreFields[colName as keyof typeof scoreFields] = null;
      }
    }
  }

  // Snapshot the active goal versions for this student. We base maxSlot
  // on the plan's `tier3GoalSlots` if a plan exists, else fall back to 5.
  const [plan] = await db
    .select()
    .from(studentMtssPlansTable)
    .where(
      and(
        eq(studentMtssPlansTable.schoolId, schoolId),
        eq(studentMtssPlansTable.studentId, cleanStudentId),
        sql`${studentMtssPlansTable.closedAt} IS NULL`,
        eq(studentMtssPlansTable.tier, 3),
      ),
    )
    .limit(1);
  const maxSlot = plan ? plan.tier3GoalSlots : 5;
  // Drop any per-goal scores aimed at slots that don't exist on the
  // student's active plan. Without this a misbehaving client could
  // litter the JSONB column with phantom slots that later confuse
  // reports that iterate over the keys.
  if (parsedGoalScores) {
    for (const slotKey of Object.keys(parsedGoalScores)) {
      if (Number(slotKey) > maxSlot) delete parsedGoalScores[slotKey];
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const goalVersionIds = await snapshotActiveGoalIds(
    schoolId,
    cleanStudentId,
    maxSlot,
    today,
  );

  // Look for an existing row.
  const [existing] = await db
    .select()
    .from(tier3WeeklyRecordsTable)
    .where(
      and(
        eq(tier3WeeklyRecordsTable.schoolId, schoolId),
        eq(tier3WeeklyRecordsTable.studentId, cleanStudentId),
        eq(tier3WeeklyRecordsTable.teacherStaffId, resolvedTeacherId),
        eq(tier3WeeklyRecordsTable.weekStartDate, weekStartDate),
      ),
    );

  // Build column patch. For score/pride/comment fields we only override
  // when the caller provided a key.
  const cols: Record<string, unknown> = {};
  function maybeAssign<T>(
    col: string,
    parsed: T | "BAD" | null | undefined,
    sourcePresent: boolean,
  ): void {
    if (!sourcePresent) return;
    cols[col] = parsed;
  }
  const body = req.body ?? {};
  maybeAssign("monScore", scoreFields.monScore, "monScore" in body);
  maybeAssign("tueScore", scoreFields.tueScore, "tueScore" in body);
  maybeAssign("wedScore", scoreFields.wedScore, "wedScore" in body);
  maybeAssign("thuScore", scoreFields.thuScore, "thuScore" in body);
  maybeAssign("friScore", scoreFields.friScore, "friScore" in body);
  maybeAssign("prideMon", prideFields.prideMon, "prideMon" in body);
  maybeAssign("prideTue", prideFields.prideTue, "prideTue" in body);
  maybeAssign("prideWed", prideFields.prideWed, "prideWed" in body);
  maybeAssign("prideThu", prideFields.prideThu, "prideThu" in body);
  maybeAssign("prideFri", prideFields.prideFri, "prideFri" in body);
  for (const [src, col] of [
    ["monComment", "monComment"],
    ["tueComment", "tueComment"],
    ["wedComment", "wedComment"],
    ["thuComment", "thuComment"],
    ["friComment", "friComment"],
  ] as const) {
    if (src in body) cols[col] = clampComment(body[src]);
  }
  if ("weeklyComment" in body) {
    cols.weeklyComment = clampComment(body.weeklyComment) ?? "";
  }
  if (parsedGoalScores !== undefined) {
    cols.goalScores = parsedGoalScores;
    // Re-sync the derived overall day scores into cols (since we only
    // assign cols when the source key was present, but the per-goal
    // map implicitly overrides them).
    cols.monScore = scoreFields.monScore;
    cols.tueScore = scoreFields.tueScore;
    cols.wedScore = scoreFields.wedScore;
    cols.thuScore = scoreFields.thuScore;
    cols.friScore = scoreFields.friScore;
  }
  if (parsedAbsent !== undefined) {
    cols.absentDays = parsedAbsent;
    // If the caller didn't also send goalScores in the same payload
    // we still want to null-out the overall score columns for any
    // newly-absent day so the bell + reports stop counting them.
    if (parsedGoalScores === undefined) {
      for (const d of DAY_KEYS) {
        if (!parsedAbsent[d]) continue;
        const colName =
          d === "mon"
            ? "monScore"
            : d === "tue"
              ? "tueScore"
              : d === "wed"
                ? "wedScore"
                : d === "thu"
                  ? "thuScore"
                  : "friScore";
        cols[colName] = null;
      }
    }
  }
  // --- Academic Tier 3 minutes model ---
  // Per-day minutes map. For an academic plan we restrict the accepted
  // days to the plan's visible days (any-day → all five, otherwise the
  // configured meeting days). Behavior records never send this.
  if ("academicMinutes" in body) {
    const allowed =
      plan && isAcademicTier3(plan)
        ? new Set<string>(academicVisibleDays(plan))
        : null;
    cols.academicMinutes = normalizeAcademicMinutes(
      body.academicMinutes,
      allowed,
    );
  }
  // Release valve: mark/clear "no group provided this week". Setting it
  // stamps who released it + why + when; clearing wipes all three. Any
  // signed-in interventionist on the plan (or Core Team) may toggle it.
  if ("releasedNoIntervention" in body) {
    const released = Boolean(body.releasedNoIntervention);
    cols.releasedNoIntervention = released;
    if (released) {
      cols.releaseReason =
        typeof body.releaseReason === "string"
          ? body.releaseReason.trim().slice(0, 1000) || null
          : null;
      cols.releasedByStaffId = staff.id;
      cols.releasedAt = new Date();
    } else {
      cols.releaseReason = null;
      cols.releasedByStaffId = null;
      cols.releasedAt = null;
    }
  }

  // Submission flag. `submitted: true` stamps submittedAt = NOW();
  // `submitted: false` reverts it to null (rare, but allows a Core
  // Team un-submit). Omitting the key leaves the existing state alone.
  if ("submitted" in (req.body ?? {})) {
    cols.submittedAt = submitted ? new Date() : null;
  }

  let recordId: number;
  if (existing) {
    cols.updatedAt = new Date();
    cols.goalVersionIds = goalVersionIds;
    const [row] = await db
      .update(tier3WeeklyRecordsTable)
      .set(cols)
      .where(eq(tier3WeeklyRecordsTable.id, existing.id))
      .returning();
    recordId = row?.id ?? existing.id;
  } else {
    const [row] = await db
      .insert(tier3WeeklyRecordsTable)
      .values({
        schoolId,
        studentId: cleanStudentId,
        teacherStaffId: resolvedTeacherId,
        weekStartDate,
        monScore: (cols.monScore as number | null) ?? null,
        tueScore: (cols.tueScore as number | null) ?? null,
        wedScore: (cols.wedScore as number | null) ?? null,
        thuScore: (cols.thuScore as number | null) ?? null,
        friScore: (cols.friScore as number | null) ?? null,
        monComment: (cols.monComment as string | null) ?? null,
        tueComment: (cols.tueComment as string | null) ?? null,
        wedComment: (cols.wedComment as string | null) ?? null,
        thuComment: (cols.thuComment as string | null) ?? null,
        friComment: (cols.friComment as string | null) ?? null,
        weeklyComment: (cols.weeklyComment as string | null) ?? "",
        prideMon: (cols.prideMon as number | null) ?? null,
        prideTue: (cols.prideTue as number | null) ?? null,
        prideWed: (cols.prideWed as number | null) ?? null,
        prideThu: (cols.prideThu as number | null) ?? null,
        prideFri: (cols.prideFri as number | null) ?? null,
        goalVersionIds,
        goalScores: parsedGoalScores ?? {},
        absentDays: parsedAbsent ?? {
          mon: false,
          tue: false,
          wed: false,
          thu: false,
          fri: false,
        },
        academicMinutes:
          (cols.academicMinutes as Record<string, number>) ?? {},
        releasedNoIntervention:
          (cols.releasedNoIntervention as boolean) ?? false,
        releaseReason: (cols.releaseReason as string | null) ?? null,
        releasedByStaffId: (cols.releasedByStaffId as number | null) ?? null,
        releasedAt: (cols.releasedAt as Date | null) ?? null,
        submittedAt:
          "submitted" in (req.body ?? {}) && submitted ? new Date() : null,
      })
      .returning();
    recordId = row.id;
  }

  // Replace strategy usage if supplied. Shape: [{strategyId, day, used?}].
  if (Array.isArray(strategyUsage)) {
    await db
      .delete(tier3StrategyUsageTable)
      .where(eq(tier3StrategyUsageTable.weeklyRecordId, recordId));
    const valid: Array<{
      weeklyRecordId: number;
      strategyId: number;
      day: string;
      used: boolean;
    }> = [];
    // Validate strategies all belong to this school.
    const strategyIds = Array.from(
      new Set(
        strategyUsage
          .map((u: { strategyId?: unknown }) => Number(u?.strategyId))
          .filter((n: number) => Number.isInteger(n) && n > 0),
      ),
    ) as number[];
    let allowedIds = new Set<number>();
    if (strategyIds.length > 0) {
      const strategies = await db
        .select({ id: tier3StrategiesTable.id })
        .from(tier3StrategiesTable)
        .where(
          and(
            inArray(tier3StrategiesTable.id, strategyIds),
            eq(tier3StrategiesTable.schoolId, schoolId),
          ),
        );
      allowedIds = new Set(strategies.map((s) => s.id));
    }
    for (const u of strategyUsage as Array<{
      strategyId?: unknown;
      day?: unknown;
      used?: unknown;
    }>) {
      const sid = Number(u?.strategyId);
      const day = typeof u?.day === "string" ? u.day.toLowerCase() : "";
      if (!Number.isInteger(sid) || !allowedIds.has(sid)) continue;
      if (!DAY_SET.has(day)) continue;
      if (u?.used === false) continue; // sparse table — only USED rows
      valid.push({
        weeklyRecordId: recordId,
        strategyId: sid,
        day,
        used: true,
      });
    }
    if (valid.length > 0) {
      await db.insert(tier3StrategyUsageTable).values(valid);
    }
  }

  const [final] = await db
    .select()
    .from(tier3WeeklyRecordsTable)
    .where(eq(tier3WeeklyRecordsTable.id, recordId));
  const finalUsage = await db
    .select()
    .from(tier3StrategyUsageTable)
    .where(eq(tier3StrategyUsageTable.weeklyRecordId, recordId));
  req.log?.info(
    { tier3RecordId: recordId, studentId: cleanStudentId },
    "tier3 record upserted",
  );
  res.status(existing ? 200 : 201).json({
    ...final,
    strategyUsage: finalUsage,
  });
});

router.delete("/tier3-records/:id", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  if (!isCoreTeam(staff)) {
    res.status(403).json({ error: "Core Team only" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }
  await db
    .delete(tier3StrategyUsageTable)
    .where(eq(tier3StrategyUsageTable.weeklyRecordId, id));
  await db
    .delete(tier3WeeklyRecordsTable)
    .where(
      and(
        eq(tier3WeeklyRecordsTable.id, id),
        eq(tier3WeeklyRecordsTable.schoolId, schoolId),
      ),
    );
  res.json({ ok: true });
});

export default router;
// Silence "DayKey is unused" if a future edit drops the explicit annotation.
export type { DayKey };
