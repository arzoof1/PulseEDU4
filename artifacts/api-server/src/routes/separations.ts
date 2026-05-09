// Separation Suggestions — teachers flag pairs of students in their own
// class section who shouldn't be scheduled together next year. Aggregated
// for the scheduling team (Admin / DistrictAdmin / SuperUser / Behavior
// Specialist / Counselor / Guidance Counselor / Dean / School Psychologist
// / MTSS Coordinator) under Insights → Behavior.
//
// Per-period scoping: a teacher only sees / writes suggestions for their
// own class_sections. The reason-tag catalog is per-school and curated by
// the same scheduling-team roles.

import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  staffTable,
  studentsTable,
  classSectionsTable,
  sectionRosterTable,
  separationReasonTagsTable,
  studentSeparationsTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

// Scheduling-team roles. Edits the tag catalog AND can see the aggregate
// view + per-student drilldown. Mirrors the user's role list:
//   Admin / DistrictAdmin / SuperUser / Behavior Specialist / Counselor /
//   Guidance Counselor / Dean / School Psychologist / MTSS Coordinator.
function isSchedulingTeam(staff: StaffRow): boolean {
  return Boolean(
    staff.isSuperUser ||
      staff.isDistrictAdmin ||
      staff.isAdmin ||
      staff.isBehaviorSpecialist ||
      staff.isCounselor ||
      staff.isGuidanceCounselor ||
      staff.isDean ||
      staff.isSchoolPsychologist ||
      staff.isMtssCoordinator,
  );
}

function requireSignedIn() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

function requireSchedulingTeam() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    if (!isSchedulingTeam(staff)) {
      res.status(403).json({
        error:
          "Admin, Behavior Specialist, Counselor, Dean, School Psychologist, or MTSS Coordinator only",
      });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

// School year as "YYYY-YYYY". Cutover month is August: Aug-Dec rolls into
// the *upcoming* spring year, Jan-Jul stays in the previous fall year.
// Kept as a tiny pure function so tests / future callers can override the
// cutover month if a district uses a different academic calendar.
function currentSchoolYear(now = new Date()): string {
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-indexed
  return m >= 7 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

// Normalize a pair so studentAId < studentBId. The DB unique index
// depends on this ordering to dedupe (A,B) and (B,A).
function orderPair(a: string, b: string): { aId: string; bId: string } {
  return a < b ? { aId: a, bId: b } : { aId: b, bId: a };
}

// =====================================================================
// Reason tag catalog (per-school). Anyone signed in can READ; only the
// scheduling team can WRITE.
// =====================================================================

router.get("/separation-reason-tags", requireSignedIn(), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const rows = await db
    .select()
    .from(separationReasonTagsTable)
    .where(eq(separationReasonTagsTable.schoolId, schoolId))
    .orderBy(separationReasonTagsTable.sortOrder, separationReasonTagsTable.label);
  res.json(rows);
});

router.post(
  "/separation-reason-tags",
  requireSchedulingTeam(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const { label, sortOrder } = req.body ?? {};
    if (typeof label !== "string" || !label.trim()) {
      res.status(400).json({ error: "label is required" });
      return;
    }
    const trimmed = label.trim().slice(0, 200);
    const existing = await db
      .select()
      .from(separationReasonTagsTable)
      .where(
        and(
          eq(separationReasonTagsTable.schoolId, schoolId),
          sql`lower(${separationReasonTagsTable.label}) = lower(${trimmed})`,
        ),
      );
    if (existing.length > 0) {
      res.status(409).json({ error: "Tag label already exists" });
      return;
    }
    const so =
      typeof sortOrder === "number" && Number.isFinite(sortOrder)
        ? Math.trunc(sortOrder)
        : 0;
    const [row] = await db
      .insert(separationReasonTagsTable)
      .values({ schoolId, label: trimmed, sortOrder: so, active: true })
      .returning();
    res.status(201).json(row);
  },
);

router.patch(
  "/separation-reason-tags/:id",
  requireSchedulingTeam(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const { label, sortOrder, active } = req.body ?? {};
    const updates: Partial<typeof separationReasonTagsTable.$inferInsert> = {};
    if (typeof label === "string" && label.trim())
      updates.label = label.trim().slice(0, 200);
    if (typeof sortOrder === "number" && Number.isFinite(sortOrder))
      updates.sortOrder = Math.trunc(sortOrder);
    if (typeof active === "boolean") updates.active = active;
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No updates" });
      return;
    }
    const [row] = await db
      .update(separationReasonTagsTable)
      .set(updates)
      .where(
        and(
          eq(separationReasonTagsTable.id, id),
          eq(separationReasonTagsTable.schoolId, schoolId),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(row);
  },
);

// =====================================================================
// Helpers shared by the teacher-facing endpoints. A teacher can only
// touch separations for class sections they actually teach.
// =====================================================================

async function loadOwnedSection(
  schoolId: number,
  staffId: number,
  classSectionId: number,
) {
  const [section] = await db
    .select()
    .from(classSectionsTable)
    .where(
      and(
        eq(classSectionsTable.id, classSectionId),
        eq(classSectionsTable.schoolId, schoolId),
        eq(classSectionsTable.teacherStaffId, staffId),
      ),
    );
  return section ?? null;
}

// Resolve the calling teacher's OWN class section for a given period.
// Teacher Roster doesn't currently know the section_id of the row it's
// rendering — it only knows the period — so this is the bridge that lets
// the Suggest-Separation modal pass a real classSectionId.
router.get(
  "/separations/section-for-period",
  requireSignedIn(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: StaffRow }).staff;
    const period = Number(req.query.period);
    if (!Number.isInteger(period)) {
      res.status(400).json({ error: "period is required" });
      return;
    }
    const [section] = await db
      .select()
      .from(classSectionsTable)
      .where(
        and(
          eq(classSectionsTable.schoolId, schoolId),
          eq(classSectionsTable.teacherStaffId, staff.id),
          eq(classSectionsTable.period, period),
        ),
      );
    if (!section) {
      res.status(404).json({ error: "No section for that period" });
      return;
    }
    res.json({
      id: section.id,
      period: section.period,
      courseName: section.courseName,
    });
  },
);

// =====================================================================
// Teacher-facing: list classmates in one of my sections, list my flags
// for that section, create a flag, delete one of my flags.
// =====================================================================

// Roster of students in one of MY sections — used to populate the
// "second student" dropdown in the Suggest Separation modal.
router.get(
  "/separations/section/:id/students",
  requireSignedIn(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: StaffRow }).staff;
    const sectionId = Number(req.params.id);
    if (!Number.isInteger(sectionId) || sectionId < 1) {
      res.status(400).json({ error: "Invalid section id" });
      return;
    }
    // Admin/scheduling-team members may inspect any section in the
    // school (used by the per-student drilldown to render section
    // context). Teachers are restricted to their own sections.
    let section = await loadOwnedSection(schoolId, staff.id, sectionId);
    if (!section && isSchedulingTeam(staff)) {
      const [s] = await db
        .select()
        .from(classSectionsTable)
        .where(
          and(
            eq(classSectionsTable.id, sectionId),
            eq(classSectionsTable.schoolId, schoolId),
          ),
        );
      section = s ?? null;
    }
    if (!section) {
      res.status(404).json({ error: "Section not found" });
      return;
    }
    const rows = await db
      .select({
        studentId: studentsTable.studentId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
      })
      .from(sectionRosterTable)
      .innerJoin(
        studentsTable,
        and(
          eq(studentsTable.studentId, sectionRosterTable.studentId),
          eq(studentsTable.schoolId, schoolId),
        ),
      )
      .where(
        and(
          eq(sectionRosterTable.sectionId, sectionId),
          eq(sectionRosterTable.schoolId, schoolId),
        ),
      )
      .orderBy(studentsTable.lastName, studentsTable.firstName);
    res.json({
      section: {
        id: section.id,
        period: section.period,
        courseName: section.courseName,
      },
      students: rows,
    });
  },
);

// All flags THIS teacher has filed for one of THEIR sections in the
// current school year. Used by Teacher Roster to show the "🚫 N" pill
// next to each student row.
router.get("/separations/my", requireSignedIn(), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staff = (req as Request & { staff: StaffRow }).staff;
  const sectionId = Number(req.query.classSectionId);
  if (!Number.isInteger(sectionId) || sectionId < 1) {
    res.status(400).json({ error: "classSectionId is required" });
    return;
  }
  const owned = await loadOwnedSection(schoolId, staff.id, sectionId);
  if (!owned) {
    res.status(404).json({ error: "Section not found" });
    return;
  }
  const year = currentSchoolYear();
  const rows = await db
    .select()
    .from(studentSeparationsTable)
    .where(
      and(
        eq(studentSeparationsTable.schoolId, schoolId),
        eq(studentSeparationsTable.classSectionId, sectionId),
        eq(studentSeparationsTable.reporterStaffId, staff.id),
        eq(studentSeparationsTable.schoolYear, year),
      ),
    );
  res.json({ schoolYear: year, separations: rows });
});

router.post("/separations", requireSignedIn(), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staff = (req as Request & { staff: StaffRow }).staff;
  const { classSectionId, studentAId, studentBId, reasonTagIds, reasonNote } =
    req.body ?? {};
  const secId = Number(classSectionId);
  if (!Number.isInteger(secId) || secId < 1) {
    res.status(400).json({ error: "classSectionId is required" });
    return;
  }
  if (
    typeof studentAId !== "string" ||
    typeof studentBId !== "string" ||
    !studentAId.trim() ||
    !studentBId.trim() ||
    studentAId === studentBId
  ) {
    res
      .status(400)
      .json({ error: "Two distinct studentIds are required" });
    return;
  }
  const owned = await loadOwnedSection(schoolId, staff.id, secId);
  if (!owned) {
    res.status(403).json({ error: "You do not teach that section" });
    return;
  }
  // Both students must actually be on this section's roster — prevents
  // spurious flags after a roster change and prevents cross-section
  // typos. The students table also enforces school scoping.
  const roster = await db
    .select({ studentId: sectionRosterTable.studentId })
    .from(sectionRosterTable)
    .where(
      and(
        eq(sectionRosterTable.sectionId, secId),
        eq(sectionRosterTable.schoolId, schoolId),
        inArray(sectionRosterTable.studentId, [studentAId, studentBId]),
      ),
    );
  if (roster.length !== 2) {
    res
      .status(400)
      .json({ error: "Both students must be on this section's roster" });
    return;
  }
  // Validate referenced tag ids belong to this school + are active.
  let tagIds: number[] = [];
  if (Array.isArray(reasonTagIds) && reasonTagIds.length > 0) {
    const cleaned = Array.from(
      new Set(
        reasonTagIds
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n > 0),
      ),
    );
    if (cleaned.length > 0) {
      const validRows = await db
        .select({ id: separationReasonTagsTable.id })
        .from(separationReasonTagsTable)
        .where(
          and(
            eq(separationReasonTagsTable.schoolId, schoolId),
            eq(separationReasonTagsTable.active, true),
            inArray(separationReasonTagsTable.id, cleaned),
          ),
        );
      tagIds = validRows.map((r) => r.id);
    }
  }
  let note: string | null = null;
  if (typeof reasonNote === "string" && reasonNote.trim()) {
    note = reasonNote.trim().slice(0, 1000);
  }
  const { aId, bId } = orderPair(studentAId, studentBId);
  const year = currentSchoolYear();
  try {
    const [row] = await db
      .insert(studentSeparationsTable)
      .values({
        schoolId,
        classSectionId: secId,
        reporterStaffId: staff.id,
        studentAId: aId,
        studentBId: bId,
        schoolYear: year,
        reasonTagIds: tagIds,
        reasonNote: note,
      })
      .returning();
    res.status(201).json(row);
  } catch (err: unknown) {
    // Unique-constraint violation: the teacher already flagged this pair
    // in this section this year. Update the existing row in-place so the
    // modal acts like an "edit" when re-opened.
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : "";
    if (code === "23505") {
      const [row] = await db
        .update(studentSeparationsTable)
        .set({ reasonTagIds: tagIds, reasonNote: note })
        .where(
          and(
            eq(studentSeparationsTable.schoolId, schoolId),
            eq(studentSeparationsTable.classSectionId, secId),
            eq(studentSeparationsTable.reporterStaffId, staff.id),
            eq(studentSeparationsTable.studentAId, aId),
            eq(studentSeparationsTable.studentBId, bId),
            eq(studentSeparationsTable.schoolYear, year),
          ),
        )
        .returning();
      res.json(row);
      return;
    }
    req.log.error({ err }, "separations.create failed");
    res.status(500).json({ error: "Failed to save separation" });
  }
});

router.delete("/separations/:id", requireSignedIn(), async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staff = (req as Request & { staff: StaffRow }).staff;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  // A teacher may only delete their own flags. Scheduling-team members
  // may also delete any flag in their school (e.g. cleanup of stale
  // suggestions during scheduling).
  const where = isSchedulingTeam(staff)
    ? and(
        eq(studentSeparationsTable.id, id),
        eq(studentSeparationsTable.schoolId, schoolId),
      )
    : and(
        eq(studentSeparationsTable.id, id),
        eq(studentSeparationsTable.schoolId, schoolId),
        eq(studentSeparationsTable.reporterStaffId, staff.id),
      );
  const [row] = await db
    .delete(studentSeparationsTable)
    .where(where)
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ ok: true, id: row.id });
});

// =====================================================================
// Aggregate view (scheduling team only). Returns:
//   - topPairs: every flagged (studentA, studentB) with the count of
//     distinct reporting teachers, total flag count, and per-tag
//     breakdown. Optionally filtered by grade and minimum teacher count.
//   - tagDistribution: counts per tag across the whole school year.
// =====================================================================

router.get(
  "/separations/aggregate",
  requireSchedulingTeam(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const year = currentSchoolYear();
    const minTeachers = Math.max(
      1,
      Math.min(20, Number(req.query.minTeachers) || 1),
    );
    const gradeRaw = req.query.grade;
    const grade =
      typeof gradeRaw === "string" && gradeRaw.trim() && gradeRaw !== "all"
        ? Number(gradeRaw)
        : null;

    const rows = await db
      .select()
      .from(studentSeparationsTable)
      .where(
        and(
          eq(studentSeparationsTable.schoolId, schoolId),
          eq(studentSeparationsTable.schoolYear, year),
        ),
      );

    // Pull every relevant student in one shot for naming + grade filter.
    const studentIds = Array.from(
      new Set(rows.flatMap((r) => [r.studentAId, r.studentBId])),
    );
    const studentsById = new Map<
      string,
      { firstName: string; lastName: string; grade: number }
    >();
    if (studentIds.length > 0) {
      const ss = await db
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
            inArray(studentsTable.studentId, studentIds),
          ),
        );
      for (const s of ss) {
        studentsById.set(s.studentId, {
          firstName: s.firstName,
          lastName: s.lastName,
          grade: s.grade,
        });
      }
    }

    const tagsRows = await db
      .select()
      .from(separationReasonTagsTable)
      .where(eq(separationReasonTagsTable.schoolId, schoolId));
    const tagsById = new Map<number, string>();
    for (const t of tagsRows) tagsById.set(t.id, t.label);

    type PairAgg = {
      studentAId: string;
      studentBId: string;
      flagCount: number;
      teacherIds: Set<number>;
      sectionIds: Set<number>;
      tagCounts: Record<number, number>;
      noteCount: number;
    };
    const pairs = new Map<string, PairAgg>();
    const tagTotals = new Map<number, number>();
    let totalFlags = 0;
    const flaggedStudents = new Set<string>();

    for (const r of rows) {
      const a = studentsById.get(r.studentAId);
      const b = studentsById.get(r.studentBId);
      // Apply grade filter (any of the two students matches keeps the pair).
      if (grade !== null) {
        const aMatch = a?.grade === grade;
        const bMatch = b?.grade === grade;
        if (!aMatch && !bMatch) continue;
      }
      totalFlags++;
      flaggedStudents.add(r.studentAId);
      flaggedStudents.add(r.studentBId);
      const key = `${r.studentAId}|${r.studentBId}`;
      let agg = pairs.get(key);
      if (!agg) {
        agg = {
          studentAId: r.studentAId,
          studentBId: r.studentBId,
          flagCount: 0,
          teacherIds: new Set(),
          sectionIds: new Set(),
          tagCounts: {},
          noteCount: 0,
        };
        pairs.set(key, agg);
      }
      agg.flagCount++;
      agg.teacherIds.add(r.reporterStaffId);
      agg.sectionIds.add(r.classSectionId);
      if (r.reasonNote && r.reasonNote.trim()) agg.noteCount++;
      for (const tid of r.reasonTagIds ?? []) {
        agg.tagCounts[tid] = (agg.tagCounts[tid] ?? 0) + 1;
        tagTotals.set(tid, (tagTotals.get(tid) ?? 0) + 1);
      }
    }

    const topPairs = Array.from(pairs.values())
      .filter((p) => p.teacherIds.size >= minTeachers)
      .map((p) => {
        const a = studentsById.get(p.studentAId);
        const b = studentsById.get(p.studentBId);
        return {
          studentAId: p.studentAId,
          studentAName: a
            ? `${a.lastName}, ${a.firstName}`
            : p.studentAId,
          studentAGrade: a?.grade ?? null,
          studentBId: p.studentBId,
          studentBName: b
            ? `${b.lastName}, ${b.firstName}`
            : p.studentBId,
          studentBGrade: b?.grade ?? null,
          flagCount: p.flagCount,
          teacherCount: p.teacherIds.size,
          sectionCount: p.sectionIds.size,
          noteCount: p.noteCount,
          tagBreakdown: Object.entries(p.tagCounts)
            .map(([tid, count]) => ({
              tagId: Number(tid),
              label: tagsById.get(Number(tid)) ?? `Tag #${tid}`,
              count,
            }))
            .sort((a, b) => b.count - a.count),
        };
      })
      .sort(
        (a, b) =>
          b.teacherCount - a.teacherCount ||
          b.flagCount - a.flagCount ||
          a.studentAName.localeCompare(b.studentAName),
      );

    const tagDistribution = Array.from(tagTotals.entries())
      .map(([tid, count]) => ({
        tagId: tid,
        label: tagsById.get(tid) ?? `Tag #${tid}`,
        count,
      }))
      .sort((a, b) => b.count - a.count);

    res.json({
      schoolYear: year,
      totals: {
        totalFlags,
        uniquePairs: pairs.size,
        flaggedStudents: flaggedStudents.size,
      },
      topPairs,
      tagDistribution,
    });
  },
);

// Per-student drilldown — every separation flag involving this student,
// with reporter, section, tags, and note. Same role gate as aggregate.
router.get(
  "/separations/student/:id",
  requireSchedulingTeam(),
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const studentId = String(req.params.id || "").trim();
    if (!studentId) {
      res.status(400).json({ error: "Invalid student id" });
      return;
    }
    const year = currentSchoolYear();
    const rows = await db
      .select({
        id: studentSeparationsTable.id,
        classSectionId: studentSeparationsTable.classSectionId,
        reporterStaffId: studentSeparationsTable.reporterStaffId,
        reporterName: staffTable.displayName,
        reporterEmail: staffTable.email,
        period: classSectionsTable.period,
        courseName: classSectionsTable.courseName,
        studentAId: studentSeparationsTable.studentAId,
        studentBId: studentSeparationsTable.studentBId,
        reasonTagIds: studentSeparationsTable.reasonTagIds,
        reasonNote: studentSeparationsTable.reasonNote,
        createdAt: studentSeparationsTable.createdAt,
      })
      .from(studentSeparationsTable)
      .innerJoin(
        classSectionsTable,
        and(
          eq(classSectionsTable.id, studentSeparationsTable.classSectionId),
          // Defense-in-depth: even though student_separations.school_id is
          // already filtered below, constrain the joined section to the
          // same tenant so a recycled section_id can never leak.
          eq(classSectionsTable.schoolId, schoolId),
        ),
      )
      .innerJoin(
        staffTable,
        and(
          eq(staffTable.id, studentSeparationsTable.reporterStaffId),
          eq(staffTable.schoolId, schoolId),
        ),
      )
      .where(
        and(
          eq(studentSeparationsTable.schoolId, schoolId),
          eq(studentSeparationsTable.schoolYear, year),
          sql`(${studentSeparationsTable.studentAId} = ${studentId} OR ${studentSeparationsTable.studentBId} = ${studentId})`,
        ),
      );

    const otherIds = Array.from(
      new Set(
        rows.map((r) =>
          r.studentAId === studentId ? r.studentBId : r.studentAId,
        ),
      ),
    );
    const otherById = new Map<string, { firstName: string; lastName: string }>();
    if (otherIds.length > 0) {
      const ss = await db
        .select({
          studentId: studentsTable.studentId,
          firstName: studentsTable.firstName,
          lastName: studentsTable.lastName,
        })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.schoolId, schoolId),
            inArray(studentsTable.studentId, otherIds),
          ),
        );
      for (const s of ss)
        otherById.set(s.studentId, {
          firstName: s.firstName,
          lastName: s.lastName,
        });
    }

    const tagRows = await db
      .select()
      .from(separationReasonTagsTable)
      .where(eq(separationReasonTagsTable.schoolId, schoolId));
    const tagsById = new Map<number, string>();
    for (const t of tagRows) tagsById.set(t.id, t.label);

    res.json({
      schoolYear: year,
      flags: rows.map((r) => {
        const otherId =
          r.studentAId === studentId ? r.studentBId : r.studentAId;
        const other = otherById.get(otherId);
        return {
          id: r.id,
          period: r.period,
          courseName: r.courseName,
          classSectionId: r.classSectionId,
          reporterStaffId: r.reporterStaffId,
          reporterName: r.reporterName ?? r.reporterEmail ?? "(unknown)",
          otherStudentId: otherId,
          otherStudentName: other
            ? `${other.lastName}, ${other.firstName}`
            : otherId,
          reasonNote: r.reasonNote,
          tags: (r.reasonTagIds ?? []).map((tid: number) => ({
            tagId: tid,
            label: tagsById.get(tid) ?? `Tag #${tid}`,
          })),
          createdAt: r.createdAt,
        };
      }),
    });
  },
);

export default router;
