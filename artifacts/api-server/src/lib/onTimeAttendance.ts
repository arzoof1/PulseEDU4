import { and, eq } from "drizzle-orm";
import {
  db,
  bellSchedulesTable,
  bellSchedulePeriodsTable,
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

export async function loadAttendanceWindow(
  schoolId: number,
  now: Date = new Date(),
): Promise<AttendanceWindow> {
  const { scheduleId, periods } = await loadDefaultSchedulePeriods(schoolId);
  return computeAttendanceWindow(scheduleId, periods, now);
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
