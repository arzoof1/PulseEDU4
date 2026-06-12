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
  bellSchedulesTable,
  bellSchedulePeriodsTable,
  studentsTable,
  staffTable,
  schoolsTable,
} from "@workspace/db";
import { and, eq, inArray, isNull, gt, asc, ne, sql } from "drizzle-orm";
import { genUrlSafeToken } from "../lib/urlSafeToken.js";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam } from "../lib/coreTeam.js";
import { findPolarityConflict } from "./polarityPairs";
import { findDailyLimitConflict } from "./studentHallPassLimits";

// How long a minted viewer token stays usable. The token is also killed
// the moment the underlying kiosk activation is deactivated, so this is
// just an upper bound for "I scanned this QR yesterday and forgot".
const VIEWER_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

// Predicate: can `staff` view/manage the queue for the given live
// activation in their school? Mirrors the take-over policy decision
// (admin/core team OR same default room OR original activator) so the
// staff app and the activation flow stay consistent.
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
  activation: { staffId: number; room: string },
): boolean {
  if (isCoreTeam(staff)) return true;
  if (activation.staffId === staff.id) return true;
  if (
    staff.defaultRoom &&
    staff.defaultRoom.trim().length > 0 &&
    staff.defaultRoom === activation.room
  ) {
    return true;
  }
  return false;
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
  const [schedule] = await db
    .select()
    .from(bellSchedulesTable)
    .where(
      and(
        eq(bellSchedulesTable.schoolId, schoolId),
        eq(bellSchedulesTable.isDefault, true),
        eq(bellSchedulesTable.active, true),
      ),
    );
  const now = new Date();
  const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (schedule) {
    const periods = await db
      .select()
      .from(bellSchedulePeriodsTable)
      .where(eq(bellSchedulePeriodsTable.scheduleId, schedule.id));
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const nowHm = `${hh}:${mm}`;
    for (const p of periods) {
      if (nowHm >= p.startTime && nowHm < p.endTime) {
        return `s${schedule.id}:p${p.periodNumber}:${dayKey}`;
      }
    }
    return `s${schedule.id}:between:${dayKey}`;
  }
  const bucket = Math.floor((now.getHours() * 60 + now.getMinutes()) / 45);
  return `idle:${dayKey}:${bucket}`;
}

// Drop entries whose period key doesn't match "now", then return the
// surviving queue rows ordered by position.
async function clearStaleAndList(act: { id: number; schoolId: number }) {
  const periodKey = await getCurrentPeriodKey(act.schoolId);
  await db
    .delete(hallPassQueueTable)
    .where(
      and(
        eq(hallPassQueueTable.kioskActivationId, act.id),
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
    })
    .from(hallPassQueueTable)
    .leftJoin(
      studentsTable,
      and(
        eq(studentsTable.studentId, hallPassQueueTable.studentId),
        eq(studentsTable.schoolId, hallPassQueueTable.schoolId),
      ),
    )
    .where(eq(hallPassQueueTable.kioskActivationId, act.id))
    .orderBy(asc(hallPassQueueTable.position), asc(hallPassQueueTable.id));
  return { periodKey, rows };
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
  };
}

// ---------------------------------------------------------------------------
// Kiosk-token endpoints (unauthenticated; the activation token is the auth)
// ---------------------------------------------------------------------------

router.get("/kiosk/queue/:token", async (req, res) => {
  const act = await loadActivationByToken(req.params.token);
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
  res.json({
    capacity: QUEUE_CAP,
    entries: rows.map((r, i) => shapeEntry(r, i)),
    nextUp,
    activePassIds: activeRows.map((r) => r.id),
  });
});

router.post("/kiosk/queue/:token/add", async (req, res) => {
  const act = await loadActivationByToken(req.params.token);
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

  // Clear stale BEFORE the transaction. Stale rows belong to a previous
  // period and should never count toward the current period's cap.
  const periodKey = await getCurrentPeriodKey(act.schoolId);
  await db
    .delete(hallPassQueueTable)
    .where(
      and(
        eq(hallPassQueueTable.kioskActivationId, act.id),
        ne(hallPassQueueTable.periodKey, periodKey),
      ),
    );

  // ---- Critical section: atomic cap + duplicate enforcement -------------
  // Two students mashing "Get in line" at the same kiosk would otherwise
  // both pass the cap pre-check and slip past 5. We open a transaction and
  // take a row-level lock on this kiosk's existing queue rows
  // (`.for("update")`), then recount inside the lock. The unique index on
  // (kioskActivationId, studentId) is the second line of defense — if a
  // duplicate insert races past the in-memory check, we map the resulting
  // 23505 to a friendly 409 instead of bubbling a 500 to the kiosk.
  let inserted: typeof hallPassQueueTable.$inferSelect;
  let fresh: Array<typeof hallPassQueueTable.$inferSelect>;
  try {
    const txnResult = await db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(hallPassQueueTable)
        .where(eq(hallPassQueueTable.kioskActivationId, act.id))
        .orderBy(
          asc(hallPassQueueTable.position),
          asc(hallPassQueueTable.id),
        )
        .for("update");
      if (locked.length >= QUEUE_CAP) {
        return { kind: "full" as const };
      }
      if (locked.some((r) => r.studentId === trimmedId)) {
        return { kind: "duplicate" as const };
      }
      const nextPos =
        locked.reduce((m, r) => (r.position > m ? r.position : m), 0) + 1;
      const [row] = await tx
        .insert(hallPassQueueTable)
        .values({
          schoolId: act.schoolId,
          kioskActivationId: act.id,
          room: act.room,
          studentId: trimmedId,
          firstName: student.firstName ?? null,
          lastName: student.lastName ?? null,
          destination: destination.trim(),
          position: nextPos,
          periodKey,
        })
        .returning();
      const after = await tx
        .select()
        .from(hallPassQueueTable)
        .where(eq(hallPassQueueTable.kioskActivationId, act.id))
        .orderBy(
          asc(hallPassQueueTable.position),
          asc(hallPassQueueTable.id),
        );
      return { kind: "ok" as const, row, after };
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
    // Postgres unique-violation (23505) means a concurrent insert won the
    // race for this same student on this kiosk — treat as "already in line".
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code === "23505") {
      res.status(409).json({ error: "You're already in line." });
      return;
    }
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
        eq(hallPassQueueTable.kioskActivationId, act.id),
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
  kioskActivationId: number,
  studentId: string,
) {
  // Callers pass the canonical student_id (resolved from local_sis_id in the
  // kiosk routes). Queue rows store that id verbatim, so match exactly.
  await db
    .delete(hallPassQueueTable)
    .where(
      and(
        eq(hallPassQueueTable.kioskActivationId, kioskActivationId),
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
    };
  }
  return null;
}

export async function peekNextInQueue(act: {
  id: number;
  schoolId: number;
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
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;

  // Pull every queue entry in this school joined to its activation so we
  // can compute `canManage` per entry on the server (the source of truth
  // for authz). Entries we can't manage are filtered out — staff who
  // can't reorder/remove a room's line have no need to see it in the
  // companion panel either.
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
      activationStaffId: kioskActivationsTable.staffId,
      activationRoom: kioskActivationsTable.room,
    })
    .from(hallPassQueueTable)
    .innerJoin(
      kioskActivationsTable,
      eq(kioskActivationsTable.id, hallPassQueueTable.kioskActivationId),
    )
    .where(eq(hallPassQueueTable.schoolId, schoolId))
    .orderBy(
      asc(hallPassQueueTable.room),
      asc(hallPassQueueTable.position),
      asc(hallPassQueueTable.id),
    );

  const manageableRooms = new Set<string>();
  const filteredRows = rows.filter((r) =>
    canManageRoomQueue(staff, {
      staffId: r.activationStaffId,
      room: r.activationRoom,
    }),
  );
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
  const entries = filteredRows.map((r, i) => {
    manageableRooms.add(r.activationRoom);
    return {
      id: r.id,
      room: r.room,
      studentId: r.studentId,
      firstName: r.firstName,
      lastName: r.lastName,
      destination: r.destination,
      position: r.position,
      addedAt:
        r.addedAt instanceof Date ? r.addedAt.toISOString() : r.addedAt,
      kioskActivationId: r.kioskActivationId,
      blocked: blockedFlags[i] === true,
      blockedReason: blockedFlags[i] === true ? "keep_apart" : null,
    };
  });

  // Also include rooms with NO queue but a live kiosk the staff can
  // manage — so the panel still shows the room (and its active passes)
  // when nobody is in line yet. Without this, a teacher with a kiosk up
  // and one student already out on a pass would see nothing in the
  // companion panel until somebody got in line.
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
    .filter((a) => canManageRoomQueue(staff, a))
    .map((a) => {
      manageableRooms.add(a.room);
      return { kioskActivationId: a.id, room: a.room };
    });

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

  res.json({ entries, activePasses, kiosks: manageableKiosks });
});

// Companion-panel endpoint: re-stamp positions for one room's queue.
// Body: { kioskActivationId, orderedIds: number[] } — the ids in the order
// they should appear (1..n). We look up the activation, authorize against
// `canManageRoomQueue`, and rewrite positions inside a transaction so the
// kiosk never sees a half-applied reorder.
router.post("/hall-pass-queue/reorder", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;
  const { kioskActivationId, orderedIds } = req.body ?? {};
  if (
    !Number.isInteger(kioskActivationId) ||
    !Array.isArray(orderedIds) ||
    orderedIds.some((v) => !Number.isInteger(v))
  ) {
    res
      .status(400)
      .json({ error: "kioskActivationId and orderedIds[] are required" });
    return;
  }

  const [activation] = await db
    .select()
    .from(kioskActivationsTable)
    .where(
      and(
        eq(kioskActivationsTable.id, kioskActivationId),
        eq(kioskActivationsTable.schoolId, schoolId),
        isNull(kioskActivationsTable.deactivatedAt),
        gt(kioskActivationsTable.expiresAt, new Date()),
      ),
    );
  if (!activation) {
    res.status(404).json({ error: "Kiosk no longer active" });
    return;
  }
  if (!canManageRoomQueue(staff, activation)) {
    res
      .status(403)
      .json({ error: "You can't manage the queue for that room" });
    return;
  }

  try {
    await db.transaction(async (tx) => {
      // Lock and verify every supplied id belongs to this activation —
      // prevents a malformed payload from rewriting another room's line.
      const live = await tx
        .select()
        .from(hallPassQueueTable)
        .where(eq(hallPassQueueTable.kioskActivationId, activation.id))
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
  if (!canManageRoomQueue(staff, activation)) {
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
  // Look up the entry + its activation so we can authorize against
  // canManageRoomQueue. Without this any staff in the school could
  // delete any entry — the chip-only UX hid the bug, but the endpoint
  // is the source of truth.
  const [target] = await db
    .select({
      entryId: hallPassQueueTable.id,
      activationStaffId: kioskActivationsTable.staffId,
      activationRoom: kioskActivationsTable.room,
    })
    .from(hallPassQueueTable)
    .innerJoin(
      kioskActivationsTable,
      eq(kioskActivationsTable.id, hallPassQueueTable.kioskActivationId),
    )
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
  if (
    !canManageRoomQueue(staff, {
      staffId: target.activationStaffId,
      room: target.activationRoom,
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
