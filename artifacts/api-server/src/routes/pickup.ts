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
  staffTable,
  parentsTable,
  studentPickupAuthorizationsTable,
  pickupQueueEventsTable,
  bellSchedulesTable,
  bellSchedulePeriodsTable,
} from "@workspace/db";
import { and, eq, inArray, gte, sql, desc, asc } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

// =============================================================================
// Parent Pick-Up Module routes
//
// Auth model:
//   - admin (or super/district admin) — full access including authorizations CRUD.
//   - cap_car_rider_monitor — can run the curb keypad + walker gate.
//   - any signed-in staff — can release one of their own students from the
//     queue ("send out to the line"). Teachers are not gated by car-rider
//     monitor for that single action.
//
// All routes are tenant-scoped via req.schoolId.
// =============================================================================

// Terminal actions remove a student from the live queue.
const TERMINAL_ACTIONS = new Set([
  "in_car",
  "auto_cleared",
  "walker_released",
]);

// All actions accepted on a queue event row. Kept in one place so a typo
// in a route handler can't quietly poison the audit log.
const VALID_ACTIONS = new Set([
  "added",
  "released_to_walk",
  "in_car",
  "walker_released",
  "auto_cleared",
  "restricted_attempt",
  "restricted_override",
]);

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

function isAdmin(staff: typeof staffTable.$inferSelect): boolean {
  return Boolean(staff.isAdmin || staff.isSuperUser || staff.isDistrictAdmin);
}

function canRunCurb(staff: typeof staffTable.$inferSelect): boolean {
  return isAdmin(staff) || Boolean(staff.capCarRiderMonitor);
}

// School-local "today" boundary. Used to scope the live queue to the
// current school day. Returns an ISO string suitable for a `gte`
// comparison against TIMESTAMPTZ columns.
function startOfTodayIso(): string {
  const now = new Date();
  const local = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
    0,
  );
  return local.toISOString();
}

// "HH:MM" — school-local current time, used to gate the walker release.
function nowHHMM(): string {
  const d = new Date();
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

// ---------------------------------------------------------------------------
// GET /pickup/queue
// Returns the live dismissal queue derived from today's append-only event
// log. Optional ?staffId=me filters to students on the calling teacher's
// roster (placeholder until SectionRoster join lands; for now `me` is a
// no-op that returns every student until the classroom signage tile is wired).
// ---------------------------------------------------------------------------
router.get("/pickup/queue", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const sinceIso = startOfTodayIso();

  // Pull every event today, then derive state in one pass. Cheap because
  // a school sees ~150 dismissal events/day max.
  const events = await db
    .select()
    .from(pickupQueueEventsTable)
    .where(
      and(
        eq(pickupQueueEventsTable.schoolId, schoolId),
        gte(pickupQueueEventsTable.occurredAt, new Date(sinceIso)),
      ),
    )
    .orderBy(asc(pickupQueueEventsTable.occurredAt));

  // Per-student state machine — keep the most recent event of interest.
  type Entry = {
    studentId: number;
    addedAt: string;
    status: "in_queue" | "walking_out";
    pickupAuthorizationId: number | null;
  };
  const byStudent = new Map<number, Entry>();
  for (const e of events) {
    const action = e.action;
    const sid = e.studentId;
    if (TERMINAL_ACTIONS.has(action)) {
      byStudent.delete(sid);
      continue;
    }
    if (action === "added") {
      byStudent.set(sid, {
        studentId: sid,
        addedAt: e.occurredAt.toISOString(),
        status: "in_queue",
        pickupAuthorizationId: e.pickupAuthorizationId,
      });
    } else if (action === "released_to_walk") {
      const existing = byStudent.get(sid);
      if (existing) {
        existing.status = "walking_out";
      }
    }
  }

  const entries = Array.from(byStudent.values()).sort((a, b) =>
    a.addedAt.localeCompare(b.addedAt),
  );

  // Hydrate with student names + grade in one round-trip.
  const studentIds = entries.map((e) => e.studentId);
  let studentRows: Array<{
    id: number;
    studentId: string;
    firstName: string;
    lastName: string;
    grade: number;
  }> = [];
  if (studentIds.length > 0) {
    studentRows = await db
      .select({
        id: studentsTable.id,
        studentId: studentsTable.studentId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          inArray(studentsTable.id, studentIds),
        ),
      );
  }
  const studentById = new Map(studentRows.map((s) => [s.id, s]));

  const queue = entries.map((e, idx) => {
    const s = studentById.get(e.studentId);
    return {
      position: idx + 1,
      studentId: s?.studentId ?? String(e.studentId),
      studentDbId: e.studentId,
      firstName: s?.firstName ?? "",
      lastName: s?.lastName ?? "",
      grade: s?.grade ?? null,
      addedAt: e.addedAt,
      status: e.status,
      pickupAuthorizationId: e.pickupAuthorizationId,
    };
  });

  res.json({ queue, asOf: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// POST /pickup/lookup
// Body: { pickupNumber: string }
// Resolves a typed pickup number into {authorization, student, siblings[]}.
// Siblings are scoped to OTHER students that the SAME parent is also
// authorized to pick up — this is the split-custody guarantee. Restricted
// authorizations come back with restricted=true so the curb page can show
// the red banner instead of the add-to-line button.
// ---------------------------------------------------------------------------
router.post("/pickup/lookup", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  if (!canRunCurb(staff)) {
    res.status(403).json({ error: "Pickup curb access not granted" });
    return;
  }

  const raw = req.body?.pickupNumber;
  const pickupNumber = typeof raw === "string" ? raw.trim() : "";
  if (!pickupNumber) {
    res.status(400).json({ error: "pickupNumber required" });
    return;
  }

  const [auth] = await db
    .select()
    .from(studentPickupAuthorizationsTable)
    .where(
      and(
        eq(studentPickupAuthorizationsTable.schoolId, schoolId),
        eq(studentPickupAuthorizationsTable.pickupNumber, pickupNumber),
        eq(studentPickupAuthorizationsTable.active, true),
      ),
    );
  if (!auth) {
    res.status(404).json({ error: "No active pickup tag found for that number" });
    return;
  }

  // The student named on the typed authorization itself.
  const [primary] = await db
    .select({
      id: studentsTable.id,
      studentId: studentsTable.studentId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
      dismissalMode: studentsTable.dismissalMode,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.id, auth.studentId),
        eq(studentsTable.schoolId, schoolId),
      ),
    );

  // Siblings = OTHER active authorizations held by the SAME parentId
  // (not the same student). When parentId is null on the typed auth, we
  // have no portal-account anchor for this guardian, so siblings can't
  // be inferred — front office would have to add each student manually.
  let siblings: Array<{
    authorizationId: number;
    studentDbId: number;
    studentId: string;
    firstName: string;
    lastName: string;
    grade: number;
    restricted: boolean;
  }> = [];
  if (auth.parentId !== null && primary) {
    const sibAuths = await db
      .select()
      .from(studentPickupAuthorizationsTable)
      .where(
        and(
          eq(studentPickupAuthorizationsTable.schoolId, schoolId),
          eq(studentPickupAuthorizationsTable.parentId, auth.parentId),
          eq(studentPickupAuthorizationsTable.active, true),
        ),
      );
    const sibStudentIds = sibAuths
      .map((a) => a.studentId)
      .filter((id) => id !== primary.id);
    if (sibStudentIds.length > 0) {
      const sibStudents = await db
        .select({
          id: studentsTable.id,
          studentId: studentsTable.studentId,
          firstName: studentsTable.firstName,
          lastName: studentsTable.lastName,
          grade: studentsTable.grade,
        })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.schoolId, schoolId),
            inArray(studentsTable.id, sibStudentIds),
          ),
        );
      siblings = sibStudents.map((s) => {
        const sibAuth = sibAuths.find((a) => a.studentId === s.id)!;
        return {
          authorizationId: sibAuth.id,
          studentDbId: s.id,
          studentId: s.studentId,
          firstName: s.firstName,
          lastName: s.lastName,
          grade: s.grade,
          restricted: sibAuth.restrictedFrom,
        };
      });
    }
  }

  res.json({
    authorization: {
      id: auth.id,
      pickupNumber: auth.pickupNumber,
      guardianLabel: auth.guardianLabel,
      restricted: auth.restrictedFrom,
      parentId: auth.parentId,
    },
    primary: primary
      ? {
          authorizationId: auth.id,
          studentDbId: primary.id,
          studentId: primary.studentId,
          firstName: primary.firstName,
          lastName: primary.lastName,
          grade: primary.grade,
          dismissalMode: primary.dismissalMode,
          restricted: auth.restrictedFrom,
        }
      : null,
    siblings,
  });
});

// ---------------------------------------------------------------------------
// POST /pickup/queue/add
// Body: { authorizationIds: number[], overrideJustification?: string }
// Each id MUST be active and (unless an override justification is supplied)
// MUST NOT be restricted_from. We never silently skip — restricted ids
// without an override are returned in `restrictedSkipped` so the UI can
// show what didn't add and why.
// ---------------------------------------------------------------------------
router.post("/pickup/queue/add", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  if (!canRunCurb(staff)) {
    res.status(403).json({ error: "Pickup curb access not granted" });
    return;
  }

  const ids: number[] = Array.isArray(req.body?.authorizationIds)
    ? req.body.authorizationIds.filter((n: unknown) => Number.isInteger(n))
    : [];
  if (ids.length === 0) {
    res.status(400).json({ error: "authorizationIds (non-empty) required" });
    return;
  }
  const justification: string =
    typeof req.body?.overrideJustification === "string"
      ? req.body.overrideJustification.trim()
      : "";

  const auths = await db
    .select()
    .from(studentPickupAuthorizationsTable)
    .where(
      and(
        eq(studentPickupAuthorizationsTable.schoolId, schoolId),
        inArray(studentPickupAuthorizationsTable.id, ids),
        eq(studentPickupAuthorizationsTable.active, true),
      ),
    );
  if (auths.length === 0) {
    res.status(404).json({ error: "No active authorizations match" });
    return;
  }

  const restricted = auths.filter((a) => a.restrictedFrom);
  if (restricted.length > 0 && justification.length < 5) {
    // Log the attempt(s) and refuse — front office must supply a
    // justification (>= 5 chars) to proceed with a restricted number.
    for (const a of restricted) {
      await db.insert(pickupQueueEventsTable).values({
        schoolId,
        studentId: a.studentId,
        pickupAuthorizationId: a.id,
        actorStaffId: staff.id,
        actorDisplayName: staff.displayName ?? "Staff",
        action: "restricted_attempt",
        note: null,
      });
    }
    res.status(403).json({
      error:
        "One or more selected students have a restricted pickup tag. An admin must supply a written justification (>= 5 chars) to override.",
      restrictedAuthorizationIds: restricted.map((a) => a.id),
    });
    return;
  }

  // Restricted-with-justification path requires admin (mirrors the ISS
  // log audit pattern in replit.md — a paraprofessional should not be
  // able to override a court-order restriction on their own). Even
  // though justification was supplied, log a `restricted_attempt` row
  // so the audit trail captures the denied non-admin override attempt
  // (auditors should be able to see who tried to bypass restrictions
  // and was refused, not just who succeeded).
  if (restricted.length > 0 && !isAdmin(staff)) {
    for (const a of restricted) {
      await db.insert(pickupQueueEventsTable).values({
        schoolId,
        studentId: a.studentId,
        pickupAuthorizationId: a.id,
        actorStaffId: staff.id,
        actorDisplayName: staff.displayName ?? "Staff",
        action: "restricted_attempt",
        note: `Non-admin override denied. Justification supplied: ${justification}`,
      });
    }
    res.status(403).json({
      error: "Only an admin can override a restricted pickup tag.",
    });
    return;
  }

  const added: number[] = [];
  await db.transaction(async (tx) => {
    for (const a of auths) {
      await tx.insert(pickupQueueEventsTable).values({
        schoolId,
        studentId: a.studentId,
        pickupAuthorizationId: a.id,
        actorStaffId: staff.id,
        actorDisplayName: staff.displayName ?? "Staff",
        action: a.restrictedFrom ? "restricted_override" : "added",
        note: a.restrictedFrom ? justification : null,
      });
      // Restricted-with-override also gets an `added` row so the live
      // queue derivation picks it up. The `restricted_override` row
      // above is the auditor-facing record of WHY it was added anyway.
      if (a.restrictedFrom) {
        await tx.insert(pickupQueueEventsTable).values({
          schoolId,
          studentId: a.studentId,
          pickupAuthorizationId: a.id,
          actorStaffId: staff.id,
          actorDisplayName: staff.displayName ?? "Staff",
          action: "added",
          note: null,
        });
      }
      added.push(a.studentId);
    }
  });

  res.json({ added: added.length, studentDbIds: added });
});

// ---------------------------------------------------------------------------
// POST /pickup/queue/event
// Body: { studentDbId: number, action: "released_to_walk" | "in_car",
//         note?: string }
// Used by the teacher classroom signage tile (released_to_walk) and the
// curb page (in_car). Rejects unknown actions so the audit vocabulary
// stays clean.
// ---------------------------------------------------------------------------
router.post("/pickup/queue/event", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const studentDbId = Number(req.body?.studentDbId);
  const action: string = String(req.body?.action ?? "");
  const note: string | null =
    typeof req.body?.note === "string" && req.body.note.trim().length > 0
      ? String(req.body.note).trim().slice(0, 500)
      : null;

  if (!Number.isInteger(studentDbId) || studentDbId <= 0) {
    res.status(400).json({ error: "studentDbId required" });
    return;
  }
  if (action !== "released_to_walk" && action !== "in_car") {
    res
      .status(400)
      .json({ error: "action must be 'released_to_walk' or 'in_car'" });
    return;
  }

  // Both in_car and released_to_walk require curb access for now. The
  // long-term design is "released_to_walk is the teacher's button on
  // the classroom signage tile" with a section_roster check proving the
  // student belongs to that teacher's class. Until the signage tile
  // (Phase F) lands with that membership join, gating the audit-write
  // route to curb-access-only avoids any signed-in staff being able to
  // mutate another classroom's queue state.
  if (!canRunCurb(staff)) {
    res.status(403).json({ error: "Pickup curb access not granted" });
    return;
  }

  // Cross-school safety: confirm the student belongs to this school.
  const [student] = await db
    .select({ id: studentsTable.id })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.id, studentDbId),
        eq(studentsTable.schoolId, schoolId),
      ),
    );
  if (!student) {
    res.status(403).json({ error: "Student is not in your school" });
    return;
  }

  await db.insert(pickupQueueEventsTable).values({
    schoolId,
    studentId: studentDbId,
    pickupAuthorizationId: null,
    actorStaffId: staff.id,
    actorDisplayName: staff.displayName ?? "Staff",
    action,
    note,
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /pickup/walkers
// Walker roster + today's release status. Bell-window gate is computed
// server-side (windowOpen=false until the configured walker-release time).
// ---------------------------------------------------------------------------
router.get("/pickup/walkers", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  if (!canRunCurb(staff)) {
    res.status(403).json({ error: "Pickup walker gate access not granted" });
    return;
  }

  const walkers = await db
    .select({
      id: studentsTable.id,
      studentId: studentsTable.studentId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        eq(studentsTable.dismissalMode, "walker"),
      ),
    )
    .orderBy(asc(studentsTable.lastName), asc(studentsTable.firstName));

  // Today's walker_released events → mark those students as released.
  const sinceIso = startOfTodayIso();
  const todays = await db
    .select({
      studentId: pickupQueueEventsTable.studentId,
      occurredAt: pickupQueueEventsTable.occurredAt,
      actorDisplayName: pickupQueueEventsTable.actorDisplayName,
    })
    .from(pickupQueueEventsTable)
    .where(
      and(
        eq(pickupQueueEventsTable.schoolId, schoolId),
        eq(pickupQueueEventsTable.action, "walker_released"),
        gte(pickupQueueEventsTable.occurredAt, new Date(sinceIso)),
      ),
    );
  const releasedById = new Map(
    todays.map((t) => [
      t.studentId,
      {
        releasedAt: t.occurredAt.toISOString(),
        releasedBy: t.actorDisplayName,
      },
    ]),
  );

  // Bell-window gate. Look for a period named "Walker Release" or
  // "Walker Dismissal" on today's default schedule. If none configured,
  // the gate stays OPEN so the feature still works pre-onboarding —
  // the schedule is the polish, not the safety net.
  let windowOpen = true;
  let windowOpensAt: string | null = null;
  const [activeSched] = await db
    .select()
    .from(bellSchedulesTable)
    .where(
      and(
        eq(bellSchedulesTable.schoolId, schoolId),
        eq(bellSchedulesTable.isDefault, true),
      ),
    );
  if (activeSched) {
    const periods = await db
      .select()
      .from(bellSchedulePeriodsTable)
      .where(eq(bellSchedulePeriodsTable.scheduleId, activeSched.id));
    const walkerPeriod = periods.find((p) =>
      /walker/i.test(p.name ?? ""),
    );
    if (walkerPeriod && walkerPeriod.startTime) {
      const now = nowHHMM();
      windowOpensAt = walkerPeriod.startTime;
      windowOpen = now >= walkerPeriod.startTime;
    }
  }

  res.json({
    walkers: walkers.map((w) => {
      const released = releasedById.get(w.id) ?? null;
      return {
        studentDbId: w.id,
        studentId: w.studentId,
        firstName: w.firstName,
        lastName: w.lastName,
        grade: w.grade,
        released,
      };
    }),
    windowOpen,
    windowOpensAt,
  });
});

// ---------------------------------------------------------------------------
// POST /pickup/walkers/release
// Body: { studentDbId: number }
// Writes a walker_released audit row. Refuses if the bell window for
// walker dismissal hasn't opened yet (server-enforced, mirrors the
// client-side gate).
// ---------------------------------------------------------------------------
router.post("/pickup/walkers/release", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  if (!canRunCurb(staff)) {
    res.status(403).json({ error: "Pickup walker gate access not granted" });
    return;
  }

  const studentDbId = Number(req.body?.studentDbId);
  if (!Number.isInteger(studentDbId) || studentDbId <= 0) {
    res.status(400).json({ error: "studentDbId required" });
    return;
  }

  // Cross-school + walker-mode check.
  const [student] = await db
    .select({
      id: studentsTable.id,
      dismissalMode: studentsTable.dismissalMode,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.id, studentDbId),
        eq(studentsTable.schoolId, schoolId),
      ),
    );
  if (!student) {
    res.status(403).json({ error: "Student is not in your school" });
    return;
  }
  if (student.dismissalMode !== "walker") {
    res
      .status(400)
      .json({ error: "Student is not flagged as a walker for dismissal" });
    return;
  }

  // Server-side bell-window enforcement (parallel to the GET endpoint).
  const [activeSched] = await db
    .select()
    .from(bellSchedulesTable)
    .where(
      and(
        eq(bellSchedulesTable.schoolId, schoolId),
        eq(bellSchedulesTable.isDefault, true),
      ),
    );
  if (activeSched) {
    const periods = await db
      .select()
      .from(bellSchedulePeriodsTable)
      .where(eq(bellSchedulePeriodsTable.scheduleId, activeSched.id));
    const walkerPeriod = periods.find((p) =>
      /walker/i.test(p.name ?? ""),
    );
    if (walkerPeriod && walkerPeriod.startTime) {
      if (nowHHMM() < walkerPeriod.startTime) {
        res.status(409).json({
          error: `Walker release opens at ${walkerPeriod.startTime}`,
        });
        return;
      }
    }
  }

  await db.insert(pickupQueueEventsTable).values({
    schoolId,
    studentId: studentDbId,
    pickupAuthorizationId: null,
    actorStaffId: staff.id,
    actorDisplayName: staff.displayName ?? "Staff",
    action: "walker_released",
    note: null,
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /pickup/reconciliation
// Still-on-campus list grouped by dismissal mode. A student "is on
// campus" if they have NO terminal event (in_car / walker_released /
// auto_cleared) today. Front office calls this after the configured
// cutoff to identify no-shows.
// ---------------------------------------------------------------------------
router.get("/pickup/reconciliation", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  if (!canRunCurb(staff)) {
    res.status(403).json({ error: "Pickup access not granted" });
    return;
  }

  const sinceIso = startOfTodayIso();
  const released = await db
    .select({ studentId: pickupQueueEventsTable.studentId })
    .from(pickupQueueEventsTable)
    .where(
      and(
        eq(pickupQueueEventsTable.schoolId, schoolId),
        gte(pickupQueueEventsTable.occurredAt, new Date(sinceIso)),
        inArray(pickupQueueEventsTable.action, [
          "in_car",
          "walker_released",
          "auto_cleared",
        ]),
      ),
    );
  const releasedSet = new Set(released.map((r) => r.studentId));

  const all = await db
    .select({
      id: studentsTable.id,
      studentId: studentsTable.studentId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
      dismissalMode: studentsTable.dismissalMode,
    })
    .from(studentsTable)
    .where(eq(studentsTable.schoolId, schoolId));

  const stillOnCampus = all
    .filter((s) => !releasedSet.has(s.id))
    .sort((a, b) =>
      a.lastName.localeCompare(b.lastName) ||
      a.firstName.localeCompare(b.firstName),
    );

  // Group by dismissal mode for the UI.
  const byMode: Record<string, typeof stillOnCampus> = {};
  for (const s of stillOnCampus) {
    const k = s.dismissalMode || "car_rider";
    if (!byMode[k]) byMode[k] = [];
    byMode[k].push(s);
  }

  res.json({ asOf: new Date().toISOString(), byMode });
});

// ---------------------------------------------------------------------------
// Authorizations CRUD (admin-only). Front office uses these to issue,
// re-issue, and retire pickup numbers / hangers / stickers.
// ---------------------------------------------------------------------------

// GET /pickup/authorizations?studentDbId=N — list authorizations for
// one student, or for the whole school if studentDbId is omitted.
router.get("/pickup/authorizations", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  if (!isAdmin(staff)) {
    res.status(403).json({ error: "Admin only" });
    return;
  }
  const studentDbId = Number(req.query.studentDbId);
  const filters = [
    eq(studentPickupAuthorizationsTable.schoolId, schoolId),
  ];
  if (Number.isInteger(studentDbId) && studentDbId > 0) {
    filters.push(eq(studentPickupAuthorizationsTable.studentId, studentDbId));
  }
  const rows = await db
    .select()
    .from(studentPickupAuthorizationsTable)
    .where(and(...filters))
    .orderBy(desc(studentPickupAuthorizationsTable.active), asc(studentPickupAuthorizationsTable.pickupNumber));

  // Hydrate parent display names for the UI (best-effort; null parent_id
  // rows show a guardian_label only).
  const parentIds = Array.from(
    new Set(rows.map((r) => r.parentId).filter((p): p is number => p !== null)),
  );
  let parentNameById = new Map<number, string>();
  if (parentIds.length > 0) {
    const ps = await db
      .select({ id: parentsTable.id, displayName: parentsTable.displayName })
      .from(parentsTable)
      .where(
        and(
          eq(parentsTable.schoolId, schoolId),
          inArray(parentsTable.id, parentIds),
        ),
      );
    parentNameById = new Map(ps.map((p) => [p.id, p.displayName]));
  }

  res.json({
    authorizations: rows.map((r) => ({
      ...r,
      parentDisplayName: r.parentId ? parentNameById.get(r.parentId) ?? null : null,
    })),
  });
});

// POST /pickup/authorizations
// Body: { studentDbId, parentId?: number|null, guardianLabel: string,
//         pickupNumber?: string, restrictedFrom?: boolean }
// pickupNumber is auto-issued (next free 4-digit per school) when omitted.
router.post("/pickup/authorizations", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  if (!isAdmin(staff)) {
    res.status(403).json({ error: "Admin only" });
    return;
  }

  const studentDbId = Number(req.body?.studentDbId);
  const guardianLabel = String(req.body?.guardianLabel ?? "").trim();
  const parentIdRaw = req.body?.parentId;
  const parentId =
    parentIdRaw === null || parentIdRaw === undefined
      ? null
      : Number(parentIdRaw);
  const restrictedFrom = Boolean(req.body?.restrictedFrom);
  const requestedNumber: string | null =
    typeof req.body?.pickupNumber === "string" &&
    req.body.pickupNumber.trim().length > 0
      ? String(req.body.pickupNumber).trim()
      : null;

  if (!Number.isInteger(studentDbId) || studentDbId <= 0) {
    res.status(400).json({ error: "studentDbId required" });
    return;
  }
  if (!guardianLabel) {
    res.status(400).json({ error: "guardianLabel required" });
    return;
  }
  if (parentId !== null && !Number.isInteger(parentId)) {
    res.status(400).json({ error: "parentId must be an integer or null" });
    return;
  }

  // Cross-school confirm.
  const [student] = await db
    .select({ id: studentsTable.id })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.id, studentDbId),
        eq(studentsTable.schoolId, schoolId),
      ),
    );
  if (!student) {
    res.status(403).json({ error: "Student is not in your school" });
    return;
  }
  if (parentId !== null) {
    const [parent] = await db
      .select({ id: parentsTable.id })
      .from(parentsTable)
      .where(
        and(eq(parentsTable.id, parentId), eq(parentsTable.schoolId, schoolId)),
      );
    if (!parent) {
      res.status(403).json({ error: "Parent is not in your school" });
      return;
    }
  }

  // Auto-issue the next free 4-digit number when not supplied. Loop with
  // an INSERT-and-catch on the partial-unique index would be cleaner, but
  // the dataset is tiny (max ~3000 active per school) so a single read is
  // fine. The partial unique index is the source of truth either way.
  let pickupNumber = requestedNumber;
  if (!pickupNumber) {
    const taken = await db
      .select({ pickupNumber: studentPickupAuthorizationsTable.pickupNumber })
      .from(studentPickupAuthorizationsTable)
      .where(
        and(
          eq(studentPickupAuthorizationsTable.schoolId, schoolId),
          eq(studentPickupAuthorizationsTable.active, true),
        ),
      );
    const used = new Set(taken.map((t) => t.pickupNumber));
    // 4-digit numbers, skipping anything already in use. Start at 1001
    // so single-digit and 3-digit numbers don't collide visually with
    // student IDs that families might already know.
    for (let n = 1001; n <= 9999; n++) {
      const candidate = String(n);
      if (!used.has(candidate)) {
        pickupNumber = candidate;
        break;
      }
    }
    if (!pickupNumber) {
      res.status(409).json({ error: "No free pickup numbers available" });
      return;
    }
  }

  try {
    const [created] = await db
      .insert(studentPickupAuthorizationsTable)
      .values({
        schoolId,
        studentId: studentDbId,
        parentId,
        guardianLabel,
        pickupNumber,
        restrictedFrom,
        active: true,
      })
      .returning();
    res.status(201).json({ authorization: created });
  } catch (e) {
    // Most likely cause: partial unique index on (school_id, pickup_number)
    // WHERE active. Surface as a 409 so the client can re-issue.
    res.status(409).json({
      error: "Pickup number already in use",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
});

// PATCH /pickup/authorizations/:id — toggle restricted_from, edit guardian
// label, or deactivate. Number itself is immutable; to re-issue, deactivate
// and POST a new row.
router.patch("/pickup/authorizations/:id", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  if (!isAdmin(staff)) {
    res.status(403).json({ error: "Admin only" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [auth] = await db
    .select()
    .from(studentPickupAuthorizationsTable)
    .where(
      and(
        eq(studentPickupAuthorizationsTable.id, id),
        eq(studentPickupAuthorizationsTable.schoolId, schoolId),
      ),
    );
  if (!auth) {
    res.status(404).json({ error: "Authorization not found" });
    return;
  }

  const patch: Partial<typeof studentPickupAuthorizationsTable.$inferInsert> = {};
  if (typeof req.body?.guardianLabel === "string") {
    const v = req.body.guardianLabel.trim();
    if (v.length > 0) patch.guardianLabel = v;
  }
  if (typeof req.body?.restrictedFrom === "boolean") {
    patch.restrictedFrom = req.body.restrictedFrom;
  }
  if (typeof req.body?.active === "boolean") {
    patch.active = req.body.active;
    if (!req.body.active) {
      patch.deactivatedAt = new Date();
    }
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }
  const [updated] = await db
    .update(studentPickupAuthorizationsTable)
    .set(patch)
    .where(eq(studentPickupAuthorizationsTable.id, id))
    .returning();
  res.json({ authorization: updated });
});

// PATCH /pickup/students/:id/dismissal-mode — admin sets the dismissal
// mode for a student. Until the roster importer learns this column,
// this is the only UI path to flip walker / car_rider / etc.
router.patch(
  "/pickup/students/:id/dismissal-mode",
  requireStaff,
  async (req, res) => {
    const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
      .staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    if (!isAdmin(staff)) {
      res.status(403).json({ error: "Admin only" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const mode = String(req.body?.dismissalMode ?? "");
    const allowed = new Set([
      "car_rider",
      "walker",
      "bus",
      "aftercare",
      "parent_pickup_only",
    ]);
    if (!allowed.has(mode)) {
      res.status(400).json({ error: "Invalid dismissalMode" });
      return;
    }
    const [updated] = await db
      .update(studentsTable)
      .set({ dismissalMode: mode })
      .where(
        and(eq(studentsTable.id, id), eq(studentsTable.schoolId, schoolId)),
      )
      .returning({ id: studentsTable.id, dismissalMode: studentsTable.dismissalMode });
    if (!updated) {
      res.status(404).json({ error: "Student not found" });
      return;
    }
    res.json({ student: updated });
  },
);

// Defensive: makes the typechecker keep `sql` and the action enum in scope
// in case future helpers reach for them.
void sql;
void VALID_ACTIONS;

export default router;
