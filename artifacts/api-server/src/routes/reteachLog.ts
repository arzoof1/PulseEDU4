// Benchmark reteach log — capture per-student × per-benchmark reteach
// moments from the Teacher Roster → Benchmarks heatmap.
//
// Routes:
//   GET    /api/reteach-log/cell?studentId=&benchmarkCode=
//   GET    /api/reteach-log/counts?teacherId=&subject=&schoolYear=
//   POST   /api/reteach-log              (single 1:1 entry)
//   POST   /api/reteach-log/bulk         (small-group: N rows, 1 sid)
//   PATCH  /api/reteach-log/:id
//   DELETE /api/reteach-log/:id          (soft delete)
//
// Edit/delete policy: teacher can edit/delete their own log within 24h
// of created_at; admin / Core Team can edit/delete anytime. Other
// teachers see logs (read) but cannot mutate.
import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import {
  db,
  benchmarkReteachLogTable,
  staffTable,
  studentsTable,
  sectionRosterTable,
  classSectionsTable,
} from "@workspace/db";
import { and, eq, inArray, isNull, sql, desc } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam } from "../lib/coreTeam.js";
import { schoolYearLabelFor, DEFAULT_SCHOOL_TZ } from "../lib/schoolYear.js";

const router: IRouter = Router();

const VALID_FORMATS = new Set(["one_on_one", "small_group"]);
const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

// Roster scoping: a teacher can only read/write reteach logs for
// students who appear on one of their `class_sections` rosters.
// Core Team / admin can touch any student in the school. Returns the
// subset of `studentIds` the staff member can access; empty array if
// none. Mirrors the gating pattern used by `routes/teacherRoster.ts`
// (see the section_roster JOIN around line 995) so authz behavior
// stays consistent across heatmap + reteach surfaces.
async function filterToRoster(
  schoolId: number,
  staff: typeof staffTable.$inferSelect,
  studentIds: string[],
): Promise<string[]> {
  if (studentIds.length === 0) return [];
  if (isCoreTeam(staff)) return studentIds;
  const rows = await db
    .selectDistinct({ studentId: sectionRosterTable.studentId })
    .from(sectionRosterTable)
    .innerJoin(
      classSectionsTable,
      eq(classSectionsTable.id, sectionRosterTable.sectionId),
    )
    .where(
      and(
        eq(classSectionsTable.schoolId, schoolId),
        eq(classSectionsTable.teacherStaffId, staff.id),
        inArray(sectionRosterTable.studentId, studentIds),
      ),
    );
  return rows.map((r) => r.studentId);
}

async function loadStaff(req: Request) {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function canMutate(
  row: { teacherStaffId: number; createdAt: Date },
  staff: { id: number; isSuperUser?: boolean | null; isDistrictAdmin?: boolean | null; isAdmin?: boolean | null; isBehaviorSpecialist?: boolean | null; isMtssCoordinator?: boolean | null; isSchoolPsychologist?: boolean | null },
): boolean {
  if (isCoreTeam(staff)) return true;
  if (row.teacherStaffId !== staff.id) return false;
  const age = Date.now() - new Date(row.createdAt).getTime();
  return age <= EDIT_WINDOW_MS;
}

// GET /api/reteach-log/cell — list all active logs for one cell
router.get("/reteach-log/cell", async (req: Request, res: Response) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req);
  if (!staff) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const studentId = req.query.studentId;
  const benchmarkCode = req.query.benchmarkCode;
  if (typeof studentId !== "string" || typeof benchmarkCode !== "string") {
    res.status(400).json({ error: "studentId and benchmarkCode required" });
    return;
  }
  const allowed = await filterToRoster(schoolId, staff, [studentId]);
  if (allowed.length === 0) {
    res.status(403).json({ error: "Student not on your roster" });
    return;
  }
  const rows = await db
    .select({
      id: benchmarkReteachLogTable.id,
      studentId: benchmarkReteachLogTable.studentId,
      benchmarkCode: benchmarkReteachLogTable.benchmarkCode,
      teacherStaffId: benchmarkReteachLogTable.teacherStaffId,
      teacherName: staffTable.displayName,
      format: benchmarkReteachLogTable.format,
      groupSessionId: benchmarkReteachLogTable.groupSessionId,
      strategy: benchmarkReteachLogTable.strategy,
      minutes: benchmarkReteachLogTable.minutes,
      note: benchmarkReteachLogTable.note,
      schoolYear: benchmarkReteachLogTable.schoolYear,
      pmWindowAtLog: benchmarkReteachLogTable.pmWindowAtLog,
      createdAt: benchmarkReteachLogTable.createdAt,
    })
    .from(benchmarkReteachLogTable)
    .leftJoin(
      staffTable,
      eq(staffTable.id, benchmarkReteachLogTable.teacherStaffId),
    )
    .where(
      and(
        eq(benchmarkReteachLogTable.schoolId, schoolId),
        eq(benchmarkReteachLogTable.studentId, studentId),
        eq(benchmarkReteachLogTable.benchmarkCode, benchmarkCode),
        isNull(benchmarkReteachLogTable.deletedAt),
      ),
    )
    .orderBy(desc(benchmarkReteachLogTable.createdAt));
  const out = rows.map((r) => ({
    ...r,
    canEdit: canMutate(
      { teacherStaffId: r.teacherStaffId, createdAt: r.createdAt },
      staff,
    ),
  }));
  res.json({ logs: out, viewerStaffId: staff.id });
});

// GET /api/reteach-log/counts — count grouped by (studentId, benchmarkCode)
// for the teacher's roster + subject + schoolYear. Used by the heatmap
// to render the 🔁 N badge per cell without N+1 round-trips.
router.get("/reteach-log/counts", async (req: Request, res: Response) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req);
  if (!staff) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const rawStudentIds = req.query.studentIds;
  let studentIds: string[] = [];
  if (typeof rawStudentIds === "string" && rawStudentIds.length > 0) {
    studentIds = rawStudentIds.split(",").filter(Boolean);
  } else if (Array.isArray(rawStudentIds)) {
    studentIds = rawStudentIds.map(String);
  }
  const schoolYear =
    typeof req.query.schoolYear === "string" && req.query.schoolYear.length > 0
      ? req.query.schoolYear
      : null;
  if (studentIds.length === 0) {
    res.json({ counts: [] });
    return;
  }
  const allowed = await filterToRoster(schoolId, staff, studentIds);
  if (allowed.length === 0) {
    res.json({ counts: [] });
    return;
  }
  const conds = [
    eq(benchmarkReteachLogTable.schoolId, schoolId),
    inArray(benchmarkReteachLogTable.studentId, allowed),
    isNull(benchmarkReteachLogTable.deletedAt),
  ];
  if (schoolYear) {
    conds.push(eq(benchmarkReteachLogTable.schoolYear, schoolYear));
  }
  const rows = await db
    .select({
      studentId: benchmarkReteachLogTable.studentId,
      benchmarkCode: benchmarkReteachLogTable.benchmarkCode,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(benchmarkReteachLogTable)
    .where(and(...conds))
    .groupBy(
      benchmarkReteachLogTable.studentId,
      benchmarkReteachLogTable.benchmarkCode,
    );
  res.json({ counts: rows });
});

interface ValidatedBody {
  benchmarkCode: string;
  format: "one_on_one" | "small_group";
  strategy: string | null;
  minutes: number | null;
  note: string | null;
  pmWindowAtLog: string | null;
  schoolYear: string;
}

function validateBody(req: Request, res: Response): ValidatedBody | null {
  const b = req.body ?? {};
  const benchmarkCode = b.benchmarkCode;
  const format = b.format;
  if (typeof benchmarkCode !== "string" || benchmarkCode.length === 0) {
    res.status(400).json({ error: "benchmarkCode required" });
    return null;
  }
  if (typeof format !== "string" || !VALID_FORMATS.has(format)) {
    res.status(400).json({ error: "format must be one_on_one or small_group" });
    return null;
  }
  const minutes =
    b.minutes == null || b.minutes === ""
      ? null
      : Number(b.minutes);
  if (minutes != null && (!Number.isFinite(minutes) || minutes < 0 || minutes > 600)) {
    res.status(400).json({ error: "minutes must be 0-600" });
    return null;
  }
  const note = typeof b.note === "string" && b.note.length > 0 ? b.note.slice(0, 500) : null;
  const strategy =
    typeof b.strategy === "string" && b.strategy.length > 0
      ? b.strategy.slice(0, 120)
      : null;
  const pmWindowAtLog =
    typeof b.pmWindowAtLog === "string" && b.pmWindowAtLog.length > 0
      ? b.pmWindowAtLog
      : null;
  const schoolYear =
    typeof b.schoolYear === "string" && b.schoolYear.length > 0
      ? b.schoolYear
      : schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ);
  return {
    benchmarkCode,
    format: format as "one_on_one" | "small_group",
    strategy,
    minutes: minutes == null ? null : Math.round(minutes),
    note,
    pmWindowAtLog,
    schoolYear,
  };
}

// POST /api/reteach-log — single (typically 1:1)
router.post("/reteach-log", async (req: Request, res: Response) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req);
  if (!staff) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const v = validateBody(req, res);
  if (!v) return;
  const studentId = req.body?.studentId;
  if (typeof studentId !== "string" || studentId.length === 0) {
    res.status(400).json({ error: "studentId required" });
    return;
  }
  const [exists] = await db
    .select({ id: studentsTable.id })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        eq(studentsTable.studentId, studentId),
      ),
    );
  if (!exists) {
    res.status(404).json({ error: "Student not found in this school" });
    return;
  }
  const allowed = await filterToRoster(schoolId, staff, [studentId]);
  if (allowed.length === 0) {
    res.status(403).json({ error: "Student not on your roster" });
    return;
  }
  const [inserted] = await db
    .insert(benchmarkReteachLogTable)
    .values({
      schoolId,
      studentId,
      benchmarkCode: v.benchmarkCode,
      teacherStaffId: staff.id,
      format: v.format,
      strategy: v.strategy,
      minutes: v.minutes,
      note: v.note,
      schoolYear: v.schoolYear,
      pmWindowAtLog: v.pmWindowAtLog,
    })
    .returning();
  res.json({ log: inserted });
});

// POST /api/reteach-log/bulk — small-group: N student rows, shared session
router.post("/reteach-log/bulk", async (req: Request, res: Response) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req);
  if (!staff) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const v = validateBody(req, res);
  if (!v) return;
  if (v.format !== "small_group") {
    res.status(400).json({ error: "bulk endpoint requires format=small_group" });
    return;
  }
  const ids = req.body?.studentIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "studentIds[] required" });
    return;
  }
  if (ids.length > 50) {
    res.status(400).json({ error: "Max 50 students per session" });
    return;
  }
  const cleanIds = Array.from(
    new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0)),
  );
  if (cleanIds.length === 0) {
    res.status(400).json({ error: "no valid studentIds" });
    return;
  }
  const valid = await db
    .select({ studentId: studentsTable.studentId })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        inArray(studentsTable.studentId, cleanIds),
      ),
    );
  const validSet = new Set(valid.map((s) => s.studentId));
  const inSchool = cleanIds.filter((id) => validSet.has(id));
  // Then intersect with the caller's roster (Core Team bypasses).
  const insertIds = await filterToRoster(schoolId, staff, inSchool);
  if (insertIds.length === 0) {
    res.status(403).json({
      error: "None of these students are on your roster",
    });
    return;
  }
  const groupSessionId = randomUUID();
  const rows = await db
    .insert(benchmarkReteachLogTable)
    .values(
      insertIds.map((studentId) => ({
        schoolId,
        studentId,
        benchmarkCode: v.benchmarkCode,
        teacherStaffId: staff.id,
        format: "small_group" as const,
        groupSessionId,
        strategy: v.strategy,
        minutes: v.minutes,
        note: v.note,
        schoolYear: v.schoolYear,
        pmWindowAtLog: v.pmWindowAtLog,
      })),
    )
    .returning();
  res.json({ logs: rows, groupSessionId });
});

// PATCH /api/reteach-log/:id — edit
router.patch("/reteach-log/:id", async (req: Request, res: Response) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req);
  if (!staff) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [row] = await db
    .select()
    .from(benchmarkReteachLogTable)
    .where(
      and(
        eq(benchmarkReteachLogTable.id, id),
        eq(benchmarkReteachLogTable.schoolId, schoolId),
        isNull(benchmarkReteachLogTable.deletedAt),
      ),
    );
  if (!row) {
    res.status(404).json({ error: "Log not found" });
    return;
  }
  if (!canMutate(row, staff)) {
    res.status(403).json({
      error:
        "Edit window closed (24 hours) or not your log. Ask an admin or Core Team member.",
    });
    return;
  }
  // Roster-scope gate (single row already loaded with school_id).
  const allowed = await filterToRoster(schoolId, staff, [row.studentId]);
  if (allowed.length === 0) {
    res.status(403).json({ error: "Student not on your roster" });
    return;
  }
  const b = req.body ?? {};
  const patch: Partial<typeof benchmarkReteachLogTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  // Intentionally not allowing `format` or `groupSessionId` edits —
  // mutating either would break the small-group session invariant
  // (a `small_group` row losing its session id, or a `one_on_one`
  // row inheriting one). To re-classify, delete + re-log.
  if ("strategy" in b) {
    patch.strategy =
      typeof b.strategy === "string" && b.strategy.length > 0
        ? b.strategy.slice(0, 120)
        : null;
  }
  if ("minutes" in b) {
    if (b.minutes == null || b.minutes === "") {
      patch.minutes = null;
    } else {
      const n = Number(b.minutes);
      if (!Number.isFinite(n) || n < 0 || n > 600) {
        res.status(400).json({ error: "minutes must be 0-600" });
        return;
      }
      patch.minutes = Math.round(n);
    }
  }
  if ("note" in b) {
    patch.note =
      typeof b.note === "string" && b.note.length > 0
        ? b.note.slice(0, 500)
        : null;
  }
  const [updated] = await db
    .update(benchmarkReteachLogTable)
    .set(patch)
    .where(eq(benchmarkReteachLogTable.id, id))
    .returning();
  res.json({ log: updated });
});

// DELETE /api/reteach-log/:id — soft delete
router.delete("/reteach-log/:id", async (req: Request, res: Response) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = await loadStaff(req);
  if (!staff) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [row] = await db
    .select()
    .from(benchmarkReteachLogTable)
    .where(
      and(
        eq(benchmarkReteachLogTable.id, id),
        eq(benchmarkReteachLogTable.schoolId, schoolId),
        isNull(benchmarkReteachLogTable.deletedAt),
      ),
    );
  if (!row) {
    res.status(404).json({ error: "Log not found" });
    return;
  }
  if (!canMutate(row, staff)) {
    res.status(403).json({
      error:
        "Delete window closed (24 hours) or not your log. Ask an admin or Core Team member.",
    });
    return;
  }
  const allowed = await filterToRoster(schoolId, staff, [row.studentId]);
  if (allowed.length === 0) {
    res.status(403).json({ error: "Student not on your roster" });
    return;
  }
  await db
    .update(benchmarkReteachLogTable)
    .set({
      deletedAt: new Date(),
      deletedByStaffId: staff.id,
      updatedAt: new Date(),
    })
    .where(eq(benchmarkReteachLogTable.id, id));
  res.json({ ok: true });
});

export default router;
