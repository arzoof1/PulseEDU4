import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { createHash } from "node:crypto";
import {
  db,
  hallPassQueueTable,
  kioskActivationsTable,
  kioskViewerTokensTable,
  hallPassesTable,
  studentsTable,
  staffTable,
  schoolsTable,
  locationsTable,
} from "@workspace/db";
import { and, eq, inArray, isNull, gt, asc, ne, sql } from "drizzle-orm";
import { genUrlSafeToken } from "../lib/urlSafeToken.js";
import {
  loadDayTypeContext,
  contextForVariant,
  minutesOfDayInTz,
} from "../lib/scheduleResolver.js";
import { autoEndStalePasses } from "../lib/hallPassLifecycle.js";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam } from "../lib/coreTeam.js";
import { findPolarityConflict } from "./polarityPairs";
import {
  findEscortHold,
  ESCORT_KIOSK_MESSAGE,
} from "../lib/safetyPlanEscort.js";
import { findDailyLimitConflict } from "./studentHallPassLimits";
import { resolveStudentIdInput } from "../lib/studentIdResolver.js";
import {
  loadRestroomDestinationNames,
  loadKioskTeacherDisplayName,
  passHeadsToKiosk,
} from "../lib/oneWayPass.js";

// How long a minted viewer token stays usable. The token is also killed
// the moment the underlying kiosk activation is deactivated, so this is
// just an upper bound for "I scanned this QR yesterday and forgot".
const VIEWER_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

// Predicate: can `staff` view/manage the line for the given ROOM?
//
// Mirrors the kiosk take-over policy (admin/core team OR the room is their
// own OR they activated a live kiosk standing in it) so the staff app and the
// activation flow stay consistent. Keyed on the room rather than an
// activation row, because a teacher-created line has no activation at all —
// the previous signature had no way to express "this is my room, there is no
// kiosk".
function canManageRoomQueue(
  staff: {
    id: number;
    defaultRoom: string | null;
    isAdmin?: boolean | null;
    isSuperUser?: boolean | null;
    isDistrictAdmin?: boolean | null;
    isBehaviorSpecialist?: boolean | null;
    isMtssCoordinator?: boolean | null;
    isSchoolPsychologist?: boolean | null;
  },
  target: { room: string; activatorStaffIds?: number[] },
): boolean {
  if (isCoreTeam(staff)) return true;
  if ((target.activatorStaffIds ?? []).includes(staff.id)) return true;
  if (
    staff.defaultRoom &&
    staff.defaultRoom.trim().length > 0 &&
    staff.defaultRoom === target.room
  ) {
    return true;
  }
  return false;
}

// Clear every stale-period row across the school in one statement. The
// per-room clearStaleAndList only touches one room; the staff panel spans
// all rooms the user can manage, so it needs the school-wide sweep.
async function clearStaleForSchool(schoolId: number) {
  const periodKey = await getCurrentPeriodKey(schoolId);
  await db
    .delete(hallPassQueueTable)
    .where(
      and(
        eq(hallPassQueueTable.schoolId, schoolId),
        ne(hallPassQueueTable.periodKey, periodKey),
      ),
    );
}

const router: IRouter = Router();

// Hard cap on a single kiosk's queue. Beyond this the kiosk shows
// "Line is full, try in a minute." Keeps the line from becoming a hangout.
// Exported so routes/kiosk.ts can enforce the same cap when it enqueues a
// student that hit the keep-apart hold.
export const QUEUE_CAP = 5;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function requireStaff(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  (req as Request & { staff: typeof staff }).staff = staff;
  next();
}

async function loadActivationByToken(token: unknown) {
  if (typeof token !== "string" || token.length < 16) return null;
  const [act] = await db
    .select()
    .from(kioskActivationsTable)
    .where(
      and(
        eq(kioskActivationsTable.tokenHash, hashToken(token)),
        isNull(kioskActivationsTable.deactivatedAt),
        gt(kioskActivationsTable.expiresAt, new Date()),
      ),
    );
  return act ?? null;
}

// Compute the current period key for a school.
//
// Order of preference:
//  1. School has a default, active bell schedule and "now" falls inside one
//     of its periods → key = `s<scheduleId>:p<periodNumber>`. The queue is
//     wiped when this key changes (i.e. period rollover).
//  2. School has a bell schedule but we're between periods (passing time,
//     before/after school) → key = `s<scheduleId>:between:<dayKey>`.
//  3. School has NO bell schedule configured → 45-minute idle buckets per
//     day. This is a safety net so the feature still works for a school in
//     onboarding; the onboarding doc instructs admins to configure a bell
//     schedule for proper period-based reset.
export async function getCurrentPeriodKey(schoolId: number): Promise<string> {
  // MULTI-SCHEDULE: the queue is a per-ROOM construct, so its rollover key
  // follows the Day Type's DEFAULT variant (a kiosk queue can hold students
  // from several grades; per-student keys would fragment the line). Uses
  // the central resolver — school timezone included (the old version used
  // the server's local clock).
  const now = new Date();
  const ctx = await loadDayTypeContext(schoolId);
  const dayKeyParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ctx.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // en-CA → YYYY-MM-DD
  const dayKey = dayKeyParts;
  if (ctx.status === "ok" && ctx.dayType && ctx.defaultVariant) {
    const sc = contextForVariant(ctx, ctx.defaultVariant, now);
    if (sc.currentBlock && sc.periodNumber != null) {
      return `s${ctx.dayType.id}:p${sc.periodNumber}:${dayKey}`;
    }
    return `s${ctx.dayType.id}:between:${dayKey}`;
  }
  const mod = Math.floor(minutesOfDayInTz(now, ctx.timezone));
  const bucket = Math.floor(mod / 45);
  return `idle:${dayKey}:${bucket}`;
}

// Drop entries whose period key doesn't match "now", then return the
// surviving queue rows ordered by position.
//
// Scoped by (schoolId, room) rather than by activation: a kiosk and the
// teacher standing in the same room must see ONE line. Callers pass the
// room, which for a kiosk is `activation.room` and for staff is their
// resolved default room.
async function clearStaleAndList(act: { schoolId: number; room: string }) {
  const periodKey = await getCurrentPeriodKey(act.schoolId);
  await db
    .delete(hallPassQueueTable)
    .where(
      and(
        eq(hallPassQueueTable.schoolId, act.schoolId),
        eq(hallPassQueueTable.room, act.room),
        ne(hallPassQueueTable.periodKey, periodKey),
      ),
    );
  const rows = await db
    .select({
      id: hallPassQueueTable.id,
      schoolId: hallPassQueueTable.schoolId,
      kioskActivationId: hallPassQueueTable.kioskActivationId,
      room: hallPassQueueTable.room,
      studentId: hallPassQueueTable.studentId,
      firstName: hallPassQueueTable.firstName,
      lastName: hallPassQueueTable.lastName,
      destination: hallPassQueueTable.destination,
      position: hallPassQueueTable.position,
      addedAt: hallPassQueueTable.addedAt,
      periodKey: hallPassQueueTable.periodKey,
      // Joined from the roster so the kiosk's next-up confirm can verify the
      // student-typed Local SIS id without a second round-trip. The queue row
      // itself stores the internal student_id; the SIS id is the human-facing
      // value students scan/type.
      localSisId: studentsTable.localSisId,
      photoObjectKey: studentsTable.photoObjectKey,
      photoConsent: studentsTable.photoConsent,
    })
    .from(hallPassQueueTable)
    .leftJoin(
      studentsTable,
      and(
        eq(studentsTable.studentId, hallPassQueueTable.studentId),
        eq(studentsTable.schoolId, hallPassQueueTable.schoolId),
      ),
    )
    .where(
      and(
        eq(hallPassQueueTable.schoolId, act.schoolId),
        eq(hallPassQueueTable.room, act.room),
      ),
    )
    .orderBy(asc(hallPassQueueTable.position), asc(hallPassQueueTable.id));
  return { periodKey, rows };
}

// Shared enqueue core. Both the kiosk path (student scans their own ID) and
// the staff path (teacher adds a student) funnel through this so the cap,
// duplicate rule, and position assignment cannot drift apart between the two
// surfaces — the same lesson as the kiosk destination GET/POST parity rule.
//
// The critical section takes a row-level lock over the ROOM's rows. Anchored
// to the activation this was `WHERE kiosk_activation_id = ?`; with teacher
// entries carrying a null activation there is no such row to lock, so the cap
// has to key on (school_id, room) or two simultaneous adds both slip past 5.
export async function enqueueStudent(opts: {
  schoolId: number;
  room: string;
  studentId: string;
  firstName: string | null;
  lastName: string | null;
  destination: string;
  kioskActivationId: number | null;
}): Promise<
  | { kind: "full" }
  | { kind: "duplicate" }
  | {
      kind: "ok";
      row: typeof hallPassQueueTable.$inferSelect;
      after: Array<typeof hallPassQueueTable.$inferSelect>;
    }
> {
  const periodKey = await getCurrentPeriodKey(opts.schoolId);

  // Clear stale BEFORE the transaction. Rows from a previous period must
  // never count toward this period's cap.
  await db
    .delete(hallPassQueueTable)
    .where(
      and(
        eq(hallPassQueueTable.schoolId, opts.schoolId),
        eq(hallPassQueueTable.room, opts.room),
        ne(hallPassQueueTable.periodKey, periodKey),
      ),
    );

  const roomScope = and(
    eq(hallPassQueueTable.schoolId, opts.schoolId),
    eq(hallPassQueueTable.room, opts.room),
  );

  try {
    return await db.transaction(async (tx) => {
      // Serialize on the ROOM, not on the room's existing rows.
      //
      // `SELECT ... FOR UPDATE` only locks rows that already exist. Under the
      // old activation anchor that was fine — the activation row was always
      // present to lock. Anchored to a room, an EMPTY line has nothing to
      // lock, so N concurrent adds each saw zero rows and every one of them
      // passed the cap check. (Verified: six simultaneous adds all returned
      // 200 and the line held 6.)
      //
      // A transaction-scoped advisory lock keyed on (school, room) always
      // exists, so it serializes the critical section even from empty. It's
      // released automatically at commit/rollback.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`hpq:${opts.schoolId}:${opts.room}`}))`,
      );
      const locked = await tx
        .select()
        .from(hallPassQueueTable)
        .where(roomScope)
        .orderBy(asc(hallPassQueueTable.position), asc(hallPassQueueTable.id))
        .for("update");
      if (locked.length >= QUEUE_CAP) return { kind: "full" as const };
      if (locked.some((r) => r.studentId === opts.studentId)) {
        return { kind: "duplicate" as const };
      }
      const nextPos =
        locked.reduce((m, r) => (r.position > m ? r.position : m), 0) + 1;
      const [row] = await tx
        .insert(hallPassQueueTable)
        .values({
          schoolId: opts.schoolId,
          kioskActivationId: opts.kioskActivationId,
          room: opts.room,
          studentId: opts.studentId,
          firstName: opts.firstName,
          lastName: opts.lastName,
          destination: opts.destination,
          position: nextPos,
          periodKey,
        })
        .returning();
      const after = await tx
        .select()
        .from(hallPassQueueTable)
        .where(roomScope)
        .orderBy(asc(hallPassQueueTable.position), asc(hallPassQueueTable.id));
      return { kind: "ok" as const, row, after };
    });
  } catch (err: unknown) {
    // 23505 = the room+student unique index caught a concurrent insert that
    // raced past the in-transaction check. Same friendly outcome.
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code === "23505") return { kind: "duplicate" as const };
    throw err;
  }
}

// Resolve the room a staff member's queue actions apply to, enforcing the
// same rule kiosk activation enforces: the room must exist as an ACTIVE
// ORIGIN location for the school. Teacher rooms are free text on
// staff_defaults/staff.default_room and can drift from the curated locations
// list, so without this the teacher path would invent rooms a kiosk would
// never accept. Returns null with a reason the caller turns into a 400.
export async function resolveStaffRoom(
  schoolId: number,
  staff: { defaultRoom: string | null },
): Promise<{ room: string } | { error: string }> {
  const room = (staff.defaultRoom ?? "").trim();
  if (!room) {
    return {
      error:
        "You don't have a room set. Ask an admin to set your room before using the line.",
    };
  }
  const [loc] = await db
    .select({ name: locationsTable.name })
    .from(locationsTable)
    .where(
      and(
        eq(locationsTable.schoolId, schoolId),
        eq(locationsTable.name, room),
        eq(locationsTable.isOrigin, true),
        eq(locationsTable.active, true),
      ),
    );
  if (!loc) {
    return {
      error: `"${room}" is not a valid room for a hall pass line. Ask an admin to set it up as a location.`,
    };
  }
  return { room };
}

function shapeEntry(
  row: {
    id: number;
    studentId: string;
    firstName: string | null;
    lastName: string | null;
    destination: string;
    addedAt: Date | string;
    localSisId?: string | null;
    photoObjectKey?: string | null;
    photoConsent?: boolean | null;
  },
  idx: number,
) {
  return {
    id: row.id,
    studentId: row.studentId,
    // Human-facing Local SIS id (null when called from a code path that
    // doesn't join the roster — e.g. the immediate post-add response, where
    // the client refetches the joined list anyway).
    localSisId: row.localSisId ?? null,
    firstName: row.firstName,
    lastName: row.lastName,
    destination: row.destination,
    position: idx + 1,
    addedAt:
      row.addedAt instanceof Date ? row.addedAt.toISOString() : row.addedAt,
    // Consent-gated photo key for the kiosk QueueStrip / NextUp avatar.
    // Null when the student withholds consent or no photo path is set, or
    // when called from a non-joined code path (photoConsent undefined).
    photoObjectKey: row.photoConsent ? row.photoObjectKey ?? null : null,
  };
}

// ---------------------------------------------------------------------------
// Kiosk-token endpoints (unauthenticated; the activation token is the auth)
// ---------------------------------------------------------------------------

router.get("/kiosk/queue/:token", async (req, res) => {
  const act = await loadActivationByToken(req.params.token);
  if (act) await autoEndStalePasses(act.schoolId);
  if (!act) {
    res
      .status(401)
      .json({ error: "Kiosk activation not found", revoked: true });
    return;
  }
  const { rows } = await clearStaleAndList(act);
  // The kiosk polls this endpoint. We surface two extra fields so a slot
  // opening from ANY source — the out student tapping "I'm back", a teacher
  // ending a pass from the staff app, or a staff queue cancel — advances the
  // line on the kiosk without anyone re-scanning:
  //   - nextUp: the first ELIGIBLE waiting student (keep-apart / daily-limit
  //     holds are skipped, preserving arrival fairness) the kiosk should
  //     promote to the "Welcome [Name] — enter your ID" handoff prompt.
  //   - activePassIds: ids of passes still OUT from this room, so the kiosk
  //     can detect that the student on its TimerScreen was ended remotely
  //     and clear the now-stale countdown.
  const nextUp = await firstEligible(rows, act.schoolId);
  const activeRows = await db
    .select({ id: hallPassesTable.id })
    .from(hallPassesTable)
    .where(
      and(
        eq(hallPassesTable.schoolId, act.schoolId),
        eq(hallPassesTable.status, "active"),
        eq(hallPassesTable.originRoom, act.room),
      ),
    );

  // One-way lifecycle surfaces for this kiosk's room:
  //   - inRouteFromHere: students who LEFT this room on a one-way pass and
  //     haven't checked in yet (origin == room). The origin kiosk shows a big
  //     "IN ROUTE" card per student until they arrive/end.
  //   - arrivalsToHere: students HEADED to this room (destination == room),
  //     not yet arrived. A destination kiosk taps one to check them in.
  // Restroom passes are round-trip and excluded from both.
  const restroomNames = await loadRestroomDestinationNames(act.schoolId);
  // Inbound passes are often addressed to the teacher (destination == teacher
  // displayName) rather than the kiosk's activated room string, so resolve the
  // activating teacher to match those too. See passHeadsToKiosk.
  const kioskTeacher = await loadKioskTeacherDisplayName(
    act.schoolId,
    act.staffId,
  );
  const oneWayActive = (await db
    .select({
      id: hallPassesTable.id,
      studentId: hallPassesTable.studentId,
      destination: hallPassesTable.destination,
      originRoom: hallPassesTable.originRoom,
      createdAt: hallPassesTable.createdAt,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      localSisId: studentsTable.localSisId,
      photoObjectKey: studentsTable.photoObjectKey,
      photoConsent: studentsTable.photoConsent,
    })
    .from(hallPassesTable)
    .leftJoin(
      studentsTable,
      and(
        eq(studentsTable.studentId, hallPassesTable.studentId),
        eq(studentsTable.schoolId, hallPassesTable.schoolId),
      ),
    )
    .where(
      and(
        eq(hallPassesTable.schoolId, act.schoolId),
        eq(hallPassesTable.status, "active"),
        isNull(hallPassesTable.arrivedAt),
      ),
    )) as Array<{
    id: number;
    studentId: string;
    destination: string;
    originRoom: string;
    createdAt: string;
    firstName: string | null;
    lastName: string | null;
    localSisId: string | null;
    photoObjectKey: string | null;
    photoConsent: boolean | null;
  }>;

  const shapeOneWay = (r: (typeof oneWayActive)[number]) => ({
    id: r.id,
    studentId: r.studentId,
    localSisId: r.localSisId ?? null,
    firstName: r.firstName,
    lastName: r.lastName,
    destination: r.destination,
    originRoom: r.originRoom,
    createdAt: r.createdAt,
    // Consent-gated: only expose the key when the student consents, so the
    // kiosk <img> never even attempts to load a non-consenting photo.
    photoObjectKey: r.photoConsent ? r.photoObjectKey ?? null : null,
  });

  const inRouteFromHere = oneWayActive
    .filter(
      (r) => r.originRoom === act.room && !restroomNames.has(r.destination),
    )
    .map(shapeOneWay);
  const arrivalsToHere = oneWayActive
    .filter(
      (r) =>
        passHeadsToKiosk(r, act.room, kioskTeacher) &&
        !restroomNames.has(r.destination),
    )
    .map(shapeOneWay);

  res.json({
    capacity: QUEUE_CAP,
    entries: rows.map((r, i) => shapeEntry(r, i)),
    nextUp,
    activePassIds: activeRows.map((r) => r.id),
    inRouteFromHere,
    arrivalsToHere,
  });
});

router.post("/kiosk/queue/:token/add", async (req, res) => {
  const act = await loadActivationByToken(req.params.token);
  if (act) await autoEndStalePasses(act.schoolId);
  if (!act) {
    res
      .status(401)
      .json({ error: "Kiosk activation not found", revoked: true });
    return;
  }
  const { studentId, destination } = req.body ?? {};
  if (typeof studentId !== "string" || !studentId.trim()) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  if (typeof destination !== "string" || !destination.trim()) {
    res.status(400).json({ error: "destination is required" });
    return;
  }
  // Students scan/type their human-facing Local SIS id; resolve it to the
  // canonical roster row so we store the internal student_id on the queue
  // (and cache the name) while verifying they belong to this school.
  const [student] = await db
    .select()
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.localSisId, studentId.trim()),
        eq(studentsTable.schoolId, act.schoolId),
      ),
    );
  if (!student) {
    res
      .status(404)
      .json({ error: "Student not found — check your ID and try again." });
    return;
  }
  const trimmedId = student.studentId;

  // Escort-required safety plan: hard block from the queue too (a queued
  // student would eventually be issued a pass). Neutral message — this is
  // a shared student-facing screen.
  const escortHold = await findEscortHold(act.schoolId, trimmedId);
  if (escortHold) {
    res.status(409).json({ error: ESCORT_KIOSK_MESSAGE });
    return;
  }

  // Don't queue someone who's currently out on a pass from this room — they
  // already have one. Saves a footgun and a confusing queue display.
  const [activePass] = await db
    .select()
    .from(hallPassesTable)
    .where(
      and(
        eq(hallPassesTable.schoolId, act.schoolId),
        eq(hallPassesTable.studentId, trimmedId),
        eq(hallPassesTable.status, "active"),
        eq(hallPassesTable.originRoom, act.room),
      ),
    );
  if (activePass) {
    res.status(409).json({
      error: "You're already on a pass — tap I'm back when you return.",
    });
    return;
  }

  // Cap, duplicate rule, and position assignment all live in the shared
  // enqueue core so this path and the staff path can't drift.
  let inserted: typeof hallPassQueueTable.$inferSelect;
  let fresh: Array<typeof hallPassQueueTable.$inferSelect>;
  try {
    const txnResult = await enqueueStudent({
      schoolId: act.schoolId,
      room: act.room,
      studentId: trimmedId,
      firstName: student.firstName ?? null,
      lastName: student.lastName ?? null,
      destination: destination.trim(),
      kioskActivationId: act.id,
    });
    if (txnResult.kind === "full") {
      res
        .status(409)
        .json({ error: "Line is full — try again in a minute." });
      return;
    }
    if (txnResult.kind === "duplicate") {
      res.status(409).json({ error: "You're already in line." });
      return;
    }
    inserted = txnResult.row;
    fresh = txnResult.after;
  } catch (err: unknown) {
    req.log.error({ err }, "hall-pass-queue add failed");
    res.status(500).json({ error: "Could not add to queue" });
    return;
  }

  const myIdx = fresh.findIndex((r) => r.id === inserted.id);
  res.json({
    position: myIdx + 1,
    capacity: QUEUE_CAP,
    entries: fresh.map((r, i) => shapeEntry(r, i)),
  });
});

// Skip / not-here. Removes the entry by studentId from this kiosk's queue.
// Used by the "Skip" button on the next-up prompt and by anyone who walked
// off and wants to give up their slot.
router.post("/kiosk/queue/:token/skip", async (req, res) => {
  const act = await loadActivationByToken(req.params.token);
  if (!act) {
    res
      .status(401)
      .json({ error: "Kiosk activation not found", revoked: true });
    return;
  }
  const { studentId } = req.body ?? {};
  if (typeof studentId !== "string" || !studentId.trim()) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  // The client sends back the entry's canonical student_id (the value
  // shapeEntry returned), so match it exactly — no case folding. Queue rows
  // store the canonical id verbatim; uppercasing here could miss a delete.
  const trimmedId = studentId.trim();
  await db
    .delete(hallPassQueueTable)
    .where(
      and(
        eq(hallPassQueueTable.schoolId, act.schoolId),
        eq(hallPassQueueTable.room, act.room),
        eq(hallPassQueueTable.studentId, trimmedId),
      ),
    );
  const { rows } = await clearStaleAndList(act);
  res.json({
    capacity: QUEUE_CAP,
    entries: rows.map((r, i) => shapeEntry(r, i)),
  });
});

// ---------------------------------------------------------------------------
// Server-side helper used by routes/kiosk.ts to consume a queue entry on
// successful pass create and to surface "next up" on successful return.
// Re-exported via this module so the kiosk router can import without a
// circular dependency on the table schema only.
// ---------------------------------------------------------------------------

export async function consumeQueueEntry(
  scope: { schoolId: number; room: string },
  studentId: string,
) {
  // Callers pass the canonical student_id (resolved from local_sis_id in the
  // kiosk routes). Queue rows store that id verbatim, so match exactly.
  //
  // Room-scoped: consuming must clear the entry regardless of whether the
  // student joined the line from a kiosk or was added by their teacher.
  await db
    .delete(hallPassQueueTable)
    .where(
      and(
        eq(hallPassQueueTable.schoolId, scope.schoolId),
        eq(hallPassQueueTable.room, scope.room),
        eq(hallPassQueueTable.studentId, studentId),
      ),
    );
}

// Skip-and-badge: walk arrival order and return the first entry that is
// currently eligible to leave — i.e. NOT blocked by either a keep-apart
// hold OR a daily-limit cap they hit while waiting in line. Preserves
// arrival fairness; blocked students don't lose their place, the kiosk
// just calls the next eligible kid until they're cleared. Shared by the
// pass-end "next up" response and the kiosk's queue poll.
async function firstEligible(
  rows: Array<{
    studentId: string;
    localSisId?: string | null;
    firstName: string | null;
    lastName: string | null;
    destination: string;
    photoObjectKey?: string | null;
    photoConsent?: boolean | null;
  }>,
  schoolId: number,
) {
  for (const row of rows) {
    const polarity = await findPolarityConflict(row.studentId, schoolId);
    if (polarity) continue;
    const limit = await findDailyLimitConflict(row.studentId, schoolId);
    if (limit) continue;
    return {
      studentId: row.studentId,
      localSisId: row.localSisId ?? null,
      firstName: row.firstName,
      lastName: row.lastName,
      destination: row.destination,
      photoObjectKey: row.photoConsent ? row.photoObjectKey ?? null : null,
    };
  }
  return null;
}

export async function peekNextInQueue(act: {
  schoolId: number;
  room: string;
}) {
  const { rows } = await clearStaleAndList(act);
  if (rows.length === 0) return null;
  return firstEligible(rows, act.schoolId);
}

// ---------------------------------------------------------------------------
// Staff endpoints — for the teacher-side "Queue · N waiting" chip.
// ---------------------------------------------------------------------------

router.get("/hall-pass-queue", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  await autoEndStalePasses(schoolId);
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;

  // Clear stale entries for every room this school has a line in, so the
  // panel never shows a previous period's leftovers.
  await clearStaleForSchool(schoolId);

  // Pull every queue entry in this school. NO join to kiosk_activations:
  // that join used to be an INNER JOIN, which silently dropped any entry
  // without an activation — i.e. every teacher-created entry would have been
  // invisible here and undeletable below. Authorization now comes from the
  // entry's own room, which is the anchor.
  const rows = await db
    .select({
      id: hallPassQueueTable.id,
      room: hallPassQueueTable.room,
      studentId: hallPassQueueTable.studentId,
      firstName: hallPassQueueTable.firstName,
      lastName: hallPassQueueTable.lastName,
      destination: hallPassQueueTable.destination,
      position: hallPassQueueTable.position,
      addedAt: hallPassQueueTable.addedAt,
      kioskActivationId: hallPassQueueTable.kioskActivationId,
    })
    .from(hallPassQueueTable)
    .where(eq(hallPassQueueTable.schoolId, schoolId))
    .orderBy(
      asc(hallPassQueueTable.room),
      asc(hallPassQueueTable.position),
      asc(hallPassQueueTable.id),
    );

  // A room's line is manageable if the staff member owns that room (default
  // room), is Core Team, or activated a live kiosk standing in it. The
  // activation lookup is now an ENRICHMENT, not a filter.
  const liveActivationsForAuthz = await db
    .select({
      room: kioskActivationsTable.room,
      staffId: kioskActivationsTable.staffId,
    })
    .from(kioskActivationsTable)
    .where(
      and(
        eq(kioskActivationsTable.schoolId, schoolId),
        isNull(kioskActivationsTable.deactivatedAt),
        gt(kioskActivationsTable.expiresAt, new Date()),
      ),
    );
  const activatorsByRoom = new Map<string, number[]>();
  for (const a of liveActivationsForAuthz) {
    const list = activatorsByRoom.get(a.room) ?? [];
    list.push(a.staffId);
    activatorsByRoom.set(a.room, list);
  }
  const canManage = (room: string) =>
    canManageRoomQueue(staff, {
      room,
      activatorStaffIds: activatorsByRoom.get(room) ?? [],
    });

  const manageableRooms = new Set<string>();
  const filteredRows = rows.filter((r) => canManage(r.room));
  // Compute keep-apart hold per entry. A queued student is "blocked" while
  // any of their polarity partners has an active hall pass right now. We
  // intentionally don't surface the partner's name to the panel — staff
  // can look up keep-apart pairs in the polarity admin if they need to.
  // Queue sizes are tiny (≤5/kiosk * a few kiosks), so per-row lookups
  // are fine.
  const blockedFlags = await Promise.all(
    filteredRows.map(async (r) => {
      const c = await findPolarityConflict(r.studentId, schoolId);
      return c !== null;
    }),
  );
  // Present positions as a dense 1..n PER ROOM rather than echoing the stored
  // `position`. Removing the student at position 1 leaves the rest stored as
  // 2,3 — correct for ordering, but the panel would then show a line that
  // starts at "2". The kiosk already renumbers this way in shapeEntry, so
  // this keeps the two surfaces telling the teacher the same thing.
  const seenPerRoom = new Map<string, number>();
  const entries = filteredRows.map((r, i) => {
    manageableRooms.add(r.room);
    const nth = (seenPerRoom.get(r.room) ?? 0) + 1;
    seenPerRoom.set(r.room, nth);
    return {
      id: r.id,
      room: r.room,
      studentId: r.studentId,
      firstName: r.firstName,
      lastName: r.lastName,
      destination: r.destination,
      position: nth,
      addedAt:
        r.addedAt instanceof Date ? r.addedAt.toISOString() : r.addedAt,
      kioskActivationId: r.kioskActivationId,
      blocked: blockedFlags[i] === true,
      blockedReason: blockedFlags[i] === true ? "keep_apart" : null,
    };
  });

  // Rooms to show even when nobody is in line yet, so the panel is a place
  // the teacher can START a line rather than something that only appears
  // once a student is already waiting.
  //
  //  · the staff member's OWN room — the teacher-path case, no kiosk needed
  //  · any room with a live kiosk they can manage — the original case
  const liveActivations = await db
    .select({
      id: kioskActivationsTable.id,
      room: kioskActivationsTable.room,
      staffId: kioskActivationsTable.staffId,
    })
    .from(kioskActivationsTable)
    .where(
      and(
        eq(kioskActivationsTable.schoolId, schoolId),
        isNull(kioskActivationsTable.deactivatedAt),
        gt(kioskActivationsTable.expiresAt, new Date()),
      ),
    );
  const manageableKiosks = liveActivations
    .filter((a) =>
      canManageRoomQueue(staff, {
        room: a.room,
        activatorStaffIds: [a.staffId],
      }),
    )
    .map((a) => {
      manageableRooms.add(a.room);
      return { kioskActivationId: a.id, room: a.room };
    });

  // The teacher's own room, when it's a valid line room and isn't already
  // present via a kiosk. `kioskActivationId: null` tells the client this is
  // a teacher-managed line with no device behind it.
  const ownRoom = await resolveStaffRoom(schoolId, staff);
  const rooms: Array<{ kioskActivationId: number | null; room: string }> = [
    ...manageableKiosks,
  ];
  if ("room" in ownRoom && !manageableRooms.has(ownRoom.room)) {
    manageableRooms.add(ownRoom.room);
    rooms.push({ kioskActivationId: null, room: ownRoom.room });
  }

  // Active hall passes currently out from any room the staff can manage.
  // We join students for display name; the kiosk uses the same shape.
  let activePasses: Array<{
    kioskActivationId: number | null;
    room: string;
    studentId: string;
    firstName: string | null;
    lastName: string | null;
    destination: string;
    createdAt: string;
    maxDurationMinutes: number;
  }> = [];
  if (manageableRooms.size > 0) {
    const rooms = Array.from(manageableRooms);
    const passRows = await db
      .select({
        studentId: hallPassesTable.studentId,
        room: hallPassesTable.originRoom,
        destination: hallPassesTable.destination,
        createdAt: hallPassesTable.createdAt,
        maxDurationMinutes: hallPassesTable.maxDurationMinutes,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
      })
      .from(hallPassesTable)
      .leftJoin(
        studentsTable,
        and(
          eq(studentsTable.studentId, hallPassesTable.studentId),
          eq(studentsTable.schoolId, schoolId),
        ),
      )
      .where(
        and(
          eq(hallPassesTable.schoolId, schoolId),
          eq(hallPassesTable.status, "active"),
          inArray(hallPassesTable.originRoom, rooms),
        ),
      );
    // Map each active pass to the kiosk activation in the same room (if
    // any). A pass created via the teacher app has no kiosk; we still
    // surface it grouped by room.
    const roomToActivation = new Map<string, number>();
    for (const a of liveActivations) roomToActivation.set(a.room, a.id);
    activePasses = passRows.map((p) => ({
      kioskActivationId: roomToActivation.get(p.room) ?? null,
      room: p.room,
      studentId: p.studentId,
      firstName: p.firstName,
      lastName: p.lastName,
      destination: p.destination,
      createdAt: p.createdAt,
      maxDurationMinutes: p.maxDurationMinutes,
    }));
  }

  res.json({ entries, activePasses, kiosks: rooms });
});

// Staff "Get in Line": a teacher adds a student to their own room's line.
// This is the teacher-path counterpart to the kiosk's /kiosk/queue/:token/add
// and the reason the queue had to stop depending on a kiosk activation.
//
// The room is DERIVED from the authenticated staff member, never taken from
// the body — same rule as the create-on-behalf derivation on POST
// /hall-passes. Letting a client name the room would allow a teacher to stuff
// another room's line, and would dodge the origin-location validation.
router.post("/hall-pass-queue/add", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const { studentId, destination } = req.body ?? {};
  if (typeof studentId !== "string" || !studentId.trim()) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  if (typeof destination !== "string" || !destination.trim()) {
    res.status(400).json({ error: "destination is required" });
    return;
  }

  const roomResult = await resolveStaffRoom(schoolId, staff);
  if ("error" in roomResult) {
    res.status(400).json({ error: roomResult.error });
    return;
  }
  const room = roomResult.room;

  // Accept either the local SIS id (what's on a student's badge) or the
  // canonical id, and store the canonical one — matching how the kiosk path
  // and POST /hall-passes both resolve student input.
  const resolvedStudentId = await resolveStudentIdInput(
    schoolId,
    studentId.trim(),
  );
  if (!resolvedStudentId) {
    res.status(404).json({ error: `No student with ID "${studentId}"` });
    return;
  }
  const [student] = await db
    .select()
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, resolvedStudentId),
        eq(studentsTable.schoolId, schoolId),
      ),
    );
  if (!student) {
    res.status(404).json({ error: `No student with ID "${studentId}"` });
    return;
  }

  // Escort-required safety plan: same hard block the kiosk applies. A queued
  // student would eventually be issued a pass, so the hold belongs here too.
  const escortHold = await findEscortHold(schoolId, resolvedStudentId);
  if (escortHold) {
    res.status(409).json({
      code: "ESCORT_REQUIRED",
      error:
        "This student's safety plan requires a staff escort — they can't join the line.",
    });
    return;
  }

  // Already out on a pass from this room: nothing to queue for.
  const [activePass] = await db
    .select()
    .from(hallPassesTable)
    .where(
      and(
        eq(hallPassesTable.schoolId, schoolId),
        eq(hallPassesTable.studentId, resolvedStudentId),
        eq(hallPassesTable.status, "active"),
      ),
    );
  if (activePass) {
    res.status(409).json({
      error: `That student is already out on a pass to ${activePass.destination}.`,
    });
    return;
  }

  let result: Awaited<ReturnType<typeof enqueueStudent>>;
  try {
    result = await enqueueStudent({
      schoolId,
      room,
      studentId: resolvedStudentId,
      firstName: student.firstName ?? null,
      lastName: student.lastName ?? null,
      destination: destination.trim(),
      // Teacher-created: no device behind it. This null is the whole point.
      kioskActivationId: null,
    });
  } catch (err) {
    req.log.error({ err }, "staff hall-pass-queue add failed");
    res.status(500).json({ error: "Could not add to the line" });
    return;
  }
  if (result.kind === "full") {
    res
      .status(409)
      .json({ error: `The line for ${room} is full (${QUEUE_CAP} waiting).` });
    return;
  }
  if (result.kind === "duplicate") {
    res.status(409).json({ error: "That student is already in line." });
    return;
  }

  const myIdx = result.after.findIndex((r) => r.id === result.row.id);
  res.json({
    position: myIdx + 1,
    capacity: QUEUE_CAP,
    room,
    entries: result.after.map((r, i) => shapeEntry(r, i)),
  });
});

// Companion-panel endpoint: re-stamp positions for one room's line.
// Body: { room, orderedIds: number[] } — the ids in the order they should
// appear (1..n). Authorizes against `canManageRoomQueue` for that room and
// rewrites positions inside a transaction so no reader ever sees a
// half-applied reorder.
//
// `kioskActivationId` is still accepted as a legacy alias (resolved to its
// room) so a browser tab loaded before this deploy keeps working.
router.post("/hall-pass-queue/reorder", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const { room, kioskActivationId, orderedIds } = req.body ?? {};
  if (
    !Array.isArray(orderedIds) ||
    orderedIds.some((v) => !Number.isInteger(v))
  ) {
    res.status(400).json({ error: "orderedIds[] is required" });
    return;
  }

  let targetRoom: string | null =
    typeof room === "string" && room.trim() ? room.trim() : null;
  if (!targetRoom && Number.isInteger(kioskActivationId)) {
    const [activation] = await db
      .select({ room: kioskActivationsTable.room })
      .from(kioskActivationsTable)
      .where(
        and(
          eq(kioskActivationsTable.id, kioskActivationId),
          eq(kioskActivationsTable.schoolId, schoolId),
        ),
      );
    targetRoom = activation?.room ?? null;
  }
  if (!targetRoom) {
    res.status(400).json({ error: "room is required" });
    return;
  }

  const activators = await db
    .select({ staffId: kioskActivationsTable.staffId })
    .from(kioskActivationsTable)
    .where(
      and(
        eq(kioskActivationsTable.schoolId, schoolId),
        eq(kioskActivationsTable.room, targetRoom),
        isNull(kioskActivationsTable.deactivatedAt),
        gt(kioskActivationsTable.expiresAt, new Date()),
      ),
    );
  if (
    !canManageRoomQueue(staff, {
      room: targetRoom,
      activatorStaffIds: activators.map((a) => a.staffId),
    })
  ) {
    res
      .status(403)
      .json({ error: "You can't manage the queue for that room" });
    return;
  }

  try {
    await db.transaction(async (tx) => {
      // Lock and verify every supplied id belongs to this room — prevents a
      // malformed payload from rewriting another room's line.
      const live = await tx
        .select()
        .from(hallPassQueueTable)
        .where(
          and(
            eq(hallPassQueueTable.schoolId, schoolId),
            eq(hallPassQueueTable.room, targetRoom),
          ),
        )
        .for("update");
      const liveIds = new Set(live.map((r) => r.id));
      const orderedSet = new Set(orderedIds as number[]);
      if (
        (orderedIds as number[]).length !== live.length ||
        (orderedIds as number[]).some((id) => !liveIds.has(id)) ||
        orderedSet.size !== (orderedIds as number[]).length
      ) {
        // Stale snapshot — somebody modified the queue between the panel
        // load and the reorder click. Surface it so the UI can refetch.
        throw new Error("STALE_QUEUE");
      }
      // Two-pass write to dodge the (kiosk_activation_id, position) range
      // ordering: first push everything to a high temporary range, then
      // back down to 1..n.
      for (let i = 0; i < (orderedIds as number[]).length; i++) {
        await tx
          .update(hallPassQueueTable)
          .set({ position: 10_000 + i })
          .where(eq(hallPassQueueTable.id, (orderedIds as number[])[i]!));
      }
      for (let i = 0; i < (orderedIds as number[]).length; i++) {
        await tx
          .update(hallPassQueueTable)
          .set({ position: i + 1 })
          .where(eq(hallPassQueueTable.id, (orderedIds as number[])[i]!));
      }
    });
  } catch (err) {
    if (err instanceof Error && err.message === "STALE_QUEUE") {
      res
        .status(409)
        .json({ error: "Queue changed — refresh and try again", stale: true });
      return;
    }
    req.log.error({ err }, "hall-pass-queue reorder failed");
    res.status(500).json({ error: "Could not reorder queue" });
    return;
  }
  res.json({ ok: true });
});

// Mint a read-only viewer token for the live kiosk in a given room.
// Returns the token string, the absolute viewer URL (so the QR code on
// the client doesn't have to know about path prefixes), and the expiry.
router.post("/kiosk/viewer-token", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const { room } = req.body ?? {};
  if (typeof room !== "string" || !room.trim()) {
    res.status(400).json({ error: "room is required" });
    return;
  }
  const trimmedRoom = room.trim();

  const [activation] = await db
    .select()
    .from(kioskActivationsTable)
    .where(
      and(
        eq(kioskActivationsTable.schoolId, schoolId),
        eq(kioskActivationsTable.room, trimmedRoom),
        isNull(kioskActivationsTable.deactivatedAt),
        gt(kioskActivationsTable.expiresAt, new Date()),
      ),
    );
  if (!activation) {
    res
      .status(404)
      .json({ error: `No active kiosk for room "${trimmedRoom}"` });
    return;
  }
  if (
    !canManageRoomQueue(staff, {
      room: activation.room,
      activatorStaffIds: [activation.staffId],
    })
  ) {
    res
      .status(403)
      .json({ error: "You can't share the queue for that room" });
    return;
  }

  const token = genUrlSafeToken(32); // ~190 bits, linkifier-safe (lib/urlSafeToken)
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(
    Math.min(
      Date.now() + VIEWER_TOKEN_TTL_MS,
      // Clip to the activation's own expiry — viewer should never outlive
      // the kiosk it's mirroring.
      activation.expiresAt.getTime(),
    ),
  );
  await db.insert(kioskViewerTokensTable).values({
    schoolId,
    kioskActivationId: activation.id,
    tokenHash,
    createdByStaffId: staff.id,
    expiresAt,
  });

  // Build an absolute URL using the request's own host so it resolves on
  // the phone (the staff app's preview/published origin). Path-based
  // routing in main.tsx picks up `/kiosk-view/...` and renders the
  // read-only mirror.
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const url = `${proto}://${host}/kiosk-view/${token}`;
  res.json({
    token,
    url,
    room: activation.room,
    expiresAt: expiresAt.toISOString(),
  });
});

// Public read for the phone mirror. NO auth — possessing the token is
// the auth. Returns 410 Gone the moment the underlying kiosk goes away,
// which is what makes "go dark on take-over" actually go dark.
router.get("/kiosk/viewer/:token", async (req, res) => {
  const raw = req.params.token;
  if (typeof raw !== "string" || raw.length < 16) {
    res.status(404).json({ error: "Invalid viewer link" });
    return;
  }
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  const [row] = await db
    .select({
      viewer: kioskViewerTokensTable,
      activation: kioskActivationsTable,
    })
    .from(kioskViewerTokensTable)
    .innerJoin(
      kioskActivationsTable,
      eq(kioskActivationsTable.id, kioskViewerTokensTable.kioskActivationId),
    )
    .where(eq(kioskViewerTokensTable.tokenHash, tokenHash));

  if (!row) {
    res.status(404).json({ error: "Viewer link not found" });
    return;
  }
  const now = new Date();
  if (row.viewer.revokedAt || row.viewer.expiresAt <= now) {
    res.status(410).json({ error: "Viewer link expired", gone: true });
    return;
  }
  if (
    row.activation.deactivatedAt ||
    row.activation.expiresAt <= now
  ) {
    res
      .status(410)
      .json({ error: "Kiosk is no longer active", gone: true });
    return;
  }

  const [school] = await db
    .select({ name: schoolsTable.name })
    .from(schoolsTable)
    .where(eq(schoolsTable.id, row.activation.schoolId));

  const { rows } = await clearStaleAndList(row.activation);
  res.json({
    room: row.activation.room,
    schoolName: school?.name ?? null,
    capacity: QUEUE_CAP,
    entries: rows.map((r, i) => shapeEntry(r, i)),
    refreshedAt: new Date().toISOString(),
  });
});

router.delete("/hall-pass-queue/:id", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  // Look up the entry so we can authorize against canManageRoomQueue.
  // Without this any staff in the school could delete any entry — the
  // chip-only UX hid the bug, but the endpoint is the source of truth.
  //
  // No INNER JOIN on kiosk_activations: that made teacher-created entries
  // (null activation) 404 here — visible in the panel but impossible to
  // remove. Authorization comes from the entry's own room.
  const [target] = await db
    .select({
      entryId: hallPassQueueTable.id,
      room: hallPassQueueTable.room,
    })
    .from(hallPassQueueTable)
    .where(
      and(
        eq(hallPassQueueTable.id, id),
        eq(hallPassQueueTable.schoolId, schoolId),
      ),
    );
  if (!target) {
    res.status(404).json({ error: "Queue entry not found" });
    return;
  }
  const targetActivators = await db
    .select({ staffId: kioskActivationsTable.staffId })
    .from(kioskActivationsTable)
    .where(
      and(
        eq(kioskActivationsTable.schoolId, schoolId),
        eq(kioskActivationsTable.room, target.room),
        isNull(kioskActivationsTable.deactivatedAt),
        gt(kioskActivationsTable.expiresAt, new Date()),
      ),
    );
  if (
    !canManageRoomQueue(staff, {
      room: target.room,
      activatorStaffIds: targetActivators.map((a) => a.staffId),
    })
  ) {
    res
      .status(403)
      .json({ error: "You can't manage the queue for that room" });
    return;
  }
  await db
    .delete(hallPassQueueTable)
    .where(
      and(
        eq(hallPassQueueTable.id, id),
        eq(hallPassQueueTable.schoolId, schoolId),
      ),
    );
  res.json({ ok: true });
});

export default router;
