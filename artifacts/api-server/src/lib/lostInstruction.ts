import { DEFAULT_SCHOOL_TZ } from "./schoolYear.js";
import {
  loadDayTypeContext,
  variantForGrade,
  type DayTypeContext,
  type ScheduleVariant,
} from "./scheduleResolver.js";

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

// Cap (minutes) for a single hall pass. A pass left open (student forgot
// to check back in) shouldn't bill a whole day of lost instruction, so a
// single pass contributes at most this many minutes.
const HALL_PASS_CAP_MIN = 240;

export interface PeriodWindow {
  startMin: number;
  // Minutes from start to end; null when the schedule lacks a sane end
  // time, in which case DEFAULT_PERIOD_CAP_MIN is used as the cap.
  lengthMin: number | null;
}

// Period number from the SIS-varying period text ("3" / "03" / "P3" → 3).
export function periodNumberFromText(period: string): number | null {
  const m = period.match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function windowsFromVariant(
  v: ScheduleVariant | null,
): Map<number, PeriodWindow> {
  const out = new Map<number, PeriodWindow>();
  if (!v) return out;
  for (const b of v.blocks) {
    if (b.blockType !== "period" || b.periodNumber == null) continue;
    out.set(b.periodNumber, {
      startMin: b.startMin,
      lengthMin: b.endMin > b.startMin ? b.endMin - b.startMin : null,
    });
  }
  return out;
}

// Grade-aware period windows for the school's active Day Type.
// MULTI-SCHEDULE: each grade may follow a different variant with different
// period start times, so lost-minute math must use the STUDENT's own
// windows. Load once per school, then call windowsForGrade per student —
// results are memoized per variant.
export interface GradePeriodWindows {
  windowsForGrade(
    grade: number | string | null | undefined,
  ): Map<number, PeriodWindow>;
}

export function gradeWindowsFromContext(ctx: DayTypeContext): GradePeriodWindows {
  const cache = new Map<number, Map<number, PeriodWindow>>();
  return {
    windowsForGrade(grade) {
      const v = ctx.status === "ok" ? variantForGrade(ctx, grade) : null;
      if (!v) return new Map();
      const hit = cache.get(v.id);
      if (hit) return hit;
      const m = windowsFromVariant(v);
      cache.set(v.id, m);
      return m;
    },
  };
}

export async function loadGradePeriodWindows(
  schoolId: number,
): Promise<GradePeriodWindows> {
  return gradeWindowsFromContext(await loadDayTypeContext(schoolId));
}

// Legacy shape: period windows of the DEFAULT variant. Kept for callers
// with no per-student grade in scope; per-student math should prefer
// loadGradePeriodWindows.
export async function loadDefaultPeriodWindows(
  schoolId: number,
): Promise<Map<number, PeriodWindow>> {
  const ctx = await loadDayTypeContext(schoolId);
  if (ctx.status !== "ok") return new Map();
  return windowsFromVariant(ctx.defaultVariant);
}

// Instructional minutes attributable to a single period when a student
// is absent for it: the period's length, or the fallback cap when the
// schedule lacks a sane end time.
export function periodLengthMinutes(w: PeriodWindow): number {
  return w.lengthMin ?? DEFAULT_PERIOD_CAP_MIN;
}

// Minutes a single hall pass kept a student out of class = (return time)
// − (checkout time), clamped to [0, HALL_PASS_CAP_MIN]. Returns null when
// the pass never ended (no return logged) so callers can skip it rather
// than guess a duration.
export function hallPassLostMinutes(
  createdAtIso: string,
  endedAtIso: string | null,
): number | null {
  if (!endedAtIso) return null;
  const a = new Date(createdAtIso).getTime();
  const b = new Date(endedAtIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  let m = Math.round((b - a) / 60000);
  if (m < 0) m = 0;
  if (m > HALL_PASS_CAP_MIN) m = HALL_PASS_CAP_MIN;
  return m;
}

const minuteFmtCache = new Map<string, Intl.DateTimeFormat>();

// Minutes-since-midnight of an ISO instant in the given IANA timezone.
// Exported so hall-pass research can attribute a pass to the bell-schedule
// period it started in, using the same clock math as tardy lost minutes.
export function tzMinutesOfDay(iso: string, tz: string): number | null {
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
