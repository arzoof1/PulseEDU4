import { db, bellSchedulesTable, bellSchedulePeriodsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { DEFAULT_SCHOOL_TZ } from "./schoolYear.js";

// Lost-instruction minutes from tardies.
//
// A tardy's lateness = (check-in time) − (scheduled period start). The
// check-in time is the tardy row's `createdAt` (the moment Core Team logs
// the student arriving). The scheduled period start comes from the
// school's DEFAULT active bell schedule, matched on period number — the
// same source the parent on-time streak uses. A tardy whose period is not
// on the default schedule (or no default schedule exists) yields `null`
// (not computable) so callers can surface it honestly rather than guess.

// Fallback cap (minutes) for a period with no usable end time — keeps a
// mistyped/late log from inflating the total with an unbounded value.
const DEFAULT_PERIOD_CAP_MIN = 90;

export interface PeriodWindow {
  startMin: number;
  // Minutes from start to end; null when the schedule lacks a sane end
  // time, in which case DEFAULT_PERIOD_CAP_MIN is used as the cap.
  lengthMin: number | null;
}

function hhmmToMinutes(s: string): number | null {
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
  return h * 60 + mi;
}

// Period number from the SIS-varying period text ("3" / "03" / "P3" → 3).
export function periodNumberFromText(period: string): number | null {
  const m = period.match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

// Load the school's default active bell schedule as a period-number →
// window map. Empty map when the school has no default schedule yet.
export async function loadDefaultPeriodWindows(
  schoolId: number,
): Promise<Map<number, PeriodWindow>> {
  const out = new Map<number, PeriodWindow>();
  const [sched] = await db
    .select({ id: bellSchedulesTable.id })
    .from(bellSchedulesTable)
    .where(
      and(
        eq(bellSchedulesTable.schoolId, schoolId),
        eq(bellSchedulesTable.isDefault, true),
        eq(bellSchedulesTable.active, true),
      ),
    )
    .limit(1);
  if (!sched) return out;
  const periods = await db
    .select({
      periodNumber: bellSchedulePeriodsTable.periodNumber,
      startTime: bellSchedulePeriodsTable.startTime,
      endTime: bellSchedulePeriodsTable.endTime,
    })
    .from(bellSchedulePeriodsTable)
    .where(eq(bellSchedulePeriodsTable.scheduleId, sched.id));
  for (const p of periods) {
    const startMin = hhmmToMinutes(p.startTime);
    if (startMin == null) continue;
    const endMin = hhmmToMinutes(p.endTime);
    const lengthMin =
      endMin != null && endMin > startMin ? endMin - startMin : null;
    out.set(p.periodNumber, { startMin, lengthMin });
  }
  return out;
}

const minuteFmtCache = new Map<string, Intl.DateTimeFormat>();

// Minutes-since-midnight of an ISO instant in the given IANA timezone.
function tzMinutesOfDay(iso: string, tz: string): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  let fmt = minuteFmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    minuteFmtCache.set(tz, fmt);
  }
  const parts = fmt.formatToParts(d);
  let h = Number(parts.find((p) => p.type === "hour")?.value);
  const mi = Number(parts.find((p) => p.type === "minute")?.value);
  // hour12:false can emit "24" at midnight in some ICU builds.
  if (h === 24) h = 0;
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
  return h * 60 + mi;
}

// Lost-instruction minutes for a single tardy. Returns null when the
// period can't be matched to the default schedule (not computable).
export function tardyLostMinutes(
  windows: Map<number, PeriodWindow>,
  periodText: string,
  createdAtIso: string,
  tz: string = DEFAULT_SCHOOL_TZ,
): number | null {
  const pn = periodNumberFromText(periodText);
  if (pn == null) return null;
  const w = windows.get(pn);
  if (!w) return null;
  const mod = tzMinutesOfDay(createdAtIso, tz);
  if (mod == null) return null;
  let lost = mod - w.startMin;
  if (lost < 0) lost = 0;
  const cap = w.lengthMin ?? DEFAULT_PERIOD_CAP_MIN;
  if (lost > cap) lost = cap;
  return Math.round(lost);
}
