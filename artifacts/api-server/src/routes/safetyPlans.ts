// Safety Plans — per-student behavioral / physical safety checklist.
//
// Routes (all under /api):
//   GET  /safety-plans/library
//   POST /safety-plans/library                  (edit gate)
//   PATCH/safety-plans/library/:id              (edit gate; rename / toggle active)
//   GET  /safety-plans/student/:studentId
//   PUT  /safety-plans/student/:studentId       (edit gate; upsert)
//   POST /safety-plans/student/:studentId/deactivate  (edit gate)
//   GET  /safety-plans/student/:studentId/audit (edit gate)
//   GET  /safety-plans/active-summary           (used by /teacher-roster
//                                                hover-popover; lightweight)
//
// Edit gate = canEditSafetyPlan (Guidance Counselor OR Core Team).
// View detail (the active items + notes) is open to any signed-in staff
// in the same school — every teacher needs to know what's on a student's
// safety plan when they see the SP pill.
import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import {
  db,
  safetyPlanLibraryTable,
  safetyPlansTable,
  safetyPlanAuditTable,
  staffTable,
  studentsTable,
  type SafetyPlanItem,
} from "@workspace/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { canEditSafetyPlan } from "../lib/coreTeam.js";

const router: IRouter = Router();

async function loadStaff(req: Request) {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function sanitizeItems(input: unknown): SafetyPlanItem[] {
  if (!Array.isArray(input)) return [];
  const out: SafetyPlanItem[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const label = typeof r.label === "string" ? r.label.trim() : "";
    if (!label) continue;
    const active = r.active !== false; // default true
    const note =
      typeof r.note === "string" && r.note.trim() ? r.note.trim() : undefined;
    out.push(note ? { label, active, note } : { label, active });
  }
  return out;
}

router.get("/safety-plans/library", async (req: Request, res: Response) => {
  const staff = await loadStaff(req);
  if (!staff) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const rows = await db
    .select()
    .from(safetyPlanLibraryTable)
    .where(eq(safetyPlanLibraryTable.schoolId, schoolId))
    .orderBy(asc(safetyPlanLibraryTable.sortOrder), asc(safetyPlanLibraryTable.id));
  res.json({ items: rows });
});

router.post("/safety-plans/library", async (req: Request, res: Response) => {
  const staff = await loadStaff(req);
  if (!staff) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  if (!canEditSafetyPlan(staff)) {
    res.status(403).json({
      error: "Only Guidance Counselor or Core Team can edit the library.",
    });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const body = (req.body ?? {}) as { label?: unknown };
  const label =
    typeof body.label === "string" ? body.label.trim() : "";
  if (!label || label.length > 200) {
    res.status(400).json({ error: "label is required (1-200 chars)" });
    return;
  }
  const [existing] = await db
    .select()
    .from(safetyPlanLibraryTable)
    .where(
      and(
        eq(safetyPlanLibraryTable.schoolId, schoolId),
        eq(safetyPlanLibraryTable.label, label),
      ),
    );
  if (existing) {
    // Reactivate if it was previously soft-deleted.
    const [reactivated] = await db
      .update(safetyPlanLibraryTable)
      .set({ active: true })
      .where(eq(safetyPlanLibraryTable.id, existing.id))
      .returning();
    res.status(200).json(reactivated);
    return;
  }
  const [row] = await db
    .insert(safetyPlanLibraryTable)
    .values({ schoolId, label, isBuiltIn: false, active: true, sortOrder: 999 })
    .returning();
  res.status(201).json(row);
});

router.patch(
  "/safety-plans/library/:id",
  async (req: Request, res: Response) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!canEditSafetyPlan(staff)) {
      res.status(403).json({ error: "Edit access required." });
      return;
    }
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const body = (req.body ?? {}) as { label?: unknown; active?: unknown };
    const updates: Partial<typeof safetyPlanLibraryTable.$inferInsert> = {};
    if (typeof body.active === "boolean") updates.active = body.active;
    if (typeof body.label === "string") {
      const label = body.label.trim();
      if (!label || label.length > 200) {
        res.status(400).json({ error: "label must be 1-200 chars" });
        return;
      }
      updates.label = label;
    }
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No updates" });
      return;
    }
    // Built-in items are rename-locked but can be deactivated.
    const [existing] = await db
      .select()
      .from(safetyPlanLibraryTable)
      .where(
        and(
          eq(safetyPlanLibraryTable.id, id),
          eq(safetyPlanLibraryTable.schoolId, schoolId),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    // Built-in items used to be rename-locked; admins now want to be
    // able to reword them (e.g. "Clear backpack" → "Transparent backpack
    // only"). We keep the isBuiltIn flag so the UI can still show the
    // "Built-in" pill and so the seeder knows not to re-insert them.
    const [row] = await db
      .update(safetyPlanLibraryTable)
      .set(updates)
      .where(eq(safetyPlanLibraryTable.id, id))
      .returning();
    res.json(row);
  },
);

// Defense-in-depth: confirm `studentId` exists in `schoolId`. Used by
// every per-student route to make sure a staff member from school A
// can't poke at a record keyed to a student in school B (the plan
// lookup itself is school-scoped, but we also want the 404 to fire
// even when no plan exists yet).
async function assertStudentInSchool(
  schoolId: number,
  studentId: string,
): Promise<boolean> {
  const [stu] = await db
    .select({ studentId: studentsTable.studentId })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        eq(studentsTable.studentId, studentId),
      ),
    );
  return Boolean(stu);
}

// Helper: read a student's plan, validating school scope.
async function loadPlan(schoolId: number, studentId: string) {
  const [plan] = await db
    .select()
    .from(safetyPlansTable)
    .where(
      and(
        eq(safetyPlansTable.schoolId, schoolId),
        eq(safetyPlansTable.studentId, studentId),
      ),
    );
  return plan ?? null;
}

router.get(
  "/safety-plans/student/:studentId",
  async (req: Request, res: Response) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const studentId = String(req.params.studentId);
    // Confirm student belongs to this school (defense-in-depth).
    const [stu] = await db
      .select({ studentId: studentsTable.studentId })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          eq(studentsTable.studentId, studentId),
        ),
      );
    if (!stu) {
      res.status(404).json({ error: "Student not found" });
      return;
    }
    const plan = await loadPlan(schoolId, studentId);
    res.json({
      studentId,
      plan,
      canEdit: canEditSafetyPlan(staff),
    });
  },
);

router.put(
  "/safety-plans/student/:studentId",
  async (req: Request, res: Response) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!canEditSafetyPlan(staff)) {
      res.status(403).json({
        error: "Only Guidance Counselor / Admin / Core Team can edit safety plans.",
      });
      return;
    }
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const studentId = String(req.params.studentId);
    const [stu] = await db
      .select({ studentId: studentsTable.studentId })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          eq(studentsTable.studentId, studentId),
        ),
      );
    if (!stu) {
      res.status(404).json({ error: "Student not found" });
      return;
    }
    const body = (req.body ?? {}) as {
      items?: unknown;
      notes?: unknown;
      status?: unknown;
      startDate?: unknown;
      endDate?: unknown;
    };
    const items = sanitizeItems(body.items);
    const notes = typeof body.notes === "string" ? body.notes : "";
    const status =
      body.status === "inactive" ? "inactive" : "active";
    const startDate =
      typeof body.startDate === "string" && body.startDate.trim()
        ? body.startDate.trim()
        : null;
    const endDate =
      typeof body.endDate === "string" && body.endDate.trim()
        ? body.endDate.trim()
        : null;
    const existing = await loadPlan(schoolId, studentId);
    const now = new Date();
    let row;
    let action: string;
    if (existing) {
      [row] = await db
        .update(safetyPlansTable)
        .set({
          status,
          items,
          notes,
          startDate,
          endDate,
          updatedByStaffId: staff.id,
          updatedByName: staff.displayName,
          updatedAt: now,
        })
        .where(eq(safetyPlansTable.id, existing.id))
        .returning();
      action =
        existing.status !== status
          ? status === "active"
            ? "activated"
            : "deactivated"
          : "updated";
    } else {
      [row] = await db
        .insert(safetyPlansTable)
        .values({
          schoolId,
          studentId,
          status,
          items,
          notes,
          startDate,
          endDate,
          createdByStaffId: staff.id,
          createdByName: staff.displayName,
          updatedByStaffId: staff.id,
          updatedByName: staff.displayName,
        })
        .returning();
      action = "created";
    }
    await db.insert(safetyPlanAuditTable).values({
      schoolId,
      studentId,
      action,
      actorStaffId: staff.id,
      actorName: staff.displayName,
      snapshot: { status, items, notes, startDate, endDate },
    });
    res.json(row);
  },
);

router.post(
  "/safety-plans/student/:studentId/deactivate",
  async (req: Request, res: Response) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!canEditSafetyPlan(staff)) {
      res.status(403).json({ error: "Edit access required." });
      return;
    }
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const studentId = String(req.params.studentId);
    if (!(await assertStudentInSchool(schoolId, studentId))) {
      res.status(404).json({ error: "Student not found" });
      return;
    }
    const existing = await loadPlan(schoolId, studentId);
    if (!existing) {
      res.status(404).json({ error: "No plan to deactivate" });
      return;
    }
    const [row] = await db
      .update(safetyPlansTable)
      .set({
        status: "inactive",
        updatedByStaffId: staff.id,
        updatedByName: staff.displayName,
        updatedAt: new Date(),
      })
      .where(eq(safetyPlansTable.id, existing.id))
      .returning();
    await db.insert(safetyPlanAuditTable).values({
      schoolId,
      studentId,
      action: "deactivated",
      actorStaffId: staff.id,
      actorName: staff.displayName,
      snapshot: null,
    });
    res.json(row);
  },
);

router.get(
  "/safety-plans/student/:studentId/audit",
  async (req: Request, res: Response) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!canEditSafetyPlan(staff)) {
      res.status(403).json({ error: "Edit access required." });
      return;
    }
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const studentId = String(req.params.studentId);
    if (!(await assertStudentInSchool(schoolId, studentId))) {
      res.status(404).json({ error: "Student not found" });
      return;
    }
    const rows = await db
      .select()
      .from(safetyPlanAuditTable)
      .where(
        and(
          eq(safetyPlanAuditTable.schoolId, schoolId),
          eq(safetyPlanAuditTable.studentId, studentId),
        ),
      )
      .orderBy(asc(safetyPlanAuditTable.createdAt));
    res.json({ entries: rows });
  },
);

// Lightweight bulk endpoint used by the roster popover. Returns
// (studentId → {items, notes, updatedAt}) for active plans only.
router.get(
  "/safety-plans/active-summary",
  async (req: Request, res: Response) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const ids =
      typeof req.query.studentIds === "string" && req.query.studentIds.length
        ? req.query.studentIds.split(",").filter(Boolean)
        : null;
    const where = ids
      ? and(
          eq(safetyPlansTable.schoolId, schoolId),
          eq(safetyPlansTable.status, "active"),
          inArray(safetyPlansTable.studentId, ids),
        )
      : and(
          eq(safetyPlansTable.schoolId, schoolId),
          eq(safetyPlansTable.status, "active"),
        );
    const rows = await db.select().from(safetyPlansTable).where(where);
    res.json({
      plans: rows.map((r) => ({
        studentId: r.studentId,
        items: r.items,
        notes: r.notes,
        updatedAt: r.updatedAt,
        updatedByName: r.updatedByName,
      })),
    });
  },
);

// Admin list endpoint used by the dedicated Safety Plans page.
// Counselor / Admin / Core Team only — returns plans across the school
// joined with student name + grade so the page can show a caseload-style
// table without N+1 lookups. Status filter mirrors the MTSS Plans page.
router.get(
  "/safety-plans/list",
  async (req: Request, res: Response) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!canEditSafetyPlan(staff)) {
      res.status(403).json({ error: "Edit access required." });
      return;
    }
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const statusParam =
      typeof req.query.status === "string" ? req.query.status : "active";
    const where =
      statusParam === "all"
        ? eq(safetyPlansTable.schoolId, schoolId)
        : statusParam === "inactive"
          ? and(
              eq(safetyPlansTable.schoolId, schoolId),
              eq(safetyPlansTable.status, "inactive"),
            )
          : and(
              eq(safetyPlansTable.schoolId, schoolId),
              eq(safetyPlansTable.status, "active"),
            );
    const rows = await db
      .select({
        id: safetyPlansTable.id,
        studentId: safetyPlansTable.studentId,
        status: safetyPlansTable.status,
        items: safetyPlansTable.items,
        notes: safetyPlansTable.notes,
        startDate: safetyPlansTable.startDate,
        endDate: safetyPlansTable.endDate,
        updatedAt: safetyPlansTable.updatedAt,
        updatedByName: safetyPlansTable.updatedByName,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
        localSisId: studentsTable.localSisId,
      })
      .from(safetyPlansTable)
      .leftJoin(
        studentsTable,
        and(
          eq(studentsTable.studentId, safetyPlansTable.studentId),
          eq(studentsTable.schoolId, safetyPlansTable.schoolId),
        ),
      )
      .where(where);
    res.json({
      plans: rows.map((r) => ({
        id: r.id,
        studentId: r.studentId,
        localSisId: r.localSisId ?? null,
        studentName:
          r.firstName || r.lastName
            ? `${r.lastName ?? ""}, ${r.firstName ?? ""}`.replace(
                /^, |, $/g,
                "",
              )
            : null,
        studentGrade: r.grade ?? null,
        status: r.status,
        items: r.items,
        notes: r.notes,
        startDate: r.startDate,
        endDate: r.endDate,
        updatedAt: r.updatedAt,
        updatedByName: r.updatedByName,
      })),
    });
  },
);

export default router;
