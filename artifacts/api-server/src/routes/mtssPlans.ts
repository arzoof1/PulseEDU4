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
} from "@workspace/db";
import { and, eq, inArray, sql, asc } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import {
  effectiveTeacherIdsForPlan,
  loadScheduleSectionsForStudent,
  loadScheduleTeacherIdsForStudents,
  parseCsvIds,
} from "../lib/effectiveTeachers.js";

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
  } = req.body ?? {};

  const updates: Partial<typeof studentMtssPlansTable.$inferInsert> = {};

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

export default router;
