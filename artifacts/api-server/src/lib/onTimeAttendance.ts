import { and, eq } from "drizzle-orm";
import {
  db,
  bellSchedulesTable,
  bellSchedulePeriodsTable,
  schoolSettingsTable,
  type BellSchedulePeriodRow,
} from "@workspace/db";

// ---------------------------------------------------------------------------
// On-Time Attendance window math.
//
// A classroom-door kiosk auto-flips to Attendance mode during the PASSING
// window that precedes a class — students scan as they walk in to earn
// on-time points. The window for an INCOMING period P is:
//
//   [ prevPeriod.endTime , P.startTime )           ← "passing" phase
//   [ P.startTime , P.startTime + GRACE )          ← "post_bell" phase
//
// For the first period of the day there is no prevPeriod, so the passing
// window opens FIRST_PERIOD_ARRIVAL_LEAD_MIN before the bell (arrival).
//
// Points:
//   passing   → min(maxPoints, ceil(minutes until the bell))   (≥1)
//   post_bell → flat 1 (in line when the bell rang)
//   off       → no credit
// ---------------------------------------------------------------------------

// Minutes the kiosk keeps taking (flat-1) scans after the tardy bell before
// it auto-reverts to hall-pass mode if the teacher never tapped Done.
export const POST_BELL_GRACE_MIN = 10;
// How long before the first-period bell the kiosk opens for arrival scans.
export const FIRST_PERIOD_ARRIVAL_LEAD_MIN = 20;
// Flat credit for an in-line scan that lands after the bell.
export const POST_BELL_POINTS = 1;

export type AttendancePhase = "passing" | "post_bell" | "off";

export interface AttendanceWindow {
  // Always present so callers can build the period key / fall back.
  scheduleId: number | null;
  dayKey: string;
  phase: AttendancePhase;
  // The class students are arriving TO (the one that earns credit).
  incomingPeriodNumber: number | null;
  incomingPeriodName: string | null;
  // Whole minutes until the tardy bell (ceil). 0 once the bell has rung.
  minutesRemaining: number;
  // s<scheduleId>:p<incomingPeriodNumber>:<dayKey> — idempotency key for a
  // single passing window. null when no attendance window is active.
  periodKey: string | null;
}

function localDayKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
}

// "HH:MM" -> minutes since midnight. Returns NaN on malformed input so the
// caller can skip the row rather than mis-order it.
function hmToMinutes(hm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

export async function loadDefaultSchedulePeriods(schoolId: number): Promise<{
  scheduleId: number | null;
  periods: BellSchedulePeriodRow[];
}> {
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
  if (!schedule) return { scheduleId: null, periods: [] };
  const periods = await db
    .select()
    .from(bellSchedulePeriodsTable)
    .where(eq(bellSchedulePeriodsTable.scheduleId, schedule.id));
  return { scheduleId: schedule.id, periods };
}

// Pure window computation given a sorted period list and "now". Exported for
// unit reasoning; the route wrapper below loads the schedule first.
export function computeAttendanceWindow(
  scheduleId: number | null,
  periods: BellSchedulePeriodRow[],
  now: Date,
): AttendanceWindow {
  const dayKey = localDayKey(now);
  const base: AttendanceWindow = {
    scheduleId,
    dayKey,
    phase: "off",
    incomingPeriodNumber: null,
    incomingPeriodName: null,
    minutesRemaining: 0,
    periodKey: null,
  };
  if (scheduleId === null || periods.length === 0) return base;

  // Sort by start time; drop malformed rows.
  const sorted = periods
    .map((p) => ({ row: p, start: hmToMinutes(p.startTime), end: hmToMinutes(p.endTime) }))
    .filter((p) => Number.isFinite(p.start) && Number.isFinite(p.end))
    .sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return base;

  const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;

  const activate = (
    p: (typeof sorted)[number],
    phase: AttendancePhase,
    minutesRemaining: number,
  ): AttendanceWindow => {
    // Lunch / advisory / passing periods the school excluded never earn
    // on-time credit even if the timing lines up.
    if (!p.row.includedInOnTimeStreak) return base;
    return {
      scheduleId,
      dayKey,
      phase,
      incomingPeriodNumber: p.row.periodNumber,
      incomingPeriodName: p.row.name,
      minutesRemaining: Math.max(0, minutesRemaining),
      periodKey: `s${scheduleId}:p${p.row.periodNumber}:${dayKey}`,
    };
  };

  // 1) Post-bell grace: we just entered a running period within GRACE.
  for (const p of sorted) {
    if (nowMin >= p.start && nowMin < p.start + POST_BELL_GRACE_MIN && nowMin < p.end) {
      return activate(p, "post_bell", 0);
    }
  }

  // 2) Passing window before an upcoming period.
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    if (nowMin >= p.start) continue; // already started — handled above / running
    // Window opens at the previous period's end, or an arrival lead for the
    // first period of the day.
    const prevEnd = i > 0 ? sorted[i - 1].end : p.start - FIRST_PERIOD_ARRIVAL_LEAD_MIN;
    if (nowMin >= prevEnd) {
      return activate(p, "passing", Math.ceil(p.start - nowMin));
    }
    break; // earliest upcoming period not yet in its window → nothing active
  }

  return base;
}

// ---------------------------------------------------------------------------
// TEST MODE (admin / Core Team only). See schoolSettings.ts for the columns.
//
// Two independent tools, both off by default:
//   * Demo clock  — a simulated "now" that advances in real time. The real
//                   bell-schedule + lottery math run against it (effectiveNow).
//   * Test loop   — a synthetic passing -> bell cycle on a short timer that
//                   ignores the bell schedule entirely (buildTestLoopWindow).
// ---------------------------------------------------------------------------

export interface SimClockSettings {
  onTimeSimClockMinutes: number | null;
  onTimeSimClockSetAt: Date | null;
}

// Resolve the effective "now" a school's On-Time logic should run against.
// When the demo clock is set, we anchor at onTimeSimClockMinutes (minutes
// since local midnight) and advance it by the real elapsed time since it was
// set, so countdowns tick naturally. Otherwise we return realNow unchanged.
export function effectiveNow(
  sim: SimClockSettings,
  realNow: Date = new Date(),
): Date {
  if (sim.onTimeSimClockMinutes === null || sim.onTimeSimClockSetAt === null) {
    return realNow;
  }
  const elapsedMs = realNow.getTime() - sim.onTimeSimClockSetAt.getTime();
  const simMin = sim.onTimeSimClockMinutes + elapsedMs / 60000;
  // Build a Date on the real local day at simMin minutes past midnight.
  const d = new Date(realNow);
  d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() + simMin * 60000);
}

// Test-loop cycle: a passing window counting down to a bell, then a post-bell
// window, then it repeats. Tuned short so a demo never waits long, but long
// enough to scan a handful of students per phase.
export const TEST_LOOP_PASSING_SEC = 150; // 2.5 min "passing" countdown
export const TEST_LOOP_POST_BELL_SEC = 90; // 1.5 min "post bell" window
export const TEST_LOOP_CYCLE_SEC =
  TEST_LOOP_PASSING_SEC + TEST_LOOP_POST_BELL_SEC;

// Synthetic attendance window for the test loop. Phase + countdown are derived
// purely from wall-clock seconds so every kiosk on the same school stays in
// sync. periodKey embeds the cycle index so each cycle is its own idempotency
// bucket (re-scans within a cycle dedupe; a new cycle reopens scanning and
// resets the teacher Done state automatically). incomingPeriodNumber = 0 has
// no class_sections row, so the roster gate falls through to open-accept —
// every scanned student earns credit, which is what a demo wants.
export function buildTestLoopWindow(now: Date): AttendanceWindow {
  const dayKey = localDayKey(now);
  const epochSec = Math.floor(now.getTime() / 1000);
  const cycleIndex = Math.floor(epochSec / TEST_LOOP_CYCLE_SEC);
  const offset = epochSec % TEST_LOOP_CYCLE_SEC;
  const periodKey = `testloop:${cycleIndex}:${dayKey}`;
  if (offset < TEST_LOOP_PASSING_SEC) {
    return {
      scheduleId: null,
      dayKey,
      phase: "passing",
      incomingPeriodNumber: 0,
      incomingPeriodName: "Test Loop",
      minutesRemaining: Math.max(
        1,
        Math.ceil((TEST_LOOP_PASSING_SEC - offset) / 60),
      ),
      periodKey,
    };
  }
  return {
    scheduleId: null,
    dayKey,
    phase: "post_bell",
    incomingPeriodNumber: 0,
    incomingPeriodName: "Test Loop",
    minutesRemaining: 0,
    periodKey,
  };
}

export async function loadAttendanceWindow(
  schoolId: number,
  now: Date = new Date(),
): Promise<AttendanceWindow> {
  const [settings] = await db
    .select({
      testLoop: schoolSettingsTable.onTimeTestLoopEnabled,
      simMinutes: schoolSettingsTable.onTimeSimClockMinutes,
      simSetAt: schoolSettingsTable.onTimeSimClockSetAt,
    })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));

  // Test loop wins over the demo clock when both are on.
  if (settings?.testLoop) {
    return buildTestLoopWindow(now);
  }
  const eff = effectiveNow(
    {
      onTimeSimClockMinutes: settings?.simMinutes ?? null,
      onTimeSimClockSetAt: settings?.simSetAt ?? null,
    },
    now,
  );
  const { scheduleId, periods } = await loadDefaultSchedulePeriods(schoolId);
  return computeAttendanceWindow(scheduleId, periods, eff);
}

// Server-authoritative point value for a scan in the given window.
export function computePoints(
  win: AttendanceWindow,
  maxPoints: number,
): number {
  if (win.phase === "passing") {
    return Math.min(maxPoints, Math.max(1, win.minutesRemaining));
  }
  if (win.phase === "post_bell") return POST_BELL_POINTS;
  return 0;
}
