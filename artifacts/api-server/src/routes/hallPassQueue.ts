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
  hallPassesTable,
  bellSchedulesTable,
  bellSchedulePeriodsTable,
  studentsTable,
  staffTable,
} from "@workspace/db";
import { and, eq, isNull, gt, asc, ne } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

// Hard cap on a single kiosk's queue. Beyond this the kiosk shows
// "Line is full, try in a minute." Keeps the line from becoming a hangout.
const QUEUE_CAP = 5;

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
async function getCurrentPeriodKey(schoolId: number): Promise<string> {
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
    .select()
    .from(hallPassQueueTable)
    .where(eq(hallPassQueueTable.kioskActivationId, act.id))
    .orderBy(asc(hallPassQueueTable.position), asc(hallPassQueueTable.id));
  return { periodKey, rows };
}

function shapeEntry(row: typeof hallPassQueueTable.$inferSelect, idx: number) {
  return {
    id: row.id,
    studentId: row.studentId,
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
  res.json({
    capacity: QUEUE_CAP,
    entries: rows.map((r, i) => shapeEntry(r, i)),
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
  const trimmedId = studentId.trim().toUpperCase();

  // Resolve student to cache name + verify they're in this school.
  const [student] = await db
    .select()
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.studentId, trimmedId),
        eq(studentsTable.schoolId, act.schoolId),
      ),
    );
  if (!student) {
    res.status(404).json({ error: `Student ${trimmedId} not found` });
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
  const trimmedId = studentId.trim().toUpperCase();
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
  await db
    .delete(hallPassQueueTable)
    .where(
      and(
        eq(hallPassQueueTable.kioskActivationId, kioskActivationId),
        eq(hallPassQueueTable.studentId, studentId.toUpperCase()),
      ),
    );
}

export async function peekNextInQueue(act: {
  id: number;
  schoolId: number;
}) {
  const { rows } = await clearStaleAndList(act);
  if (rows.length === 0) return null;
  const next = rows[0];
  return {
    studentId: next.studentId,
    firstName: next.firstName,
    lastName: next.lastName,
    destination: next.destination,
  };
}

// ---------------------------------------------------------------------------
// Staff endpoints — for the teacher-side "Queue · N waiting" chip.
// ---------------------------------------------------------------------------

router.get("/hall-pass-queue", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  // Return all current queue entries for this school. The client can group
  // by `room` for display. We do NOT auto-clear stale entries here because
  // we don't have a single activation context — staff view is read-only and
  // the next kiosk read will clear them.
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
  res.json({
    entries: rows.map((r) => ({
      ...r,
      addedAt:
        r.addedAt instanceof Date ? r.addedAt.toISOString() : r.addedAt,
    })),
  });
});

router.delete("/hall-pass-queue/:id", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const result = await db
    .delete(hallPassQueueTable)
    .where(
      and(
        eq(hallPassQueueTable.id, id),
        eq(hallPassQueueTable.schoolId, schoolId),
      ),
    )
    .returning({ id: hallPassQueueTable.id });
  if (result.length === 0) {
    res.status(404).json({ error: "Queue entry not found" });
    return;
  }
  res.json({ ok: true });
});

export default router;
