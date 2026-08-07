import { eq } from "drizzle-orm";
import {
  db,
  schoolSettingsTable,
  type BellSchedulePeriodRow,
} from "@workspace/db";
import {
  loadDayTypeContext,
  variantForGrade,
  minutesOfDayInTz,
  type DayTypeContext,
  type ScheduleVariant,
} from "./scheduleResolver.js";

// ---------------------------------------------------------------------------
// On-Time Attendance window math.
//
// A classroom-door kiosk auto-flips to Attendance mode during the PASSING
// window that precedes a class — students scan as they walk in to earn
// on-time points. The window for an INCOMING period P is:
//
//   [ prevBlock.endTime , P.startTime )            ← "passing" phase
//   [ P.startTime , P.startTime + GRACE )          ← "post_bell" phase
//
// For the first period of the day there is no prevBlock, so the passing
// window opens FIRST_PERIOD_ARRIVAL_LEAD_MIN before the bell (arrival).
//
// MULTI-SCHEDULE: windows are computed per schedule VARIANT (grade-level
// schedules under one Day Type). The kiosk's on-screen mode uses the Day
// Type's default variant; each SCAN is credited against the scanning
// student's own variant, so a 7th grader mid-class never earns passing
// credit just because the 6th-grade bell rang. See scheduleResolver.ts.
//
// Points:
//   passing   → min(maxPoints, ceil(minutes until the bell))   (≥1)
//   post_bell → flat 1 (in line when the bell rang)
//   off       → no credit
// ---------------------------------------------------------------------------

export const POST_BELL_GRACE_MIN = 10;
export const FIRST_PERIOD_ARRIVAL_LEAD_MIN = 20;
export const POST_BELL_POINTS = 1;

export type AttendancePhase = "passing" | "post_bell" | "off";

export interface AttendanceWindow {
  // Legacy field name — now carries the schedule (Day Type) id; the
  // variant id is baked into periodKey so idempotency is per-variant.
  scheduleId: number | null;
  dayKey: string;
  phase: AttendancePhase;
  incomingPeriodNumber: number | null;
  incomingPeriodName: string | null;
  minutesRemaining: number;
  periodKey: string | null;
}

function dayKeyInTz(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "00";
  const d = parts.find((p) => p.type === "day")?.value ?? "00";
  return `${y}-${m}-${d}`;
}

interface WindowPeriod {
  periodNumber: number;
  name: string;
  start: number; // minutes since midnight
  end: number;
  included: boolean;
  // Bridge blocks (explicit "passing" blocks) are transparent to the
  // window math: the on-time window stays OPEN across them toward the
  // next instructional period. Non-bridge excluded blocks (lunch,
  // advisory) keep the window CLOSED while they run.
  bridge?: boolean;
}

// Pure window computation over a variant's timing rows. `keyPrefix`
// namespaces the idempotency key (schedule + variant).
export function computeWindow(
  scheduleId: number | null,
  keyPrefix: string,
  periods: WindowPeriod[],
  nowMin: number,
  dayKey: string,
): AttendanceWindow {
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
  const sorted = [...periods].sort((a, b) => a.start - b.start);

  const activate = (
    p: WindowPeriod,
    phase: AttendancePhase,
    minutesRemaining: number,
  ): AttendanceWindow => {
    // Lunch / advisory / excluded periods never earn on-time credit.
    if (!p.included) return base;
    return {
      scheduleId,
      dayKey,
      phase,
      incomingPeriodNumber: p.periodNumber,
      incomingPeriodName: p.name,
      minutesRemaining: Math.max(0, minutesRemaining),
      periodKey: `${keyPrefix}:p${p.periodNumber}:${dayKey}`,
    };
  };

  // 1) Post-bell grace: we just entered a running INSTRUCTIONAL period
  // within GRACE. Non-credit blocks (lunch/passing) don't short-circuit
  // here — step 2 decides whether the window is open or closed.
  for (const p of sorted) {
    if (!p.included) continue;
    if (nowMin >= p.start && nowMin < p.start + POST_BELL_GRACE_MIN && nowMin < p.end) {
      return activate(p, "post_bell", 0);
    }
  }

  // 2) Passing window before the next INSTRUCTIONAL period. Explicit
  // passing blocks are transparent (window stays open across them);
  // lunch/advisory blocks keep the window closed while they run.
  const inClosedBlock = sorted.some(
    (p) =>
      nowMin >= p.start && nowMin < p.end && !p.included && !p.bridge,
  );
  if (inClosedBlock) return base;
  for (const p of sorted) {
    if (p.start <= nowMin || !p.included) continue;
    // Window opens when the last NON-BRIDGE block before p ends (its own
    // running period, lunch, etc.), or LEAD minutes early for the first
    // period of the day.
    const priorEnds = sorted
      .filter((x) => x !== p && !x.bridge && x.end <= p.start)
      .map((x) => x.end);
    const openAt =
      priorEnds.length > 0
        ? Math.max(...priorEnds)
        : p.start - FIRST_PERIOD_ARRIVAL_LEAD_MIN;
    if (nowMin >= openAt) {
      return activate(p, "passing", Math.ceil(p.start - nowMin));
    }
    break;
  }

  return base;
}

// A variant's on-time timing rows: instructional PERIOD blocks only, with
// the previous block's end (lunch included) forming the passing boundary.
// Lunch matters here: for a grade whose lunch precedes Period 4, the
// passing window for Period 4 opens when LUNCH ends — so we compute the
// window over ALL blocks, then only period blocks can activate.
function variantWindowPeriods(variant: ScheduleVariant): WindowPeriod[] {
  return variant.blocks.map((b) => ({
    periodNumber: b.periodNumber ?? 0,
    name: b.name,
    start: b.startMin,
    end: b.endMin,
    // Only instructional period blocks with a real period number can earn
    // credit; lunch/advisory/passing blocks participate in the timeline but
    // never activate.
    included:
      b.blockType === "period" && b.periodNumber != null && b.includedInOnTimeStreak,
    bridge: b.blockType === "passing",
  }));
}

export interface AttendanceEnv {
  ctx: DayTypeContext;
  effNow: Date;
  nowMin: number;
  dayKey: string;
  testLoop: boolean;
  // Whether this school actually runs multiple simultaneous schedules.
  hasGradeVariants: boolean;
}

export function attendanceWindowForVariant(
  env: AttendanceEnv,
  variant: ScheduleVariant | null,
): AttendanceWindow {
  if (env.testLoop) return buildTestLoopWindow(env.effNow);
  if (env.ctx.status !== "ok" || !env.ctx.dayType || !variant) {
    return {
      scheduleId: null,
      dayKey: env.dayKey,
      phase: "off",
      incomingPeriodNumber: null,
      incomingPeriodName: null,
      minutesRemaining: 0,
      periodKey: null,
    };
  }
  const prefix = variant.isDefault
    ? `s${env.ctx.dayType.id}` // legacy prefix — single-schedule schools keep their existing key shape
    : `s${env.ctx.dayType.id}:v${variant.id}`;
  return computeWindow(
    env.ctx.dayType.id,
    prefix,
    variantWindowPeriods(variant),
    env.nowMin,
    env.dayKey,
  );
}

export function attendanceWindowForGrade(
  env: AttendanceEnv,
  grade: number | string | null | undefined,
): AttendanceWindow {
  return attendanceWindowForVariant(env, variantForGrade(env.ctx, grade));
}

// ---------------------------------------------------------------------------
// TEST MODE (admin / Core Team only) — unchanged. Demo clock + test loop.
// ---------------------------------------------------------------------------

export interface SimClockSettings {
  onTimeSimClockMinutes: number | null;
  onTimeSimClockSetAt: Date | null;
}

export function effectiveNow(
  sim: SimClockSettings,
  realNow: Date = new Date(),
): Date {
  if (sim.onTimeSimClockMinutes === null || sim.onTimeSimClockSetAt === null) {
    return realNow;
  }
  const elapsedMs = realNow.getTime() - sim.onTimeSimClockSetAt.getTime();
  const simMin = sim.onTimeSimClockMinutes + elapsedMs / 60000;
  const d = new Date(realNow);
  d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() + simMin * 60000);
}

export const TEST_LOOP_PASSING_SEC = 150;
export const TEST_LOOP_POST_BELL_SEC = 90;
export const TEST_LOOP_CYCLE_SEC =
  TEST_LOOP_PASSING_SEC + TEST_LOOP_POST_BELL_SEC;

export function buildTestLoopWindow(now: Date): AttendanceWindow {
  const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
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

// Load everything a kiosk needs to evaluate windows for ANY student in one
// pass: Day Type context (variants + assignments), the effective clock
// (demo-clock aware), and whether the test loop is on.
export async function loadAttendanceEnv(
  schoolId: number,
  now: Date = new Date(),
): Promise<AttendanceEnv> {
  const [settings] = await db
    .select({
      testLoop: schoolSettingsTable.onTimeTestLoopEnabled,
      simMinutes: schoolSettingsTable.onTimeSimClockMinutes,
      simSetAt: schoolSettingsTable.onTimeSimClockSetAt,
    })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));

  const ctx = await loadDayTypeContext(schoolId);
  const testLoop = Boolean(settings?.testLoop);
  const eff = effectiveNow(
    {
      onTimeSimClockMinutes: settings?.simMinutes ?? null,
      onTimeSimClockSetAt: settings?.simSetAt ?? null,
    },
    now,
  );
  // Demo clock simulates a server-local wall time; real time uses school tz.
  const simActive =
    settings?.simMinutes != null && settings?.simSetAt != null;
  const nowMin = simActive
    ? eff.getHours() * 60 + eff.getMinutes() + eff.getSeconds() / 60
    : minutesOfDayInTz(eff, ctx.timezone);
  const dayKey = simActive
    ? `${eff.getFullYear()}-${String(eff.getMonth() + 1).padStart(2, "0")}-${String(eff.getDate()).padStart(2, "0")}`
    : dayKeyInTz(eff, ctx.timezone);
  return {
    ctx,
    effNow: eff,
    nowMin,
    dayKey,
    testLoop,
    hasGradeVariants: ctx.gradeAssignment.size > 0,
  };
}

// School-level window (default variant) — drives the kiosk's on-screen
// mode. Per-scan credit must use attendanceWindowForGrade instead.
export async function loadAttendanceWindow(
  schoolId: number,
  now: Date = new Date(),
): Promise<AttendanceWindow> {
  const env = await loadAttendanceEnv(schoolId, now);
  return attendanceWindowForVariant(env, env.ctx.defaultVariant);
}

// ---------------------------------------------------------------------------
// Legacy compat: several modules (on-time lottery) still consume the default
// schedule as a flat period list. Serve it from the DEFAULT VARIANT's
// instructional period blocks so there is a single source of truth.
// ---------------------------------------------------------------------------
export async function loadDefaultSchedulePeriods(schoolId: number): Promise<{
  scheduleId: number | null;
  periods: BellSchedulePeriodRow[];
}> {
  const ctx = await loadDayTypeContext(schoolId);
  if (ctx.status !== "ok" || !ctx.dayType || !ctx.defaultVariant) {
    return { scheduleId: null, periods: [] };
  }
  const fmt = (min: number) =>
    `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  const periods: BellSchedulePeriodRow[] = ctx.defaultVariant.blocks
    .filter((b) => b.blockType === "period" && b.periodNumber != null)
    .map((b) => ({
      id: b.id,
      scheduleId: ctx.dayType!.id,
      periodNumber: b.periodNumber as number,
      name: b.name,
      startTime: fmt(b.startMin),
      endTime: fmt(b.endMin),
      includedInOnTimeStreak: b.includedInOnTimeStreak,
    }));
  return { scheduleId: ctx.dayType.id, periods };
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
