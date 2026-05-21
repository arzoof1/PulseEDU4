import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  studentsTable,
  studentAccommodationsTable,
  schoolAccommodationsTable,
  studentEmergencyContactsTable,
  staffTable,
  housesTable,
  studentHouseChangesTable,
} from "@workspace/db";
import { eq, isNull, and, asc, inArray, or, ilike } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import {
  canManageStudentPhoto,
  isAdminOrSuperUser,
  isCoreTeam,
} from "../lib/coreTeam.js";
import { bindObjectToSchool } from "./storage.js";

const router: IRouter = Router();

// Inline requireStaff — every route file in this codebase has its own
// copy following the pattern in pickup.ts / interventions.ts. Keeps
// students.ts self-contained and matches the audit pattern reviewers
// expect when reading any one route file.
async function requireStaff(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Staff not found or inactive" });
    return;
  }
  (req as Request & { staff: typeof staffTable.$inferSelect }).staff = staff;
  next();
}

router.get("/students", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  // Optional ?q= typeahead filter — used by the Admin Hub discipline-log
  // modal so the student picker can narrow the school roster instead of
  // returning every student. Matches first/last/student_id (case-insensitive).
  const qRaw = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const q = qRaw.slice(0, 64);
  const where = q
    ? and(
        eq(studentsTable.schoolId, schoolId),
        or(
          // Prefix match: typing "joh" returns "John Smith" or
          // "Mike Johnson" — but NOT "Stephanie Cohen". Matches the
          // beginning of first or last name only. Student ID stays a
          // prefix match too (admins typically know the leading digits).
          ilike(studentsTable.firstName, `${q}%`),
          ilike(studentsTable.lastName, `${q}%`),
          ilike(studentsTable.localSisId, `${q}%`),
        ),
      )
    : eq(studentsTable.schoolId, schoolId);

  const rows = await db
    .select()
    .from(studentsTable)
    .where(where)
    .orderBy(studentsTable.lastName, studentsTable.firstName);
  // student_id is NOT globally unique across schools, so an in-memory
  // membership filter on the school's roster would still mis-attribute an
  // assignment that belongs to a different school's student with the same
  // student_id. AND-filter the assignments themselves by schoolId in SQL.
  const assignments = await db
    .select({
      studentId: studentAccommodationsTable.studentId,
      name: schoolAccommodationsTable.name,
    })
    .from(studentAccommodationsTable)
    .innerJoin(
      schoolAccommodationsTable,
      eq(studentAccommodationsTable.accommodationId, schoolAccommodationsTable.id),
    )
    .where(
      and(
        eq(studentAccommodationsTable.schoolId, schoolId),
        isNull(studentAccommodationsTable.removedAt),
      ),
    );

  const byStudent = new Map<string, string[]>();
  for (const a of assignments) {
    const list = byStudent.get(a.studentId) ?? [];
    list.push(a.name);
    byStudent.set(a.studentId, list);
  }

  res.json(
    rows.map((r) => ({
      ...r,
      accommodations: byStudent.get(r.studentId) ?? [],
    })),
  );
});

// Single-student endpoint with emergency contacts (the 4 SIS-derived
// contact slots — read-only, sourced via the Data Importer). Used by
// the student profile drawer.
router.get("/students/:studentId", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const studentId = String(req.params.studentId ?? "");
  if (!studentId) {
    res.status(400).json({ error: "studentId required" });
    return;
  }
  const [stu] = await db
    .select()
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, studentId),
        eq(studentsTable.schoolId, schoolId),
      ),
    );
  if (!stu) {
    res.status(404).json({ error: "Student not found" });
    return;
  }
  const accommodations = await db
    .select({ name: schoolAccommodationsTable.name })
    .from(studentAccommodationsTable)
    .innerJoin(
      schoolAccommodationsTable,
      eq(studentAccommodationsTable.accommodationId, schoolAccommodationsTable.id),
    )
    .where(
      and(
        eq(studentAccommodationsTable.schoolId, schoolId),
        eq(studentAccommodationsTable.studentId, studentId),
        isNull(studentAccommodationsTable.removedAt),
      ),
    );
  const contacts = await db
    .select()
    .from(studentEmergencyContactsTable)
    .where(
      and(
        eq(studentEmergencyContactsTable.schoolId, schoolId),
        eq(studentEmergencyContactsTable.studentId, studentId),
      ),
    )
    .orderBy(asc(studentEmergencyContactsTable.slot));
  res.json({
    ...stu,
    accommodations: accommodations.map((a) => a.name),
    emergencyContacts: contacts,
  });
});

// ---------------------------------------------------------------------------
// Student photo manager — single-entry path. Bulk yearbook ZIP ingest is
// future work (replit.md). Audience: canManageStudentPhoto (admin / core
// team / guidance). Bytes go through the existing /api/storage/* pipeline,
// so the ACL is school-scoped automatically; we just record the resulting
// objectKey on the student row. Bytes are NEVER deleted on consent
// revocation or photo replace — the previous object remains in storage
// (orphaned) so an accidental delete can be recovered. A future cleanup
// job could prune by age, but for now the storage cost is negligible.
// ---------------------------------------------------------------------------
router.post("/students/:studentId/photo", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  if (!canManageStudentPhoto(staff)) {
    res.status(403).json({ error: "Not authorized to manage student photos" });
    return;
  }
  const studentId = String(req.params.studentId ?? "");
  const objectPath: string =
    typeof req.body?.objectPath === "string" ? req.body.objectPath.trim() : "";
  if (!studentId) {
    res.status(400).json({ error: "studentId required" });
    return;
  }
  if (!objectPath || !objectPath.startsWith("/objects/")) {
    res.status(400).json({ error: "objectPath required (/objects/...)" });
    return;
  }
  // Cross-school safety + verify the student exists in this tenant.
  const [stu] = await db
    .select({ id: studentsTable.id })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, studentId),
        eq(studentsTable.schoolId, schoolId),
      ),
    );
  if (!stu) {
    res.status(404).json({ error: "Student not found" });
    return;
  }
  // Bind the freshly-uploaded object to this school. bindObjectToSchool
  // returns false if the path was either issued to a different school
  // or already bound elsewhere — both cases must reject so a hostile
  // client can't reassign someone else's image to one of our students.
  const ok = await bindObjectToSchool(objectPath, schoolId);
  if (!ok) {
    res
      .status(403)
      .json({ error: "Object not bound — re-upload and try again" });
    return;
  }
  await db
    .update(studentsTable)
    .set({ photoObjectKey: objectPath })
    .where(
      and(
        eq(studentsTable.id, stu.id),
        eq(studentsTable.schoolId, schoolId),
      ),
    );
  res.json({ ok: true, photoObjectKey: objectPath });
});

router.delete("/students/:studentId/photo", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  if (!canManageStudentPhoto(staff)) {
    res.status(403).json({ error: "Not authorized to manage student photos" });
    return;
  }
  const studentId = String(req.params.studentId ?? "");
  if (!studentId) {
    res.status(400).json({ error: "studentId required" });
    return;
  }
  const result = await db
    .update(studentsTable)
    .set({ photoObjectKey: null })
    .where(
      and(
        eq(studentsTable.studentId, studentId),
        eq(studentsTable.schoolId, schoolId),
      ),
    );
  res.json({ ok: true, updated: result.rowCount ?? 0 });
});

// PATCH /students/:studentId/photo-consent  body: { consent: boolean }
// Admin-only — privacy toggle. Setting consent=false hides the photo
// in every render path even if bytes are on disk.
router.patch(
  "/students/:studentId/photo-consent",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
      .staff;
    if (!isAdminOrSuperUser(staff)) {
      res.status(403).json({ error: "Admin only" });
      return;
    }
    const studentId = String(req.params.studentId ?? "");
    const consent = req.body?.consent;
    if (typeof consent !== "boolean") {
      res.status(400).json({ error: "consent (boolean) required" });
      return;
    }
    if (!studentId) {
      res.status(400).json({ error: "studentId required" });
      return;
    }
    const result = await db
      .update(studentsTable)
      .set({ photoConsent: consent })
      .where(
        and(
          eq(studentsTable.studentId, studentId),
          eq(studentsTable.schoolId, schoolId),
        ),
      );
    res.json({ ok: true, updated: result.rowCount ?? 0 });
  },
);

// PATCH /students/:studentId/house — admin-only, single-row house change
// with a required reason. Writes the new house_id AND appends a row to
// student_house_changes so the move is auditable. Cross-tenant guards:
// student must belong to the actor's school, and the new house must
// belong to the same school as the student.
router.patch(
  "/students/:studentId/house",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
      .staff;
    // Per spec ("same gate as Staff & Roles"): Admin / SuperUser /
    // District Admin plus Core Team (Behavior Specialist, MTSS
    // Coordinator, School Psychologist).
    if (!isCoreTeam(staff)) {
      res.status(403).json({ error: "Admin or Core Team only" });
      return;
    }
    const studentIdParam = String(req.params.studentId ?? "");
    if (!studentIdParam) {
      res.status(400).json({ error: "studentId required" });
      return;
    }
    const body = req.body ?? {};
    const rawHouseId = body.houseId;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 10) {
      res
        .status(400)
        .json({ error: "Reason is required (at least 10 characters)." });
      return;
    }
    let newHouseId: number | null;
    if (rawHouseId === null) {
      newHouseId = null;
    } else if (
      typeof rawHouseId === "number" &&
      Number.isInteger(rawHouseId) &&
      rawHouseId > 0
    ) {
      newHouseId = rawHouseId;
    } else {
      res
        .status(400)
        .json({ error: "houseId must be a positive integer or null" });
      return;
    }
    const [student] = await db
      .select({ id: studentsTable.id, houseId: studentsTable.houseId })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          eq(studentsTable.studentId, studentIdParam),
        ),
      );
    if (!student) {
      res.status(404).json({ error: "Student not found" });
      return;
    }
    if (newHouseId !== null) {
      const [house] = await db
        .select({ id: housesTable.id })
        .from(housesTable)
        .where(
          and(
            eq(housesTable.id, newHouseId),
            eq(housesTable.schoolId, schoolId),
          ),
        );
      if (!house) {
        res
          .status(400)
          .json({ error: "House does not belong to this school." });
        return;
      }
    }
    if (student.houseId === newHouseId) {
      res.json({ ok: true, unchanged: true });
      return;
    }
    // Every direction is audited — including clearing a student
    // back to "— None —". The audit table's to_house_id column is
    // nullable specifically so this end-of-transition still leaves
    // a defensible row.
    await db.transaction(async (tx) => {
      await tx
        .update(studentsTable)
        .set({ houseId: newHouseId })
        .where(
          and(
            eq(studentsTable.id, student.id),
            eq(studentsTable.schoolId, schoolId),
          ),
        );
      await tx.insert(studentHouseChangesTable).values({
        schoolId,
        studentDbId: student.id,
        fromHouseId: student.houseId,
        toHouseId: newHouseId,
        reason,
        changedByStaffId: staff.id,
        source: "manual",
      });
    });
    res.json({ ok: true, houseId: newHouseId });
  },
);

export default router;
