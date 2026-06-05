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
  schoolSettingsTable,
  mtssFastSuggestionDismissalsTable,
} from "@workspace/db";
import { and, eq, inArray, sql, asc, isNull } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
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
  } = req.body ?? {};

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
  } = req.body ?? {};

  const updates: Partial<typeof studentMtssPlansTable.$inferInsert> = {};

  if (fastBenchmarkCode !== undefined) {
    if (fastBenchmarkCode === null || fastBenchmarkCode === "") {
      updates.fastBenchmarkCode = null;
    } else if (typeof fastBenchmarkCode === "string") {
      updates.fastBenchmarkCode = fastBenchmarkCode.trim().slice(0, 64) || null;
    }
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

router.get("/mtss-plans/fast-suggestions", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requireCoreTeam(staff, res)) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  // ---- Settings: mastery threshold + min-windows ----
  const [settings] = await db
    .select()
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  const thresholdPct = settings?.fastBenchmarkMasteryThreshold ?? 80;
  // Clamp to [1..3] defensively — the suggestions endpoint only ever
  // inspects 3 windows, so a higher value would silently produce
  // zero suggestions and a lower value bypasses the "missed twice"
  // intent of the feature.
  const minWindows = Math.min(
    3,
    Math.max(1, settings?.fastTier2MinWindows ?? 2),
  );

  // ---- Resolve last 3 windows per subject for this school ----
  const tupleRows = await db
    .selectDistinct({
      subject: studentFastItemResponsesTable.subject,
      schoolYear: studentFastItemResponsesTable.schoolYear,
      window: studentFastItemResponsesTable.window,
    })
    .from(studentFastItemResponsesTable)
    .where(eq(studentFastItemResponsesTable.schoolId, schoolId));

  // Order by (schoolYear DESC, window DESC) within each subject, take 3.
  const recentBySubject = new Map<
    string,
    Array<{ schoolYear: string; window: string }>
  >();
  for (const t of tupleRows) {
    if (!FAST_SUBJECTS.includes(t.subject as (typeof FAST_SUBJECTS)[number])) {
      continue;
    }
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

  // Flat list of (subject, schoolYear, window) we care about — used
  // to build a single WHERE clause below. Bail early if there's no
  // FAST data on file yet.
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
  if (allTuples.length === 0) {
    res.json({
      thresholdPct,
      minWindows,
      suggestions: [],
    });
    return;
  }

  // ---- Pull every item response in those windows for this school ----
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

  // ---- Aggregate (student, benchmark, window) → mastery pct ----
  // Many items per (student, benchmark, window) — sum then divide.
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
    // Record category from first row that has one.
    if (!agg.category && r.category) agg.category = r.category;
    const wkey = `${r.schoolYear}|${r.window}`;
    const slot = agg.perWindow.get(wkey) ?? { earned: 0, possible: 0 };
    slot.earned += r.pointsEarned ?? 0;
    slot.possible += r.pointsPossible;
    agg.perWindow.set(wkey, slot);
  }

  // ---- Exclusions: active plans + dismissals ----
  const activePlans = await db
    .select({
      studentId: studentMtssPlansTable.studentId,
      fastBenchmarkCode: studentMtssPlansTable.fastBenchmarkCode,
    })
    .from(studentMtssPlansTable)
    .where(
      and(
        eq(studentMtssPlansTable.schoolId, schoolId),
        isNull(studentMtssPlansTable.closedAt),
      ),
    );
  const activePairs = new Set<string>();
  for (const p of activePlans) {
    if (p.fastBenchmarkCode) {
      activePairs.add(`${p.studentId}|${p.fastBenchmarkCode}`);
    }
  }

  const currentSchoolYear = schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ);
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

  // ---- Build suggestion list ----
  type WindowPct = {
    schoolYear: string;
    window: string;
    masteryPct: number;
    below: boolean;
  };
  type Suggestion = {
    studentId: string;
    studentName: string | null;
    studentGrade: number | null;
    subject: string;
    benchmarkCode: string;
    benchmarkCategory: string | null;
    suggestedStrategyCategory: string;
    suggestedTitle: string;
    suggestedGoal: string;
    windows: WindowPct[];
    belowCount: number;
    // Most-recent prior-year PM3 for this student+subject (from the
    // FL Florida historical importer). Null when no historical row.
    priorYearPm3: { schoolYear: string; pm3: number } | null;
  };

  const studentIdsNeeded = new Set<string>();
  const provisional: Suggestion[] = [];

  for (const agg of byPair.values()) {
    const key = `${agg.studentId}|${agg.benchmarkCode}`;
    if (activePairs.has(key)) continue;
    if (dismissedPairs.has(key)) continue;

    const subjectWindows = recentBySubject.get(agg.subject) ?? [];
    const windows: WindowPct[] = subjectWindows.map((w) => {
      const slot = agg.perWindow.get(`${w.schoolYear}|${w.window}`);
      if (!slot || slot.possible <= 0) {
        return {
          schoolYear: w.schoolYear,
          window: w.window,
          masteryPct: -1, // sentinel = not administered
          below: false,
        };
      }
      // Compare on the raw ratio against the threshold so a student
      // sitting at 79.5% still counts as "below 80" — only the displayed
      // pct is rounded. (Rounding the comparison side previously let
      // borderline cases sneak past qualification.)
      const ratioPct = (slot.earned / slot.possible) * 100;
      return {
        schoolYear: w.schoolYear,
        window: w.window,
        masteryPct: Math.round(ratioPct),
        below: ratioPct < thresholdPct,
      };
    });
    const belowCount = windows.filter((w) => w.below).length;
    if (belowCount < minWindows) continue;

    const strategy = strategyCategoryForBenchmark(
      agg.category,
      agg.benchmarkCode,
    );
    // Pull the most recent administered pct (windows are sorted
    // newest-first) so the prefilled goal cites where the student is
    // starting from — meaningfully better progress-monitoring copy
    // than a bare "improve to N%".
    const latestPct = windows.find((w) => w.masteryPct >= 0)?.masteryPct;
    const latestSnippet =
      latestPct != null ? `currently ${latestPct}%` : "currently below mastery";
    // The FAST item-response feed gives us a `category` label (the
    // state-printed reporting category, e.g. "Reading Prose and
    // Poetry") but no full benchmark statement text — Florida's
    // benchmark catalog isn't ingested in this codebase. We surface
    // category prominently so the goal reads as a real statement
    // rather than a bare code, and tag the strategy approach in the
    // same sentence so Tier 2 plans created from suggestions document
    // the "why" inline (the plan schema has no separate
    // strategy_category column at Tier 2 — that lives on Tier 3).
    const benchmarkPhrase = agg.category
      ? `${agg.benchmarkCode} (${agg.category})`
      : `${agg.benchmarkCode}`;
    provisional.push({
      studentId: agg.studentId,
      studentName: null,
      studentGrade: null,
      subject: agg.subject,
      benchmarkCode: agg.benchmarkCode,
      benchmarkCategory: agg.category,
      suggestedStrategyCategory: strategy,
      suggestedTitle: `Tier 2 — ${strategy} (${agg.benchmarkCode})`,
      suggestedGoal:
        `Student is ${latestSnippet} on FAST benchmark ${benchmarkPhrase}, ` +
        `below the ${thresholdPct}% mastery bar in ${belowCount} of the ` +
        `last 3 windows. Goal: reach ${thresholdPct}% or higher on this ` +
        `benchmark by the next FAST window through targeted ${strategy} ` +
        `instruction and weekly progress monitoring.`,
      windows,
      belowCount,
      priorYearPm3: null,
    });
    studentIdsNeeded.add(agg.studentId);
  }

  // ---- Resolve student names ----
  let nameById = new Map<string, { name: string; grade: number | null }>();
  if (studentIdsNeeded.size > 0) {
    const studentRows = await db
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
          inArray(studentsTable.studentId, Array.from(studentIdsNeeded)),
        ),
      );
    nameById = new Map(
      studentRows.map((s) => [
        s.studentId,
        {
          name: `${s.firstName} ${s.lastName}`,
          grade: s.grade ?? null,
        },
      ]),
    );
  }
  for (const s of provisional) {
    const meta = nameById.get(s.studentId);
    if (meta) {
      s.studentName = meta.name;
      s.studentGrade = meta.grade;
    }
  }

  // Attach most-recent prior-year PM3 per (student, subject) from the
  // FL Florida historical importer. Single batched load keyed by every
  // suggested student. Empty map when no historical data.
  if (provisional.length > 0) {
    const historyMap = await loadFastHistory({
      schoolId,
      studentIds: Array.from(studentIdsNeeded),
    });
    for (const s of provisional) {
      const hist = pickHistory(historyMap, s.studentId, s.subject);
      if (hist.length > 0) {
        s.priorYearPm3 = {
          schoolYear: hist[0].schoolYear,
          pm3: hist[0].pm3,
        };
      }
    }
  }

  // Sort: most-below first, then by student name for stable display.
  provisional.sort((a, b) => {
    if (b.belowCount !== a.belowCount) return b.belowCount - a.belowCount;
    const an = a.studentName ?? a.studentId;
    const bn = b.studentName ?? b.studentId;
    return an.localeCompare(bn);
  });

  res.json({
    thresholdPct,
    minWindows,
    schoolYear: currentSchoolYear,
    suggestions: provisional,
  });
});

router.post("/mtss-plans/fast-suggestions/dismiss", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requireCoreTeam(staff, res)) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const { studentId, benchmarkCode } = req.body ?? {};
  const cleanStudent =
    typeof studentId === "string" ? studentId.trim() : "";
  const cleanCode =
    typeof benchmarkCode === "string" ? benchmarkCode.trim() : "";
  if (!cleanStudent || !cleanCode) {
    res
      .status(400)
      .json({ error: "studentId and benchmarkCode are required" });
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
