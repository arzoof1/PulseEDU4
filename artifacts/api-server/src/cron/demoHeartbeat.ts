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
//
// Scope: hard-pinned to Parrott (school_id = 1). The user has no
// onboarded schools yet, but other dev schools exist in the DB and
// we don't want this ambient drip running there. When real tenants
// onboard, gate this behind DEMO_MODE env *and* a per-school flag.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
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
// across a 7-hour school day). Plenty for the feed to never go quiet, far
// short of "firehose" territory.
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
const recentStudents = new Map<string, number>(); // studentId → lastFiredMs
let houseRotationIdx = 0;

// Cached bell-schedule window, refreshed when the date rolls over.
let cachedWindow: {
  date: string;
  startMin: number;
  endMin: number;
} | null = null;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function jitteredDelay(): number {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
}

// School-local "HH:MM" + "YYYY-MM-DD" via Intl, so we don't fight UTC.
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
  // Tolerates "HH:MM" and "HH:MM:SS".
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
  // "en-US" weekday short — Mon..Fri only.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  });
  const day = fmt.format(new Date(`${dateKey}T12:00:00Z`));
  return ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(day);
}

function pruneRecent(now: number) {
  for (const [sid, ts] of recentStudents.entries()) {
    if (now - ts > STUDENT_COOLDOWN_MS) recentStudents.delete(sid);
  }
}

// -----------------------------------------------------------------------------
// Tick — called every minute by cron
// -----------------------------------------------------------------------------
export async function runDemoHeartbeatTick(): Promise<{ fired: boolean; reason?: string }> {
  if (!isDemoHeartbeatEnabled()) {
    return { fired: false, reason: "DEMO_MODE off" };
  }

  const now = Date.now();
  if (now < nextFireAtMs) {
    return { fired: false, reason: "cadence-wait" };
  }

  const { dateKey, minutesSinceMidnight } = nowInTz(DEMO_TZ);

  if (!isSchoolDay(dateKey, DEMO_TZ)) {
    // Push the next eval out a bit so weekends don't hot-loop the DB.
    nextFireAtMs = now + 5 * 60_000;
    return { fired: false, reason: "weekend" };
  }

  const { startMin, endMin } = await getBellWindow(DEMO_SCHOOL_ID, dateKey);
  if (minutesSinceMidnight < startMin || minutesSinceMidnight >= endMin) {
    nextFireAtMs = now + 5 * 60_000;
    return { fired: false, reason: "outside-bell-window" };
  }

  // Pick a house round-robin. We refresh the house list on each fire so
  // newly-added houses get rotated in without a server restart.
  const houseRows = await db.execute<{ id: number }>(sql`
    SELECT id FROM houses WHERE school_id = ${DEMO_SCHOOL_ID} ORDER BY id ASC
  `);
  const houseIds = (houseRows as unknown as { rows: Array<{ id: number }> })
    .rows.map((r) => r.id);
  if (houseIds.length === 0) {
    nextFireAtMs = now + jitteredDelay();
    return { fired: false, reason: "no-houses" };
  }
  const houseId = houseIds[houseRotationIdx % houseIds.length];
  houseRotationIdx = (houseRotationIdx + 1) % houseIds.length;

  // Eligible students: in this house, in this school, not on cooldown.
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
    // All students on cooldown for this house — try again sooner with a
    // different house next time.
    nextFireAtMs = now + 30_000;
    return { fired: false, reason: "house-cooled-down" };
  }

  const pick = studentRows[Math.floor(Math.random() * studentRows.length)];

  // Pick a positive PBIS reason — defaults to small point values so the
  // ambient drip doesn't drown out the bigger Spotlight awards.
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
    nextFireAtMs = now + jitteredDelay();
    return { fired: false, reason: "no-positive-reasons" };
  }

  // Bias toward 1-3 point reasons so the drip stays small. Falls back to
  // any positive reason if none match.
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
  nextFireAtMs = now + jitteredDelay();
  return { fired: true };
}

// -----------------------------------------------------------------------------
// Midnight reset — purge yesterday's demo drip so totals don't accumulate
// across days. Only touches rows tagged with DEMO_MARKER, so real awards
// are untouched.
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

  // Reset in-memory cadence state so the next morning starts fresh.
  nextFireAtMs = 0;
  recentStudents.clear();
  houseRotationIdx = 0;
  cachedWindow = null;

  logger.info({ deleted }, "demo heartbeat midnight reset complete");
  return { deleted };
}
