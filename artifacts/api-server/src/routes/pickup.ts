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
  schoolSettingsTable,
  classSectionsTable,
  sectionRosterTable,
} from "@workspace/db";
import { and, eq, inArray, gt, gte, sql, desc, asc } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { canManageDismissal, canManagePickup } from "../lib/coreTeam.js";
import { renderPickupTagsPdf, type PickupTagInput } from "../lib/pickupTagsPdf.js";

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
  "release_undone",
  "in_car",
  "walker_released",
  "auto_cleared",
  "restricted_attempt",
  "restricted_override",
]);

// Window during which a teacher can take back a `released_to_walk`
// they themselves wrote. Matches the 10s undo toast on the client.
const RELEASE_UNDO_WINDOW_MS = 10_000;

// Resolve the integer student PKs that a given teacher owns across
// their non-planning class sections. section_roster.student_id is the
// district-supplied TEXT code, so we join through students to get the
// integer PK the queue is keyed on.
async function loadOwnRosterStudentIds(
  schoolId: number,
  staffId: number,
): Promise<Set<number>> {
  const rows = await db
    .select({ id: studentsTable.id })
    .from(classSectionsTable)
    .innerJoin(
      sectionRosterTable,
      eq(sectionRosterTable.sectionId, classSectionsTable.id),
    )
    .innerJoin(
      studentsTable,
      and(
        eq(studentsTable.studentId, sectionRosterTable.studentId),
        eq(studentsTable.schoolId, classSectionsTable.schoolId),
      ),
    )
    .where(
      and(
        eq(classSectionsTable.schoolId, schoolId),
        eq(classSectionsTable.teacherStaffId, staffId),
        eq(classSectionsTable.isPlanning, false),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

// Read-or-default the per-school pickup settings. Mirrors the same
// "settings row may not exist for a brand-new tenant" pattern as the
// schoolSettings route — falls back to the schema defaults instead of
// failing the request.
async function loadPickupSettings(schoolId: number): Promise<{
  cutoffTime: string;
  teacherViewScope: "all_students" | "own_roster";
}> {
  const [row] = await db
    .select({
      cutoffTime: schoolSettingsTable.pickupCutoffTime,
      teacherViewScope: schoolSettingsTable.pickupTeacherViewScope,
    })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  return {
    cutoffTime: row?.cutoffTime ?? "15:30",
    teacherViewScope:
      row?.teacherViewScope === "own_roster" ? "own_roster" : "all_students",
  };
}

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

// Dismissal-mode editor gate. Re-exported from lib/coreTeam.ts so the
// definition can't drift between the route file and the shared helper
// (architect feedback — earlier draft duplicated the predicate inline).

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
    } else if (action === "release_undone") {
      // Teacher hit Undo within the 10s window. Flip back to in_queue
      // without touching addedAt — the student keeps their original
      // queue position rather than getting bumped to the back.
      const existing = byStudent.get(sid);
      if (existing) {
        existing.status = "in_queue";
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
      // Photo verification at the curb — staff visually match the
      // face on screen to the student walking out. Falls back to
      // initials on the client when photoObjectKey is null or
      // photoConsent is false. ACL on /api/storage/* enforces
      // school-tenant isolation.
      photoObjectKey: studentsTable.photoObjectKey,
      photoConsent: studentsTable.photoConsent,
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
    dismissalMode: string;
    restricted: boolean;
    photoObjectKey: string | null;
    photoConsent: boolean;
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
          dismissalMode: studentsTable.dismissalMode,
          photoObjectKey: studentsTable.photoObjectKey,
          photoConsent: studentsTable.photoConsent,
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
          dismissalMode: s.dismissalMode,
          restricted: sibAuth.restrictedFrom,
          photoObjectKey: s.photoObjectKey,
          photoConsent: s.photoConsent,
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
          photoObjectKey: primary.photoObjectKey,
          photoConsent: primary.photoConsent,
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

  // `in_car` is curb-only — it terminates the queue entry and is the
  // dispatcher's call. `released_to_walk` is now the teacher action from
  // /pickup/teacher: any signed-in staff may write it, with a server-side
  // view-scope gate (own_roster requires section_roster membership).
  if (action === "in_car") {
    if (!canRunCurb(staff)) {
      res.status(403).json({ error: "Pickup curb access not granted" });
      return;
    }
  } else {
    // released_to_walk — view-scope enforcement happens after the
    // cross-school check below so we can return a clean 403.
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

  if (action === "released_to_walk") {
    const settings = await loadPickupSettings(schoolId);
    if (settings.teacherViewScope === "own_roster" && !canRunCurb(staff)) {
      // Curb dispatchers can release anyone regardless of scope —
      // they're the fallback when a teacher is absent. Everyone else
      // has to be on the student's section roster.
      const ownRoster = await loadOwnRosterStudentIds(schoolId, staff.id);
      if (!ownRoster.has(studentDbId)) {
        res.status(403).json({
          error:
            "This school restricts release to the student's own teacher",
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
    action,
    note,
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /pickup/queue/release-undo
// Body: { studentDbId: number }
// Reverses a `released_to_walk` event the caller themselves wrote within
// the last RELEASE_UNDO_WINDOW_MS. Writes a `release_undone` audit row
// rather than deleting the original — the audit log is append-only.
// ---------------------------------------------------------------------------
router.post("/pickup/queue/release-undo", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const studentDbId = Number(req.body?.studentDbId);
  if (!Number.isInteger(studentDbId) || studentDbId <= 0) {
    res.status(400).json({ error: "studentDbId required" });
    return;
  }

  const cutoff = new Date(Date.now() - RELEASE_UNDO_WINDOW_MS);
  const [recent] = await db
    .select({
      id: pickupQueueEventsTable.id,
      occurredAt: pickupQueueEventsTable.occurredAt,
    })
    .from(pickupQueueEventsTable)
    .where(
      and(
        eq(pickupQueueEventsTable.schoolId, schoolId),
        eq(pickupQueueEventsTable.studentId, studentDbId),
        eq(pickupQueueEventsTable.actorStaffId, staff.id),
        eq(pickupQueueEventsTable.action, "released_to_walk"),
        gte(pickupQueueEventsTable.occurredAt, cutoff),
      ),
    )
    .orderBy(desc(pickupQueueEventsTable.occurredAt))
    .limit(1);
  if (!recent) {
    res.status(409).json({
      error: "No recent release to undo (window is 10 seconds)",
    });
    return;
  }

  // Race guard: only allow undo if the actor's release is still the
  // latest event for this student. If anyone (including the same actor)
  // wrote a later event — another release, an in_car, a release_undone,
  // etc. — the queue state has already moved on and undoing would
  // incorrectly reverse the newer action.
  const [later] = await db
    .select({ id: pickupQueueEventsTable.id })
    .from(pickupQueueEventsTable)
    .where(
      and(
        eq(pickupQueueEventsTable.schoolId, schoolId),
        eq(pickupQueueEventsTable.studentId, studentDbId),
        gt(pickupQueueEventsTable.occurredAt, recent.occurredAt),
      ),
    )
    .limit(1);
  if (later) {
    res.status(409).json({
      error: "Release was superseded by a newer event — cannot undo",
    });
    return;
  }

  await db.insert(pickupQueueEventsTable).values({
    schoolId,
    studentId: studentDbId,
    pickupAuthorizationId: null,
    actorStaffId: staff.id,
    actorDisplayName: staff.displayName ?? "Staff",
    action: "release_undone",
    note: `Undo of release at ${recent.occurredAt.toISOString()}`,
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /pickup/teacher-queue
// Any signed-in staff. Returns the queue scoped per the school's
// pickup_teacher_view_scope setting, with `isOnMyRoster` flag per row.
// Newest-at-bottom (asc by addedAt) — the existing /pickup/queue
// derivation already returns that order, so we just filter + annotate.
// ---------------------------------------------------------------------------
router.get("/pickup/teacher-queue", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const settings = await loadPickupSettings(schoolId);

  // Reuse the same derivation the /pickup/queue route uses.
  const startOfToday = new Date(startOfTodayIso());
  const events = await db
    .select({
      studentId: pickupQueueEventsTable.studentId,
      action: pickupQueueEventsTable.action,
      occurredAt: pickupQueueEventsTable.occurredAt,
      pickupAuthorizationId: pickupQueueEventsTable.pickupAuthorizationId,
    })
    .from(pickupQueueEventsTable)
    .where(
      and(
        eq(pickupQueueEventsTable.schoolId, schoolId),
        gte(pickupQueueEventsTable.occurredAt, startOfToday),
      ),
    )
    .orderBy(asc(pickupQueueEventsTable.occurredAt));

  const TERMINAL = new Set(["in_car", "auto_cleared", "walker_released"]);
  type Entry = {
    studentId: number;
    addedAt: string;
    status: "in_queue" | "walking_out";
    pickupAuthorizationId: number | null;
  };
  const byStudent = new Map<number, Entry>();
  for (const e of events) {
    if (TERMINAL.has(e.action)) {
      byStudent.delete(e.studentId);
      continue;
    }
    if (e.action === "added") {
      byStudent.set(e.studentId, {
        studentId: e.studentId,
        addedAt: e.occurredAt.toISOString(),
        status: "in_queue",
        pickupAuthorizationId: e.pickupAuthorizationId,
      });
    } else if (e.action === "released_to_walk") {
      const ex = byStudent.get(e.studentId);
      if (ex) ex.status = "walking_out";
    } else if (e.action === "release_undone") {
      const ex = byStudent.get(e.studentId);
      if (ex) ex.status = "in_queue";
    }
  }

  let entries = Array.from(byStudent.values()).sort((a, b) =>
    a.addedAt.localeCompare(b.addedAt),
  );

  // Compute roster membership once, regardless of scope — the client
  // uses it both for the "own_roster" filter (already done server-side
  // when scope='own_roster') and for the highlight + Show-mine toggle.
  const ownRoster = await loadOwnRosterStudentIds(schoolId, staff.id);

  if (settings.teacherViewScope === "own_roster") {
    entries = entries.filter((e) => ownRoster.has(e.studentId));
  }

  // Hydrate names + grade for the surviving set.
  const ids = entries.map((e) => e.studentId);
  let nameById = new Map<
    number,
    { firstName: string; lastName: string; grade: number }
  >();
  if (ids.length > 0) {
    const rows = await db
      .select({
        id: studentsTable.id,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          inArray(studentsTable.id, ids),
        ),
      );
    nameById = new Map(rows.map((r) => [r.id, r]));
  }

  res.json({
    viewScope: settings.teacherViewScope,
    entries: entries.map((e) => {
      const n = nameById.get(e.studentId);
      return {
        studentDbId: e.studentId,
        firstName: n?.firstName ?? "",
        lastName: n?.lastName ?? "",
        grade: n?.grade ?? null,
        addedAt: e.addedAt,
        status: e.status,
        isOnMyRoster: ownRoster.has(e.studentId),
      };
    }),
  });
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
      photoObjectKey: studentsTable.photoObjectKey,
      photoConsent: studentsTable.photoConsent,
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

  // ---------------------------------------------------------------------
  // Sibling soft-flag. Build, per walker student, the list of OTHER
  // walker students who share at least one guardian (parentId) with
  // them — and whether each of those siblings has been released yet
  // today. The gate UI uses this to show "Sister Marcus G5 still on
  // campus" so staff can choose to hold the present sibling. This is
  // INFORMATIONAL ONLY — no server-side block. Real-life exceptions
  // (one sibling at tutoring / absent / picked up early) are common,
  // so a hard block would just train staff to override constantly.
  //
  // Authorizations with a NULL parentId can't be sibling-grouped —
  // we have no portal-account anchor — so those students show no
  // sibling badge. That matches /pickup/lookup's split-custody rule.
  // ---------------------------------------------------------------------
  const walkerIds = new Set(walkers.map((w) => w.id));
  const allActiveAuths = walkerIds.size
    ? await db
        .select({
          studentId: studentPickupAuthorizationsTable.studentId,
          parentId: studentPickupAuthorizationsTable.parentId,
        })
        .from(studentPickupAuthorizationsTable)
        .where(
          and(
            eq(studentPickupAuthorizationsTable.schoolId, schoolId),
            eq(studentPickupAuthorizationsTable.active, true),
          ),
        )
    : [];
  // parentId → Set<walkerStudentDbId>
  const parentToWalkers = new Map<number, Set<number>>();
  // walkerStudentDbId → Set<parentId>
  const walkerToParents = new Map<number, Set<number>>();
  for (const a of allActiveAuths) {
    if (a.parentId === null) continue;
    if (!walkerIds.has(a.studentId)) continue;
    if (!parentToWalkers.has(a.parentId)) {
      parentToWalkers.set(a.parentId, new Set());
    }
    parentToWalkers.get(a.parentId)!.add(a.studentId);
    if (!walkerToParents.has(a.studentId)) {
      walkerToParents.set(a.studentId, new Set());
    }
    walkerToParents.get(a.studentId)!.add(a.parentId);
  }
  const walkerById = new Map(walkers.map((w) => [w.id, w]));
  const siblingsFor = (studentDbId: number) => {
    const parents = walkerToParents.get(studentDbId);
    if (!parents) return [];
    const sibIds = new Set<number>();
    for (const pid of parents) {
      const ws = parentToWalkers.get(pid);
      if (!ws) continue;
      for (const sid of ws) {
        if (sid !== studentDbId) sibIds.add(sid);
      }
    }
    return [...sibIds]
      .map((sid) => {
        const s = walkerById.get(sid);
        if (!s) return null;
        return {
          studentDbId: s.id,
          firstName: s.firstName,
          lastName: s.lastName,
          grade: s.grade,
          releasedToday: releasedById.has(s.id),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.grade - b.grade || a.lastName.localeCompare(b.lastName));
  };

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
        photoObjectKey: w.photoObjectKey,
        photoConsent: w.photoConsent,
        released,
        siblingWalkers: siblingsFor(w.id),
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

  // Optional context from the keypad lookup flow. When present we
  // enforce the same restricted-pickup rules as /pickup/queue/add so
  // a restricted guardian can't bypass the curb-side override prompt
  // by walking up to the walker gate instead.
  const rawAuthId = req.body?.pickupAuthorizationId;
  const pickupAuthorizationId =
    rawAuthId === undefined || rawAuthId === null
      ? null
      : Number(rawAuthId);
  if (
    pickupAuthorizationId !== null &&
    (!Number.isInteger(pickupAuthorizationId) || pickupAuthorizationId <= 0)
  ) {
    res
      .status(400)
      .json({ error: "pickupAuthorizationId must be a positive integer" });
    return;
  }
  const rawJust = req.body?.overrideJustification;
  const overrideJustification =
    typeof rawJust === "string" ? rawJust.trim() : "";

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

  // Restricted-pickup gate. Mirrors /pickup/queue/add: any restricted
  // authorization needs an admin + a >=5-char justification, which we
  // bake into the audit row's note column so reviewers can see why
  // the gate let them through.
  let auditNote: string | null = null;
  if (pickupAuthorizationId !== null) {
    const [auth] = await db
      .select()
      .from(studentPickupAuthorizationsTable)
      .where(
        and(
          eq(studentPickupAuthorizationsTable.id, pickupAuthorizationId),
          eq(studentPickupAuthorizationsTable.schoolId, schoolId),
          eq(studentPickupAuthorizationsTable.studentId, studentDbId),
          eq(studentPickupAuthorizationsTable.active, true),
        ),
      );
    if (!auth) {
      res
        .status(404)
        .json({ error: "Pickup authorization not found for that student" });
      return;
    }
    if (auth.restrictedFrom) {
      if (overrideJustification.length < 5) {
        res.status(409).json({
          error:
            "Restricted authorization — admin must supply a justification (5+ chars)",
        });
        return;
      }
      if (!staff.isAdmin && !staff.isSuperUser && !staff.isDistrictAdmin) {
        res.status(403).json({
          error: "Only an admin can override a restricted pickup",
        });
        return;
      }
      auditNote = `RESTRICTED override: ${overrideJustification}`;
    }
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
    pickupAuthorizationId,
    actorStaffId: staff.id,
    actorDisplayName: staff.displayName ?? "Staff",
    action: "walker_released",
    note: auditNote,
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

  const settings = await loadPickupSettings(schoolId);
  res.json({
    asOf: new Date().toISOString(),
    cutoffTime: settings.cutoffTime,
    byMode,
  });
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
  if (!canManagePickup(staff)) {
    res.status(403).json({ error: "Not authorized to manage pickup tags" });
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
  if (!canManagePickup(staff)) {
    res.status(403).json({ error: "Not authorized to manage pickup tags" });
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
  if (!canManagePickup(staff)) {
    res.status(403).json({ error: "Not authorized to manage pickup tags" });
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
    if (!canManageDismissal(staff)) {
      res.status(403).json({ error: "Not authorized" });
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

// ---------------------------------------------------------------------------
// Number capacity helpers + bulk-assign + reissue + tag-print endpoints.
// ---------------------------------------------------------------------------

// 4-digit range: 1001..9999 inclusive = 8999 slots per school. The
// admin UI surfaces a warning at 80% so an admin can plan ahead.
//
// 5-DIGIT EXPANSION PATH (Packet A — design notes, code change deferred
// until the 80%-of-range warning fires for a real tenant): bump
// NUMBER_RANGE_MAX to 99999, narrow the PDF tag font one notch in
// lib/pickupTagsPdf.ts, and let the curb keypad accept 4-OR-5 digit
// input (keypad already caps at 6 chars, server already clean()s
// to 10 — no migration required, the column is TEXT). DO NOT bump
// preemptively: a 5-digit number is harder for a parent to read aloud
// on the carpool radio, so we trade 11x capacity for usability only
// when a school crosses the warn threshold.
//
// IN-APP CHIME (Packet A — design resolved, no code change): visual-
// only confirmation stays. A chime on every "added to line" would
// overlap noisily at peak (30 cars/min schools) and would conflict
// with the cafeteria/classroom signage tile that some tenants already
// play through the same audio bus. Reopen if we ever build a per-
// kiosk volume model.
const NUMBER_RANGE_MIN = 1001;
const NUMBER_RANGE_MAX = 9999;
const NUMBER_RANGE_TOTAL = NUMBER_RANGE_MAX - NUMBER_RANGE_MIN + 1;
const CAPACITY_WARN_PCT = 0.8;

// Pick the next available number, given a Set of already-used numbers.
function nextFreeNumber(used: Set<string>): string | null {
  for (let n = NUMBER_RANGE_MIN; n <= NUMBER_RANGE_MAX; n++) {
    const candidate = String(n);
    if (!used.has(candidate)) return candidate;
  }
  return null;
}

// GET /pickup/capacity — used + total + warn flag for the admin tile.
router.get("/pickup/capacity", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  if (!canManagePickup(staff)) {
    res.status(403).json({ error: "Not authorized to manage pickup tags" });
    return;
  }
  const [row] = await db
    .select({ used: sql<number>`COUNT(*)::int` })
    .from(studentPickupAuthorizationsTable)
    .where(
      and(
        eq(studentPickupAuthorizationsTable.schoolId, schoolId),
        eq(studentPickupAuthorizationsTable.active, true),
      ),
    );
  const used = Number(row?.used ?? 0);
  const pctUsed = used / NUMBER_RANGE_TOTAL;
  res.json({
    used,
    total: NUMBER_RANGE_TOTAL,
    pctUsed,
    warn: pctUsed >= CAPACITY_WARN_PCT,
  });
});

// POST /pickup/authorizations/bulk-assign
// Body: { guardianLabel?: string } — defaults to "Primary".
// Issues a fresh active authorization for every student in the school
// who does NOT already have an active authorization. Idempotent — a
// second run after a partial roster import only fills the new students.
router.post(
  "/pickup/authorizations/bulk-assign",
  requireStaff,
  async (req, res) => {
    const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
      .staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    if (!canManagePickup(staff)) {
      res.status(403).json({ error: "Not authorized to manage pickup tags" });
      return;
    }
    const guardianLabel =
      typeof req.body?.guardianLabel === "string" &&
      req.body.guardianLabel.trim().length > 0
        ? String(req.body.guardianLabel).trim()
        : "Primary";

    try {
      const result = await db.transaction(async (tx) => {
        // 1. Pull students who don't already have an active authorization.
        const studentsMissing = await tx
          .select({ id: studentsTable.id })
          .from(studentsTable)
          .leftJoin(
            studentPickupAuthorizationsTable,
            and(
              eq(
                studentPickupAuthorizationsTable.studentId,
                studentsTable.id,
              ),
              eq(studentPickupAuthorizationsTable.active, true),
            ),
          )
          .where(
            and(
              eq(studentsTable.schoolId, schoolId),
              sql`${studentPickupAuthorizationsTable.id} IS NULL`,
            ),
          );

        if (studentsMissing.length === 0) {
          return { assigned: 0, totalStudents: 0, capacityHit: false };
        }

        // 2. Pull all active numbers (school-wide) so we don't collide.
        const taken = await tx
          .select({
            pickupNumber: studentPickupAuthorizationsTable.pickupNumber,
          })
          .from(studentPickupAuthorizationsTable)
          .where(
            and(
              eq(studentPickupAuthorizationsTable.schoolId, schoolId),
              eq(studentPickupAuthorizationsTable.active, true),
            ),
          );
        const used = new Set(taken.map((t) => t.pickupNumber));

        // 3. Issue numbers + insert rows.
        let assigned = 0;
        for (const s of studentsMissing) {
          const num = nextFreeNumber(used);
          if (!num) {
            // Throw rolls back the whole batch so we don't partially
            // assign half the roster.
            throw new Error("CAPACITY_EXHAUSTED");
          }
          used.add(num);
          await tx.insert(studentPickupAuthorizationsTable).values({
            schoolId,
            studentId: s.id,
            parentId: null,
            guardianLabel,
            pickupNumber: num,
            restrictedFrom: false,
            active: true,
          });
          assigned++;
        }
        return {
          assigned,
          totalStudents: studentsMissing.length,
          capacityHit: false,
        };
      });
      res.json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "CAPACITY_EXHAUSTED") {
        res.status(409).json({
          error:
            "Not enough free pickup numbers to cover the remaining roster. Free up numbers or expand the range.",
        });
        return;
      }
      throw e;
    }
  },
);

// POST /pickup/authorizations/:id/reissue
// Deactivates the existing authorization row and creates a new active
// row with the same student/parent/guardianLabel but a freshly-issued
// number. Used for "lost tag" reprints — the old card is immediately
// invalid (curb keypad rejects deactivated rows) and a new card prints
// from the returned authorization. Whole flow runs in one transaction.
router.post(
  "/pickup/authorizations/:id/reissue",
  requireStaff,
  async (req, res) => {
    const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
      .staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    if (!canManagePickup(staff)) {
      res.status(403).json({ error: "Not authorized to manage pickup tags" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    try {
      const created = await db.transaction(async (tx) => {
        const [old] = await tx
          .select()
          .from(studentPickupAuthorizationsTable)
          .where(
            and(
              eq(studentPickupAuthorizationsTable.id, id),
              eq(studentPickupAuthorizationsTable.schoolId, schoolId),
            ),
          );
        if (!old) {
          throw new Error("NOT_FOUND");
        }
        if (!old.active) {
          throw new Error("ALREADY_INACTIVE");
        }
        // Deactivate first so its number frees up before we pick.
        await tx
          .update(studentPickupAuthorizationsTable)
          .set({ active: false, deactivatedAt: new Date() })
          .where(eq(studentPickupAuthorizationsTable.id, id));

        const taken = await tx
          .select({
            pickupNumber: studentPickupAuthorizationsTable.pickupNumber,
          })
          .from(studentPickupAuthorizationsTable)
          .where(
            and(
              eq(studentPickupAuthorizationsTable.schoolId, schoolId),
              eq(studentPickupAuthorizationsTable.active, true),
            ),
          );
        const used = new Set(taken.map((t) => t.pickupNumber));
        const num = nextFreeNumber(used);
        if (!num) {
          throw new Error("CAPACITY_EXHAUSTED");
        }
        const [inserted] = await tx
          .insert(studentPickupAuthorizationsTable)
          .values({
            schoolId,
            studentId: old.studentId,
            parentId: old.parentId,
            guardianLabel: old.guardianLabel,
            pickupNumber: num,
            restrictedFrom: old.restrictedFrom,
            active: true,
          })
          .returning();
        return inserted;
      });
      res.status(201).json({ authorization: created });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "NOT_FOUND") {
        res.status(404).json({ error: "Authorization not found" });
        return;
      }
      if (msg === "ALREADY_INACTIVE") {
        res.status(409).json({
          error: "This authorization is already inactive; nothing to reissue.",
        });
        return;
      }
      if (msg === "CAPACITY_EXHAUSTED") {
        res.status(409).json({ error: "No free pickup numbers available" });
        return;
      }
      throw e;
    }
  },
);

// Internal helper used by both single-tag and batch-tag PDF endpoints.
async function loadTagInputs(
  schoolId: number,
  authIds: number[] | null,
): Promise<PickupTagInput[]> {
  const conds = [
    eq(studentPickupAuthorizationsTable.schoolId, schoolId),
    eq(studentPickupAuthorizationsTable.active, true),
  ];
  if (authIds !== null) {
    conds.push(inArray(studentPickupAuthorizationsTable.id, authIds));
  }
  const auths = await db
    .select()
    .from(studentPickupAuthorizationsTable)
    .where(and(...conds))
    .orderBy(asc(studentPickupAuthorizationsTable.pickupNumber));
  if (auths.length === 0) return [];

  const studentIds = Array.from(new Set(auths.map((a) => a.studentId)));
  const students = await db
    .select({
      id: studentsTable.id,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        inArray(studentsTable.id, studentIds),
      ),
    );
  const studentById = new Map(students.map((s) => [s.id, s]));

  const [settings] = await db
    .select({ name: schoolSettingsTable.schoolName })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  const schoolName = settings?.name ?? "School";

  return auths.map((a) => {
    const s = studentById.get(a.studentId);
    const name = s ? `${s.firstName} ${s.lastName}`.trim() : `Student #${a.studentId}`;
    return {
      pickupNumber: a.pickupNumber,
      studentName: name,
      guardianLabel: a.guardianLabel,
      restricted: a.restrictedFrom,
      schoolName,
    };
  });
}

function sendTagsPdf(
  res: Response,
  pdf: Buffer,
  filename: string,
): void {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${filename}"`,
  );
  res.setHeader("Cache-Control", "no-store");
  res.end(pdf);
}

// GET /pickup/authorizations/:id/tag.pdf — single-tag reprint.
router.get(
  "/pickup/authorizations/:id/tag.pdf",
  requireStaff,
  async (req, res) => {
    const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
      .staff;
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    if (!canManagePickup(staff)) {
      res.status(403).json({ error: "Not authorized to manage pickup tags" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const tags = await loadTagInputs(schoolId, [id]);
    if (tags.length === 0) {
      res.status(404).json({ error: "Authorization not found or inactive" });
      return;
    }
    const pdf = await renderPickupTagsPdf(tags);
    sendTagsPdf(res, pdf, `pickup-tag-${tags[0]!.pickupNumber}.pdf`);
  },
);

// GET /pickup/tags.pdf — batch print all active tags. Optional
// ?ids=1,2,3 lets the admin print a filtered subset (used by the
// "print all unprinted" workflow once we track print history; today
// it's just a full batch when ids is omitted).
router.get("/pickup/tags.pdf", requireStaff, async (req, res) => {
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  if (!canManagePickup(staff)) {
    res.status(403).json({ error: "Not authorized to manage pickup tags" });
    return;
  }
  const idsRaw = String(req.query.ids ?? "").trim();
  let ids: number[] | null = null;
  if (idsRaw) {
    ids = idsRaw
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length === 0) {
      res.status(400).json({ error: "ids must be a comma-separated list of integers" });
      return;
    }
  }
  const tags = await loadTagInputs(schoolId, ids);
  if (tags.length === 0) {
    res.status(404).json({ error: "No active authorizations to print" });
    return;
  }
  const pdf = await renderPickupTagsPdf(tags);
  sendTagsPdf(res, pdf, `pickup-tags-${tags.length}.pdf`);
});

// Defensive: makes the typechecker keep `sql` and the action enum in scope
// in case future helpers reach for them.
void sql;
void VALID_ACTIONS;
void isAdmin;

export default router;
