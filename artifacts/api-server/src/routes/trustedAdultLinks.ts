// Trusted Adult linkage — explicit per-student → per-staff relationships
// that the Insights module uses to widen a teacher's visibility scope
// beyond their roster.
//
// Owners (read + write): Admin, SuperUser, MTSS Coordinator, Behavior
// Specialist, PBIS Coordinator. Plain teachers can read the list of
// students they themselves are linked to (for the Insights watchlist
// "my advisees" view) but cannot create or delete links.
//
// All endpoints are school-scoped via requireSchool — the same multi-
// tenancy convention the rest of the app uses.

import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  studentTrustedAdultsTable,
  studentsTable,
  staffTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

async function loadStaff(req: Request, res: Response) {
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

function isCoreTeam(s: typeof staffTable.$inferSelect): boolean {
  return Boolean(
    s.isSuperUser ||
      s.isAdmin ||
      s.isBehaviorSpecialist ||
      s.isMtssCoordinator ||
      s.isPbisCoordinator,
  );
}

function requireCoreTeam(
  staff: typeof staffTable.$inferSelect,
  res: Response,
): boolean {
  if (!isCoreTeam(staff)) {
    res.status(403).json({
      error:
        "Only admins, Behavior Specialists, MTSS Coordinators, and PBIS Coordinators can manage trusted adult links",
    });
    return false;
  }
  return true;
}

type LinkRow = {
  id: number;
  studentId: string;
  staffId: number;
  studentFirstName: string | null;
  studentLastName: string | null;
  studentGrade: number | null;
  staffName: string | null;
  staffEmail: string | null;
  assignedByName: string | null;
  assignedAt: string;
  notes: string | null;
};

// Single source of truth for the joined SELECT shape used by GET. The
// join is JS-side per the codebase's multi-tenancy convention; we use
// LEFT JOINs so a stale student/staff reference still surfaces the
// link (with nulls) rather than dropping it from the response.
async function selectLinks(
  schoolId: number,
  filter:
    | { type: "all" }
    | { type: "student"; studentId: string }
    | { type: "staff"; staffId: number },
): Promise<LinkRow[]> {
  const wheres = [eq(studentTrustedAdultsTable.schoolId, schoolId)];
  if (filter.type === "student") {
    wheres.push(eq(studentTrustedAdultsTable.studentId, filter.studentId));
  } else if (filter.type === "staff") {
    wheres.push(eq(studentTrustedAdultsTable.staffId, filter.staffId));
  }
  const rows = await db
    .select({
      id: studentTrustedAdultsTable.id,
      studentId: studentTrustedAdultsTable.studentId,
      staffId: studentTrustedAdultsTable.staffId,
      studentFirstName: studentsTable.firstName,
      studentLastName: studentsTable.lastName,
      studentGrade: studentsTable.grade,
      staffName: staffTable.displayName,
      staffEmail: staffTable.email,
      assignedByName: studentTrustedAdultsTable.assignedByName,
      assignedAt: studentTrustedAdultsTable.assignedAt,
      notes: studentTrustedAdultsTable.notes,
    })
    .from(studentTrustedAdultsTable)
    .leftJoin(
      studentsTable,
      and(
        eq(studentsTable.studentId, studentTrustedAdultsTable.studentId),
        eq(studentsTable.schoolId, studentTrustedAdultsTable.schoolId),
      ),
    )
    .leftJoin(staffTable, eq(staffTable.id, studentTrustedAdultsTable.staffId))
    .where(and(...wheres))
    .orderBy(
      studentsTable.lastName,
      studentsTable.firstName,
      staffTable.displayName,
    );
  return rows.map((r) => ({
    ...r,
    assignedAt:
      r.assignedAt instanceof Date
        ? r.assignedAt.toISOString()
        : String(r.assignedAt),
  }));
}

// GET /api/trusted-adult-links/staff-directory
//   Returns minimal {id, displayName, email} for every active staff member
//   in the active school. Used by the Trusted Adults admin picker —
//   /api/admin/staff is gated to admin/super, but core-team roles like
//   MTSS Coordinator + Behavior Specialist also need to assign trusted
//   adults, so we expose this thin sibling endpoint with the same gate
//   as the rest of the file.
router.get("/trusted-adult-links/staff-directory", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requireCoreTeam(staff, res)) return;
  const rows = await db
    .select({
      id: staffTable.id,
      displayName: staffTable.displayName,
      email: staffTable.email,
    })
    .from(staffTable)
    .where(and(eq(staffTable.schoolId, schoolId), eq(staffTable.active, true)))
    .orderBy(staffTable.displayName);
  res.json(rows);
});

// GET /api/trusted-adult-links
//   ?student=SISID — links for a specific student (any caller in the school)
//   ?staff=ID      — links for a specific staff member
//   (no filter)    — full school list (core team only)
//
// A plain teacher with no filter is rejected (403) — they should hit
// ?staff=<their-id>. We allow ?staff=<their-id> for any caller because
// the watchlist needs it.
router.get("/trusted-adult-links", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req, res);
  if (!staff) return;

  const studentParam =
    typeof req.query.student === "string" ? req.query.student.trim() : "";
  const staffParam =
    typeof req.query.staff === "string" ? req.query.staff.trim() : "";

  if (staffParam) {
    const targetStaffId = parseInt(staffParam, 10);
    if (!Number.isFinite(targetStaffId)) {
      res.status(400).json({ error: "Invalid staff id" });
      return;
    }
    // Plain teachers can only ask for their own list. Core team can ask
    // for anyone's. The visibility check matters: links contain student
    // names, which are PII that shouldn't leak between teachers.
    if (targetStaffId !== staff.id && !isCoreTeam(staff)) {
      res.status(403).json({ error: "Cannot view another staff member's links" });
      return;
    }
    const rows = await selectLinks(schoolId, {
      type: "staff",
      staffId: targetStaffId,
    });
    res.json(rows);
    return;
  }

  if (studentParam) {
    // Per-student lookup is gated to core team — same reasoning as the
    // MTSS plan list (sensitive to share with random teachers).
    if (!requireCoreTeam(staff, res)) return;
    const rows = await selectLinks(schoolId, {
      type: "student",
      studentId: studentParam,
    });
    res.json(rows);
    return;
  }

  // Unfiltered — core team only.
  if (!requireCoreTeam(staff, res)) return;
  const rows = await selectLinks(schoolId, { type: "all" });
  res.json(rows);
});

// POST /api/trusted-adult-links
//   Body: { studentId: string, staffId: number, notes?: string }
//   - Validates the student exists in this school and the staff is in
//     this school (or, for SuperUser, anywhere — we still require the
//     row's schoolId to match the active school silo).
//   - Idempotent on the unique (school, student, staff) constraint:
//     200 with the existing row if it already exists.
router.post("/trusted-adult-links", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requireCoreTeam(staff, res)) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const studentId =
    typeof body.studentId === "string" ? body.studentId.trim() : "";
  const targetStaffIdRaw = body.staffId;
  const targetStaffId =
    typeof targetStaffIdRaw === "number"
      ? targetStaffIdRaw
      : parseInt(String(targetStaffIdRaw ?? ""), 10);
  const notes =
    typeof body.notes === "string" && body.notes.trim()
      ? body.notes.trim().slice(0, 500)
      : null;

  if (!studentId) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  if (!Number.isFinite(targetStaffId)) {
    res.status(400).json({ error: "staffId is required and must be a number" });
    return;
  }

  // Verify both ends exist in this school. We reject silently-invalid
  // pairs early so the unique constraint can't paper over a typo.
  const [studentExists] = await db
    .select({ id: studentsTable.id })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, studentId),
        eq(studentsTable.schoolId, schoolId),
      ),
    );
  if (!studentExists) {
    res.status(404).json({ error: "Student not found in this school" });
    return;
  }
  const [staffExists] = await db
    .select({ id: staffTable.id, schoolId: staffTable.schoolId })
    .from(staffTable)
    .where(eq(staffTable.id, targetStaffId));
  if (!staffExists) {
    res.status(404).json({ error: "Staff member not found" });
    return;
  }
  // Multi-tenancy: only allow linking staff who actually belong to this
  // school. SuperUsers operating cross-school must switch tenancy first.
  if (staffExists.schoolId !== schoolId) {
    res.status(400).json({
      error: "Staff member does not belong to this school",
    });
    return;
  }

  // Idempotent insert: ON CONFLICT DO NOTHING + a follow-up SELECT for
  // the row id. Cheaper than a SELECT-then-INSERT race window.
  await db
    .insert(studentTrustedAdultsTable)
    .values({
      schoolId,
      studentId,
      staffId: targetStaffId,
      assignedByStaffId: staff.id,
      assignedByName: staff.displayName ?? staff.email ?? null,
      notes,
    })
    .onConflictDoNothing({
      target: [
        studentTrustedAdultsTable.schoolId,
        studentTrustedAdultsTable.studentId,
        studentTrustedAdultsTable.staffId,
      ],
    });

  // Fetch the canonical row (existing or newly inserted) so the client
  // gets a consistent shape regardless of conflict outcome.
  const [row] = await selectLinks(schoolId, {
    type: "student",
    studentId,
  }).then((rows) => rows.filter((r) => r.staffId === targetStaffId));
  res.json(row ?? null);
});

// DELETE /api/trusted-adult-links/:id
router.delete("/trusted-adult-links/:id", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!requireCoreTeam(staff, res)) return;

  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const r = await db
    .delete(studentTrustedAdultsTable)
    .where(
      and(
        eq(studentTrustedAdultsTable.id, id),
        eq(studentTrustedAdultsTable.schoolId, schoolId),
      ),
    );
  const deleted = (r as unknown as { rowCount?: number }).rowCount ?? 0;
  res.json({ deleted });
});

export default router;
