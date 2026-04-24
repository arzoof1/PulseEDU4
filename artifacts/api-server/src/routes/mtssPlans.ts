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
import { and, eq, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

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

  res.json(
    rows.map((r) => ({
      ...r.plan,
      studentName:
        r.firstName && r.lastName ? `${r.firstName} ${r.lastName}` : null,
      studentGrade: r.grade ?? null,
    })),
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

  const [row] = await db
    .insert(studentMtssPlansTable)
    .values({
      schoolId,
      studentId: cleanStudentId,
      title: cleanTitle,
      goals: clampString(goals, 4000),
      tier: tierVal,
      pointRangeMin: minParsed,
      pointRangeMax: maxParsed,
      notes: clampString(notes, 4000),
      openedByStaffId: staff.id,
      openedByName: staff.displayName,
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
  } = req.body ?? {};

  const updates: Partial<typeof studentMtssPlansTable.$inferInsert> = {};

  if (typeof title === "string" && title.trim()) {
    updates.title = title.trim().slice(0, 200);
  }
  if (typeof goals === "string") {
    updates.goals = goals.trim().slice(0, 4000);
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
