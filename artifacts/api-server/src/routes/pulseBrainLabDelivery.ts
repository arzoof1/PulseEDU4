// PulseBrainLab DELIVERY — school-scoped Behavior-Specialist workflow built on
// top of the global pulse_brain_lab_lessons catalog. The BS builds a named
// group (student search → members), delivers a lesson to it on a date (a
// "session"), and marks per-member attendance.
//
// Gating: Core Team (which includes Behavior Specialist) per isCoreTeam — the
// same gate the Tier 2 / Tier 3 intervention surfaces use.
//
// FLEID boundary: student rows are keyed by the canonical students.student_id
// (the FLEID, a text FK) which is NEVER rendered. Every response JOINs to
// students.local_sis_id for the human-visible id and returns `localSisId`.
import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  pulseBrainLabGroupsTable,
  pulseBrainLabGroupMembersTable,
  pulseBrainLabSessionsTable,
  pulseBrainLabSessionAttendanceTable,
  pulseBrainLabWorksheetTokensTable,
  pulseBrainLabWorkSamplesTable,
  pulseBrainLabUnmatchedScansTable,
  pulseBrainLabHomeResponsesTable,
  studentsTable,
  staffTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { genUrlSafeToken } from "../lib/urlSafeToken.js";
import { renderPulseBrainLabFacilitationPdf } from "../lib/pulseBrainLabFacilitationPdf.js";
import {
  renderPulseBrainLabWorksheetPdf,
  type WorksheetLanguage,
  type WorksheetStudent,
} from "../lib/pulseBrainLabWorksheetPdf.js";
import {
  CreatePulseBrainLabGroupBody,
  UpdatePulseBrainLabGroupBody,
  AddPulseBrainLabGroupMembersBody,
  CreatePulseBrainLabSessionBody,
  SetPulseBrainLabAttendanceBody,
  RoutePulseBrainLabScanBody,
  BatchPulseBrainLabScanBody,
  FilePulseBrainLabUnmatchedScanBody,
  AssignPulseBrainLabUnmatchedScanBody,
  SetPulseBrainLabWorkSampleShareBody,
} from "@workspace/api-zod";
import { bindObjectToSchool, readStoredObject } from "./storage.js";
import { buildHomeCards } from "../lib/pulseBrainLabHomeCards.js";
import {
  renderPulseBrainLabPacketPdf,
  type PacketWorkSampleImage,
} from "../lib/pulseBrainLabPacketPdf.js";
import { decodeWorksheetPdf } from "../lib/scanDecode.js";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam } from "../lib/coreTeam.js";
import { schoolYearLabelFor, DEFAULT_SCHOOL_TZ } from "../lib/schoolYear.js";
import { PULSE_BRAIN_LAB_LESSONS } from "../data/pulseBrainLab/index.js";

const router: IRouter = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_GRADE_BANDS = new Set(["K-2", "3-5", "6-8", "9-12"]);

// Load the acting staff member and enforce the Core Team gate (Behavior
// Specialist included). Returns the staff row, or null after writing the
// appropriate 401/403 response.
async function loadCoreTeamStaff(req: Request, res: Response) {
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
  if (!isCoreTeam(staff)) {
    res.status(403).json({ error: "Core Team access required" });
    return null;
  }
  return staff;
}

function lessonTitle(lessonKey: string): string {
  return (
    PULSE_BRAIN_LAB_LESSONS.find((l) => l.id === lessonKey)?.title ?? lessonKey
  );
}

// Resolve the subset of `studentIds` that actually belong to `schoolId`.
// Guards against cross-tenant member injection.
async function filterSchoolStudents(
  schoolId: number,
  studentIds: string[],
): Promise<string[]> {
  const unique = [...new Set(studentIds)];
  if (unique.length === 0) return [];
  const rows = await db
    .select({ studentId: studentsTable.studentId })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        inArray(studentsTable.studentId, unique),
      ),
    );
  return rows.map((r) => r.studentId);
}

async function loadGroupDetail(schoolId: number, groupId: number) {
  const [group] = await db
    .select()
    .from(pulseBrainLabGroupsTable)
    .where(
      and(
        eq(pulseBrainLabGroupsTable.id, groupId),
        eq(pulseBrainLabGroupsTable.schoolId, schoolId),
      ),
    );
  if (!group) return null;
  const members = await db
    .select({
      studentId: pulseBrainLabGroupMembersTable.studentId,
      localSisId: studentsTable.localSisId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
    })
    .from(pulseBrainLabGroupMembersTable)
    .innerJoin(
      studentsTable,
      and(
        eq(studentsTable.studentId, pulseBrainLabGroupMembersTable.studentId),
        // student_id (FLEID) is NOT globally unique — pair with school_id or the
        // join can resolve to another tenant's student row (name/local SIS leak).
        eq(studentsTable.schoolId, schoolId),
      ),
    )
    .where(
      and(
        eq(pulseBrainLabGroupMembersTable.groupId, groupId),
        eq(pulseBrainLabGroupMembersTable.schoolId, schoolId),
      ),
    );
  return {
    id: group.id,
    name: group.name,
    gradeBand: group.gradeBand,
    schoolYear: group.schoolYear,
    createdAt: group.createdAt.toISOString(),
    members: members.map((m) => ({
      studentId: m.studentId,
      localSisId: m.localSisId ?? null,
      firstName: m.firstName,
      lastName: m.lastName,
      gradeLevel: m.grade == null ? null : String(m.grade),
    })),
  };
}

async function loadSessionDetail(schoolId: number, sessionId: number) {
  const [session] = await db
    .select()
    .from(pulseBrainLabSessionsTable)
    .where(
      and(
        eq(pulseBrainLabSessionsTable.id, sessionId),
        eq(pulseBrainLabSessionsTable.schoolId, schoolId),
      ),
    );
  if (!session) return null;
  // Current group roster (so members added after the session still appear).
  const members = await db
    .select({
      studentId: pulseBrainLabGroupMembersTable.studentId,
      localSisId: studentsTable.localSisId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
    })
    .from(pulseBrainLabGroupMembersTable)
    .innerJoin(
      studentsTable,
      and(
        eq(studentsTable.studentId, pulseBrainLabGroupMembersTable.studentId),
        // student_id (FLEID) is NOT globally unique — pair with school_id or the
        // join can resolve to another tenant's student row (name/local SIS leak).
        eq(studentsTable.schoolId, schoolId),
      ),
    )
    .where(
      and(
        eq(pulseBrainLabGroupMembersTable.groupId, session.groupId),
        eq(pulseBrainLabGroupMembersTable.schoolId, schoolId),
      ),
    );
  const attRows = await db
    .select({
      studentId: pulseBrainLabSessionAttendanceTable.studentId,
      status: pulseBrainLabSessionAttendanceTable.status,
    })
    .from(pulseBrainLabSessionAttendanceTable)
    .where(
      and(
        eq(pulseBrainLabSessionAttendanceTable.sessionId, sessionId),
        eq(pulseBrainLabSessionAttendanceTable.schoolId, schoolId),
      ),
    );
  const statusByStudent = new Map(attRows.map((r) => [r.studentId, r.status]));
  return {
    id: session.id,
    groupId: session.groupId,
    lessonKey: session.lessonKey,
    lessonTitle: lessonTitle(session.lessonKey),
    sessionDate: session.sessionDate,
    notes: session.notes ?? null,
    createdAt: session.createdAt.toISOString(),
    attendance: members.map((m) => ({
      studentId: m.studentId,
      localSisId: m.localSisId ?? null,
      firstName: m.firstName,
      lastName: m.lastName,
      // Unmarked members default to "present" — the contract has no
      // "unmarked" state and present is the common case at view time.
      status: (statusByStudent.get(m.studentId) ?? "present") as
        | "present"
        | "absent"
        | "excused",
    })),
  };
}

// GET /api/pulse-brain-lab/groups — groups for the active school.
router.get("/pulse-brain-lab/groups", async (req, res) => {
  const staff = await loadCoreTeamStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const groups = await db
    .select()
    .from(pulseBrainLabGroupsTable)
    .where(eq(pulseBrainLabGroupsTable.schoolId, schoolId));
  const memberRows = await db
    .select({ groupId: pulseBrainLabGroupMembersTable.groupId })
    .from(pulseBrainLabGroupMembersTable)
    .where(eq(pulseBrainLabGroupMembersTable.schoolId, schoolId));
  const countByGroup = new Map<number, number>();
  for (const r of memberRows) {
    countByGroup.set(r.groupId, (countByGroup.get(r.groupId) ?? 0) + 1);
  }
  res.json(
    groups.map((g) => ({
      id: g.id,
      name: g.name,
      gradeBand: g.gradeBand,
      schoolYear: g.schoolYear,
      memberCount: countByGroup.get(g.id) ?? 0,
      createdAt: g.createdAt.toISOString(),
    })),
  );
});

// POST /api/pulse-brain-lab/groups — create a group (optionally with members).
router.post("/pulse-brain-lab/groups", async (req, res) => {
  const staff = await loadCoreTeamStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const parsed = CreatePulseBrainLabGroupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid group" });
    return;
  }
  const { name, gradeBand, studentIds } = parsed.data;
  if (!VALID_GRADE_BANDS.has(gradeBand)) {
    res.status(400).json({ error: `Invalid gradeBand "${gradeBand}"` });
    return;
  }
  const trimmed = name.trim();
  if (!trimmed) {
    res.status(400).json({ error: "Group name is required" });
    return;
  }
  const schoolYear = schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ);
  const [group] = await db
    .insert(pulseBrainLabGroupsTable)
    .values({
      schoolId,
      name: trimmed,
      gradeBand,
      schoolYear,
      createdByStaffId: staff.id,
    })
    .returning();
  if (studentIds && studentIds.length > 0) {
    const valid = await filterSchoolStudents(schoolId, studentIds);
    if (valid.length > 0) {
      await db
        .insert(pulseBrainLabGroupMembersTable)
        .values(
          valid.map((studentId) => ({
            schoolId,
            groupId: group.id,
            studentId,
          })),
        )
        .onConflictDoNothing();
    }
  }
  const detail = await loadGroupDetail(schoolId, group.id);
  res.status(201).json(detail);
});

// GET /api/pulse-brain-lab/groups/:groupId — group with members.
router.get("/pulse-brain-lab/groups/:groupId", async (req, res) => {
  const staff = await loadCoreTeamStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const groupId = Number(req.params.groupId);
  if (!Number.isInteger(groupId)) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  const detail = await loadGroupDetail(schoolId, groupId);
  if (!detail) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  res.json(detail);
});

// PATCH /api/pulse-brain-lab/groups/:groupId — rename / restamp school year.
router.patch("/pulse-brain-lab/groups/:groupId", async (req, res) => {
  const staff = await loadCoreTeamStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const groupId = Number(req.params.groupId);
  if (!Number.isInteger(groupId)) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  const parsed = UpdatePulseBrainLabGroupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid update" });
    return;
  }
  const patch: { name?: string; schoolYear?: string } = {};
  if (parsed.data.name !== undefined) {
    const trimmed = parsed.data.name.trim();
    if (!trimmed) {
      res.status(400).json({ error: "Group name is required" });
      return;
    }
    patch.name = trimmed;
  }
  if (parsed.data.schoolYear !== undefined) {
    patch.schoolYear = parsed.data.schoolYear;
  }
  if (Object.keys(patch).length > 0) {
    const updated = await db
      .update(pulseBrainLabGroupsTable)
      .set(patch)
      .where(
        and(
          eq(pulseBrainLabGroupsTable.id, groupId),
          eq(pulseBrainLabGroupsTable.schoolId, schoolId),
        ),
      )
      .returning({ id: pulseBrainLabGroupsTable.id });
    if (updated.length === 0) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
  }
  const detail = await loadGroupDetail(schoolId, groupId);
  if (!detail) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  res.json(detail);
});

// DELETE /api/pulse-brain-lab/groups/:groupId — remove group + members +
// sessions + attendance for that group (school-scoped).
router.delete("/pulse-brain-lab/groups/:groupId", async (req, res) => {
  const staff = await loadCoreTeamStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const groupId = Number(req.params.groupId);
  if (!Number.isInteger(groupId)) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  const deleted = await db
    .delete(pulseBrainLabGroupsTable)
    .where(
      and(
        eq(pulseBrainLabGroupsTable.id, groupId),
        eq(pulseBrainLabGroupsTable.schoolId, schoolId),
      ),
    )
    .returning({ id: pulseBrainLabGroupsTable.id });
  if (deleted.length === 0) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  const sessions = await db
    .select({ id: pulseBrainLabSessionsTable.id })
    .from(pulseBrainLabSessionsTable)
    .where(
      and(
        eq(pulseBrainLabSessionsTable.groupId, groupId),
        eq(pulseBrainLabSessionsTable.schoolId, schoolId),
      ),
    );
  const sessionIds = sessions.map((s) => s.id);
  if (sessionIds.length > 0) {
    await db
      .delete(pulseBrainLabSessionAttendanceTable)
      .where(
        and(
          eq(pulseBrainLabSessionAttendanceTable.schoolId, schoolId),
          inArray(pulseBrainLabSessionAttendanceTable.sessionId, sessionIds),
        ),
      );
  }
  await db
    .delete(pulseBrainLabSessionsTable)
    .where(
      and(
        eq(pulseBrainLabSessionsTable.groupId, groupId),
        eq(pulseBrainLabSessionsTable.schoolId, schoolId),
      ),
    );
  await db
    .delete(pulseBrainLabGroupMembersTable)
    .where(
      and(
        eq(pulseBrainLabGroupMembersTable.groupId, groupId),
        eq(pulseBrainLabGroupMembersTable.schoolId, schoolId),
      ),
    );
  res.status(204).end();
});

// POST /api/pulse-brain-lab/groups/:groupId/members — add members.
router.post("/pulse-brain-lab/groups/:groupId/members", async (req, res) => {
  const staff = await loadCoreTeamStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const groupId = Number(req.params.groupId);
  if (!Number.isInteger(groupId)) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  const parsed = AddPulseBrainLabGroupMembersBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid members" });
    return;
  }
  const [group] = await db
    .select({ id: pulseBrainLabGroupsTable.id })
    .from(pulseBrainLabGroupsTable)
    .where(
      and(
        eq(pulseBrainLabGroupsTable.id, groupId),
        eq(pulseBrainLabGroupsTable.schoolId, schoolId),
      ),
    );
  if (!group) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  const valid = await filterSchoolStudents(schoolId, parsed.data.studentIds);
  if (valid.length > 0) {
    await db
      .insert(pulseBrainLabGroupMembersTable)
      .values(
        valid.map((studentId) => ({ schoolId, groupId, studentId })),
      )
      .onConflictDoNothing();
  }
  const detail = await loadGroupDetail(schoolId, groupId);
  res.json(detail);
});

// DELETE /api/pulse-brain-lab/groups/:groupId/members/:studentId — remove one.
router.delete(
  "/pulse-brain-lab/groups/:groupId/members/:studentId",
  async (req, res) => {
    const staff = await loadCoreTeamStaff(req, res);
    if (!staff) return;
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const groupId = Number(req.params.groupId);
    if (!Number.isInteger(groupId)) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    const detailBefore = await loadGroupDetail(schoolId, groupId);
    if (!detailBefore) {
      res.status(404).json({ error: "Group not found" });
      return;
    }
    await db
      .delete(pulseBrainLabGroupMembersTable)
      .where(
        and(
          eq(pulseBrainLabGroupMembersTable.groupId, groupId),
          eq(pulseBrainLabGroupMembersTable.schoolId, schoolId),
          eq(pulseBrainLabGroupMembersTable.studentId, req.params.studentId),
        ),
      );
    const detail = await loadGroupDetail(schoolId, groupId);
    res.json(detail);
  },
);

// GET /api/pulse-brain-lab/groups/:groupId/sessions — sessions for a group.
router.get("/pulse-brain-lab/groups/:groupId/sessions", async (req, res) => {
  const staff = await loadCoreTeamStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const groupId = Number(req.params.groupId);
  if (!Number.isInteger(groupId)) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  const [group] = await db
    .select({ id: pulseBrainLabGroupsTable.id })
    .from(pulseBrainLabGroupsTable)
    .where(
      and(
        eq(pulseBrainLabGroupsTable.id, groupId),
        eq(pulseBrainLabGroupsTable.schoolId, schoolId),
      ),
    );
  if (!group) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  const sessions = await db
    .select()
    .from(pulseBrainLabSessionsTable)
    .where(
      and(
        eq(pulseBrainLabSessionsTable.groupId, groupId),
        eq(pulseBrainLabSessionsTable.schoolId, schoolId),
      ),
    );
  res.json(
    sessions.map((s) => ({
      id: s.id,
      groupId: s.groupId,
      lessonKey: s.lessonKey,
      lessonTitle: lessonTitle(s.lessonKey),
      sessionDate: s.sessionDate,
      notes: s.notes ?? null,
      createdAt: s.createdAt.toISOString(),
    })),
  );
});

// POST /api/pulse-brain-lab/groups/:groupId/sessions — deliver a lesson.
router.post("/pulse-brain-lab/groups/:groupId/sessions", async (req, res) => {
  const staff = await loadCoreTeamStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const groupId = Number(req.params.groupId);
  if (!Number.isInteger(groupId)) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  const parsed = CreatePulseBrainLabSessionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid session" });
    return;
  }
  const { lessonKey, sessionDate, notes } = parsed.data;
  if (!DATE_RE.test(sessionDate)) {
    res.status(400).json({ error: "sessionDate must be YYYY-MM-DD" });
    return;
  }
  if (!PULSE_BRAIN_LAB_LESSONS.some((l) => l.id === lessonKey)) {
    res.status(400).json({ error: `Unknown lessonKey "${lessonKey}"` });
    return;
  }
  const [group] = await db
    .select({ id: pulseBrainLabGroupsTable.id })
    .from(pulseBrainLabGroupsTable)
    .where(
      and(
        eq(pulseBrainLabGroupsTable.id, groupId),
        eq(pulseBrainLabGroupsTable.schoolId, schoolId),
      ),
    );
  if (!group) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  const [session] = await db
    .insert(pulseBrainLabSessionsTable)
    .values({
      schoolId,
      groupId,
      lessonKey,
      sessionDate,
      notes: notes?.trim() ? notes.trim() : null,
      createdByStaffId: staff.id,
    })
    .returning();
  const detail = await loadSessionDetail(schoolId, session.id);
  res.status(201).json(detail);
});

// GET /api/pulse-brain-lab/sessions/:sessionId — session with attendance.
router.get("/pulse-brain-lab/sessions/:sessionId", async (req, res) => {
  const staff = await loadCoreTeamStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const sessionId = Number(req.params.sessionId);
  if (!Number.isInteger(sessionId)) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const detail = await loadSessionDetail(schoolId, sessionId);
  if (!detail) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json(detail);
});

// DELETE /api/pulse-brain-lab/sessions/:sessionId — remove a session.
router.delete("/pulse-brain-lab/sessions/:sessionId", async (req, res) => {
  const staff = await loadCoreTeamStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const sessionId = Number(req.params.sessionId);
  if (!Number.isInteger(sessionId)) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const deleted = await db
    .delete(pulseBrainLabSessionsTable)
    .where(
      and(
        eq(pulseBrainLabSessionsTable.id, sessionId),
        eq(pulseBrainLabSessionsTable.schoolId, schoolId),
      ),
    )
    .returning({ id: pulseBrainLabSessionsTable.id });
  if (deleted.length === 0) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await db
    .delete(pulseBrainLabSessionAttendanceTable)
    .where(
      and(
        eq(pulseBrainLabSessionAttendanceTable.sessionId, sessionId),
        eq(pulseBrainLabSessionAttendanceTable.schoolId, schoolId),
      ),
    );
  res.status(204).end();
});

// PUT /api/pulse-brain-lab/sessions/:sessionId/attendance — upsert per-member
// attendance. Only members of the session's group may be marked.
router.put(
  "/pulse-brain-lab/sessions/:sessionId/attendance",
  async (req, res) => {
    const staff = await loadCoreTeamStaff(req, res);
    if (!staff) return;
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const sessionId = Number(req.params.sessionId);
    if (!Number.isInteger(sessionId)) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const parsed = SetPulseBrainLabAttendanceBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid attendance" });
      return;
    }
    const [session] = await db
      .select({ groupId: pulseBrainLabSessionsTable.groupId })
      .from(pulseBrainLabSessionsTable)
      .where(
        and(
          eq(pulseBrainLabSessionsTable.id, sessionId),
          eq(pulseBrainLabSessionsTable.schoolId, schoolId),
        ),
      );
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    // Restrict marks to current group members.
    const members = await db
      .select({ studentId: pulseBrainLabGroupMembersTable.studentId })
      .from(pulseBrainLabGroupMembersTable)
      .where(
        and(
          eq(pulseBrainLabGroupMembersTable.groupId, session.groupId),
          eq(pulseBrainLabGroupMembersTable.schoolId, schoolId),
        ),
      );
    const memberSet = new Set(members.map((m) => m.studentId));
    for (const entry of parsed.data.entries) {
      if (!memberSet.has(entry.studentId)) continue;
      await db
        .insert(pulseBrainLabSessionAttendanceTable)
        .values({
          schoolId,
          sessionId,
          studentId: entry.studentId,
          status: entry.status,
        })
        .onConflictDoUpdate({
          target: [
            pulseBrainLabSessionAttendanceTable.sessionId,
            pulseBrainLabSessionAttendanceTable.studentId,
          ],
          set: { status: entry.status },
        });
    }
    const detail = await loadSessionDetail(schoolId, sessionId);
    res.json(detail);
  },
);

// ---------------------------------------------------------------------------
// Derived lesson outputs (T003): facilitation PDF, parent recall card payload,
// and per-(student,session) worksheet PDF carrying an opaque QR token.
// ---------------------------------------------------------------------------

function findLesson(lessonKey: string) {
  return PULSE_BRAIN_LAB_LESSONS.find((l) => l.id === lessonKey) ?? null;
}

// Short, human-typeable session code for the worksheet's manual-routing
// fallback. The QR carries the opaque token; this code + local_sis_id let staff
// file a sheet by hand if the QR won't scan. NEVER derived from the FLEID.
function shortSessionCode(sessionId: number): string {
  return `S${sessionId}`;
}

// Idempotent per (session, student): reprinting a worksheet reuses the same
// opaque token. Race-safe — a concurrent insert hitting the unique index falls
// back to re-selecting the winner's token.
async function mintWorksheetToken(
  schoolId: number,
  sessionId: number,
  studentId: string,
): Promise<string> {
  const [existing] = await db
    .select({ token: pulseBrainLabWorksheetTokensTable.token })
    .from(pulseBrainLabWorksheetTokensTable)
    .where(
      and(
        eq(pulseBrainLabWorksheetTokensTable.schoolId, schoolId),
        eq(pulseBrainLabWorksheetTokensTable.sessionId, sessionId),
        eq(pulseBrainLabWorksheetTokensTable.studentId, studentId),
      ),
    );
  if (existing) return existing.token;
  const token = genUrlSafeToken(24);
  try {
    await db.insert(pulseBrainLabWorksheetTokensTable).values({
      schoolId,
      sessionId,
      studentId,
      token,
    });
    return token;
  } catch {
    const [row] = await db
      .select({ token: pulseBrainLabWorksheetTokensTable.token })
      .from(pulseBrainLabWorksheetTokensTable)
      .where(
        and(
          eq(pulseBrainLabWorksheetTokensTable.schoolId, schoolId),
          eq(pulseBrainLabWorksheetTokensTable.sessionId, sessionId),
          eq(pulseBrainLabWorksheetTokensTable.studentId, studentId),
        ),
      );
    if (row) return row.token;
    throw new Error("Failed to mint worksheet token");
  }
}

function parseLang(value: unknown): WorksheetLanguage {
  return value === "es" ? "es" : "en";
}

// GET /api/pulse-brain-lab/lessons/:lessonKey/facilitation.pdf
// Interventionist facilitation guide (staff-facing, English-only by design).
router.get(
  "/pulse-brain-lab/lessons/:lessonKey/facilitation.pdf",
  async (req, res) => {
    const staff = await loadCoreTeamStaff(req, res);
    if (!staff) return;
    const lesson = findLesson(req.params.lessonKey);
    if (!lesson) {
      res.status(404).json({ error: "Lesson not found" });
      return;
    }
    const buf = await renderPulseBrainLabFacilitationPdf(lesson);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${lesson.id}-facilitation.pdf"`,
    );
    res.send(buf);
  },
);

// GET /api/pulse-brain-lab/lessons/:lessonKey/parent-card/:lang
// The four-part "Reinforce at Home" recall card, resolved to one language.
router.get(
  "/pulse-brain-lab/lessons/:lessonKey/parent-card/:lang",
  async (req, res) => {
    const staff = await loadCoreTeamStaff(req, res);
    if (!staff) return;
    const lesson = findLesson(req.params.lessonKey);
    if (!lesson) {
      res.status(404).json({ error: "Lesson not found" });
      return;
    }
    const lang = parseLang(req.params.lang);
    const pr = lesson.parentReinforcement;
    res.json({
      lessonKey: lesson.id,
      lessonTitle: lesson.title,
      skillArea: lesson.skillArea,
      brainIdea: pr.brainIdea,
      language: lang,
      summary: pr.summary[lang],
      askYourChild: pr.askYourChild.map((q) => q[lang]),
      whyThisWorks: pr.whyThisWorks[lang],
      tryTogether: pr.tryTogether[lang],
    });
  },
);

// Assemble the worksheet-PDF input from a session. When `onlyStudentId` is set,
// renders one student (single reprint); otherwise the whole current roster
// (batch copier print). Returns a discriminated result for clean 404 mapping.
async function buildWorksheetInput(
  schoolId: number,
  sessionId: number,
  lang: WorksheetLanguage,
  onlyStudentId?: string,
): Promise<
  | { ok: true; input: Parameters<typeof renderPulseBrainLabWorksheetPdf>[0] }
  | { ok: false; status: number; error: string }
> {
  const detail = await loadSessionDetail(schoolId, sessionId);
  if (!detail) return { ok: false, status: 404, error: "Session not found" };
  const lesson = findLesson(detail.lessonKey);
  if (!lesson) return { ok: false, status: 404, error: "Lesson not found" };

  let roster = detail.attendance;
  if (onlyStudentId) {
    roster = roster.filter((m) => m.studentId === onlyStudentId);
    if (roster.length === 0) {
      return { ok: false, status: 404, error: "Student not in this group" };
    }
  }
  if (roster.length === 0) {
    return { ok: false, status: 400, error: "Group has no members" };
  }

  const [group] = await db
    .select({ name: pulseBrainLabGroupsTable.name })
    .from(pulseBrainLabGroupsTable)
    .where(
      and(
        eq(pulseBrainLabGroupsTable.id, detail.groupId),
        eq(pulseBrainLabGroupsTable.schoolId, schoolId),
      ),
    );

  const students: WorksheetStudent[] = [];
  for (const m of roster) {
    const token = await mintWorksheetToken(schoolId, sessionId, m.studentId);
    students.push({
      token,
      localSisId: m.localSisId ?? null,
      firstName: m.firstName,
      lastName: m.lastName,
    });
  }

  return {
    ok: true,
    input: {
      lesson,
      language: lang,
      sessionCode: shortSessionCode(sessionId),
      sessionDateLabel: detail.sessionDate,
      groupName: group?.name ?? "PulseBrainLab Group",
      students,
    },
  };
}

// GET /api/pulse-brain-lab/sessions/:sessionId/students/:studentId/worksheet.pdf?lang=
// Single personalized worksheet (reprint / make-up).
router.get(
  "/pulse-brain-lab/sessions/:sessionId/students/:studentId/worksheet.pdf",
  async (req, res) => {
    const staff = await loadCoreTeamStaff(req, res);
    if (!staff) return;
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const sessionId = Number(req.params.sessionId);
    if (!Number.isInteger(sessionId)) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }
    const built = await buildWorksheetInput(
      schoolId,
      sessionId,
      parseLang(req.query.lang),
      req.params.studentId,
    );
    if (!built.ok) {
      res.status(built.status).json({ error: built.error });
      return;
    }
    const buf = await renderPulseBrainLabWorksheetPdf(built.input);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="worksheet-${shortSessionCode(sessionId)}.pdf"`,
    );
    res.send(buf);
  },
);

// GET /api/pulse-brain-lab/sessions/:sessionId/worksheets.pdf?lang=
// Whole-group batch print — one personalized page per member (T004 copier batch).
router.get(
  "/pulse-brain-lab/sessions/:sessionId/worksheets.pdf",
  async (req, res) => {
    const staff = await loadCoreTeamStaff(req, res);
    if (!staff) return;
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const sessionId = Number(req.params.sessionId);
    if (!Number.isInteger(sessionId)) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }
    const built = await buildWorksheetInput(
      schoolId,
      sessionId,
      parseLang(req.query.lang),
    );
    if (!built.ok) {
      res.status(built.status).json({ error: built.error });
      return;
    }
    const buf = await renderPulseBrainLabWorksheetPdf(built.input);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="worksheets-${shortSessionCode(sessionId)}.pdf"`,
    );
    res.send(buf);
  },
);

// ---------------------------------------------------------------------------
// T005 — Evidence capture (work-sample scans)
//
// One ROUTING BRAIN, two intake paths that DECODE IN DIFFERENT PLACES:
//   - PHONE path → /scan/route: the browser decodes the opaque base62 QR token
//     with a live camera and POSTs the token + uploaded object path here.
//   - COPIER path → /scan/batch: the BS uploads ONE multi-page scanned PDF and
//     the SERVER decodes each page (see lib/scanDecode.ts).
// Either way the server is the source of truth for token → (school, session,
// student): it resolves the token SCHOOL-SCOPED, binds the object to the school,
// and files the work sample. Pages whose QR won't decode are parked in the
// per-school "Unmatched" tray for one-tap manual assignment. Nothing here is
// family-visible — `shared` defaults false until a BS flips it in T006.
// ---------------------------------------------------------------------------

type WorkSampleApi = {
  id: number;
  sessionId: number;
  studentId: string;
  localSisId: string | null;
  firstName: string | null;
  lastName: string | null;
  objectKey: string;
  pageIndex: number | null;
  source: string;
  shared: boolean;
  createdAt: string;
};

// Executor that works for both the module-level `db` and a transaction handle,
// so the same loader serves the non-tx list routes and the atomic assign tx.
type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Load work samples (with student display fields JOINed school-scoped) for the
// given filter. The student JOIN pairs student_id WITH school_id because the
// FLEID is NOT globally unique — joining on student_id alone could resolve to
// another tenant's name/local SIS id.
async function loadWorkSamplesTx(
  exec: DbExecutor,
  schoolId: number,
  extraWhere: ReturnType<typeof eq>,
): Promise<WorkSampleApi[]> {
  const rows = await exec
    .select({
      id: pulseBrainLabWorkSamplesTable.id,
      sessionId: pulseBrainLabWorkSamplesTable.sessionId,
      studentId: pulseBrainLabWorkSamplesTable.studentId,
      objectKey: pulseBrainLabWorkSamplesTable.objectKey,
      pageIndex: pulseBrainLabWorkSamplesTable.pageIndex,
      source: pulseBrainLabWorkSamplesTable.source,
      shared: pulseBrainLabWorkSamplesTable.shared,
      createdAt: pulseBrainLabWorkSamplesTable.createdAt,
      localSisId: studentsTable.localSisId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
    })
    .from(pulseBrainLabWorkSamplesTable)
    .leftJoin(
      studentsTable,
      and(
        eq(studentsTable.studentId, pulseBrainLabWorkSamplesTable.studentId),
        eq(studentsTable.schoolId, schoolId),
      ),
    )
    .where(
      and(eq(pulseBrainLabWorkSamplesTable.schoolId, schoolId), extraWhere),
    );
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.sessionId,
    studentId: r.studentId,
    localSisId: r.localSisId ?? null,
    firstName: r.firstName ?? null,
    lastName: r.lastName ?? null,
    objectKey: r.objectKey,
    pageIndex: r.pageIndex ?? null,
    source: r.source,
    shared: r.shared,
    createdAt: r.createdAt.toISOString(),
  }));
}

// Non-tx convenience wrapper over the module-level `db`.
function loadWorkSamples(
  schoolId: number,
  extraWhere: ReturnType<typeof eq>,
): Promise<WorkSampleApi[]> {
  return loadWorkSamplesTx(db, schoolId, extraWhere);
}

function unmatchedScanApi(row: typeof pulseBrainLabUnmatchedScansTable.$inferSelect) {
  return {
    id: row.id,
    objectKey: row.objectKey,
    source: row.source,
    batchLabel: row.batchLabel ?? null,
    pageIndex: row.pageIndex ?? null,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

// File one work sample to (session, student) and return the API shape. Assumes
// the object has already been bound to the school. `source` is the intake path.
async function fileWorkSample(opts: {
  schoolId: number;
  sessionId: number;
  studentId: string;
  objectKey: string;
  pageIndex: number | null;
  source: string;
  staffId: number;
}): Promise<WorkSampleApi> {
  const [inserted] = await db
    .insert(pulseBrainLabWorkSamplesTable)
    .values({
      schoolId: opts.schoolId,
      sessionId: opts.sessionId,
      studentId: opts.studentId,
      objectKey: opts.objectKey,
      pageIndex: opts.pageIndex,
      source: opts.source,
      createdByStaffId: opts.staffId,
    })
    .returning({ id: pulseBrainLabWorkSamplesTable.id });
  const [row] = await loadWorkSamples(
    opts.schoolId,
    eq(pulseBrainLabWorkSamplesTable.id, inserted.id),
  );
  return row;
}

// POST /api/pulse-brain-lab/scan/route — the routing brain. Resolve the opaque
// token school-scoped → (session, student), bind the upload, file the sample.
router.post("/pulse-brain-lab/scan/route", async (req, res) => {
  const staff = await loadCoreTeamStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const parsed = RoutePulseBrainLabScanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid scan payload" });
    return;
  }
  const { token, objectPath, source } = parsed.data;
  const pageIndex =
    typeof parsed.data.pageIndex === "number" ? parsed.data.pageIndex : null;

  // Resolve the token SCHOOL-SCOPED — a token from another tenant must 404 here.
  const [tok] = await db
    .select({
      sessionId: pulseBrainLabWorksheetTokensTable.sessionId,
      studentId: pulseBrainLabWorksheetTokensTable.studentId,
    })
    .from(pulseBrainLabWorksheetTokensTable)
    .where(
      and(
        eq(pulseBrainLabWorksheetTokensTable.token, token),
        eq(pulseBrainLabWorksheetTokensTable.schoolId, schoolId),
      ),
    );
  if (!tok) {
    res.status(404).json({ error: "Worksheet code not found for this school" });
    return;
  }

  const bound = await bindObjectToSchool(objectPath, schoolId);
  if (!bound) {
    res.status(403).json({ error: "Upload not authorized for this school" });
    return;
  }

  const sample = await fileWorkSample({
    schoolId,
    sessionId: tok.sessionId,
    studentId: tok.studentId,
    objectKey: objectPath,
    pageIndex,
    source,
    staffId: staff.id,
  });
  res.status(201).json(sample);
});

// POST /api/pulse-brain-lab/scan/batch — the COPIER-BATCH routing brain. The BS
// scans the whole completed stack at the office MFP into ONE multi-page PDF and
// uploads it; the server rasterizes each page, decodes its QR SERVER-SIDE, and
// fans each page out to the right (session, student). Pages whose QR won't read
// fall to the Unmatched tray for one-tap manual assignment.
//
// The single uploaded PDF object is shared by every filed page; each work sample
// records its own `pageIndex` so the evidence packet can extract the right page.
router.post("/pulse-brain-lab/scan/batch", async (req, res) => {
  const staff = await loadCoreTeamStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const parsed = BatchPulseBrainLabScanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid batch payload" });
    return;
  }
  const { objectPath } = parsed.data;
  const batchLabel =
    typeof parsed.data.batchLabel === "string" ? parsed.data.batchLabel : null;

  // Bind the upload to THIS school before reading a single byte — refuses an
  // object that belongs to another tenant or was never issued to us (403).
  const bound = await bindObjectToSchool(objectPath, schoolId);
  if (!bound) {
    res.status(403).json({ error: "Upload not authorized for this school" });
    return;
  }

  const pdfBytes = await readStoredObject(objectPath);
  if (!pdfBytes) {
    res.status(404).json({ error: "Uploaded file not found" });
    return;
  }

  let pages: Awaited<ReturnType<typeof decodeWorksheetPdf>>;
  try {
    pages = await decodeWorksheetPdf(pdfBytes);
  } catch (err) {
    req.log.error({ err }, "pulse-brain-lab batch decode failed");
    res.status(422).json({ error: "Could not read the uploaded PDF" });
    return;
  }
  if (pages.length === 0) {
    res.status(422).json({ error: "The uploaded PDF has no pages" });
    return;
  }

  // Resolve every decoded token school-scoped in one query, then file matched
  // pages and park the rest. A token from another tenant simply won't resolve
  // here, so it lands in Unmatched rather than crossing the school boundary.
  const tokens = pages
    .map((p) => p.token)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  const tokenRows = tokens.length
    ? await db
        .select({
          token: pulseBrainLabWorksheetTokensTable.token,
          sessionId: pulseBrainLabWorksheetTokensTable.sessionId,
          studentId: pulseBrainLabWorksheetTokensTable.studentId,
        })
        .from(pulseBrainLabWorksheetTokensTable)
        .where(
          and(
            eq(pulseBrainLabWorksheetTokensTable.schoolId, schoolId),
            inArray(pulseBrainLabWorksheetTokensTable.token, tokens),
          ),
        )
    : [];
  const tokenMap = new Map(tokenRows.map((r) => [r.token, r]));

  const matched: WorkSampleApi[] = [];
  const unmatched: ReturnType<typeof unmatchedScanApi>[] = [];
  for (const page of pages) {
    const tok = page.token ? tokenMap.get(page.token) : undefined;
    if (tok) {
      const sample = await fileWorkSample({
        schoolId,
        sessionId: tok.sessionId,
        studentId: tok.studentId,
        objectKey: objectPath,
        pageIndex: page.pageIndex,
        source: "batch",
        staffId: staff.id,
      });
      matched.push(sample);
    } else {
      const [inserted] = await db
        .insert(pulseBrainLabUnmatchedScansTable)
        .values({
          schoolId,
          objectKey: objectPath,
          source: "batch",
          batchLabel,
          pageIndex: page.pageIndex,
          createdByStaffId: staff.id,
        })
        .returning();
      unmatched.push(unmatchedScanApi(inserted));
    }
  }

  res.status(201).json({
    pageCount: pages.length,
    matchedCount: matched.length,
    unmatchedCount: unmatched.length,
    matched,
    unmatched,
  });
});

// POST /api/pulse-brain-lab/scan/unmatched — park a page whose QR won't decode.
router.post("/pulse-brain-lab/scan/unmatched", async (req, res) => {
  const staff = await loadCoreTeamStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const parsed = FilePulseBrainLabUnmatchedScanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid scan payload" });
    return;
  }
  const { objectPath, source } = parsed.data;
  const batchLabel =
    typeof parsed.data.batchLabel === "string" ? parsed.data.batchLabel : null;
  const pageIndex =
    typeof parsed.data.pageIndex === "number" ? parsed.data.pageIndex : null;

  const bound = await bindObjectToSchool(objectPath, schoolId);
  if (!bound) {
    res.status(403).json({ error: "Upload not authorized for this school" });
    return;
  }

  const [inserted] = await db
    .insert(pulseBrainLabUnmatchedScansTable)
    .values({
      schoolId,
      objectKey: objectPath,
      source,
      batchLabel,
      pageIndex,
      createdByStaffId: staff.id,
    })
    .returning();
  res.status(201).json(unmatchedScanApi(inserted));
});

// GET /api/pulse-brain-lab/scan/unmatched — the pending tray for this school.
router.get("/pulse-brain-lab/scan/unmatched", async (req, res) => {
  const staff = await loadCoreTeamStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const rows = await db
    .select()
    .from(pulseBrainLabUnmatchedScansTable)
    .where(
      and(
        eq(pulseBrainLabUnmatchedScansTable.schoolId, schoolId),
        eq(pulseBrainLabUnmatchedScansTable.status, "pending"),
      ),
    );
  res.json(rows.map(unmatchedScanApi));
});

// POST /api/pulse-brain-lab/scan/unmatched/:scanId/assign — promote a parked
// scan to a work sample on a manually-chosen (session, student).
router.post(
  "/pulse-brain-lab/scan/unmatched/:scanId/assign",
  async (req, res) => {
    const staff = await loadCoreTeamStaff(req, res);
    if (!staff) return;
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const scanId = Number(req.params.scanId);
    if (!Number.isInteger(scanId)) {
      res.status(400).json({ error: "Invalid scan id" });
      return;
    }
    const parsed = AssignPulseBrainLabUnmatchedScanBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid assignment payload" });
      return;
    }
    const { sessionId, studentId } = parsed.data;

    // The target session and student must both belong to this school.
    const session = await loadSessionDetail(schoolId, sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const okStudents = await filterSchoolStudents(schoolId, [studentId]);
    if (okStudents.length === 0) {
      res.status(404).json({ error: "Student not found" });
      return;
    }

    // Atomically CLAIM the pending scan and file the sample in one transaction.
    // The guarded UPDATE (... AND status='pending' RETURNING) is the sole
    // concurrency gate: a second concurrent assign/discard finds no pending row
    // and gets 404, so we never double-file or leave a half-assigned scan.
    let sample: WorkSampleApi | null = null;
    await db.transaction(async (tx) => {
      const claimed = await tx
        .update(pulseBrainLabUnmatchedScansTable)
        .set({ status: "assigned", resolvedAt: new Date() })
        .where(
          and(
            eq(pulseBrainLabUnmatchedScansTable.id, scanId),
            eq(pulseBrainLabUnmatchedScansTable.schoolId, schoolId),
            eq(pulseBrainLabUnmatchedScansTable.status, "pending"),
          ),
        )
        .returning({
          objectKey: pulseBrainLabUnmatchedScansTable.objectKey,
          pageIndex: pulseBrainLabUnmatchedScansTable.pageIndex,
        });
      if (claimed.length === 0) return; // not pending / not found
      const [scan] = claimed;
      const [inserted] = await tx
        .insert(pulseBrainLabWorkSamplesTable)
        .values({
          schoolId,
          sessionId,
          studentId,
          objectKey: scan.objectKey,
          pageIndex: scan.pageIndex,
          source: "manual",
          createdByStaffId: staff.id,
        })
        .returning({ id: pulseBrainLabWorkSamplesTable.id });
      const [row] = await loadWorkSamplesTx(
        tx,
        schoolId,
        eq(pulseBrainLabWorkSamplesTable.id, inserted.id),
      );
      sample = row;
    });
    if (!sample) {
      res.status(404).json({ error: "Unmatched scan not found" });
      return;
    }
    res.status(201).json(sample);
  },
);

// POST /api/pulse-brain-lab/scan/unmatched/:scanId/discard — drop from the tray.
router.post(
  "/pulse-brain-lab/scan/unmatched/:scanId/discard",
  async (req, res) => {
    const staff = await loadCoreTeamStaff(req, res);
    if (!staff) return;
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const scanId = Number(req.params.scanId);
    if (!Number.isInteger(scanId)) {
      res.status(400).json({ error: "Invalid scan id" });
      return;
    }
    const updated = await db
      .update(pulseBrainLabUnmatchedScansTable)
      .set({ status: "discarded", resolvedAt: new Date() })
      .where(
        and(
          eq(pulseBrainLabUnmatchedScansTable.id, scanId),
          eq(pulseBrainLabUnmatchedScansTable.schoolId, schoolId),
          eq(pulseBrainLabUnmatchedScansTable.status, "pending"),
        ),
      )
      .returning({ id: pulseBrainLabUnmatchedScansTable.id });
    if (updated.length === 0) {
      res.status(404).json({ error: "Unmatched scan not found" });
      return;
    }
    res.status(204).end();
  },
);

// GET /api/pulse-brain-lab/sessions/:sessionId/work-samples — filed samples.
router.get(
  "/pulse-brain-lab/sessions/:sessionId/work-samples",
  async (req, res) => {
    const staff = await loadCoreTeamStaff(req, res);
    if (!staff) return;
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const sessionId = Number(req.params.sessionId);
    if (!Number.isInteger(sessionId)) {
      res.status(400).json({ error: "Invalid session id" });
      return;
    }
    const session = await loadSessionDetail(schoolId, sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const samples = await loadWorkSamples(
      schoolId,
      eq(pulseBrainLabWorkSamplesTable.sessionId, sessionId),
    );
    res.json(samples);
  },
);

// DELETE /api/pulse-brain-lab/work-samples/:sampleId — remove a filed sample.
router.delete("/pulse-brain-lab/work-samples/:sampleId", async (req, res) => {
  const staff = await loadCoreTeamStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const sampleId = Number(req.params.sampleId);
  if (!Number.isInteger(sampleId)) {
    res.status(400).json({ error: "Invalid sample id" });
    return;
  }
  const deleted = await db
    .delete(pulseBrainLabWorkSamplesTable)
    .where(
      and(
        eq(pulseBrainLabWorkSamplesTable.id, sampleId),
        eq(pulseBrainLabWorkSamplesTable.schoolId, schoolId),
      ),
    )
    .returning({ id: pulseBrainLabWorkSamplesTable.id });
  if (deleted.length === 0) {
    res.status(404).json({ error: "Work sample not found" });
    return;
  }
  res.status(204).end();
});

// PATCH /api/pulse-brain-lab/work-samples/:sampleId/share — toggle whether a
// filed work sample is visible to the family on the "Reinforce at Home" card.
// The share flag is the SINGLE gate that exposes a delivered lesson to the home.
router.patch(
  "/pulse-brain-lab/work-samples/:sampleId/share",
  async (req, res) => {
    const staff = await loadCoreTeamStaff(req, res);
    if (!staff) return;
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const sampleId = Number(req.params.sampleId);
    if (!Number.isInteger(sampleId)) {
      res.status(400).json({ error: "Invalid sample id" });
      return;
    }
    const parsed = SetPulseBrainLabWorkSampleShareBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const updated = await db
      .update(pulseBrainLabWorkSamplesTable)
      .set({ shared: parsed.data.shared })
      .where(
        and(
          eq(pulseBrainLabWorkSamplesTable.id, sampleId),
          eq(pulseBrainLabWorkSamplesTable.schoolId, schoolId),
        ),
      )
      .returning({ id: pulseBrainLabWorkSamplesTable.id });
    if (updated.length === 0) {
      res.status(404).json({ error: "Work sample not found" });
      return;
    }
    const [sample] = await loadWorkSamples(
      schoolId,
      eq(pulseBrainLabWorkSamplesTable.id, sampleId),
    );
    res.json(sample);
  },
);

// GET /api/pulse-brain-lab/students/:studentId/home-cards — the staff preview of
// exactly what a family sees on the "Reinforce at Home" surface for one student.
// :studentId is the canonical student_id (FLEID FK) — never rendered; the cards
// carry localSisId for display.
router.get(
  "/pulse-brain-lab/students/:studentId/home-cards",
  async (req, res) => {
    const staff = await loadCoreTeamStaff(req, res);
    if (!staff) return;
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const studentId = String(req.params.studentId);
    if (!studentId) {
      res.status(400).json({ error: "Invalid student id" });
      return;
    }
    const cards = await buildHomeCards(schoolId, studentId);
    res.json(cards);
  },
);

// GET /api/pulse-brain-lab/students/:studentId/packet.pdf?lessonKey=&lang= — the
// downloadable evidence packet: the bilingual recall card + the child's shared
// work sample image + any Home Follow-Up the family recorded for that lesson.
router.get(
  "/pulse-brain-lab/students/:studentId/packet.pdf",
  async (req, res) => {
    const staff = await loadCoreTeamStaff(req, res);
    if (!staff) return;
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const studentId = String(req.params.studentId);
    const lessonKey = String(req.query.lessonKey ?? "");
    if (!studentId || !lessonKey) {
      res.status(400).json({ error: "Missing studentId or lessonKey" });
      return;
    }
    const lang = parseLang(req.query.lang);
    const cards = await buildHomeCards(schoolId, studentId);
    const card = cards.find((c) => c.lessonKey === lessonKey);
    if (!card) {
      res.status(404).json({ error: "No shared evidence for that lesson" });
      return;
    }
    const pdf = await buildPacketPdf(card, lang);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="reinforce-at-home-${lessonKey}.pdf"`,
    );
    res.end(pdf);
  },
);

// Shared packet builder used by both the staff route above and the parent route.
// Resolves each shared sample's stored object to image bytes when it is a phone
// photo (PNG/JPEG magic bytes); scanned-PDF samples render as an on-file note.
export async function buildPacketPdf(
  card: Awaited<ReturnType<typeof buildHomeCards>>[number],
  lang: WorksheetLanguage,
): Promise<Buffer> {
  const sampleImages: PacketWorkSampleImage[] = [];
  for (const s of card.workSamples) {
    let imageBytes: Buffer | null = null;
    try {
      const buf = await readStoredObject(s.objectKey);
      if (buf && isEmbeddableImage(buf)) imageBytes = buf;
    } catch {
      imageBytes = null;
    }
    sampleImages.push({
      imageBytes,
      source: s.source,
      createdAtLabel: s.createdAt.slice(0, 10),
    });
  }
  const first = card.workSamples[0];
  const studentName = first
    ? [first.firstName, first.lastName].filter(Boolean).join(" ").trim()
    : "";
  const localSisId = first?.localSisId ?? null;
  return renderPulseBrainLabPacketPdf({
    language: lang,
    lessonTitle: card.lessonTitle,
    skillArea: card.skillArea,
    studentName: studentName || (localSisId ?? ""),
    localSisId,
    sessionDateLabel: card.sessionDate,
    parentReinforcement: card.parentReinforcement,
    workSamples: sampleImages,
    homeResponses: card.homeResponses.map((r) => ({
      promptIndex: r.promptIndex,
      transcript: r.transcript,
    })),
  });
}

// PNG (\x89PNG) or JPEG (\xFF\xD8\xFF) — the formats pdfkit's doc.image accepts.
// Scanned-PDF samples (%PDF) need rasterizing we can't do without a PNG encoder.
function isEmbeddableImage(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  const isPng =
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  return isPng || isJpeg;
}

export default router;
