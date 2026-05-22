// Demo Heartbeat — ambient fake PBIS awards for the houses signage.
//
// Why this exists
// ----------------
// During investor / school demos the hallway TV (HousesSignage) reads from
// pbis_entries. Without any background activity the action feed strip
// looks dead within minutes of the seed running, which kills the
// "this is alive" illusion. Real awards from staff (teacher-entered,
// Spotlight, etc.) still land in the same table and out-rank the
// demo drip because timestamps are now() — so the user's actual
// Spotlight wins always sit at the top of the feed within the next
// 30s poll.
//
// What it does
// ------------
//   1. Every minute, decide whether to fire (jittered 90-180s cadence,
//      so it never feels metronomic).
//   2. Only fires inside the bell-schedule window
//      (first-period start → last-period end, school-local TZ).
//      Hard stop at end of last period — anything after would
//      give the illusion away (clubs / after-school is quiet on TVs).
//   3. Anti-repeat: same student blocked for 10 minutes, and houses
//      are rotated round-robin so no single house dominates the feed.
//   4. Counts toward house totals (operator confirmed Option A) — bars
//      grow visibly through the day.
//   5. Tagged `note = '__demo_heartbeat__'` so the midnight reset can
//      purge cleanly without touching any real teacher-entered award.
//   6. Admin can force-fire one award on demand via the "Fire heartbeat"
//      button on the houses signage page — bypasses cadence + window
//      gates but still respects anti-repeat + house rotation + marker.
//
// Scope: hard-pinned to Parrott (school_id = 1). The user has no
// onboarded schools yet, but other dev schools exist in the DB and
// we don't want this ambient drip running there. When real tenants
// onboard, gate this behind DEMO_MODE env *and* a per-school flag.

import { and, eq, sql } from "drizzle-orm";
import {
  db,
  bellSchedulesTable,
  bellSchedulePeriodsTable,
  pbisEntriesTable,
  pbisReasonsTable,
  studentsTable,
} from "@workspace/db";
import { logger } from "../lib/logger.js";

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------
const DEMO_SCHOOL_ID = 1; // Parrott
const DEMO_TZ = "America/New_York";
const DEMO_MARKER = "__demo_heartbeat__";
const DEMO_STAFF_NAME = "PulseEDU Demo";

// Gate: enabled by default in dev (the user has no onboarded schools yet
// and explicitly wants ambient drip during demos). Disabled in production
// unless DEMO_MODE=true is set explicitly. Set DEMO_MODE=false to force
// off in dev (e.g. while debugging a real-award flow).
export function isDemoHeartbeatEnabled(): boolean {
  if (process.env.DEMO_MODE === "true") return true;
  if (process.env.DEMO_MODE === "false") return false;
  return process.env.NODE_ENV !== "production";
}

// Cadence jitter — 90 to 180 seconds between fires (avg ~135s = ~26 awards
// across a 7-hour school day).
const MIN_DELAY_MS = 90_000;
const MAX_DELAY_MS = 180_000;

// Anti-repeat: a student can't be picked again within this window.
const STUDENT_COOLDOWN_MS = 10 * 60_000; // 10 minutes

// Fallback window if no bell schedule is configured (should not happen for
// Parrott but kept defensive so a missing schedule never crashes the cron).
const FALLBACK_START_MIN = 7 * 60 + 30;  // 7:30am
const FALLBACK_END_MIN = 15 * 60 + 30;   // 3:30pm

// -----------------------------------------------------------------------------
// Module-scope state (single-process; demo cadence doesn't need durability)
// -----------------------------------------------------------------------------
let nextFireAtMs = 0;
const recentStudents = new Map<string, number>();
let houseRotationIdx = 0;
let cachedWindow: { date: string; startMin: number; endMin: number } | null = null;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function jitteredDelay(): number {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
}

function nowInTz(tz: string): { dateKey: string; minutesSinceMidnight: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = parseInt(get("hour"), 10);
  const minute = parseInt(get("minute"), 10);
  return {
    dateKey: `${year}-${month}-${day}`,
    minutesSinceMidnight: hour * 60 + minute,
  };
}

function hhmmToMinutes(s: string): number {
  const [h, m] = s.split(":").map((x) => parseInt(x, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return h * 60 + m;
}

async function getBellWindow(
  schoolId: number,
  dateKey: string,
): Promise<{ startMin: number; endMin: number }> {
  if (cachedWindow && cachedWindow.date === dateKey) {
    return { startMin: cachedWindow.startMin, endMin: cachedWindow.endMin };
  }
  const [defaultSched] = await db
    .select({ id: bellSchedulesTable.id })
    .from(bellSchedulesTable)
    .where(
      and(
        eq(bellSchedulesTable.schoolId, schoolId),
        eq(bellSchedulesTable.isDefault, true),
        eq(bellSchedulesTable.active, true),
      ),
    );

  let startMin = FALLBACK_START_MIN;
  let endMin = FALLBACK_END_MIN;

  if (defaultSched) {
    const periods = await db
      .select({
        startTime: bellSchedulePeriodsTable.startTime,
        endTime: bellSchedulePeriodsTable.endTime,
      })
      .from(bellSchedulePeriodsTable)
      .where(eq(bellSchedulePeriodsTable.scheduleId, defaultSched.id));
    if (periods.length > 0) {
      const starts = periods.map((p) => hhmmToMinutes(p.startTime)).filter(Number.isFinite);
      const ends = periods.map((p) => hhmmToMinutes(p.endTime)).filter(Number.isFinite);
      if (starts.length > 0) startMin = Math.min(...starts);
      if (ends.length > 0) endMin = Math.max(...ends);
    }
  }

  cachedWindow = { date: dateKey, startMin, endMin };
  return { startMin, endMin };
}

function isSchoolDay(dateKey: string, tz: string): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" });
  const day = fmt.format(new Date(`${dateKey}T12:00:00Z`));
  return ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(day);
}

function pruneRecent(now: number) {
  for (const [sid, ts] of recentStudents.entries()) {
    if (now - ts > STUDENT_COOLDOWN_MS) recentStudents.delete(sid);
  }
}

// -----------------------------------------------------------------------------
// Tick — called every minute by cron, OR force-fired by the admin button
// -----------------------------------------------------------------------------
export async function runDemoHeartbeatTick(
  opts: { force?: boolean } = {},
): Promise<{ fired: boolean; reason?: string }> {
  const force = opts.force === true;

  if (!isDemoHeartbeatEnabled()) {
    return { fired: false, reason: "DEMO_MODE off" };
  }

  const now = Date.now();
  if (!force && now < nextFireAtMs) {
    return { fired: false, reason: "cadence-wait" };
  }

  const { dateKey, minutesSinceMidnight } = nowInTz(DEMO_TZ);

  if (!force) {
    if (!isSchoolDay(dateKey, DEMO_TZ)) {
      nextFireAtMs = now + 5 * 60_000;
      return { fired: false, reason: "weekend" };
    }
    const { startMin, endMin } = await getBellWindow(DEMO_SCHOOL_ID, dateKey);
    if (minutesSinceMidnight < startMin || minutesSinceMidnight >= endMin) {
      nextFireAtMs = now + 5 * 60_000;
      return { fired: false, reason: "outside-bell-window" };
    }
  }

  // Pick a house round-robin.
  const houseRows = await db.execute<{ id: number }>(sql`
    SELECT id FROM houses WHERE school_id = ${DEMO_SCHOOL_ID} ORDER BY id ASC
  `);
  const houseIds = (houseRows as unknown as { rows: Array<{ id: number }> })
    .rows.map((r) => r.id);
  if (houseIds.length === 0) {
    if (!force) nextFireAtMs = now + jitteredDelay();
    return { fired: false, reason: "no-houses" };
  }
  const houseId = houseIds[houseRotationIdx % houseIds.length];
  houseRotationIdx = (houseRotationIdx + 1) % houseIds.length;

  // Eligible students.
  pruneRecent(now);
  const cooldownIds = Array.from(recentStudents.keys());
  const studentRows = await db
    .select({ studentId: studentsTable.studentId })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, DEMO_SCHOOL_ID),
        eq(studentsTable.houseId, houseId),
        cooldownIds.length > 0
          ? sql`${studentsTable.studentId} NOT IN (${sql.join(
              cooldownIds.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql`TRUE`,
      ),
    );

  if (studentRows.length === 0) {
    if (!force) nextFireAtMs = now + 30_000;
    return { fired: false, reason: "house-cooled-down" };
  }

  const pick = studentRows[Math.floor(Math.random() * studentRows.length)];

  // Positive PBIS reason, biased to 1-3 pts.
  const reasons = await db
    .select({
      name: pbisReasonsTable.name,
      defaultPoints: pbisReasonsTable.defaultPoints,
    })
    .from(pbisReasonsTable)
    .where(
      and(
        eq(pbisReasonsTable.schoolId, DEMO_SCHOOL_ID),
        eq(pbisReasonsTable.polarity, "positive"),
      ),
    );

  if (reasons.length === 0) {
    if (!force) nextFireAtMs = now + jitteredDelay();
    return { fired: false, reason: "no-positive-reasons" };
  }

  const small = reasons.filter(
    (r) => typeof r.defaultPoints === "number" && r.defaultPoints >= 1 && r.defaultPoints <= 3,
  );
  const pool = small.length > 0 ? small : reasons;
  const reason = pool[Math.floor(Math.random() * pool.length)];
  const points = reason.defaultPoints && reason.defaultPoints > 0 ? reason.defaultPoints : 1;

  await db.insert(pbisEntriesTable).values({
    schoolId: DEMO_SCHOOL_ID,
    studentId: pick.studentId,
    reason: reason.name,
    points,
    polarity: "positive",
    staffName: DEMO_STAFF_NAME,
    note: DEMO_MARKER,
    createdAt: new Date().toISOString(),
  });

  recentStudents.set(pick.studentId, now);
  if (!force) nextFireAtMs = now + jitteredDelay();
  return { fired: true };
}

// -----------------------------------------------------------------------------
// Midnight reset — purge yesterday's demo drip so totals don't accumulate
// across days. Only touches rows tagged with DEMO_MARKER.
// -----------------------------------------------------------------------------
export async function runDemoHeartbeatReset(): Promise<{ deleted: number }> {
  if (!isDemoHeartbeatEnabled()) {
    return { deleted: 0 };
  }
  const res = await db.execute<{ deleted: number }>(sql`
    WITH del AS (
      DELETE FROM pbis_entries
       WHERE school_id = ${DEMO_SCHOOL_ID}
         AND note = ${DEMO_MARKER}
      RETURNING 1
    )
    SELECT COUNT(*)::int AS deleted FROM del
  `);
  const deleted = (res as unknown as { rows: Array<{ deleted: number }> })
    .rows[0]?.deleted ?? 0;

  nextFireAtMs = 0;
  recentStudents.clear();
  houseRotationIdx = 0;
  cachedWindow = null;

  logger.info({ deleted }, "demo heartbeat midnight reset complete");
  return { deleted };
}
