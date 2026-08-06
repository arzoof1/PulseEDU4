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
  planUpdatesTable,
  planUpdateRecipientsTable,
  behaviorSupportsTable,
} from "@workspace/db";
import { and, eq, desc, inArray, isNull, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam } from "../lib/coreTeam.js";
import { sendPlanUpdateEmail } from "../lib/planUpdateEmail.js";
import { loadScheduleSectionsForStudent } from "../lib/effectiveTeachers.js";

// ---------------------------------------------------------------------------
// Student Plan Updates (v1).
//
// After a support meeting revises a student's plan, the MTSS coordinator
// (Core Team, incl. isMtssCoordinator, + counselors — same organizer gate
// as support meetings) logs a Plan Update with a plain-language summary,
// an effective date (prefilled from the linked meeting), and the teachers
// who must re-read + acknowledge (default: the student's schedule teachers).
//
// Teachers see the update as a dot on the matching roster program pill and
// acknowledge from the pill's hover box; the coordinator's Plan Updates tab
// tracks who still hasn't acknowledged and can send email reminders.
//
// Tenancy: every query carries school_id; acting staff must belong to the
// active school (403 non-SuperUser cross-school).
// ---------------------------------------------------------------------------

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

function canManage(staff: StaffRow): boolean {
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
const requireManager = requireStaffMW(canManage, "Plan update manager");

function getStaff(req: Request): StaffRow {
  return (req as Request & { staff: StaffRow }).staff;
}

const PLAN_TYPES = ["ese", "504", "ell", "behavior"] as const;
type PlanType = (typeof PLAN_TYPES)[number];
const PLAN_LABELS: Record<PlanType, string> = {
  ese: "ESE / IEP",
  "504": "504 Plan",
  ell: "ELL Plan",
  behavior: "Behavior Plan",
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ---------------------------------------------------------------------------
// GET /plan-updates/meta — { canManage, planTypes }
// ---------------------------------------------------------------------------
router.get("/plan-updates/meta", requireAnyStaff, (req, res) => {
  const staff = getStaff(req);
  res.json({
    canManage: canManage(staff),
    planTypes: PLAN_TYPES.map((k) => ({ key: k, label: PLAN_LABELS[k] })),
  });
});

// ---------------------------------------------------------------------------
// GET /plan-updates/student-context?studentId= — manager only.
// Student snapshot + schedule teachers + recent support meetings (for
// effective-date prefill / linking).
// ---------------------------------------------------------------------------
router.get(
  "/plan-updates/student-context",
  requireManager,
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
        ese: studentsTable.ese,
        is504: studentsTable.is504,
        ell: studentsTable.ell,
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
          .select({ id: staffTable.id, displayName: staffTable.displayName })
          .from(staffTable)
          .where(
            and(
              eq(staffTable.schoolId, schoolId),
              inArray(staffTable.id, teacherIds),
              eq(staffTable.active, true),
            ),
          )
      : [];
    // Recent meetings for this student (newest first, cap 10) so the
    // coordinator can link the update and prefill the effective date.
    const meetings = await db
      .select({
        id: supportMeetingsTable.id,
        meetingType: supportMeetingsTable.meetingType,
        date: supportMeetingsTable.date,
        status: supportMeetingsTable.status,
      })
      .from(supportMeetingsTable)
      .where(
        and(
          eq(supportMeetingsTable.schoolId, schoolId),
          eq(supportMeetingsTable.studentId, studentId),
        ),
      )
      .orderBy(desc(supportMeetingsTable.date))
      .limit(10);
    res.json({
      student,
      scheduleTeachers: teachers
        .map((t) => ({ staffId: t.id, displayName: t.displayName }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      recentMeetings: meetings.filter((m) => m.status !== "canceled"),
    });
  },
);

// ---------------------------------------------------------------------------
// POST /plan-updates — create. Manager only.
// Body: { studentId, planType, summary, effectiveDate, meetingId?,
//         recipientStaffIds: number[] }
// Notifies every recipient by email (fire-and-forget) and lights the
// roster pill dot until each acknowledges.
// ---------------------------------------------------------------------------
router.post("/plan-updates", requireManager, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = getStaff(req);
  const b = (req.body ?? {}) as Record<string, unknown>;

  const studentId = typeof b.studentId === "string" ? b.studentId : "";
  const planType = typeof b.planType === "string" ? b.planType : "";
  const summary =
    typeof b.summary === "string" ? b.summary.trim().slice(0, 2000) : "";
  const effectiveDate =
    typeof b.effectiveDate === "string" ? b.effectiveDate : "";
  const meetingIdRaw = b.meetingId;
  const recipientIds = Array.isArray(b.recipientStaffIds)
    ? b.recipientStaffIds.filter(
        (n): n is number => Number.isInteger(n) && (n as number) > 0,
      )
    : [];

  if (!(PLAN_TYPES as readonly string[]).includes(planType)) {
    res.status(400).json({ error: "Valid plan type is required" });
    return;
  }
  if (!summary) {
    res.status(400).json({ error: "A summary of the change is required" });
    return;
  }
  if (!DATE_RE.test(effectiveDate)) {
    res.status(400).json({ error: "A valid effective date is required" });
    return;
  }
  const [student] = await db
    .select({
      studentId: studentsTable.studentId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
      ese: studentsTable.ese,
      is504: studentsTable.is504,
      ell: studentsTable.ell,
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
  // The teacher-facing notice lives ON the roster program pill, and pills
  // only render when the matching flag/support exists — so refuse to log
  // an update the recipients would never see (or be able to acknowledge).
  let planVisible = false;
  if (planType === "ese") planVisible = !!student.ese;
  else if (planType === "504") planVisible = !!student.is504;
  else if (planType === "ell") planVisible = !!student.ell;
  else if (planType === "behavior") {
    const [bs] = await db
      .select({ id: behaviorSupportsTable.id })
      .from(behaviorSupportsTable)
      .where(
        and(
          eq(behaviorSupportsTable.schoolId, schoolId),
          eq(behaviorSupportsTable.studentId, studentId),
          eq(behaviorSupportsTable.isActive, true),
          isNull(behaviorSupportsTable.archivedAt),
        ),
      )
      .limit(1);
    planVisible = !!bs;
  }
  if (!planVisible) {
    res.status(400).json({
      error: `${PLAN_LABELS[planType as (typeof PLAN_TYPES)[number]] ?? planType} isn't on this student's roster record, so teachers wouldn't see the update. Check the student's program flags first.`,
    });
    return;
  }
  // Optional meeting link — must be this school's meeting for this student.
  let meetingId: number | null = null;
  if (meetingIdRaw != null && meetingIdRaw !== "") {
    const mid = Number(meetingIdRaw);
    if (!Number.isInteger(mid) || mid <= 0) {
      res.status(400).json({ error: "Invalid meeting link" });
      return;
    }
    const [m] = await db
      .select({ id: supportMeetingsTable.id })
      .from(supportMeetingsTable)
      .where(
        and(
          eq(supportMeetingsTable.id, mid),
          eq(supportMeetingsTable.schoolId, schoolId),
          eq(supportMeetingsTable.studentId, studentId),
        ),
      );
    if (!m) {
      res.status(400).json({ error: "Linked meeting not found" });
      return;
    }
    meetingId = mid;
  }
  // Validate recipients: active staff at this school.
  const validRecipients = recipientIds.length
    ? await db
        .select({
          id: staffTable.id,
          displayName: staffTable.displayName,
          email: staffTable.email,
        })
        .from(staffTable)
        .where(
          and(
            eq(staffTable.schoolId, schoolId),
            inArray(staffTable.id, Array.from(new Set(recipientIds))),
            eq(staffTable.active, true),
          ),
        )
    : [];
  if (validRecipients.length === 0) {
    res.status(400).json({ error: "At least one teacher must be notified" });
    return;
  }

  const created = await db.transaction(async (tx) => {
    const [u] = await tx
      .insert(planUpdatesTable)
      .values({
        schoolId,
        planType,
        studentId: student.studentId,
        studentName: `${student.firstName} ${student.lastName}`.trim(),
        grade: student.grade,
        summary,
        effectiveDate,
        meetingId,
        createdByStaffId: staff.id,
      })
      .returning();
    await tx.insert(planUpdateRecipientsTable).values(
      validRecipients.map((r) => ({
        schoolId,
        updateId: u.id,
        staffId: r.id,
      })),
    );
    return u;
  });

  // Notify each recipient (fire-and-forget; roster dot is the reliable
  // channel).
  for (const r of validRecipients) {
    void sendPlanUpdateEmail({
      toEmail: r.email,
      toDisplayName: r.displayName,
      coordinatorName: staff.displayName,
      planLabel: PLAN_LABELS[planType as PlanType],
      studentName: created.studentName,
      effectiveDateLabel: dateLabel(effectiveDate),
      summary,
      isReminder: false,
    });
  }

  res.status(201).json({ id: created.id });
});

// ---------------------------------------------------------------------------
// GET /plan-updates?scope=manage — manager list with ack progress.
// Includes per-recipient detail so the coordinator sees exactly who is
// outstanding. Newest first; archived excluded unless ?includeArchived=1.
// ---------------------------------------------------------------------------
router.get("/plan-updates", requireManager, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const includeArchived = req.query.includeArchived === "1";
  const updates = await db
    .select()
    .from(planUpdatesTable)
    .where(
      includeArchived
        ? eq(planUpdatesTable.schoolId, schoolId)
        : and(
            eq(planUpdatesTable.schoolId, schoolId),
            isNull(planUpdatesTable.archivedAt),
          ),
    )
    .orderBy(desc(planUpdatesTable.createdAt))
    .limit(200);
  const ids = updates.map((u) => u.id);
  const recipients = ids.length
    ? await db
        .select()
        .from(planUpdateRecipientsTable)
        .where(
          and(
            eq(planUpdateRecipientsTable.schoolId, schoolId),
            inArray(planUpdateRecipientsTable.updateId, ids),
          ),
        )
    : [];
  const staffIds = Array.from(new Set(recipients.map((r) => r.staffId)));
  const creatorIds = Array.from(new Set(updates.map((u) => u.createdByStaffId)));
  const allStaffIds = Array.from(new Set([...staffIds, ...creatorIds]));
  const staffRows = allStaffIds.length
    ? await db
        .select({ id: staffTable.id, displayName: staffTable.displayName })
        .from(staffTable)
        .where(
          and(
            eq(staffTable.schoolId, schoolId),
            inArray(staffTable.id, allStaffIds),
          ),
        )
    : [];
  const nameById = new Map(staffRows.map((s) => [s.id, s.displayName]));
  res.json({
    updates: updates.map((u) => {
      const recs = recipients.filter((r) => r.updateId === u.id);
      const acked = recs.filter((r) => r.acknowledgedAt != null);
      return {
        id: u.id,
        planType: u.planType,
        planLabel: PLAN_LABELS[u.planType as PlanType] ?? u.planType,
        studentId: u.studentId,
        studentName: u.studentName,
        grade: u.grade,
        summary: u.summary,
        effectiveDate: u.effectiveDate,
        meetingId: u.meetingId,
        createdByName: nameById.get(u.createdByStaffId) ?? "Staff",
        createdAt: u.createdAt,
        archived: u.archivedAt != null,
        counts: { recipients: recs.length, acknowledged: acked.length },
        recipients: recs
          .map((r) => ({
            staffId: r.staffId,
            displayName: nameById.get(r.staffId) ?? "Staff",
            acknowledgedAt: r.acknowledgedAt,
            remindedAt: r.remindedAt,
          }))
          .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      };
    }),
  });
});

// ---------------------------------------------------------------------------
// GET /plan-updates/mine — my outstanding (unacknowledged, unarchived)
// updates, for the Teacher Roster pill dots + hover boxes.
// ---------------------------------------------------------------------------
router.get("/plan-updates/mine", requireAnyStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = getStaff(req);
  const rows = await db
    .select({
      id: planUpdatesTable.id,
      planType: planUpdatesTable.planType,
      studentId: planUpdatesTable.studentId,
      studentName: planUpdatesTable.studentName,
      summary: planUpdatesTable.summary,
      effectiveDate: planUpdatesTable.effectiveDate,
      createdByStaffId: planUpdatesTable.createdByStaffId,
    })
    .from(planUpdateRecipientsTable)
    .innerJoin(
      planUpdatesTable,
      eq(planUpdateRecipientsTable.updateId, planUpdatesTable.id),
    )
    .where(
      and(
        eq(planUpdateRecipientsTable.schoolId, schoolId),
        eq(planUpdateRecipientsTable.staffId, staff.id),
        isNull(planUpdateRecipientsTable.acknowledgedAt),
        eq(planUpdatesTable.schoolId, schoolId),
        isNull(planUpdatesTable.archivedAt),
      ),
    )
    .orderBy(desc(planUpdatesTable.createdAt));
  const creatorIds = Array.from(new Set(rows.map((r) => r.createdByStaffId)));
  const creators = creatorIds.length
    ? await db
        .select({ id: staffTable.id, displayName: staffTable.displayName })
        .from(staffTable)
        .where(
          and(
            eq(staffTable.schoolId, schoolId),
            inArray(staffTable.id, creatorIds),
          ),
        )
    : [];
  const nameById = new Map(creators.map((s) => [s.id, s.displayName]));
  res.json({
    updates: rows.map((r) => ({
      id: r.id,
      planType: r.planType,
      studentId: r.studentId,
      studentName: r.studentName,
      summary: r.summary,
      effectiveDate: r.effectiveDate,
      createdByName: nameById.get(r.createdByStaffId) ?? "Staff",
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /plan-updates/:id/ack — recipient acknowledges (idempotent).
// ---------------------------------------------------------------------------
router.post("/plan-updates/:id/ack", requireAnyStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = getStaff(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).json({ error: "Update not found" });
    return;
  }
  const [rec] = await db
    .select()
    .from(planUpdateRecipientsTable)
    .where(
      and(
        eq(planUpdateRecipientsTable.schoolId, schoolId),
        eq(planUpdateRecipientsTable.updateId, id),
        eq(planUpdateRecipientsTable.staffId, staff.id),
      ),
    );
  if (!rec) {
    // Not a recipient (or wrong school) — same 404 as missing, no leak.
    res.status(404).json({ error: "Update not found" });
    return;
  }
  if (rec.acknowledgedAt == null) {
    await db
      .update(planUpdateRecipientsTable)
      .set({ acknowledgedAt: new Date() })
      .where(eq(planUpdateRecipientsTable.id, rec.id));
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /plan-updates/:id/remind — manager emails everyone still pending.
// ---------------------------------------------------------------------------
router.post("/plan-updates/:id/remind", requireManager, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = getStaff(req);
  const id = Number(req.params.id);
  const [u] = Number.isInteger(id) && id > 0
    ? await db
        .select()
        .from(planUpdatesTable)
        .where(
          and(
            eq(planUpdatesTable.id, id),
            eq(planUpdatesTable.schoolId, schoolId),
          ),
        )
    : [];
  if (!u) {
    res.status(404).json({ error: "Update not found" });
    return;
  }
  if (u.archivedAt != null) {
    res.status(409).json({ error: "This update is archived" });
    return;
  }
  const pending = await db
    .update(planUpdateRecipientsTable)
    .set({ remindedAt: new Date() })
    .where(
      and(
        eq(planUpdateRecipientsTable.schoolId, schoolId),
        eq(planUpdateRecipientsTable.updateId, u.id),
        isNull(planUpdateRecipientsTable.acknowledgedAt),
      ),
    )
    .returning({ staffId: planUpdateRecipientsTable.staffId });
  if (pending.length) {
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
            pending.map((p) => p.staffId),
          ),
          eq(staffTable.active, true),
        ),
      );
    for (const r of recipients) {
      void sendPlanUpdateEmail({
        toEmail: r.email,
        toDisplayName: r.displayName,
        coordinatorName: staff.displayName,
        planLabel: PLAN_LABELS[u.planType as PlanType] ?? u.planType,
        studentName: u.studentName,
        effectiveDateLabel: dateLabel(u.effectiveDate),
        summary: u.summary,
        isReminder: true,
      });
    }
  }
  res.json({ ok: true, reminded: pending.length });
});

// ---------------------------------------------------------------------------
// PATCH /plan-updates/:id — manager archive/unarchive (soft close).
// ---------------------------------------------------------------------------
router.patch("/plan-updates/:id", requireManager, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const id = Number(req.params.id);
  const b = (req.body ?? {}) as { archived?: unknown };
  if (typeof b.archived !== "boolean") {
    res.status(400).json({ error: "archived (boolean) is required" });
    return;
  }
  const updated = Number.isInteger(id) && id > 0
    ? await db
        .update(planUpdatesTable)
        .set({ archivedAt: b.archived ? new Date() : null })
        .where(
          and(
            eq(planUpdatesTable.id, id),
            eq(planUpdatesTable.schoolId, schoolId),
          ),
        )
        .returning({ id: planUpdatesTable.id })
    : [];
  if (!updated.length) {
    res.status(404).json({ error: "Update not found" });
    return;
  }
  res.json({ ok: true });
});

export default router;
