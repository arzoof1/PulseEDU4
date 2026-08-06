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
  supportMeetingsTable,
  supportMeetingAttendeesTable,
  supportMeetingFeedbackTable,
  supportMeetingEventsTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam } from "../lib/coreTeam.js";
import { sendMeetingReminderEmail } from "../lib/supportMeetingEmail.js";
import { loadScheduleSectionsForStudent } from "../lib/effectiveTeachers.js";

// ---------------------------------------------------------------------------
// Student Support Meetings (v1).
//
// Organizers (Core Team + counselors) schedule support meetings (504 / IEP /
// MTSS / parent conference / ...) for a student; the student's schedule
// teachers are auto-added as required attendees. Teachers confirm or decline
// from their Meetings dashboard; declining prompts the structured feedback
// form, which attaches to the meeting for the organizer.
//
// Tenancy: every query carries school_id; acting staff must belong to the
// active school (403 otherwise — mirrors dataChats loadStaff).
// Teachers may only read meetings they are attendees of; feedback is
// visible to organizers/Core Team plus its author.
// ---------------------------------------------------------------------------

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

function canOrganize(staff: StaffRow): boolean {
  return (
    isCoreTeam(staff) || staff.isCounselor || staff.isGuidanceCounselor
  );
}

async function loadStaff(
  req: Request,
  res: Response,
): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  if (!s || !s.active) {
    res.status(401).json({ error: "Staff not found or inactive" });
    return null;
  }
  // Tenant guard: non-SuperUser actors must belong to the active school.
  const schoolId = req.schoolId;
  if (!s.isSuperUser && schoolId != null && s.schoolId !== schoolId) {
    res.status(403).json({ error: "Not authorized for this school" });
    return null;
  }
  return s;
}

function requireStaffMW(check?: (s: StaffRow) => boolean, label = "Staff") {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req, res);
    if (!staff) return;
    if (check && !check(staff)) {
      res.status(403).json({ error: `${label} only` });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

const requireAnyStaff = requireStaffMW();
const requireOrganizer = requireStaffMW(canOrganize, "Meeting organizer");

function getStaff(req: Request): StaffRow {
  return (req as Request & { staff: StaffRow }).staff;
}

const MEETING_TYPES = [
  "504 Initial",
  "504 Annual Review",
  "IEP Initial",
  "IEP Annual Review",
  "IEP Amendment",
  "MTSS Problem-Solving Meeting",
  "Eligibility Meeting",
  "Reevaluation Meeting",
  "Parent Conference",
  "Manifestation Determination",
  "Other",
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

async function logEvent(
  schoolId: number,
  meetingId: number,
  staffId: number,
  action: string,
  detail = "",
): Promise<void> {
  await db.insert(supportMeetingEventsTable).values({
    schoolId,
    meetingId,
    staffId,
    action,
    detail,
  });
}

// Resolve a meeting row scoped to the active school, else 404.
async function loadMeeting(
  schoolId: number,
  id: number,
): Promise<typeof supportMeetingsTable.$inferSelect | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const [m] = await db
    .select()
    .from(supportMeetingsTable)
    .where(
      and(
        eq(supportMeetingsTable.id, id),
        eq(supportMeetingsTable.schoolId, schoolId),
      ),
    );
  return m ?? null;
}

// ---------------------------------------------------------------------------
// GET /support-meetings/meta — meeting types (for the create form).
// ---------------------------------------------------------------------------
router.get("/support-meetings/meta", requireAnyStaff, (req, res) => {
  const staff = getStaff(req);
  res.json({ meetingTypes: MEETING_TYPES, canOrganize: canOrganize(staff) });
});

// ---------------------------------------------------------------------------
// GET /support-meetings/student-context?studentId=
// Grade + schedule teachers for auto-attendee population. Organizer only.
// ---------------------------------------------------------------------------
router.get(
  "/support-meetings/student-context",
  requireOrganizer,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const studentId =
      typeof req.query.studentId === "string" ? req.query.studentId : "";
    if (!studentId) {
      res.status(400).json({ error: "studentId is required" });
      return;
    }
    const [student] = await db
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
          eq(studentsTable.studentId, studentId),
        ),
      );
    if (!student) {
      res.status(404).json({ error: "Student not found" });
      return;
    }
    const sections = await loadScheduleSectionsForStudent(schoolId, studentId);
    const teacherIds = Array.from(new Set(sections.map((s) => s.staffId)));
    const teachers = teacherIds.length
      ? await db
          .select({
            id: staffTable.id,
            displayName: staffTable.displayName,
          })
          .from(staffTable)
          .where(
            and(
              eq(staffTable.schoolId, schoolId),
              inArray(staffTable.id, teacherIds),
              eq(staffTable.active, true),
            ),
          )
      : [];
    const nameById = new Map(teachers.map((t) => [t.id, t.displayName]));
    res.json({
      student,
      scheduleTeachers: teacherIds
        .filter((id) => nameById.has(id))
        .map((id) => ({
          staffId: id,
          displayName: nameById.get(id) ?? "",
          sections: sections
            .filter((s) => s.staffId === id)
            .map((s) => ({ period: s.period, courseName: s.courseName })),
        })),
    });
  },
);

// ---------------------------------------------------------------------------
// GET /support-meetings/staff-options — active staff for the "add attendee"
// picker (organizer only). {id, displayName, department} shape for the
// shared TeacherPicker.
// ---------------------------------------------------------------------------
router.get(
  "/support-meetings/staff-options",
  requireOrganizer,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const rows = await db
      .select({
        id: staffTable.id,
        displayName: staffTable.displayName,
        department: staffTable.department,
      })
      .from(staffTable)
      .where(and(eq(staffTable.schoolId, schoolId), eq(staffTable.active, true)))
      .orderBy(staffTable.displayName);
    res.json({ staff: rows });
  },
);

// ---------------------------------------------------------------------------
// POST /support-meetings — create. Organizer only.
// Body: { meetingType, studentId, date, startTime, endTime?, location?,
//         virtualLink?, notes?, attendeeStaffIds: number[] (manual adds),
//         includeScheduleTeachers?: boolean (default true) }
// ---------------------------------------------------------------------------
router.post("/support-meetings", requireOrganizer, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = getStaff(req);
  const b = (req.body ?? {}) as Record<string, unknown>;

  const meetingType = typeof b.meetingType === "string" ? b.meetingType.trim() : "";
  const studentId = typeof b.studentId === "string" ? b.studentId : "";
  const date = typeof b.date === "string" ? b.date : "";
  const startTime = typeof b.startTime === "string" ? b.startTime : "";
  const endTime = typeof b.endTime === "string" && b.endTime ? b.endTime : null;
  const location = typeof b.location === "string" ? b.location.trim().slice(0, 200) : "";
  const virtualLink = typeof b.virtualLink === "string" ? b.virtualLink.trim().slice(0, 500) : "";
  const notes = typeof b.notes === "string" ? b.notes.trim().slice(0, 5000) : "";
  const includeScheduleTeachers = b.includeScheduleTeachers !== false;
  const manualIds = Array.isArray(b.attendeeStaffIds)
    ? b.attendeeStaffIds.filter(
        (n): n is number => Number.isInteger(n) && (n as number) > 0,
      )
    : [];

  if (!meetingType || meetingType.length > 100) {
    res.status(400).json({ error: "Meeting type is required" });
    return;
  }
  if (!DATE_RE.test(date) || !TIME_RE.test(startTime) || (endTime && !TIME_RE.test(endTime))) {
    res.status(400).json({ error: "Valid date and time are required" });
    return;
  }
  const [student] = await db
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
        eq(studentsTable.studentId, studentId),
      ),
    );
  if (!student) {
    res.status(400).json({ error: "Student not found" });
    return;
  }

  // Attendee set: schedule teachers (flagged fromSchedule) + manual adds.
  const scheduleIds = includeScheduleTeachers
    ? Array.from(
        new Set(
          (await loadScheduleSectionsForStudent(schoolId, studentId)).map(
            (s) => s.staffId,
          ),
        ),
      )
    : [];
  // Validate every attendee id is active staff at this school.
  const allIds = Array.from(new Set([...scheduleIds, ...manualIds]));
  const validRows = allIds.length
    ? await db
        .select({ id: staffTable.id })
        .from(staffTable)
        .where(
          and(
            eq(staffTable.schoolId, schoolId),
            inArray(staffTable.id, allIds),
            eq(staffTable.active, true),
          ),
        )
    : [];
  const valid = new Set(validRows.map((r) => r.id));
  const scheduleSet = new Set(scheduleIds.filter((id) => valid.has(id)));
  const finalIds = allIds.filter((id) => valid.has(id));
  if (finalIds.length === 0) {
    res.status(400).json({ error: "At least one attendee is required" });
    return;
  }

  const created = await db.transaction(async (tx) => {
    const [m] = await tx
      .insert(supportMeetingsTable)
      .values({
        schoolId,
        meetingType,
        studentId: student.studentId,
        studentName: `${student.firstName} ${student.lastName}`,
        grade: student.grade,
        date,
        startTime,
        endTime,
        location,
        virtualLink,
        notes,
        organizerStaffId: staff.id,
        status: "scheduled",
      })
      .returning();
    await tx.insert(supportMeetingAttendeesTable).values(
      finalIds.map((id) => ({
        schoolId,
        meetingId: m.id,
        staffId: id,
        fromSchedule: scheduleSet.has(id),
      })),
    );
    return m;
  });
  await logEvent(schoolId, created.id, staff.id, "created", meetingType);
  res.json({ ok: true, meetingId: created.id });
});

// ---------------------------------------------------------------------------
// GET /support-meetings?scope=mine|manage
// mine   — meetings where I'm an attendee (any staff).
// manage — all school meetings (organizer only).
// ---------------------------------------------------------------------------
router.get("/support-meetings", requireAnyStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = getStaff(req);
  const scope = req.query.scope === "manage" ? "manage" : "mine";
  if (scope === "manage" && !canOrganize(staff)) {
    res.status(403).json({ error: "Meeting organizer only" });
    return;
  }

  let meetingRows: (typeof supportMeetingsTable.$inferSelect)[];
  if (scope === "manage") {
    meetingRows = await db
      .select()
      .from(supportMeetingsTable)
      .where(eq(supportMeetingsTable.schoolId, schoolId));
  } else {
    const myAtt = await db
      .select({ meetingId: supportMeetingAttendeesTable.meetingId })
      .from(supportMeetingAttendeesTable)
      .where(
        and(
          eq(supportMeetingAttendeesTable.schoolId, schoolId),
          eq(supportMeetingAttendeesTable.staffId, staff.id),
        ),
      );
    const ids = myAtt.map((a) => a.meetingId);
    meetingRows = ids.length
      ? await db
          .select()
          .from(supportMeetingsTable)
          .where(
            and(
              eq(supportMeetingsTable.schoolId, schoolId),
              inArray(supportMeetingsTable.id, ids),
            ),
          )
      : [];
  }

  const ids = meetingRows.map((m) => m.id);
  const attendees = ids.length
    ? await db
        .select()
        .from(supportMeetingAttendeesTable)
        .where(
          and(
            eq(supportMeetingAttendeesTable.schoolId, schoolId),
            inArray(supportMeetingAttendeesTable.meetingId, ids),
          ),
        )
    : [];
  const feedback = ids.length
    ? await db
        .select({
          meetingId: supportMeetingFeedbackTable.meetingId,
          staffId: supportMeetingFeedbackTable.staffId,
        })
        .from(supportMeetingFeedbackTable)
        .where(
          and(
            eq(supportMeetingFeedbackTable.schoolId, schoolId),
            inArray(supportMeetingFeedbackTable.meetingId, ids),
          ),
        )
    : [];
  const staffIds = Array.from(
    new Set([
      ...attendees.map((a) => a.staffId),
      ...meetingRows.map((m) => m.organizerStaffId),
    ]),
  );
  const staffRows = staffIds.length
    ? await db
        .select({ id: staffTable.id, displayName: staffTable.displayName })
        .from(staffTable)
        .where(
          and(
            eq(staffTable.schoolId, schoolId),
            inArray(staffTable.id, staffIds),
          ),
        )
    : [];
  const nameById = new Map(staffRows.map((s) => [s.id, s.displayName]));
  const fbSet = new Set(feedback.map((f) => `${f.meetingId}:${f.staffId}`));

  const out = meetingRows
    .map((m) => {
      const att = attendees.filter((a) => a.meetingId === m.id);
      const mine = att.find((a) => a.staffId === staff.id) ?? null;
      return {
        id: m.id,
        meetingType: m.meetingType,
        studentName: m.studentName,
        grade: m.grade,
        date: m.date,
        startTime: m.startTime,
        endTime: m.endTime,
        location: m.location,
        virtualLink: m.virtualLink,
        status: m.status,
        organizerStaffId: m.organizerStaffId,
        organizerName: nameById.get(m.organizerStaffId) ?? "Staff",
        counts: {
          attendees: att.length,
          confirmed: att.filter((a) => a.response === "confirmed").length,
          declined: att.filter((a) => a.response === "declined").length,
          pending: att.filter((a) => a.response === "pending").length,
          feedback: att.filter((a) => fbSet.has(`${m.id}:${a.staffId}`)).length,
        },
        my: mine
          ? {
              response: mine.response,
              feedbackSubmitted: fbSet.has(`${m.id}:${staff.id}`),
            }
          : null,
      };
    })
    .sort((a, b) =>
      a.date === b.date
        ? a.startTime.localeCompare(b.startTime)
        : a.date.localeCompare(b.date),
    );
  res.json({ meetings: out, canOrganize: canOrganize(staff) });
});

// ---------------------------------------------------------------------------
// GET /support-meetings/pending-count — nav badge. Actionable-for-me:
// pending responses + declines missing feedback, on non-canceled upcoming
// (today or later) meetings.
// ---------------------------------------------------------------------------
router.get(
  "/support-meetings/pending-count",
  requireAnyStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const staff = getStaff(req);
    const today = new Date().toISOString().slice(0, 10);
    const [row] = await db
      .select({
        n: sql<number>`COUNT(*)::int`,
      })
      .from(supportMeetingAttendeesTable)
      .innerJoin(
        supportMeetingsTable,
        eq(supportMeetingsTable.id, supportMeetingAttendeesTable.meetingId),
      )
      .where(
        and(
          eq(supportMeetingAttendeesTable.schoolId, schoolId),
          eq(supportMeetingAttendeesTable.staffId, staff.id),
          eq(supportMeetingsTable.status, "scheduled"),
          sql`${supportMeetingsTable.date} >= ${today}`,
          sql`(
            ${supportMeetingAttendeesTable.response} = 'pending'
            OR (
              ${supportMeetingAttendeesTable.response} = 'declined'
              AND NOT EXISTS (
                SELECT 1 FROM support_meeting_feedback f
                WHERE f.school_id = ${schoolId}
                  AND f.meeting_id = ${supportMeetingAttendeesTable.meetingId}
                  AND f.staff_id = ${supportMeetingAttendeesTable.staffId}
              )
            )
          )`,
        ),
      );
    res.json({ count: row?.n ?? 0 });
  },
);

// ---------------------------------------------------------------------------
// GET /support-meetings/:id — detail. Attendee, organizer, or Core Team.
// Feedback bodies: organizers see all; an attendee sees only their own.
// Unauthorized + not-found both 404 (don't leak existence).
// ---------------------------------------------------------------------------
router.get("/support-meetings/:id", requireAnyStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = getStaff(req);
  const m = await loadMeeting(schoolId, Number(req.params.id));
  if (!m) {
    res.status(404).json({ error: "Meeting not found" });
    return;
  }
  const attendees = await db
    .select()
    .from(supportMeetingAttendeesTable)
    .where(
      and(
        eq(supportMeetingAttendeesTable.schoolId, schoolId),
        eq(supportMeetingAttendeesTable.meetingId, m.id),
      ),
    );
  const isAttendee = attendees.some((a) => a.staffId === staff.id);
  const organizerView = canOrganize(staff) || m.organizerStaffId === staff.id;
  if (!isAttendee && !organizerView) {
    res.status(404).json({ error: "Meeting not found" });
    return;
  }
  const feedbackRows = await db
    .select()
    .from(supportMeetingFeedbackTable)
    .where(
      and(
        eq(supportMeetingFeedbackTable.schoolId, schoolId),
        eq(supportMeetingFeedbackTable.meetingId, m.id),
      ),
    );
  const staffIds = Array.from(
    new Set([...attendees.map((a) => a.staffId), m.organizerStaffId]),
  );
  const staffRows = staffIds.length
    ? await db
        .select({ id: staffTable.id, displayName: staffTable.displayName })
        .from(staffTable)
        .where(
          and(
            eq(staffTable.schoolId, schoolId),
            inArray(staffTable.id, staffIds),
          ),
        )
    : [];
  const nameById = new Map(staffRows.map((s) => [s.id, s.displayName]));
  const visibleFeedback = organizerView
    ? feedbackRows
    : feedbackRows.filter((f) => f.staffId === staff.id);
  res.json({
    meeting: {
      id: m.id,
      meetingType: m.meetingType,
      studentId: m.studentId,
      studentName: m.studentName,
      grade: m.grade,
      date: m.date,
      startTime: m.startTime,
      endTime: m.endTime,
      location: m.location,
      virtualLink: m.virtualLink,
      // Staff-only notes are still staff-facing here; hide from
      // non-organizer attendees anyway to keep them organizer-scoped.
      notes: organizerView ? m.notes : "",
      status: m.status,
      organizerStaffId: m.organizerStaffId,
      organizerName: nameById.get(m.organizerStaffId) ?? "Staff",
    },
    attendees: attendees.map((a) => ({
      staffId: a.staffId,
      displayName: nameById.get(a.staffId) ?? "Staff",
      fromSchedule: a.fromSchedule,
      response: a.response,
      respondedAt: a.respondedAt,
      remindedAt: a.remindedAt,
      feedbackSubmitted: feedbackRows.some((f) => f.staffId === a.staffId),
    })),
    feedback: visibleFeedback.map((f) => ({
      staffId: f.staffId,
      displayName: nameById.get(f.staffId) ?? "Staff",
      academicPerformance: f.academicPerformance,
      strengths: f.strengths,
      concerns: f.concerns,
      accommodations: f.accommodations,
      recommendations: f.recommendations,
      additional: f.additional,
      updatedAt: f.updatedAt,
    })),
    my: {
      staffId: staff.id,
      isAttendee,
      response: attendees.find((a) => a.staffId === staff.id)?.response ?? null,
      feedbackSubmitted: feedbackRows.some((f) => f.staffId === staff.id),
      canEdit: organizerView,
    },
  });
});

// ---------------------------------------------------------------------------
// PATCH /support-meetings/:id — edit fields / cancel / complete / attendees.
// Organizer (any) or the meeting's creator.
// ---------------------------------------------------------------------------
router.patch("/support-meetings/:id", requireOrganizer, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = getStaff(req);
  const m = await loadMeeting(schoolId, Number(req.params.id));
  if (!m) {
    res.status(404).json({ error: "Meeting not found" });
    return;
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const updates: Partial<typeof supportMeetingsTable.$inferInsert> = {};

  if (typeof b.meetingType === "string" && b.meetingType.trim()) {
    updates.meetingType = b.meetingType.trim().slice(0, 100);
  }
  if (typeof b.date === "string") {
    if (!DATE_RE.test(b.date)) {
      res.status(400).json({ error: "Invalid date" });
      return;
    }
    updates.date = b.date;
  }
  if (typeof b.startTime === "string") {
    if (!TIME_RE.test(b.startTime)) {
      res.status(400).json({ error: "Invalid start time" });
      return;
    }
    updates.startTime = b.startTime;
  }
  if (typeof b.endTime === "string") {
    if (b.endTime && !TIME_RE.test(b.endTime)) {
      res.status(400).json({ error: "Invalid end time" });
      return;
    }
    updates.endTime = b.endTime || null;
  }
  if (typeof b.location === "string") updates.location = b.location.trim().slice(0, 200);
  if (typeof b.virtualLink === "string") updates.virtualLink = b.virtualLink.trim().slice(0, 500);
  if (typeof b.notes === "string") updates.notes = b.notes.trim().slice(0, 5000);
  if (typeof b.status === "string") {
    if (!["scheduled", "canceled", "completed"].includes(b.status)) {
      res.status(400).json({ error: "Invalid status" });
      return;
    }
    updates.status = b.status;
  }

  // Attendee replacement (manual list). fromSchedule flags preserved for
  // retained rows; removed attendees' feedback rows are kept (historical
  // record) but their pending row disappears.
  const nextIds = Array.isArray(b.attendeeStaffIds)
    ? (b.attendeeStaffIds as unknown[]).filter(
        (n): n is number => Number.isInteger(n) && (n as number) > 0,
      )
    : null;

  await db.transaction(async (tx) => {
    if (Object.keys(updates).length > 0) {
      await tx
        .update(supportMeetingsTable)
        .set({ ...updates, updatedAt: new Date() })
        .where(
          and(
            eq(supportMeetingsTable.id, m.id),
            eq(supportMeetingsTable.schoolId, schoolId),
          ),
        );
    }
    if (nextIds) {
      const validRows = nextIds.length
        ? await tx
            .select({ id: staffTable.id })
            .from(staffTable)
            .where(
              and(
                eq(staffTable.schoolId, schoolId),
                inArray(staffTable.id, nextIds),
                eq(staffTable.active, true),
              ),
            )
        : [];
      const valid = new Set(validRows.map((r) => r.id));
      const existing = await tx
        .select()
        .from(supportMeetingAttendeesTable)
        .where(
          and(
            eq(supportMeetingAttendeesTable.schoolId, schoolId),
            eq(supportMeetingAttendeesTable.meetingId, m.id),
          ),
        );
      const existingIds = new Set(existing.map((a) => a.staffId));
      const keep = new Set(nextIds.filter((id) => valid.has(id)));
      if (keep.size === 0) {
        throw Object.assign(new Error("At least one attendee is required"), {
          statusCode: 400,
        });
      }
      const toRemove = existing.filter((a) => !keep.has(a.staffId));
      const toAdd = Array.from(keep).filter((id) => !existingIds.has(id));
      if (toRemove.length) {
        await tx.delete(supportMeetingAttendeesTable).where(
          and(
            eq(supportMeetingAttendeesTable.schoolId, schoolId),
            eq(supportMeetingAttendeesTable.meetingId, m.id),
            inArray(
              supportMeetingAttendeesTable.staffId,
              toRemove.map((a) => a.staffId),
            ),
          ),
        );
      }
      if (toAdd.length) {
        await tx.insert(supportMeetingAttendeesTable).values(
          toAdd.map((id) => ({
            schoolId,
            meetingId: m.id,
            staffId: id,
            fromSchedule: false,
          })),
        );
      }
    }
  }).catch((err: Error & { statusCode?: number }) => {
    if (err.statusCode === 400) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  });
  if (res.headersSent) return;

  const action =
    updates.status === "canceled"
      ? "canceled"
      : updates.status === "completed"
        ? "completed"
        : "updated";
  await logEvent(schoolId, m.id, staff.id, action);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /support-meetings/:id/respond — attendee confirms or declines.
// ---------------------------------------------------------------------------
router.post(
  "/support-meetings/:id/respond",
  requireAnyStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const staff = getStaff(req);
    const m = await loadMeeting(schoolId, Number(req.params.id));
    if (!m) {
      res.status(404).json({ error: "Meeting not found" });
      return;
    }
    if (m.status !== "scheduled") {
      res.status(409).json({ error: "This meeting is no longer active" });
      return;
    }
    const response =
      req.body?.response === "confirmed"
        ? "confirmed"
        : req.body?.response === "declined"
          ? "declined"
          : null;
    if (!response) {
      res.status(400).json({ error: "response must be confirmed or declined" });
      return;
    }
    const updated = await db
      .update(supportMeetingAttendeesTable)
      .set({ response, respondedAt: new Date() })
      .where(
        and(
          eq(supportMeetingAttendeesTable.schoolId, schoolId),
          eq(supportMeetingAttendeesTable.meetingId, m.id),
          eq(supportMeetingAttendeesTable.staffId, staff.id),
        ),
      )
      .returning({ id: supportMeetingAttendeesTable.id });
    if (updated.length === 0) {
      res.status(404).json({ error: "Meeting not found" });
      return;
    }
    await logEvent(schoolId, m.id, staff.id, response);
    res.json({ ok: true, needsFeedback: response === "declined" });
  },
);

// ---------------------------------------------------------------------------
// POST /support-meetings/:id/feedback — attendee submits/updates feedback.
// ---------------------------------------------------------------------------
router.post(
  "/support-meetings/:id/feedback",
  requireAnyStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const staff = getStaff(req);
    const m = await loadMeeting(schoolId, Number(req.params.id));
    if (!m) {
      res.status(404).json({ error: "Meeting not found" });
      return;
    }
    const [att] = await db
      .select({ id: supportMeetingAttendeesTable.id })
      .from(supportMeetingAttendeesTable)
      .where(
        and(
          eq(supportMeetingAttendeesTable.schoolId, schoolId),
          eq(supportMeetingAttendeesTable.meetingId, m.id),
          eq(supportMeetingAttendeesTable.staffId, staff.id),
        ),
      );
    if (!att) {
      res.status(404).json({ error: "Meeting not found" });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const field = (k: string) =>
      typeof b[k] === "string" ? (b[k] as string).trim().slice(0, 8000) : "";
    const values = {
      academicPerformance: field("academicPerformance"),
      strengths: field("strengths"),
      concerns: field("concerns"),
      accommodations: field("accommodations"),
      recommendations: field("recommendations"),
      additional: field("additional"),
    };
    if (Object.values(values).every((v) => !v)) {
      res.status(400).json({ error: "Please fill in at least one field" });
      return;
    }
    await db
      .insert(supportMeetingFeedbackTable)
      .values({ schoolId, meetingId: m.id, staffId: staff.id, ...values })
      .onConflictDoUpdate({
        target: [
          supportMeetingFeedbackTable.meetingId,
          supportMeetingFeedbackTable.staffId,
        ],
        set: { ...values, updatedAt: new Date() },
      });
    await logEvent(schoolId, m.id, staff.id, "feedback_submitted");
    res.json({ ok: true });
  },
);

// ---------------------------------------------------------------------------
// POST /support-meetings/:id/remind — organizer pings attendees who still
// owe a response or feedback (marks remindedAt; badge count already
// includes them, so this simply refreshes the timestamp/audit trail).
// ---------------------------------------------------------------------------
router.post(
  "/support-meetings/:id/remind",
  requireOrganizer,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const staff = getStaff(req);
    const m = await loadMeeting(schoolId, Number(req.params.id));
    if (!m) {
      res.status(404).json({ error: "Meeting not found" });
      return;
    }
    if (m.status !== "scheduled") {
      res.status(409).json({ error: "This meeting is no longer active" });
      return;
    }
    // Outstanding = pending responses + declines still owing feedback
    // (same definition as the nav badge).
    const outstanding = await db
      .update(supportMeetingAttendeesTable)
      .set({ remindedAt: new Date() })
      .where(
        and(
          eq(supportMeetingAttendeesTable.schoolId, schoolId),
          eq(supportMeetingAttendeesTable.meetingId, m.id),
          sql`(
            ${supportMeetingAttendeesTable.response} = 'pending'
            OR (
              ${supportMeetingAttendeesTable.response} = 'declined'
              AND NOT EXISTS (
                SELECT 1 FROM support_meeting_feedback f
                WHERE f.school_id = ${schoolId}
                  AND f.meeting_id = ${supportMeetingAttendeesTable.meetingId}
                  AND f.staff_id = ${supportMeetingAttendeesTable.staffId}
              )
            )
          )`,
        ),
      )
      .returning({
        staffId: supportMeetingAttendeesTable.staffId,
        response: supportMeetingAttendeesTable.response,
      });
    // Real delivery: courtesy email per outstanding attendee (fire-and-
    // forget; the in-app badge remains the reliable channel).
    if (outstanding.length) {
      const recipients = await db
        .select({
          id: staffTable.id,
          displayName: staffTable.displayName,
          email: staffTable.email,
        })
        .from(staffTable)
        .where(
          and(
            eq(staffTable.schoolId, schoolId),
            inArray(
              staffTable.id,
              outstanding.map((o) => o.staffId),
            ),
            eq(staffTable.active, true),
          ),
        );
      const declinedSet = new Set(
        outstanding.filter((o) => o.response === "declined").map((o) => o.staffId),
      );
      const [y, mo, d] = m.date.split("-").map(Number);
      const dateLabel =
        y && mo && d
          ? new Date(y, mo - 1, d).toLocaleDateString("en-US", {
              weekday: "short",
              month: "short",
              day: "numeric",
              year: "numeric",
            })
          : m.date;
      const fmt = (t: string) => {
        const [h, min] = t.split(":").map(Number);
        if (h == null || Number.isNaN(h)) return t;
        const h12 = h % 12 === 0 ? 12 : h % 12;
        return `${h12}:${String(min ?? 0).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
      };
      const timeLabel = m.endTime
        ? `${fmt(m.startTime)} – ${fmt(m.endTime)}`
        : fmt(m.startTime);
      for (const r of recipients) {
        void sendMeetingReminderEmail({
          toEmail: r.email,
          toDisplayName: r.displayName,
          organizerName: staff.displayName,
          meetingType: m.meetingType,
          studentName: m.studentName,
          dateLabel,
          timeLabel,
          location: m.location,
          needsFeedback: declinedSet.has(r.id),
        });
      }
    }
    await logEvent(
      schoolId,
      m.id,
      staff.id,
      "reminder_sent",
      `${outstanding.length} attendee(s)`,
    );
    res.json({ ok: true, reminded: outstanding.length });
  },
);

export default router;
