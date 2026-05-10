// ESE Coordinator + Admin routes for managing the school's accommodation
// master list and per-student assignments.

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import {
  db,
  schoolAccommodationsTable,
  studentAccommodationsTable,
  staffTable,
  studentsTable,
} from "@workspace/db";
import { and, eq, isNull, sql, desc, inArray } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

// Resolve the actor strictly from the signed-in session — no query/body
// staffId fallback. The earlier fallback let any caller impersonate any
// staff id by appending ?staffId=N, which would also bypass the school
// scope (because schoolId is taken from the session).
async function requireEseOrAdmin(
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
  if (!staff.isAdmin && !staff.isEseCoordinator && !staff.isSuperUser) {
    res.status(403).json({ error: "ESE coordinator or admin only" });
    return;
  }
  (req as Request & { staff: typeof staff }).staff = staff;
  next();
}

// ---- Master list ----

router.get("/school-accommodations", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const rows = await db
    .select()
    .from(schoolAccommodationsTable)
    .where(eq(schoolAccommodationsTable.schoolId, schoolId))
    .orderBy(schoolAccommodationsTable.category, schoolAccommodationsTable.name);
  // include in-use count, scoped to this school's assignments
  const counts = await db
    .select({
      accommodationId: studentAccommodationsTable.accommodationId,
      n: sql<number>`count(*)::int`,
    })
    .from(studentAccommodationsTable)
    .where(
      and(
        eq(studentAccommodationsTable.schoolId, schoolId),
        isNull(studentAccommodationsTable.removedAt),
      ),
    )
    .groupBy(studentAccommodationsTable.accommodationId);
  const byId = new Map(counts.map((c) => [c.accommodationId, c.n]));
  res.json(
    rows.map((r) => ({ ...r, inUseCount: byId.get(r.id) ?? 0 })),
  );
});

router.post("/school-accommodations", requireEseOrAdmin, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const { name, category } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const cat =
    typeof category === "string" && category.trim() ? category.trim() : "Strategy";

  // Name uniqueness is per-school.
  const existing = await db
    .select()
    .from(schoolAccommodationsTable)
    .where(
      and(
        eq(schoolAccommodationsTable.schoolId, schoolId),
        eq(schoolAccommodationsTable.name, name.trim()),
      ),
    );
  if (existing.length > 0) {
    res.status(409).json({ error: "Accommodation name already exists" });
    return;
  }

  const [row] = await db
    .insert(schoolAccommodationsTable)
    .values({ schoolId, name: name.trim(), category: cat, active: true })
    .returning();
  res.status(201).json(row);
});

router.patch("/school-accommodations/:id", requireEseOrAdmin, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const { name, category, active } = req.body ?? {};
  const updates: Partial<typeof schoolAccommodationsTable.$inferInsert> = {};
  if (typeof name === "string" && name.trim()) updates.name = name.trim();
  if (typeof category === "string" && category.trim())
    updates.category = category.trim();
  if (typeof active === "boolean") updates.active = active;
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No updates" });
    return;
  }
  const [row] = await db
    .update(schoolAccommodationsTable)
    .set(updates)
    .where(
      and(
        eq(schoolAccommodationsTable.id, id),
        eq(schoolAccommodationsTable.schoolId, schoolId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(row);
});

// Hard-delete a master accommodation. Only permitted when it has never been
// assigned (active or historical) to any student in THIS school. Cross-school
// usage of an accommodation with the same id elsewhere does not block this
// school's delete.
router.delete("/school-accommodations/:id", requireEseOrAdmin, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(studentAccommodationsTable)
    .where(
      and(
        eq(studentAccommodationsTable.schoolId, schoolId),
        eq(studentAccommodationsTable.accommodationId, id),
      ),
    );
  if (n > 0) {
    res.status(409).json({
      error:
        "This accommodation has assignment history and cannot be deleted. Deactivate it instead.",
      assignmentCount: n,
    });
    return;
  }
  const [row] = await db
    .delete(schoolAccommodationsTable)
    .where(
      and(
        eq(schoolAccommodationsTable.id, id),
        eq(schoolAccommodationsTable.schoolId, schoolId),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ deleted: true });
});

// Matrix view of one category (IEP / 504 / ELL / Strategy). Returns the active
// master accommodations in that category and every student who currently has
// at least one active assignment in that category, with the assignmentId for
// each (studentId, accommodationId) cell so the UI can toggle.
router.get(
  "/accommodation-category-matrix",
  requireEseOrAdmin,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const category =
      typeof req.query.category === "string" ? req.query.category : "";
    const ALLOWED = new Set(["IEP", "504", "ELL", "Strategy"]);
    if (!ALLOWED.has(category)) {
      res
        .status(400)
        .json({ error: "category must be one of IEP, 504, ELL, Strategy" });
      return;
    }
    const accs = await db
      .select()
      .from(schoolAccommodationsTable)
      .where(
        and(
          eq(schoolAccommodationsTable.schoolId, schoolId),
          eq(schoolAccommodationsTable.category, category),
          eq(schoolAccommodationsTable.active, true),
        ),
      )
      .orderBy(schoolAccommodationsTable.name);
    if (accs.length === 0) {
      res.json({ category, accommodations: [], students: [] });
      return;
    }
    const accIds = accs.map((a) => a.id);
    // Constrain BOTH the assignment row AND the joined students row by
    // schoolId so a same-id student in another school can't appear.
    const rows = await db
      .select({
        assignmentId: studentAccommodationsTable.id,
        studentId: studentAccommodationsTable.studentId,
        accommodationId: studentAccommodationsTable.accommodationId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
      })
      .from(studentAccommodationsTable)
      .innerJoin(
        studentsTable,
        and(
          eq(studentsTable.studentId, studentAccommodationsTable.studentId),
          eq(studentsTable.schoolId, schoolId),
        ),
      )
      .where(
        and(
          eq(studentAccommodationsTable.schoolId, schoolId),
          isNull(studentAccommodationsTable.removedAt),
          inArray(studentAccommodationsTable.accommodationId, accIds),
        ),
      );
    const byStudent = new Map<
      string,
      {
        studentId: string;
        firstName: string;
        lastName: string;
        grade: number;
        assignments: Record<number, number>;
      }
    >();
    for (const r of rows) {
      let s = byStudent.get(r.studentId);
      if (!s) {
        s = {
          studentId: r.studentId,
          firstName: r.firstName,
          lastName: r.lastName,
          grade: r.grade,
          assignments: {},
        };
        byStudent.set(r.studentId, s);
      }
      s.assignments[r.accommodationId] = r.assignmentId;
    }
    const students = Array.from(byStudent.values()).sort((a, b) => {
      const ln = a.lastName.localeCompare(b.lastName);
      return ln !== 0 ? ln : a.firstName.localeCompare(b.firstName);
    });
    res.json({
      category,
      accommodations: accs.map((a) => ({ id: a.id, name: a.name })),
      students,
    });
  },
);

// ---- Per-student assignments ----

// Returns current + history for one student. ESE coordinator or admin only,
// since this exposes full assignment history including removed entries.
router.get(
  "/students/:studentId/accommodations",
  requireEseOrAdmin,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const studentId = String(req.params.studentId);
    // Confirm the student belongs to this school first; otherwise 404 — an
    // ESE coordinator at school A must not be able to read school B's
    // assignment history by guessing a colliding student id.
    const [student] = await db
      .select({ studentId: studentsTable.studentId })
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
    const rows = await db
      .select({
        id: studentAccommodationsTable.id,
        accommodationId: studentAccommodationsTable.accommodationId,
        name: schoolAccommodationsTable.name,
        category: schoolAccommodationsTable.category,
        assignedAt: studentAccommodationsTable.assignedAt,
        assignedByStaffId: studentAccommodationsTable.assignedByStaffId,
        removedAt: studentAccommodationsTable.removedAt,
        removedByStaffId: studentAccommodationsTable.removedByStaffId,
      })
      .from(studentAccommodationsTable)
      .innerJoin(
        schoolAccommodationsTable,
        eq(
          studentAccommodationsTable.accommodationId,
          schoolAccommodationsTable.id,
        ),
      )
      .where(
        and(
          eq(studentAccommodationsTable.schoolId, schoolId),
          eq(studentAccommodationsTable.studentId, studentId),
        ),
      )
      .orderBy(desc(studentAccommodationsTable.assignedAt));
    res.json(rows);
  },
);

// Assign one or more accommodations to a student. Idempotent: skips ones
// already actively assigned. Body: { accommodationIds: number[] }
router.post(
  "/students/:studentId/accommodations",
  requireEseOrAdmin,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: typeof staffTable.$inferSelect }).staff;
    const studentId = String(req.params.studentId);
    const { accommodationIds } = req.body ?? {};
    if (
      !Array.isArray(accommodationIds) ||
      accommodationIds.length === 0 ||
      !accommodationIds.every((n) => typeof n === "number")
    ) {
      res.status(400).json({ error: "accommodationIds (number[]) required" });
      return;
    }

    // Verify the student belongs to this school.
    const [student] = await db
      .select({ studentId: studentsTable.studentId })
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

    // All accommodation IDs must belong to this school.
    const okAccs = await db
      .select({ id: schoolAccommodationsTable.id })
      .from(schoolAccommodationsTable)
      .where(
        and(
          eq(schoolAccommodationsTable.schoolId, schoolId),
          inArray(schoolAccommodationsTable.id, accommodationIds as number[]),
        ),
      );
    const okSet = new Set(okAccs.map((a) => a.id));
    if (okSet.size !== (accommodationIds as number[]).length) {
      res.status(400).json({
        error: "One or more accommodation IDs are not valid for this school",
      });
      return;
    }

    const existing = await db
      .select()
      .from(studentAccommodationsTable)
      .where(
        and(
          eq(studentAccommodationsTable.schoolId, schoolId),
          eq(studentAccommodationsTable.studentId, studentId),
          isNull(studentAccommodationsTable.removedAt),
          inArray(
            studentAccommodationsTable.accommodationId,
            accommodationIds as number[],
          ),
        ),
      );
    const alreadyActive = new Set(existing.map((e) => e.accommodationId));
    const toInsert = (accommodationIds as number[])
      .filter((id) => !alreadyActive.has(id))
      .map((id) => ({
        schoolId,
        studentId,
        accommodationId: id,
        assignedByStaffId: staff.id,
      }));
    if (toInsert.length > 0) {
      await db.insert(studentAccommodationsTable).values(toInsert);
    }
    res.status(201).json({
      inserted: toInsert.length,
      skipped: alreadyActive.size,
    });
  },
);

// Soft-remove an active assignment.
router.delete(
  "/students/:studentId/accommodations/:assignmentId",
  requireEseOrAdmin,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: typeof staffTable.$inferSelect }).staff;
    const studentId = String(req.params.studentId);
    const assignmentId = Number(req.params.assignmentId);
    if (!Number.isInteger(assignmentId) || assignmentId < 1) {
      res.status(400).json({ error: "Invalid assignment id" });
      return;
    }
    const [row] = await db
      .update(studentAccommodationsTable)
      .set({
        removedAt: new Date(),
        removedByStaffId: staff.id,
      })
      .where(
        and(
          eq(studentAccommodationsTable.schoolId, schoolId),
          eq(studentAccommodationsTable.id, assignmentId),
          eq(studentAccommodationsTable.studentId, studentId),
          isNull(studentAccommodationsTable.removedAt),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found or already removed" });
      return;
    }
    res.json(row);
  },
);

export default router;
