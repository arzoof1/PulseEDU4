// ACADEMIC EVIDENCE — PARENT ("Learning at Home"). The family-facing mirror of
// the staff "Partnering with Parents" surface: one card per class on the
// student's read-only schedule (section_roster + class_sections), each card
// holding the PUBLISHED academic work samples a teacher shared for that class.
//
// HARD CONSTRAINTS:
//  - Parent-authed (req.parentId via session or Bearer parent token). Every
//    lookup is gated by parent↔student ownership AND the student's school_id.
//  - The FLEID (students.student_id) is an internal FK only. The parent payload
//    NEVER includes it or the raw object key; the only id that may appear is
//    local_sis_id.
//  - Only PUBLISHED samples (published_at IS NOT NULL) are visible. Section
//    roster membership is the OUTER gate (a family only sees their own student's
//    classes).
import { Router, type IRouter } from "express";
import { and, eq, inArray, isNotNull, desc } from "drizzle-orm";
import {
  db,
  parentStudentsTable,
  studentsTable,
  staffTable,
  classSectionsTable,
  sectionRosterTable,
  academicWorkSamplesTable,
} from "@workspace/db";
import { requireActiveParent } from "../lib/parentAuthMiddleware.js";
import { streamObjectToResponse } from "./storage.js";
import { academicEvidenceEnabled } from "../lib/academicEvidenceGate.js";

const router: IRouter = Router();

// Resolve req.parentId AND enforce parents.active=true on every request (F02).
router.use(requireActiveParent);

interface OwnedStudent {
  fleid: string;
  schoolId: number;
  localSisId: string | null;
}

async function resolveOwnedStudent(
  parentId: number,
  studentIdInt: number,
): Promise<OwnedStudent | null> {
  const [link] = await db
    .select({ id: parentStudentsTable.id })
    .from(parentStudentsTable)
    .where(
      and(
        eq(parentStudentsTable.parentId, parentId),
        eq(parentStudentsTable.studentId, studentIdInt),
      ),
    );
  if (!link) return null;
  const [student] = await db
    .select({
      studentId: studentsTable.studentId,
      schoolId: studentsTable.schoolId,
      localSisId: studentsTable.localSisId,
    })
    .from(studentsTable)
    .where(eq(studentsTable.id, studentIdInt));
  if (!student) return null;
  return {
    fleid: student.studentId,
    schoolId: student.schoolId,
    localSisId: student.localSisId ?? null,
  };
}

// GET /api/parent/learning-at-home/cards?studentId= — the "Learning at Home"
// cards for one owned child. studentId is the integer students.id used across
// the portal. One card per class section the child is on; each card holds that
// class's PUBLISHED academic work samples (newest first). Cards with no
// published sample are still returned (so the family sees the class), with an
// empty sample list.
router.get("/parent/learning-at-home/cards", async (req, res) => {
  const pid = req.parentId;
  if (!pid) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const studentIdInt = Number(req.query.studentId);
  if (!Number.isInteger(studentIdInt)) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  const owned = await resolveOwnedStudent(pid, studentIdInt);
  if (!owned) {
    res.status(403).json({ error: "Not your student" });
    return;
  }
  // Feature disabled for this school → behave as if there's nothing to show.
  if (!(await academicEvidenceEnabled(owned.schoolId))) {
    res.json({ localSisId: owned.localSisId, cards: [] });
    return;
  }

  // The child's read-only schedule: section_roster → class_sections (+ teacher).
  const sectionRows = await db
    .select({
      sectionId: classSectionsTable.id,
      period: classSectionsTable.period,
      courseName: classSectionsTable.courseName,
      isPlanning: classSectionsTable.isPlanning,
      teacherName: staffTable.displayName,
    })
    .from(sectionRosterTable)
    .innerJoin(
      classSectionsTable,
      and(
        eq(classSectionsTable.id, sectionRosterTable.sectionId),
        eq(classSectionsTable.schoolId, sectionRosterTable.schoolId),
      ),
    )
    .leftJoin(staffTable, eq(staffTable.id, classSectionsTable.teacherStaffId))
    .where(
      and(
        eq(sectionRosterTable.schoolId, owned.schoolId),
        eq(sectionRosterTable.studentId, owned.fleid),
      ),
    )
    .orderBy(classSectionsTable.period);

  const sections = sectionRows.filter((s) => !s.isPlanning);
  const sectionIds = sections.map((s) => s.sectionId);

  // PUBLISHED samples for THIS student across those sections.
  const sampleRows = sectionIds.length
    ? await db
        .select({
          id: academicWorkSamplesTable.id,
          sectionId: academicWorkSamplesTable.sectionId,
          subject: academicWorkSamplesTable.subject,
          assignmentTitle: academicWorkSamplesTable.assignmentTitle,
          note: academicWorkSamplesTable.note,
          source: academicWorkSamplesTable.source,
          publishedAt: academicWorkSamplesTable.publishedAt,
        })
        .from(academicWorkSamplesTable)
        .where(
          and(
            eq(academicWorkSamplesTable.schoolId, owned.schoolId),
            eq(academicWorkSamplesTable.studentId, owned.fleid),
            inArray(academicWorkSamplesTable.sectionId, sectionIds),
            isNotNull(academicWorkSamplesTable.publishedAt),
          ),
        )
        .orderBy(desc(academicWorkSamplesTable.publishedAt))
    : [];

  const bySection = new Map<number, typeof sampleRows>();
  for (const s of sampleRows) {
    const list = bySection.get(s.sectionId) ?? [];
    list.push(s);
    bySection.set(s.sectionId, list);
  }

  res.json({
    localSisId: owned.localSisId,
    cards: sections.map((s) => ({
      sectionId: s.sectionId,
      period: s.period,
      courseName: s.courseName,
      teacherName: s.teacherName ?? null,
      samples: (bySection.get(s.sectionId) ?? []).map((sample) => ({
        id: sample.id,
        subject: sample.subject,
        assignmentTitle: sample.assignmentTitle,
        note: sample.note,
        source: sample.source,
        publishedAt: sample.publishedAt
          ? sample.publishedAt.toISOString()
          : null,
      })),
    })),
  });
});

// GET /api/parent/learning-at-home/sample/:sampleId/image?studentId= — stream
// the bytes of ONE published sample the family owns. Re-checks ownership +
// publish gate so a known/guessed sample id can't bypass visibility.
router.get(
  "/parent/learning-at-home/sample/:sampleId/image",
  async (req, res) => {
    const pid = req.parentId;
    if (!pid) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    const sampleId = Number(req.params.sampleId);
    const studentIdInt = Number(req.query.studentId);
    if (!Number.isInteger(sampleId) || !Number.isInteger(studentIdInt)) {
      res.status(400).json({ error: "sampleId and studentId are required" });
      return;
    }
    const owned = await resolveOwnedStudent(pid, studentIdInt);
    if (!owned) {
      res.status(403).json({ error: "Not your student" });
      return;
    }
    if (!(await academicEvidenceEnabled(owned.schoolId))) {
      res.status(404).json({ error: "Sample not found" });
      return;
    }
    const [sample] = await db
      .select({ objectKey: academicWorkSamplesTable.objectKey })
      .from(academicWorkSamplesTable)
      .where(
        and(
          eq(academicWorkSamplesTable.id, sampleId),
          eq(academicWorkSamplesTable.schoolId, owned.schoolId),
          eq(academicWorkSamplesTable.studentId, owned.fleid),
          isNotNull(academicWorkSamplesTable.publishedAt),
        ),
      );
    if (!sample) {
      res.status(404).json({ error: "Sample not found" });
      return;
    }
    const ok = await streamObjectToResponse(sample.objectKey, res);
    if (!ok) res.status(404).json({ error: "Sample not found" });
  },
);

export default router;
