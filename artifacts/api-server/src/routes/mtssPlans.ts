// MTSS Plans CRUD — student-level intervention plans owned by the MTSS
// coordinator and the rest of the "core team" (admin, BS, PBIS coord,
// SuperUser). Plain teachers cannot read or write — these plans contain
// sensitive intervention notes meant for the support team.
//
// Routes:
//   GET    /api/mtss-plans?status=active|closed|all&studentId=...
//                                              → list this school's plans
//                                                with student name + grade
//                                                joined in
//   POST   /api/mtss-plans                     → create
//   PATCH  /api/mtss-plans/:id                 → edit; pass `closed: true`
//                                                to close, `closed: false`
//                                                to reopen
//   DELETE /api/mtss-plans/:id                 → hard delete
//
// Read access is intentionally gated to the same set as write access.
// MTSS plans contain protected intervention details — broader read access
// can be added later via a separate, more restrictive view if needed.
import { Router, type IRouter } from "express";
import {
  db,
  studentMtssPlansTable,
  staffTable,
  studentsTable,
  studentFastItemResponsesTable,
  studentFastScoresTable,
  schoolSettingsTable,
  mtssFastSuggestionDismissalsTable,
  assessmentsTable,
} from "@workspace/db";
import { and, eq, inArray, sql, asc, isNull, ilike } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import {
  placeOnChart,
  chartGradeFor,
  SUB_LEVEL_LABEL,
  type Subject,
} from "../lib/fastCutScores.js";
import {
  effectiveTeacherIdsForPlan,
  loadScheduleSectionsForStudent,
  loadScheduleTeacherIdsForStudents,
  parseCsvIds,
} from "../lib/effectiveTeachers.js";
import { schoolYearLabelFor, DEFAULT_SCHOOL_TZ } from "../lib/schoolYear.js";
import { loadFastHistory, pickHistory } from "../lib/fastHistory.js";

const router: IRouter = Router();

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

// Core-team gate. Mirrors the client's `canManageMtssPlans` in App.tsx —
// keep in sync if either changes.
function requireCoreTeam(
  staff: typeof staffTable.$inferSelect,
  res: import("express").Response,
) {
  const allowed =
    staff.isSuperUser ||
    staff.isAdmin ||
    staff.isBehaviorSpecialist ||
    staff.isMtssCoordinator ||
    staff.isPbisCoordinator;
  if (!allowed) {
    res.status(403).json({
      error:
        "Only admins, Behavior Specialists, MTSS Coordinators, and PBIS Coordinators can manage MTSS plans",
    });
    return false;
  }
  return true;
}

// Goals are stored newline-delimited in the existing `goals` text column.
// Cap at 5 goals × 800 chars each so the rendered list stays manageable.
const MAX_GOALS = 5;
const MAX_GOAL_CHARS = 800;

function normalizeGoals(v: unknown): string {
  if (typeof v !== "string") return "";
  return v
    .split(/\r?\n/)
    .map((g) => g.trim())
    .filter((g) => g.length > 0)
    .slice(0, MAX_GOALS)
    .map((g) => g.slice(0, MAX_GOAL_CHARS))
    .join("\n");
}

function clampString(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

function parseOptionalInt(v: unknown): number | null | "BAD" {
  if (v === undefined) return "BAD"; // sentinel — caller must check undefined first
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return "BAD";
  return n;
}

// Accept either an array of numbers or a comma-string from the client and
// produce the canonical "12,47,138" CSV the DB column stores. De-dupes
// and drops anything that isn't a positive integer.
function normalizeStaffIdCsv(v: unknown): string {
  if (v === null || v === undefined) return "";
  let arr: unknown[] = [];
  if (Array.isArray(v)) arr = v;
  else if (typeof v === "string") arr = v.split(",");
  else return "";
  const seen = new Set<number>();
  const out: number[] = [];
  for (const raw of arr) {
    const n = Number(typeof raw === "string" ? raw.trim() : raw);
    if (!Number.isInteger(n) || n <= 0) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out.sort((a, b) => a - b).join(",");
}

// ---- TEACHER PROBE ----
// Lightweight endpoint that lets any signed-in staff member ask
// "what tier is the active plan for this student?" without needing the
// Core Team gate. Returns only `{tier, interventionSubType,
// trackSchoolWideExpectations}` (no notes / goal text / strategy
// history) so it's safe to expose to rank-and-file teachers — exactly
// what the LogInterventionLauncher needs to route to Tier 2 vs Tier 3.
//
// School scoping is still enforced via requireSchool; teachers can
// only probe students in their own school. We don't filter by
// `assignedTeacherIds` here because a teacher who picks the wrong
// student would otherwise get a confusing fall-through to Tier 2 — we
// want them to see "this is a Tier 3 student, please log the weekly
// record" even if they aren't on the official assigned list (the
// weekly record submit will then 403 if they really aren't allowed).
router.get("/mtss-plans/probe/:studentId", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const studentId = String(req.params.studentId).trim();
  if (!studentId) {
    res.status(400).json({ error: "studentId required" });
    return;
  }
  const rows = await db
    .select({
      tier: studentMtssPlansTable.tier,
      interventionSubType: studentMtssPlansTable.interventionSubType,
      trackSchoolWideExpectations:
        studentMtssPlansTable.trackSchoolWideExpectations,
      tier3GoalSlots: studentMtssPlansTable.tier3GoalSlots,
      fastSubject: studentMtssPlansTable.fastSubject,
      meetingDays: studentMtssPlansTable.meetingDays,
      closedAt: studentMtssPlansTable.closedAt,
    })
    .from(studentMtssPlansTable)
    .where(
      and(
        eq(studentMtssPlansTable.schoolId, schoolId),
        eq(studentMtssPlansTable.studentId, studentId),
        sql`${studentMtssPlansTable.closedAt} IS NULL`,
      ),
    );
  // If multiple active plans exist (shouldn't, but defensively), prefer
  // Tier 3 over Tier 2 over Tier 1.
  const sorted = rows
    .filter((r) => !r.closedAt)
    .sort((a, b) => Number(b.tier) - Number(a.tier));
  res.json({ plan: sorted[0] ?? null });
});

// ---- TEACHER OPTIONS for the plan modal ----
// Returns the resolved schedule teachers for this student plus a sorted
// list of every active staff member in the school. The modal uses the
// schedule list to render the "include all teachers on this student's
// schedule" checklist (with per-teacher exclude X) and the staff list
// to drive the "Add additional interventionists" picker.
router.get("/mtss-plans/teacher-options", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requireCoreTeam(staff, res)) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const studentId =
    typeof req.query.studentId === "string"
      ? req.query.studentId.trim()
      : "";
  if (!studentId) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  // Confirm the student lives in this school before exposing their
  // schedule (cross-tenant attack defense).
  const [student] = await db
    .select({ id: studentsTable.id })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, studentId),
        eq(studentsTable.schoolId, schoolId),
      ),
    );
  if (!student) {
    res.status(404).json({ error: "Student not found in this school" });
    return;
  }
  const sections = await loadScheduleSectionsForStudent(schoolId, studentId);
  const scheduleStaffIds = Array.from(
    new Set(sections.map((s) => s.staffId)),
  );
  // Pull all active staff in the school for the picker. Names only.
  const allStaff = await db
    .select({
      id: staffTable.id,
      displayName: staffTable.displayName,
    })
    .from(staffTable)
    .where(and(eq(staffTable.schoolId, schoolId), eq(staffTable.active, true)))
    .orderBy(asc(staffTable.displayName));
  const nameById = new Map(allStaff.map((s) => [s.id, s.displayName]));
  const scheduleTeachers = sections.map((s) => ({
    staffId: s.staffId,
    displayName: nameById.get(s.staffId) ?? `#${s.staffId}`,
    period: s.period,
    courseName: s.courseName,
  }));
  res.json({
    studentId,
    scheduleTeachers,
    scheduleStaffIds,
    staffOptions: allStaff,
  });
});

// ---- LIST ----
router.get("/mtss-plans", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requireCoreTeam(staff, res)) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const status =
    typeof req.query.status === "string" ? req.query.status : "active";
  const studentId =
    typeof req.query.studentId === "string"
      ? req.query.studentId.trim()
      : "";

  const conds = [eq(studentMtssPlansTable.schoolId, schoolId)];
  if (status === "active") {
    conds.push(sql`${studentMtssPlansTable.closedAt} IS NULL`);
  } else if (status === "closed") {
    conds.push(sql`${studentMtssPlansTable.closedAt} IS NOT NULL`);
  } // "all" → no extra filter
  if (studentId) {
    conds.push(eq(studentMtssPlansTable.studentId, studentId));
  }

  // Left-join students so the UI doesn't have to make a second round-trip
  // to render the name. AND-filtered by school to honor multi-tenancy
  // (studentId is text and not globally unique across schools).
  const rows = await db
    .select({
      plan: studentMtssPlansTable,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
      localSisId: studentsTable.localSisId,
    })
    .from(studentMtssPlansTable)
    .leftJoin(
      studentsTable,
      and(
        eq(studentsTable.studentId, studentMtssPlansTable.studentId),
        eq(studentsTable.schoolId, studentMtssPlansTable.schoolId),
      ),
    )
    .where(and(...conds))
    .orderBy(sql`${studentMtssPlansTable.openedAt} DESC`);

  // Resolve effective teachers (schedule + additional − excluded) for
  // every plan in one batch so the UI doesn't need follow-up calls.
  const studentIdsForLookup = Array.from(
    new Set(rows.map((r) => r.plan.studentId)),
  );
  const scheduleByStudent = await loadScheduleTeacherIdsForStudents(
    schoolId,
    studentIdsForLookup,
  );
  const allStaffIds = new Set<number>();
  for (const r of rows) {
    const sched = scheduleByStudent.get(r.plan.studentId) ?? [];
    for (const id of effectiveTeacherIdsForPlan(r.plan, sched)) {
      allStaffIds.add(id);
    }
    // Always also resolve names for explicit additionals/excluded so the
    // UI can render badges for "excluded teacher: Mr. Smith" etc. even
    // when they're no longer effective.
    for (const id of parseCsvIds(r.plan.additionalInterventionistIds)) {
      allStaffIds.add(id);
    }
    for (const id of parseCsvIds(r.plan.excludedTeacherIds)) {
      allStaffIds.add(id);
    }
  }
  const staffNameRows =
    allStaffIds.size === 0
      ? []
      : await db
          .select({ id: staffTable.id, displayName: staffTable.displayName })
          .from(staffTable)
          .where(
            and(
              eq(staffTable.schoolId, schoolId),
              inArray(staffTable.id, Array.from(allStaffIds)),
            ),
          );
  const nameById = new Map(staffNameRows.map((s) => [s.id, s.displayName]));

  res.json(
    rows.map((r) => {
      const sched = scheduleByStudent.get(r.plan.studentId) ?? [];
      const effective = effectiveTeacherIdsForPlan(r.plan, sched);
      return {
        ...r.plan,
        studentName:
          r.firstName && r.lastName ? `${r.firstName} ${r.lastName}` : null,
        studentGrade: r.grade ?? null,
        studentLocalSisId: r.localSisId ?? null,
        effectiveTeacherIds: effective,
        effectiveTeachers: effective.map((id) => ({
          staffId: id,
          displayName: nameById.get(id) ?? `#${id}`,
          source: sched.includes(id) ? "schedule" : "additional",
        })),
      };
    }),
  );
});

// ---- CREATE ----
router.post("/mtss-plans", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requireCoreTeam(staff, res)) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const {
    studentId,
    title,
    goals,
    tier,
    pointRangeMin,
    pointRangeMax,
    notes,
    autoAssignScheduleTeachers,
    excludedTeacherIds,
    additionalInterventionistIds,
    assignedTeacherIds, // legacy/manual list — only honored when auto=false
    fastBenchmarkCode,
    fastSubject,
    meetingDays,
  } = req.body ?? {};

  // Academic Tier 3 monitoring meeting days (validated CSV, "" → null).
  const cleanMeetingDays = normalizeMeetingDays(meetingDays) || null;

  // Subject-level academic plans created from the condensed FAST
  // scale-score suggestions. Only "ela" / "math" are accepted; anything
  // else (including the advanced EOC subjects) stores NULL.
  const cleanFastSubject =
    fastSubject === "ela" || fastSubject === "math" ? fastSubject : null;

  const cleanStudentId =
    typeof studentId === "string" ? studentId.trim() : "";
  if (!cleanStudentId) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  const cleanTitle = clampString(title, 200);
  if (!cleanTitle) {
    res.status(400).json({ error: "title is required" });
    return;
  }

  // The student must exist in THIS school (closes the cross-tenant id
  // attach). studentId is text + not globally unique.
  const [student] = await db
    .select()
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

  let tierVal = 2;
  if (typeof tier === "number" && [1, 2, 3].includes(tier)) tierVal = tier;

  const minParsed = parseOptionalInt(
    pointRangeMin === undefined ? null : pointRangeMin,
  );
  const maxParsed = parseOptionalInt(
    pointRangeMax === undefined ? null : pointRangeMax,
  );
  if (minParsed === "BAD") {
    res.status(400).json({ error: "pointRangeMin must be an integer" });
    return;
  }
  if (maxParsed === "BAD") {
    res.status(400).json({ error: "pointRangeMax must be an integer" });
    return;
  }
  if (
    minParsed !== null &&
    maxParsed !== null &&
    minParsed > maxParsed
  ) {
    res
      .status(400)
      .json({ error: "pointRangeMin cannot exceed pointRangeMax" });
    return;
  }

  // New-plan default: auto-track the student's schedule unless the
  // client explicitly says otherwise. Excluded list and additional
  // interventionists default to empty.
  const autoFlag =
    typeof autoAssignScheduleTeachers === "boolean"
      ? autoAssignScheduleTeachers
      : true;

  const excludedCsv = normalizeStaffIdCsv(excludedTeacherIds);
  const additionalCsv = normalizeStaffIdCsv(additionalInterventionistIds);

  // Always recompute the legacy `assignedTeacherIds` server-side so
  // older readers (and any code path that still consults the CSV
  // directly) stays in sync with the new effective list. When
  // auto=true we materialize schedule ∪ additional − excluded; when
  // auto=false we honor the explicit list the client sent.
  let assignedCsv: string;
  if (autoFlag) {
    const sched = (
      await loadScheduleTeacherIdsForStudents(schoolId, [cleanStudentId])
    ).get(cleanStudentId) ?? [];
    const eff = effectiveTeacherIdsForPlan(
      {
        autoAssignScheduleTeachers: true,
        assignedTeacherIds: "",
        excludedTeacherIds: excludedCsv,
        additionalInterventionistIds: additionalCsv,
      },
      sched,
    );
    assignedCsv = eff.join(",");
  } else {
    assignedCsv = normalizeStaffIdCsv(assignedTeacherIds);
  }

  const [row] = await db
    .insert(studentMtssPlansTable)
    .values({
      schoolId,
      studentId: cleanStudentId,
      title: cleanTitle,
      goals: normalizeGoals(goals),
      tier: tierVal,
      pointRangeMin: minParsed,
      pointRangeMax: maxParsed,
      notes: clampString(notes, 4000),
      openedByStaffId: staff.id,
      openedByName: staff.displayName,
      autoAssignScheduleTeachers: autoFlag,
      excludedTeacherIds: excludedCsv,
      additionalInterventionistIds: additionalCsv,
      assignedTeacherIds: assignedCsv,
      fastBenchmarkCode:
        typeof fastBenchmarkCode === "string" && fastBenchmarkCode.trim()
          ? fastBenchmarkCode.trim().slice(0, 64)
          : null,
      fastSubject: cleanFastSubject,
      meetingDays: cleanMeetingDays,
    })
    .returning();

  res.status(201).json(row);
});

// ---- UPDATE ----
router.patch("/mtss-plans/:id", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requireCoreTeam(staff, res)) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [existing] = await db
    .select()
    .from(studentMtssPlansTable)
    .where(
      and(
        eq(studentMtssPlansTable.id, id),
        eq(studentMtssPlansTable.schoolId, schoolId),
      ),
    );
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const {
    title,
    goals,
    tier,
    pointRangeMin,
    pointRangeMax,
    notes,
    closed,
    autoAssignScheduleTeachers,
    excludedTeacherIds,
    additionalInterventionistIds,
    assignedTeacherIds, // legacy/manual list — only honored when auto=false
    fastBenchmarkCode,
    fastSubject,
    meetingDays,
  } = req.body ?? {};

  const updates: Partial<typeof studentMtssPlansTable.$inferInsert> = {};

  if (fastBenchmarkCode !== undefined) {
    if (fastBenchmarkCode === null || fastBenchmarkCode === "") {
      updates.fastBenchmarkCode = null;
    } else if (typeof fastBenchmarkCode === "string") {
      updates.fastBenchmarkCode = fastBenchmarkCode.trim().slice(0, 64) || null;
    }
  }
  if (fastSubject !== undefined) {
    updates.fastSubject =
      fastSubject === "ela" || fastSubject === "math" ? fastSubject : null;
  }
  // Academic Tier 3 monitoring meeting days. Empty/invalid → null, which
  // demotes the plan back to "light" (no per-day bell). Lets Core Team
  // escalate a Tier 2 academic plan to a monitored Tier 3 by setting
  // tier:3 + meetingDays in one PATCH.
  if (meetingDays !== undefined) {
    updates.meetingDays = normalizeMeetingDays(meetingDays) || null;
  }

  if (typeof title === "string" && title.trim()) {
    updates.title = title.trim().slice(0, 200);
  }
  if (typeof goals === "string") {
    updates.goals = normalizeGoals(goals);
  }
  if (typeof notes === "string") {
    updates.notes = notes.trim().slice(0, 4000);
  }
  if (typeof tier === "number" && [1, 2, 3].includes(tier)) {
    updates.tier = tier;
  }

  if (pointRangeMin !== undefined) {
    const p = parseOptionalInt(pointRangeMin);
    if (p === "BAD") {
      res.status(400).json({ error: "pointRangeMin must be an integer" });
      return;
    }
    updates.pointRangeMin = p;
  }
  if (pointRangeMax !== undefined) {
    const p = parseOptionalInt(pointRangeMax);
    if (p === "BAD") {
      res.status(400).json({ error: "pointRangeMax must be an integer" });
      return;
    }
    updates.pointRangeMax = p;
  }

  // Validate min/max against the post-update values, not just whichever
  // side the client sent.
  const newMin =
    updates.pointRangeMin !== undefined
      ? updates.pointRangeMin
      : existing.pointRangeMin;
  const newMax =
    updates.pointRangeMax !== undefined
      ? updates.pointRangeMax
      : existing.pointRangeMax;
  if (newMin != null && newMax != null && newMin > newMax) {
    res
      .status(400)
      .json({ error: "pointRangeMin cannot exceed pointRangeMax" });
    return;
  }

  if (typeof autoAssignScheduleTeachers === "boolean") {
    updates.autoAssignScheduleTeachers = autoAssignScheduleTeachers;
  }
  if (excludedTeacherIds !== undefined) {
    updates.excludedTeacherIds = normalizeStaffIdCsv(excludedTeacherIds);
  }
  if (additionalInterventionistIds !== undefined) {
    updates.additionalInterventionistIds = normalizeStaffIdCsv(
      additionalInterventionistIds,
    );
  }

  // Keep the legacy `assignedTeacherIds` CSV in lockstep with the new
  // assignment fields whenever any of them is touched (or the toggle
  // flips). For auto plans we recompute schedule ∪ additional −
  // excluded; for manual plans we honor whatever the client sent
  // (falling back to the existing list to avoid a surprise wipe).
  const touchesAssignment =
    updates.autoAssignScheduleTeachers !== undefined ||
    updates.excludedTeacherIds !== undefined ||
    updates.additionalInterventionistIds !== undefined ||
    assignedTeacherIds !== undefined;
  if (touchesAssignment) {
    const newAuto =
      updates.autoAssignScheduleTeachers !== undefined
        ? updates.autoAssignScheduleTeachers
        : existing.autoAssignScheduleTeachers;
    const newExcluded =
      updates.excludedTeacherIds !== undefined
        ? updates.excludedTeacherIds
        : existing.excludedTeacherIds;
    const newAdditional =
      updates.additionalInterventionistIds !== undefined
        ? updates.additionalInterventionistIds
        : existing.additionalInterventionistIds;
    if (newAuto) {
      const sched = (
        await loadScheduleTeacherIdsForStudents(schoolId, [existing.studentId])
      ).get(existing.studentId) ?? [];
      const eff = effectiveTeacherIdsForPlan(
        {
          autoAssignScheduleTeachers: true,
          assignedTeacherIds: "",
          excludedTeacherIds: newExcluded,
          additionalInterventionistIds: newAdditional,
        },
        sched,
      );
      updates.assignedTeacherIds = eff.join(",");
    } else if (assignedTeacherIds !== undefined) {
      updates.assignedTeacherIds = normalizeStaffIdCsv(assignedTeacherIds);
    }
    // else: manual mode + client did not send assignedTeacherIds →
    // leave the existing CSV alone to avoid a surprise wipe.
  }

  if (closed === true && !existing.closedAt) {
    updates.closedAt = new Date();
    updates.closedByStaffId = staff.id;
    updates.closedByName = staff.displayName;
  } else if (closed === false && existing.closedAt) {
    updates.closedAt = null;
    updates.closedByStaffId = null;
    updates.closedByName = null;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No updates" });
    return;
  }
  updates.updatedAt = new Date();

  const [row] = await db
    .update(studentMtssPlansTable)
    .set(updates)
    .where(
      and(
        eq(studentMtssPlansTable.id, id),
        eq(studentMtssPlansTable.schoolId, schoolId),
      ),
    )
    .returning();
  res.json(row);
});

// ---- DELETE ----
router.delete("/mtss-plans/:id", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requireCoreTeam(staff, res)) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const result = await db
    .delete(studentMtssPlansTable)
    .where(
      and(
        eq(studentMtssPlansTable.id, id),
        eq(studentMtssPlansTable.schoolId, schoolId),
      ),
    )
    .returning();
  if (result.length === 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------
// FAST Phase 5 — Tier 2 auto-suggestions
//
// GET  /api/mtss-plans/fast-suggestions
//   For each (student, benchmarkCode) in the school whose mastery
//   percent is below the school's mastery threshold in at least
//   `fast_tier2_min_windows` of the most-recent 3 FAST windows (per
//   subject), return a suggestion row with per-window pcts and a
//   prefill payload for the PlanModal. Excludes:
//     - pairs whose student×benchmark already has an active MTSS plan
//       with a matching fast_benchmark_code
//     - pairs already dismissed in the current school year
//
// POST /api/mtss-plans/fast-suggestions/dismiss
//   Body: { studentId, benchmarkCode }. Inserts an idempotent
//   dismissal row keyed to the current school year. Returns
//   { ok, dismissedAt }.
// ---------------------------------------------------------------

const FAST_SUBJECTS = ["ela", "math", "algebra1", "geometry"] as const;

// Map a Florida FAST category label (state-printed, e.g. "Reading Prose
// and Poetry") to a short strategy descriptor we use in the prefilled
// plan title. Best-effort — falls back to the raw category label when
// no rule fires. Casing-insensitive prefix match keeps it resilient to
// minor formatting drift between subjects.
export function strategyCategoryForBenchmark(
  category: string | null,
  benchmarkCode: string,
): string {
  const c = (category ?? "").toLowerCase();
  // Math: derive from the benchmark code's strand prefix BEFORE
  // falling back to the category label. Florida's grade 6+ Math
  // category "Geometric Reasoning, Data Analysis, and Probability"
  // bundles GR.* and DP.* benchmarks under a single label, so the
  // category text alone cannot tell geometry from data — only the
  // code can. Strands used by Florida B.E.S.T. math standards:
  //   NSO = Number Sense & Operations
  //   FR  = Fractions (K-5)
  //   AR  = Algebraic Reasoning
  //   M   = Measurement (K-5)
  //   GR  = Geometric Reasoning
  //   DP  = Data Analysis & Probability
  const mathStrand = /^MA\.[^.]+\.([A-Z]+)\./i.exec(benchmarkCode);
  if (mathStrand) {
    const strand = mathStrand[1].toUpperCase();
    if (strand === "NSO") return "Math — Numbers & Operations";
    if (strand === "FR") return "Math — Fractions";
    if (strand === "AR") return "Math — Algebraic Reasoning";
    if (strand === "M") return "Math — Measurement";
    if (strand === "GR") return "Math — Geometry & Measurement";
    if (strand === "DP") return "Math — Data & Statistics";
  }
  if (c.includes("reading prose")) return "Reading Comprehension";
  if (c.includes("reading informational")) return "Reading Comprehension";
  if (c.includes("across genres")) return "Reading Comprehension";
  if (c.includes("vocabulary")) return "Vocabulary";
  if (c.includes("foundational")) return "Reading Foundations";
  // Grade 7 Math: "Proportional Reasoning and Relationships".
  if (c.includes("proportional")) return "Math — Ratios & Proportions";
  // Grade 8 Math: "Linear Relationships, Data Analysis and Functions" —
  // matches "linear" before the generic "data" branch.
  if (c.includes("linear")) return "Math — Linear Relationships & Functions";
  if (c.includes("number sense") || c.includes("number and operations"))
    return "Math — Numbers & Operations";
  if (c.includes("algebraic") || c.includes("algebra"))
    return "Math — Algebraic Reasoning";
  if (c.includes("geometric") || c.includes("geometry"))
    return "Math — Geometry & Measurement";
  if (c.includes("data") || c.includes("statistic") || c.includes("probability"))
    return "Math — Data & Statistics";
  if (category && category.trim()) return category.trim();
  // Last resort: derive from benchmark code prefix.
  if (/^ELA\./i.test(benchmarkCode)) return "Reading";
  if (/^MA\./i.test(benchmarkCode) || /^MATH\./i.test(benchmarkCode))
    return "Math";
  return "Academic";
}

// Map a Florida benchmark code to its academic subject. Used to exclude a
// student from re-suggestion when they already carry a legacy
// benchmark-level academic plan (those store only fastBenchmarkCode, not
// fastSubject). ELA.* → ela; MA.* / MATH.* → math; anything else → null.
function benchmarkSubjectOf(code: string | null): "ela" | "math" | null {
  if (!code) return null;
  if (/^ELA\./i.test(code)) return "ela";
  if (/^MA\./i.test(code) || /^MATH\./i.test(code)) return "math";
  return null;
}

// Canonical scheduled meeting-day keys for academic Tier 3 plans.
const MEETING_DAY_KEYS = ["mon", "tue", "wed", "thu", "fri"] as const;
type MeetingDay = (typeof MEETING_DAY_KEYS)[number];

// Parse a client-supplied meeting-days value (array OR CSV string) into a
// canonical, deduped, Mon→Fri-ordered CSV (e.g. "tue,thu"). Returns "" when
// nothing valid was supplied. Drives the per-meeting-day bell + the
// "save until every scheduled day is logged" check-in cadence.
function normalizeMeetingDays(input: unknown): string {
  let parts: string[] = [];
  if (Array.isArray(input)) {
    parts = input.map((x) => (typeof x === "string" ? x : "")).filter(Boolean);
  } else if (typeof input === "string") {
    parts = input.split(",");
  }
  const set = new Set<MeetingDay>();
  for (const p of parts) {
    const k = p.trim().toLowerCase();
    if ((MEETING_DAY_KEYS as readonly string[]).includes(k)) {
      set.add(k as MeetingDay);
    }
  }
  return MEETING_DAY_KEYS.filter((d) => set.has(d)).join(",");
}

router.get("/mtss-plans/fast-suggestions", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requireCoreTeam(staff, res)) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const currentSchoolYear = schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ);

  // ---- Settings ----
  // The mastery threshold + min-windows are used ONLY to flag weak
  // benchmarks for the per-row "weak standards" dropdown. They do NOT
  // gate qualification anymore — a student qualifies for a subject-level
  // academic plan purely by their latest FAST SCALE SCORE placing them at
  // Level 1 or 2 (below the grade-level Level 3 cut). The user dropped the
  // per-subject gap inputs and the benchmark-mastery qualification gate.
  const [settings] = await db
    .select()
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  const thresholdPct = settings?.fastBenchmarkMasteryThreshold ?? 80;
  const minWindows = Math.min(
    3,
    Math.max(1, settings?.fastTier2MinWindows ?? 2),
  );

  // =================================================================
  // QUALIFICATION — latest FAST scale score at Level 1 or 2
  // =================================================================
  // One row per (student, subject) for ELA & Math. We take the most
  // recent current-year (non-historical) score row per pair and place
  // its latest available window (pm3 → pm2 → pm1) on the FAST chart.
  // Level 1 or 2 ⇒ below the grade-level benchmark ⇒ qualifies.
  const ACADEMIC_SUBJECTS = ["ela", "math"] as const;
  type AcademicSubject = (typeof ACADEMIC_SUBJECTS)[number];

  const scoreRows = await db
    .select({
      studentId: studentFastScoresTable.studentId,
      subject: studentFastScoresTable.subject,
      schoolYear: studentFastScoresTable.schoolYear,
      pm1: studentFastScoresTable.pm1,
      pm2: studentFastScoresTable.pm2,
      pm3: studentFastScoresTable.pm3,
    })
    .from(studentFastScoresTable)
    .where(
      and(
        eq(studentFastScoresTable.schoolId, schoolId),
        eq(studentFastScoresTable.isHistorical, false),
        inArray(studentFastScoresTable.subject, [...ACADEMIC_SUBJECTS]),
      ),
    );

  // Keep the most-recent school_year row per (student, subject).
  const latestScoreByPair = new Map<string, (typeof scoreRows)[number]>();
  for (const r of scoreRows) {
    const key = `${r.studentId}|${r.subject}`;
    const prev = latestScoreByPair.get(key);
    if (!prev || r.schoolYear.localeCompare(prev.schoolYear) > 0) {
      latestScoreByPair.set(key, r);
    }
  }

  // ---- Student names + grades (grade is required to pick the chart) ----
  const candidateStudentIds = Array.from(
    new Set(Array.from(latestScoreByPair.values()).map((r) => r.studentId)),
  );
  const studentRows =
    candidateStudentIds.length === 0
      ? []
      : await db
          .select({
            studentId: studentsTable.studentId,
            firstName: studentsTable.firstName,
            lastName: studentsTable.lastName,
            grade: studentsTable.grade,
            localSisId: studentsTable.localSisId,
          })
          .from(studentsTable)
          .where(
            and(
              eq(studentsTable.schoolId, schoolId),
              inArray(studentsTable.studentId, candidateStudentIds),
            ),
          );
  const studentMeta = new Map(
    studentRows.map((s) => [
      s.studentId,
      {
        name: `${s.firstName} ${s.lastName}`,
        grade: s.grade ?? null,
        localSisId: s.localSisId ?? null,
      },
    ]),
  );

  // =================================================================
  // iReady AP1 — the second qualification gate for Tier 3 Academic
  // =================================================================
  // iReady scores land in the generic assessments table via the Data
  // Importer (free-form name like "iReady Reading AP1", source "iReady").
  // We pull every AP1 row for the candidate students, map the subject
  // off the name (reading → ela, math → math), and keep the most recent
  // by administered date per (student, subject).
  const ireadyAp1ByPair = new Map<string, number>();
  if (candidateStudentIds.length > 0) {
    const ap1Rows = await db
      .select({
        studentId: assessmentsTable.studentId,
        assessmentName: assessmentsTable.assessmentName,
        score: assessmentsTable.score,
        administeredAt: assessmentsTable.administeredAt,
      })
      .from(assessmentsTable)
      .where(
        and(
          eq(assessmentsTable.schoolId, schoolId),
          inArray(assessmentsTable.studentId, candidateStudentIds),
          ilike(assessmentsTable.source, "%iready%"),
          ilike(assessmentsTable.assessmentName, "%ap1%"),
        ),
      );
    const ap1LatestAt = new Map<string, number>();
    for (const r of ap1Rows) {
      if (r.score == null) continue;
      const name = r.assessmentName.toLowerCase();
      let subj: "ela" | "math" | null = null;
      // Check "math" FIRST: every iReady name starts with "iReady", and
      // "iready" contains the substring "read", so a "read" test would
      // misclassify "iReady Math AP1" as ELA.
      if (name.includes("math")) subj = "math";
      else if (name.includes("read") || name.includes("ela")) subj = "ela";
      if (!subj) continue;
      const key = `${r.studentId}|${subj}`;
      const at =
        r.administeredAt instanceof Date
          ? r.administeredAt.getTime()
          : new Date(r.administeredAt).getTime();
      const prevAt = ap1LatestAt.get(key);
      if (prevAt == null || at > prevAt) {
        ap1LatestAt.set(key, at);
        ireadyAp1ByPair.set(key, r.score);
      }
    }
  }

  // Per-grade, per-subject iReady AP1 cut scores configured by the MTSS
  // coordinator. A missing cut for a (grade, subject) means no Tier 3
  // suggestion can surface there yet — the coordinator must fill it in.
  const ireadyCuts = (settings?.ireadyAp1Cuts ?? { ela: {}, math: {} }) as {
    ela?: Record<string, number>;
    math?: Record<string, number>;
  };
  const cutFor = (subject: "ela" | "math", grade: number): number | null => {
    const v = ireadyCuts?.[subject]?.[String(grade)];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };

  // =================================================================
  // EXCLUSIONS — active academic plan (by subject) + dismissals
  // =================================================================
  const activePlans = await db
    .select({
      studentId: studentMtssPlansTable.studentId,
      fastSubject: studentMtssPlansTable.fastSubject,
      fastBenchmarkCode: studentMtssPlansTable.fastBenchmarkCode,
    })
    .from(studentMtssPlansTable)
    .where(
      and(
        eq(studentMtssPlansTable.schoolId, schoolId),
        isNull(studentMtssPlansTable.closedAt),
      ),
    );
  // A (student, subject) pair is excluded when the student already has an
  // active academic plan for that subject — either a subject-level plan
  // (fastSubject set) OR a legacy benchmark-level plan whose code maps to
  // the subject (fastBenchmarkCode prefix).
  const excludedPairs = new Set<string>();
  for (const p of activePlans) {
    if (p.fastSubject === "ela" || p.fastSubject === "math") {
      excludedPairs.add(`${p.studentId}|${p.fastSubject}`);
    }
    const bSub = benchmarkSubjectOf(p.fastBenchmarkCode);
    if (bSub) excludedPairs.add(`${p.studentId}|${bSub}`);
  }

  // Dismissals are now keyed by SUBJECT (the benchmark_code column stores
  // "ela" / "math" for subject-level dismissals). Legacy benchmark-code
  // dismissals simply won't match a subject key, which is the intended
  // re-key behavior.
  const dismissals = await db
    .select({
      studentId: mtssFastSuggestionDismissalsTable.studentId,
      benchmarkCode: mtssFastSuggestionDismissalsTable.benchmarkCode,
    })
    .from(mtssFastSuggestionDismissalsTable)
    .where(
      and(
        eq(mtssFastSuggestionDismissalsTable.schoolId, schoolId),
        eq(mtssFastSuggestionDismissalsTable.schoolYear, currentSchoolYear),
      ),
    );
  const dismissedPairs = new Set<string>(
    dismissals.map((d) => `${d.studentId}|${d.benchmarkCode}`),
  );

  // =================================================================
  // WEAK STANDARDS — per-row expandable dropdown (informational)
  // =================================================================
  // Reuses the FAST item-response feed: a benchmark is "weak" when the
  // student is below the mastery threshold in >= minWindows of the last 3
  // windows. Grouped per (student, subject). Does NOT affect
  // qualification — purely the dropdown detail under each row.
  type WeakStandard = {
    benchmarkCode: string;
    category: string | null;
    strategyCategory: string;
    belowCount: number;
    latestPct: number | null;
  };
  const weakByPair = new Map<string, WeakStandard[]>();

  // Resolve the last 3 (schoolYear, window) tuples per subject.
  const tupleRows = await db
    .selectDistinct({
      subject: studentFastItemResponsesTable.subject,
      schoolYear: studentFastItemResponsesTable.schoolYear,
      window: studentFastItemResponsesTable.window,
    })
    .from(studentFastItemResponsesTable)
    .where(eq(studentFastItemResponsesTable.schoolId, schoolId));
  const recentBySubject = new Map<
    string,
    Array<{ schoolYear: string; window: string }>
  >();
  for (const t of tupleRows) {
    if (t.subject !== "ela" && t.subject !== "math") continue;
    const arr = recentBySubject.get(t.subject) ?? [];
    arr.push({ schoolYear: t.schoolYear, window: t.window });
    recentBySubject.set(t.subject, arr);
  }
  for (const [subject, arr] of recentBySubject) {
    arr.sort((a, b) => {
      if (a.schoolYear !== b.schoolYear) {
        return b.schoolYear.localeCompare(a.schoolYear);
      }
      return b.window.localeCompare(a.window);
    });
    recentBySubject.set(subject, arr.slice(0, 3));
  }
  const allTuples: Array<{
    subject: string;
    schoolYear: string;
    window: string;
  }> = [];
  for (const [subject, arr] of recentBySubject) {
    for (const w of arr) {
      allTuples.push({ subject, schoolYear: w.schoolYear, window: w.window });
    }
  }

  if (allTuples.length > 0) {
    const tupleClause = sql.join(
      allTuples.map(
        (t) =>
          sql`(${studentFastItemResponsesTable.subject} = ${t.subject} AND ${studentFastItemResponsesTable.schoolYear} = ${t.schoolYear} AND ${studentFastItemResponsesTable.window} = ${t.window})`,
      ),
      sql` OR `,
    );
    const rows = await db
      .select({
        studentId: studentFastItemResponsesTable.studentId,
        subject: studentFastItemResponsesTable.subject,
        schoolYear: studentFastItemResponsesTable.schoolYear,
        window: studentFastItemResponsesTable.window,
        category: studentFastItemResponsesTable.category,
        benchmarkCode: studentFastItemResponsesTable.benchmarkCode,
        pointsEarned: studentFastItemResponsesTable.pointsEarned,
        pointsPossible: studentFastItemResponsesTable.pointsPossible,
      })
      .from(studentFastItemResponsesTable)
      .where(
        and(
          eq(studentFastItemResponsesTable.schoolId, schoolId),
          sql`(${tupleClause})`,
        ),
      );

    type Agg = {
      studentId: string;
      benchmarkCode: string;
      subject: string;
      category: string | null;
      perWindow: Map<string, { earned: number; possible: number }>;
    };
    const byPair = new Map<string, Agg>();
    for (const r of rows) {
      if (r.pointsPossible == null || r.pointsPossible <= 0) continue;
      const key = `${r.studentId}|${r.benchmarkCode}`;
      let agg = byPair.get(key);
      if (!agg) {
        agg = {
          studentId: r.studentId,
          benchmarkCode: r.benchmarkCode,
          subject: r.subject,
          category: r.category,
          perWindow: new Map(),
        };
        byPair.set(key, agg);
      }
      if (!agg.category && r.category) agg.category = r.category;
      const wkey = `${r.schoolYear}|${r.window}`;
      const slot = agg.perWindow.get(wkey) ?? { earned: 0, possible: 0 };
      slot.earned += r.pointsEarned ?? 0;
      slot.possible += r.pointsPossible;
      agg.perWindow.set(wkey, slot);
    }

    for (const agg of byPair.values()) {
      if (agg.subject !== "ela" && agg.subject !== "math") continue;
      const subjectWindows = recentBySubject.get(agg.subject) ?? [];
      const windows = subjectWindows.map((w) => {
        const slot = agg.perWindow.get(`${w.schoolYear}|${w.window}`);
        if (!slot || slot.possible <= 0) {
          return { masteryPct: -1, below: false };
        }
        const ratioPct = (slot.earned / slot.possible) * 100;
        return {
          masteryPct: Math.round(ratioPct),
          below: ratioPct < thresholdPct,
        };
      });
      const belowCount = windows.filter((w) => w.below).length;
      if (belowCount < minWindows) continue;
      const latestPct = windows.find((w) => w.masteryPct >= 0)?.masteryPct;
      const key = `${agg.studentId}|${agg.subject}`;
      const list = weakByPair.get(key) ?? [];
      list.push({
        benchmarkCode: agg.benchmarkCode,
        category: agg.category,
        strategyCategory: strategyCategoryForBenchmark(
          agg.category,
          agg.benchmarkCode,
        ),
        belowCount,
        latestPct: latestPct ?? null,
      });
      weakByPair.set(key, list);
    }
    for (const list of weakByPair.values()) {
      list.sort(
        (a, b) =>
          b.belowCount - a.belowCount ||
          a.benchmarkCode.localeCompare(b.benchmarkCode),
      );
    }
  }

  // =================================================================
  // BUILD SUGGESTIONS — one per qualifying (student, subject)
  // =================================================================
  type Suggestion = {
    studentId: string;
    studentLocalSisId: string | null;
    studentName: string | null;
    studentGrade: number | null;
    subject: AcademicSubject;
    level: number;
    subLevel: string;
    levelLabel: string;
    score: number;
    window: string;
    schoolYear: string;
    // iReady AP1 evidence — the second Tier 3 gate. `ireadyAp1` is the
    // student's most-recent AP1 scale score; `ap1Cut` is the configured
    // per-grade per-subject cut it fell below.
    ireadyAp1: number;
    ap1Cut: number;
    suggestedTitle: string;
    suggestedGoal: string;
    weakStandards: WeakStandard[];
    priorYearPm3: { schoolYear: string; pm3: number } | null;
  };
  const suggestions: Suggestion[] = [];
  // Grades among FAST PM1 = Level 1 candidates (BEFORE the iReady gate),
  // so the cut-score grid in the UI shows exactly the grades that have
  // students waiting on a cut — even when no cut is configured yet.
  const gradesPresent = new Set<number>();

  for (const [key, row] of latestScoreByPair) {
    if (excludedPairs.has(key) || dismissedPairs.has(key)) continue;
    const subject = row.subject as AcademicSubject;
    const meta = studentMeta.get(row.studentId);
    const grade = meta?.grade ?? null;
    // Need a grade to select the FAST chart; skip if missing.
    if (grade == null) continue;

    // Tier 3 Academic gate #1: FAST PM1 must place the student at
    // Level 1. PM1 specifically (not the latest window) — this is the
    // beginning-of-year signal paired with iReady AP1.
    if (row.pm1 == null) continue;
    const window = "pm1";
    const score = row.pm1;
    const chartGrade = chartGradeFor(subject as Subject, grade, window);
    const placement = placeOnChart(score, subject as Subject, chartGrade);
    if (!placement || placement.level !== 1) continue;

    // This student is a PM1 Level-1 candidate — record their grade for
    // the cut-score grid regardless of whether a cut is configured.
    gradesPresent.add(grade);

    // Tier 3 Academic gate #2: iReady AP1 present AND strictly below the
    // configured per-grade per-subject cut. Both gates required (BOTH).
    const ap1 = ireadyAp1ByPair.get(key);
    const cut = cutFor(subject, grade);
    if (ap1 == null || cut == null || ap1 >= cut) continue;

    const levelLabel = SUB_LEVEL_LABEL[placement.subLevel];
    const subjLabel = subject === "ela" ? "ELA" : "Math";
    suggestions.push({
      studentId: row.studentId,
      studentLocalSisId: meta?.localSisId ?? null,
      studentName: meta?.name ?? null,
      studentGrade: grade,
      subject,
      level: placement.level,
      subLevel: placement.subLevel,
      levelLabel,
      score,
      window,
      schoolYear: row.schoolYear,
      ireadyAp1: ap1,
      ap1Cut: cut,
      suggestedTitle: `Tier 3 Academic — ${subjLabel}`,
      suggestedGoal:
        `Student scored ${score} on FAST ${subjLabel} PM1 ` +
        `(Level 1, ${levelLabel}) and ${ap1} on iReady ${subjLabel} AP1, ` +
        `below the grade ${grade} cut of ${cut}. Both early-year measures ` +
        `place the student well below grade level. Goal: provide intensive, ` +
        `closely-monitored Tier 3 ${subjLabel} intervention and re-evaluate ` +
        `at the next FAST/iReady window.`,
      weakStandards: weakByPair.get(key) ?? [],
      priorYearPm3: null,
    });
  }

  // ---- Prior-year PM3 context (FL historical importer) ----
  if (suggestions.length > 0) {
    const ids = Array.from(new Set(suggestions.map((s) => s.studentId)));
    const historyMap = await loadFastHistory({ schoolId, studentIds: ids });
    for (const s of suggestions) {
      const hist = pickHistory(historyMap, s.studentId, s.subject);
      if (hist.length > 0) {
        s.priorYearPm3 = { schoolYear: hist[0].schoolYear, pm3: hist[0].pm3 };
      }
    }
  }

  // Sort: lowest level first (most in need), then by student name.
  suggestions.sort((a, b) => {
    if (a.level !== b.level) return a.level - b.level;
    const an = a.studentName ?? a.studentId;
    const bn = b.studentName ?? b.studentId;
    return an.localeCompare(bn);
  });

  res.json({
    thresholdPct,
    minWindows,
    schoolYear: currentSchoolYear,
    ireadyAp1Cuts: {
      ela: ireadyCuts.ela ?? {},
      math: ireadyCuts.math ?? {},
    },
    gradesPresent: Array.from(gradesPresent).sort((a, b) => a - b),
    suggestions,
  });
});

router.post("/mtss-plans/fast-suggestions/dismiss", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requireCoreTeam(staff, res)) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  // Academic suggestions are dismissed by (student, SUBJECT). The subject
  // ("ela" | "math") is stored in the legacy benchmark_code column so the
  // existing unique index + dismissedPairs lookup re-key cleanly. We still
  // accept `benchmarkCode` for backward-compat with any old caller.
  const { studentId, subject, benchmarkCode } = req.body ?? {};
  const cleanStudent =
    typeof studentId === "string" ? studentId.trim() : "";
  const rawSubject =
    typeof subject === "string"
      ? subject.trim().toLowerCase()
      : typeof benchmarkCode === "string"
        ? benchmarkCode.trim().toLowerCase()
        : "";
  const cleanCode =
    rawSubject === "ela" || rawSubject === "math" ? rawSubject : "";
  if (!cleanStudent || !cleanCode) {
    res
      .status(400)
      .json({ error: "studentId and subject (ela|math) are required" });
    return;
  }

  // Confirm the student lives in this school (cross-tenant defense).
  const [student] = await db
    .select({ id: studentsTable.id })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, cleanStudent),
        eq(studentsTable.schoolId, schoolId),
      ),
    );
  if (!student) {
    res.status(404).json({ error: "Student not found in this school" });
    return;
  }

  const currentSchoolYear = schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ);

  // Idempotent insert — unique index on
  // (school_id, student_id, benchmark_code, school_year) collapses
  // duplicate dismiss clicks.
  await db
    .insert(mtssFastSuggestionDismissalsTable)
    .values({
      schoolId,
      studentId: cleanStudent,
      benchmarkCode: cleanCode.slice(0, 64),
      schoolYear: currentSchoolYear,
      dismissedByStaffId: staff.id,
    })
    .onConflictDoNothing();

  res.json({ ok: true, schoolYear: currentSchoolYear });
});

export default router;
