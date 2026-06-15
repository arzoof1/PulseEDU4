// ACADEMIC EVIDENCE — STAFF ("Partnering with Parents"). The academic sibling of
// the PulseBrainLab delivery workflow: a classroom TEACHER captures a student's
// formative-assessment work sample for one of their OWN class sections and
// shares it with that student's family on the parent "Learning at Home" surface.
//
// Gating: any signed-in active staff member. A teacher only ever sees their OWN
// class sections (class_sections.teacher_staff_id = actor). Core Team may pass
// ?teacherId= to view/curate another teacher's sections (same district-wide
// reach the other Core Team surfaces have).
//
// FLEID boundary: student rows are keyed by students.student_id (the FLEID, a
// text FK) which is NEVER rendered. Every response JOINs to
// students.local_sis_id for the human-visible id and returns `localSisId`.
//
// Roster is READ-ONLY: section membership comes from section_roster +
// class_sections (Skyward is the source of truth) — this surface never writes to
// either table.
import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq, inArray, desc } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  academicWorkSamplesTable,
  classSectionsTable,
  sectionRosterTable,
  studentsTable,
  staffTable,
} from "@workspace/db";
import { bindObjectToSchool, readStoredObject } from "./storage.js";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam } from "../lib/coreTeam.js";

const router: IRouter = Router();

const SUBJECTS = ["ela", "math"] as const;

// Any signed-in active staff member. Returns the staff row (so callers can test
// isCoreTeam) or null after writing the appropriate 401.
async function loadActiveStaff(req: Request, res: Response) {
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

// Resolve the staff whose sections we are operating on. Defaults to the actor;
// Core Team may target another teacher via teacherId. Returns null (after
// writing 403) when a non-Core-Team actor tries to target someone else.
function resolveTargetTeacherId(
  staff: { id: number },
  isCore: boolean,
  rawTeacherId: unknown,
): number | null {
  if (rawTeacherId == null || rawTeacherId === "") return staff.id;
  const tid = Number(rawTeacherId);
  if (!Number.isInteger(tid)) return staff.id;
  if (tid === staff.id) return staff.id;
  return isCore ? tid : null;
}

// Confirm the section belongs to this school AND the actor may touch it (owns it
// or is Core Team). Returns the section row or null after writing the response.
async function loadOwnedSection(
  schoolId: number,
  sectionId: number,
  staff: { id: number },
  isCore: boolean,
  res: Response,
) {
  const [section] = await db
    .select()
    .from(classSectionsTable)
    .where(
      and(
        eq(classSectionsTable.id, sectionId),
        eq(classSectionsTable.schoolId, schoolId),
      ),
    );
  if (!section) {
    res.status(404).json({ error: "Section not found" });
    return null;
  }
  if (!isCore && section.teacherStaffId !== staff.id) {
    res.status(403).json({ error: "Not your class section" });
    return null;
  }
  return section;
}

// GET /api/academic-evidence/my-sections[?teacherId=] — the teacher's (or, for
// Core Team, a chosen teacher's) class sections with their read-only rosters.
// Planning periods are excluded. Drives the recipient picker.
router.get("/academic-evidence/my-sections", async (req, res) => {
  const staff = await loadActiveStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const isCore = isCoreTeam(staff);
  const teacherId = resolveTargetTeacherId(staff, isCore, req.query.teacherId);
  if (teacherId == null) {
    res.status(403).json({ error: "Core Team access required" });
    return;
  }

  const sections = await db
    .select({
      id: classSectionsTable.id,
      period: classSectionsTable.period,
      courseName: classSectionsTable.courseName,
      isPlanning: classSectionsTable.isPlanning,
    })
    .from(classSectionsTable)
    .where(
      and(
        eq(classSectionsTable.schoolId, schoolId),
        eq(classSectionsTable.teacherStaffId, teacherId),
      ),
    )
    .orderBy(classSectionsTable.period);

  const teaching = sections.filter((s) => !s.isPlanning);
  const sectionIds = teaching.map((s) => s.id);

  // Roster rows for all sections at once, joined to local_sis_id + name.
  const rosterRows = sectionIds.length
    ? await db
        .select({
          sectionId: sectionRosterTable.sectionId,
          studentId: sectionRosterTable.studentId,
          firstName: studentsTable.firstName,
          lastName: studentsTable.lastName,
          localSisId: studentsTable.localSisId,
        })
        .from(sectionRosterTable)
        .innerJoin(
          studentsTable,
          and(
            eq(studentsTable.studentId, sectionRosterTable.studentId),
            eq(studentsTable.schoolId, sectionRosterTable.schoolId),
          ),
        )
        .where(
          and(
            eq(sectionRosterTable.schoolId, schoolId),
            inArray(sectionRosterTable.sectionId, sectionIds),
          ),
        )
    : [];

  const bySection = new Map<number, typeof rosterRows>();
  for (const r of rosterRows) {
    const list = bySection.get(r.sectionId) ?? [];
    list.push(r);
    bySection.set(r.sectionId, list);
  }

  res.json({
    teacherId,
    sections: teaching.map((s) => ({
      id: s.id,
      period: s.period,
      courseName: s.courseName,
      students: (bySection.get(s.id) ?? [])
        .map((r) => ({
          studentId: r.studentId,
          localSisId: r.localSisId,
          name: `${r.firstName} ${r.lastName}`.trim(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    })),
  });
});

// GET /api/academic-evidence/sections/:sectionId/samples — the captured samples
// for one section (all subjects), newest first.
router.get(
  "/academic-evidence/sections/:sectionId/samples",
  async (req, res) => {
    const staff = await loadActiveStaff(req, res);
    if (!staff) return;
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const isCore = isCoreTeam(staff);
    const sectionId = Number(req.params.sectionId);
    if (!Number.isInteger(sectionId)) {
      res.status(400).json({ error: "Invalid section id" });
      return;
    }
    const section = await loadOwnedSection(
      schoolId,
      sectionId,
      staff,
      isCore,
      res,
    );
    if (!section) return;

    const rows = await db
      .select({
        id: academicWorkSamplesTable.id,
        studentId: academicWorkSamplesTable.studentId,
        subject: academicWorkSamplesTable.subject,
        assignmentTitle: academicWorkSamplesTable.assignmentTitle,
        note: academicWorkSamplesTable.note,
        source: academicWorkSamplesTable.source,
        shared: academicWorkSamplesTable.shared,
        publishedAt: academicWorkSamplesTable.publishedAt,
        createdAt: academicWorkSamplesTable.createdAt,
        localSisId: studentsTable.localSisId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
      })
      .from(academicWorkSamplesTable)
      .innerJoin(
        studentsTable,
        and(
          eq(studentsTable.studentId, academicWorkSamplesTable.studentId),
          eq(studentsTable.schoolId, academicWorkSamplesTable.schoolId),
        ),
      )
      .where(
        and(
          eq(academicWorkSamplesTable.schoolId, schoolId),
          eq(academicWorkSamplesTable.sectionId, sectionId),
        ),
      )
      .orderBy(desc(academicWorkSamplesTable.createdAt));

    res.json({
      samples: rows.map((r) => ({
        id: r.id,
        studentId: r.studentId,
        localSisId: r.localSisId,
        studentName: `${r.firstName} ${r.lastName}`.trim(),
        subject: r.subject,
        assignmentTitle: r.assignmentTitle,
        note: r.note,
        source: r.source,
        shared: r.shared,
        publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  },
);

const CreateSampleBody = z.object({
  sectionId: z.number().int(),
  studentId: z.string().min(1),
  subject: z.enum(SUBJECTS),
  assignmentTitle: z.string().min(1).max(200),
  note: z.string().max(2000).optional(),
  objectPath: z.string().min(1),
  source: z.enum(["phone", "upload"]),
});

// POST /api/academic-evidence/samples — file a captured work sample. Validates
// the student is actually on the section's roster, binds the uploaded object to
// the school, then inserts. Drafts (publishedAt null) are staff-only until
// published.
router.post("/academic-evidence/samples", async (req, res) => {
  const staff = await loadActiveStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const isCore = isCoreTeam(staff);
  const parsed = CreateSampleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid work sample payload" });
    return;
  }
  const { sectionId, studentId, subject, assignmentTitle, note, objectPath, source } =
    parsed.data;

  const section = await loadOwnedSection(
    schoolId,
    sectionId,
    staff,
    isCore,
    res,
  );
  if (!section) return;

  // The student MUST be on this section's read-only roster.
  const [member] = await db
    .select({ id: sectionRosterTable.id })
    .from(sectionRosterTable)
    .where(
      and(
        eq(sectionRosterTable.schoolId, schoolId),
        eq(sectionRosterTable.sectionId, sectionId),
        eq(sectionRosterTable.studentId, studentId),
      ),
    );
  if (!member) {
    res.status(400).json({ error: "Student is not on this section roster" });
    return;
  }

  const bound = await bindObjectToSchool(objectPath, schoolId);
  if (!bound) {
    res.status(403).json({ error: "Upload not authorized for this school" });
    return;
  }

  const [inserted] = await db
    .insert(academicWorkSamplesTable)
    .values({
      schoolId,
      sectionId,
      studentId,
      subject,
      assignmentTitle: assignmentTitle.trim(),
      note: note?.trim() || null,
      objectKey: objectPath,
      source,
      createdByStaffId: staff.id,
    })
    .returning({ id: academicWorkSamplesTable.id });

  res.status(201).json({ id: inserted.id });
});

const UpdateSampleBody = z.object({
  assignmentTitle: z.string().min(1).max(200).optional(),
  note: z.string().max(2000).nullable().optional(),
});

// Load a sample school-scoped + enforce section ownership for the actor.
async function loadOwnedSample(
  schoolId: number,
  sampleId: number,
  staff: { id: number },
  isCore: boolean,
  res: Response,
) {
  const [row] = await db
    .select()
    .from(academicWorkSamplesTable)
    .where(
      and(
        eq(academicWorkSamplesTable.id, sampleId),
        eq(academicWorkSamplesTable.schoolId, schoolId),
      ),
    );
  if (!row) {
    res.status(404).json({ error: "Work sample not found" });
    return null;
  }
  const section = await loadOwnedSection(
    schoolId,
    row.sectionId,
    staff,
    isCore,
    res,
  );
  if (!section) return null;
  return row;
}

// PATCH /api/academic-evidence/samples/:id — edit title/note.
router.patch("/academic-evidence/samples/:id", async (req, res) => {
  const staff = await loadActiveStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const isCore = isCoreTeam(staff);
  const sampleId = Number(req.params.id);
  if (!Number.isInteger(sampleId)) {
    res.status(400).json({ error: "Invalid sample id" });
    return;
  }
  const parsed = UpdateSampleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid update payload" });
    return;
  }
  const row = await loadOwnedSample(schoolId, sampleId, staff, isCore, res);
  if (!row) return;

  const patch: Record<string, unknown> = {};
  if (parsed.data.assignmentTitle !== undefined) {
    patch.assignmentTitle = parsed.data.assignmentTitle.trim();
  }
  if (parsed.data.note !== undefined) {
    patch.note = parsed.data.note?.trim() || null;
  }
  if (Object.keys(patch).length) {
    await db
      .update(academicWorkSamplesTable)
      .set(patch)
      .where(
        and(
          eq(academicWorkSamplesTable.id, sampleId),
          eq(academicWorkSamplesTable.schoolId, schoolId),
        ),
      );
  }
  res.json({ ok: true });
});

// POST /api/academic-evidence/samples/:id/publish — make visible to the family.
router.post("/academic-evidence/samples/:id/publish", async (req, res) => {
  const staff = await loadActiveStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const isCore = isCoreTeam(staff);
  const sampleId = Number(req.params.id);
  if (!Number.isInteger(sampleId)) {
    res.status(400).json({ error: "Invalid sample id" });
    return;
  }
  const row = await loadOwnedSample(schoolId, sampleId, staff, isCore, res);
  if (!row) return;
  await db
    .update(academicWorkSamplesTable)
    .set({ publishedAt: new Date() })
    .where(
      and(
        eq(academicWorkSamplesTable.id, sampleId),
        eq(academicWorkSamplesTable.schoolId, schoolId),
      ),
    );
  res.json({ ok: true });
});

// POST /api/academic-evidence/samples/:id/unpublish — pull back from the family.
router.post("/academic-evidence/samples/:id/unpublish", async (req, res) => {
  const staff = await loadActiveStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const isCore = isCoreTeam(staff);
  const sampleId = Number(req.params.id);
  if (!Number.isInteger(sampleId)) {
    res.status(400).json({ error: "Invalid sample id" });
    return;
  }
  const row = await loadOwnedSample(schoolId, sampleId, staff, isCore, res);
  if (!row) return;
  await db
    .update(academicWorkSamplesTable)
    .set({ publishedAt: null })
    .where(
      and(
        eq(academicWorkSamplesTable.id, sampleId),
        eq(academicWorkSamplesTable.schoolId, schoolId),
      ),
    );
  res.json({ ok: true });
});

// DELETE /api/academic-evidence/samples/:id — remove a filed sample.
router.delete("/academic-evidence/samples/:id", async (req, res) => {
  const staff = await loadActiveStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const isCore = isCoreTeam(staff);
  const sampleId = Number(req.params.id);
  if (!Number.isInteger(sampleId)) {
    res.status(400).json({ error: "Invalid sample id" });
    return;
  }
  const row = await loadOwnedSample(schoolId, sampleId, staff, isCore, res);
  if (!row) return;
  await db
    .delete(academicWorkSamplesTable)
    .where(
      and(
        eq(academicWorkSamplesTable.id, sampleId),
        eq(academicWorkSamplesTable.schoolId, schoolId),
      ),
    );
  res.json({ ok: true });
});

// GET /api/academic-evidence/samples/:id/image — staff preview of the exact
// bytes a family would receive. Phone photos render inline (PNG/JPEG); scanned
// PDFs are served as application/pdf. School-scoped + section-owned.
router.get("/academic-evidence/samples/:id/image", async (req, res) => {
  const staff = await loadActiveStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const isCore = isCoreTeam(staff);
  const sampleId = Number(req.params.id);
  if (!Number.isInteger(sampleId)) {
    res.status(400).json({ error: "Invalid sample id" });
    return;
  }
  const row = await loadOwnedSample(schoolId, sampleId, staff, isCore, res);
  if (!row) return;

  let buf: Buffer | null = null;
  try {
    buf = await readStoredObject(row.objectKey);
  } catch {
    buf = null;
  }
  if (!buf) {
    res.status(404).json({ error: "Sample file unavailable" });
    return;
  }
  const isPng = buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50;
  const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
  const isPdf =
    buf.length > 4 &&
    buf[0] === 0x25 &&
    buf[1] === 0x50 &&
    buf[2] === 0x44 &&
    buf[3] === 0x46;
  const contentType = isPng
    ? "image/png"
    : isJpeg
      ? "image/jpeg"
      : isPdf
        ? "application/pdf"
        : "application/octet-stream";
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "private, max-age=60");
  res.send(buf);
});

export default router;
