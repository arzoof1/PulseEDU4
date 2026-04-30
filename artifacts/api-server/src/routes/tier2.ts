// Tier 2 daily intervention entries.
//
// Routes:
//   GET    /api/tier2-entries?studentId=&date=YYYY-MM-DD&teacherStaffId=
//                             → list (school-scoped). Teachers see only
//                                their own rows by default; Core Team
//                                sees school-wide. Filters are AND-joined.
//   POST   /api/tier2-entries → create one entry. Teachers may only insert
//                                under their own staff_id; Core Team may
//                                insert on behalf of any teacher.
//   PATCH  /api/tier2-entries/:id → edit notes / sub_type / TAI.
//                                Teachers limited to their own rows.
//   DELETE /api/tier2-entries/:id → Core Team only.
//
// `subType` is the plan's assigned sub-type ('cico' | 'group'). For a
// teacher, the form submits whatever the plan dictates and the route
// validates that match. Core Team can override.
import { Router, type IRouter } from "express";
import {
  db,
  staffTable,
  studentsTable,
  studentMtssPlansTable,
  tier2InterventionEntriesTable,
  trustedAdultInterventionsTable,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam } from "../lib/coreTeam.js";

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

const VALID_SUB_TYPES = new Set(["cico", "group"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function clampNotes(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, 2000);
}

// ---- LIST ----
router.get("/tier2-entries", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const studentId =
    typeof req.query.studentId === "string" ? req.query.studentId.trim() : "";
  const date =
    typeof req.query.date === "string" && DATE_RE.test(req.query.date)
      ? req.query.date
      : "";
  const teacherStaffId =
    typeof req.query.teacherStaffId === "string"
      ? Number(req.query.teacherStaffId)
      : NaN;

  const conds = [eq(tier2InterventionEntriesTable.schoolId, schoolId)];
  if (studentId) {
    conds.push(eq(tier2InterventionEntriesTable.studentId, studentId));
  }
  if (date) {
    conds.push(eq(tier2InterventionEntriesTable.entryDate, date));
  }

  // Non-Core-Team teachers are limited to their own rows.
  if (!isCoreTeam(staff)) {
    conds.push(eq(tier2InterventionEntriesTable.teacherStaffId, staff.id));
  } else if (Number.isInteger(teacherStaffId) && teacherStaffId > 0) {
    conds.push(
      eq(tier2InterventionEntriesTable.teacherStaffId, teacherStaffId),
    );
  }

  const rows = await db
    .select()
    .from(tier2InterventionEntriesTable)
    .where(and(...conds))
    .orderBy(desc(tier2InterventionEntriesTable.entryDate))
    .limit(500);
  res.json(rows);
});

// ---- CREATE ----
router.post("/tier2-entries", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const {
    studentId,
    entryDate,
    subType,
    teacherStaffId,
    trustedAdultInterventionId,
    notes,
  } = req.body ?? {};

  const cleanStudentId =
    typeof studentId === "string" ? studentId.trim() : "";
  if (!cleanStudentId) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  const cleanDate =
    typeof entryDate === "string" && DATE_RE.test(entryDate)
      ? entryDate
      : "";
  if (!cleanDate) {
    res
      .status(400)
      .json({ error: "entryDate (YYYY-MM-DD) is required" });
    return;
  }
  const cleanSubType =
    typeof subType === "string" ? subType.toLowerCase() : "";
  if (!VALID_SUB_TYPES.has(cleanSubType)) {
    res
      .status(400)
      .json({ error: "subType must be 'cico' or 'group'" });
    return;
  }

  // Resolve the teacher who's claiming the work. Teachers can only post
  // under themselves; Core Team can post on behalf of anyone in the
  // same school.
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

  // Student must belong to this school.
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

  // For non-Core-Team teachers, lock subType to whatever the student's
  // active Tier 2 plan declares (when one exists). Core Team can override.
  if (!isCoreTeam(staff)) {
    const [plan] = await db
      .select()
      .from(studentMtssPlansTable)
      .where(
        and(
          eq(studentMtssPlansTable.schoolId, schoolId),
          eq(studentMtssPlansTable.studentId, cleanStudentId),
          sql`${studentMtssPlansTable.closedAt} IS NULL`,
          eq(studentMtssPlansTable.tier, 2),
        ),
      )
      .limit(1);
    if (
      plan &&
      plan.interventionSubType &&
      plan.interventionSubType !== cleanSubType
    ) {
      res.status(400).json({
        error: `Plan is set to '${plan.interventionSubType}'; subType must match`,
      });
      return;
    }
  }

  // Optional Trusted Adult Intervention. Must belong to this school and
  // (when tagged) carry tier='2'.
  let resolvedTaiId: number | null = null;
  if (
    trustedAdultInterventionId !== undefined &&
    trustedAdultInterventionId !== null &&
    trustedAdultInterventionId !== ""
  ) {
    const taiId = Number(trustedAdultInterventionId);
    if (!Number.isInteger(taiId) || taiId < 1) {
      res
        .status(400)
        .json({ error: "trustedAdultInterventionId must be a positive int" });
      return;
    }
    const [tai] = await db
      .select()
      .from(trustedAdultInterventionsTable)
      .where(
        and(
          eq(trustedAdultInterventionsTable.id, taiId),
          eq(trustedAdultInterventionsTable.schoolId, schoolId),
        ),
      );
    if (!tai) {
      res
        .status(404)
        .json({ error: "Trusted Adult Intervention not found" });
      return;
    }
    if (!tai.active) {
      res
        .status(400)
        .json({ error: "Trusted Adult Intervention is inactive" });
      return;
    }
    if (tai.tier && tai.tier !== "2") {
      res
        .status(400)
        .json({ error: "Trusted Adult Intervention is not tier 2" });
      return;
    }
    resolvedTaiId = taiId;
  }

  const [row] = await db
    .insert(tier2InterventionEntriesTable)
    .values({
      schoolId,
      studentId: cleanStudentId,
      teacherStaffId: resolvedTeacherId,
      entryDate: cleanDate,
      subType: cleanSubType,
      trustedAdultInterventionId: resolvedTaiId,
      notes: clampNotes(notes),
    })
    .returning();

  req.log?.info(
    { tier2EntryId: row?.id, studentId: cleanStudentId },
    "tier2 entry created",
  );
  res.status(201).json(row);
});

// ---- UPDATE ----
router.patch("/tier2-entries/:id", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }
  const [existing] = await db
    .select()
    .from(tier2InterventionEntriesTable)
    .where(
      and(
        eq(tier2InterventionEntriesTable.id, id),
        eq(tier2InterventionEntriesTable.schoolId, schoolId),
      ),
    );
  if (!existing) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }
  if (existing.teacherStaffId !== staff.id && !isCoreTeam(staff)) {
    res.status(403).json({ error: "Cannot edit another teacher's entry" });
    return;
  }

  const patch: Partial<typeof tier2InterventionEntriesTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (typeof req.body?.notes === "string") {
    patch.notes = clampNotes(req.body.notes);
  }
  if (typeof req.body?.subType === "string") {
    const st = req.body.subType.toLowerCase();
    if (!VALID_SUB_TYPES.has(st)) {
      res
        .status(400)
        .json({ error: "subType must be 'cico' or 'group'" });
      return;
    }
    if (st !== existing.subType && !isCoreTeam(staff)) {
      res
        .status(403)
        .json({ error: "Only Core Team can change a plan's sub-type" });
      return;
    }
    patch.subType = st;
  }
  if (req.body?.trustedAdultInterventionId !== undefined) {
    const v = req.body.trustedAdultInterventionId;
    if (v === null || v === "") {
      patch.trustedAdultInterventionId = null;
    } else {
      const taiId = Number(v);
      if (!Number.isInteger(taiId) || taiId < 1) {
        res.status(400).json({ error: "Bad trustedAdultInterventionId" });
        return;
      }
      const [tai] = await db
        .select()
        .from(trustedAdultInterventionsTable)
        .where(
          and(
            eq(trustedAdultInterventionsTable.id, taiId),
            eq(trustedAdultInterventionsTable.schoolId, schoolId),
          ),
        );
      if (!tai) {
        res
          .status(404)
          .json({ error: "Trusted Adult Intervention not found" });
        return;
      }
      patch.trustedAdultInterventionId = taiId;
    }
  }

  const [row] = await db
    .update(tier2InterventionEntriesTable)
    .set(patch)
    .where(eq(tier2InterventionEntriesTable.id, id))
    .returning();
  res.json(row);
});

// ---- DELETE ----
router.delete("/tier2-entries/:id", async (req, res) => {
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
    .delete(tier2InterventionEntriesTable)
    .where(
      and(
        eq(tier2InterventionEntriesTable.id, id),
        eq(tier2InterventionEntriesTable.schoolId, schoolId),
      ),
    );
  res.json({ ok: true });
});

export default router;
