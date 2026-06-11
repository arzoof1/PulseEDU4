// Shared helpers for the Academic Tier 3 "minutes" model.
//
// Academic Tier 3 plans (tier === 3 AND fastSubject set) no longer track
// per-day goal scores. Instead the interventionist logs MINUTES of
// small-group time per day and the week is "met" once the weekly total
// reaches the plan's `academicMinutesTarget` (or the week is released as
// "no group provided"). These pure helpers are shared by the bell, the
// weekly form's status endpoint, and the reports so every surface agrees
// on the met / owed / excused math.

export const ACADEMIC_DAY_KEYS = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
] as const;
export type AcademicDayKey = (typeof ACADEMIC_DAY_KEYS)[number];

// Default weekly minutes target for a fresh academic Tier 3 plan.
export const DEFAULT_ACADEMIC_MINUTES_TARGET = 30;

// Minutes are entered in 5-minute steps in the UI; the server clamps to
// this granularity and to a sane per-day ceiling so a fat-fingered entry
// can't store an absurd value.
export const ACADEMIC_MINUTES_STEP = 5;
export const ACADEMIC_MINUTES_DAY_MAX = 240;

// Monday floor for the minutes rework. The bell + week selector never look
// back past this week for plans that predate the rework, so existing
// academic plans don't show a false multi-week backlog the day this ships.
// (Ship week: the Monday of the rework deploy.)
export const ACADEMIC_MINUTES_REWORK_FLOOR = "2026-06-08";

export function isAcademicTier3(plan: {
  tier: number;
  fastSubject: string | null;
}): boolean {
  return (
    plan.tier === 3 &&
    (plan.fastSubject === "ela" || plan.fastSubject === "math")
  );
}

// Sum the per-day minutes map, ignoring junk values.
export function sumAcademicMinutes(map: unknown): number {
  if (!map || typeof map !== "object") return 0;
  let total = 0;
  for (const k of ACADEMIC_DAY_KEYS) {
    const v = (map as Record<string, unknown>)[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) total += v;
  }
  return total;
}

// Coerce an incoming per-day minutes map into a clean, clamped record.
// Drops days that aren't allowed by `allowedDays` (when provided) and
// snaps every value to the 5-minute grid within [0, DAY_MAX].
export function normalizeAcademicMinutes(
  raw: unknown,
  allowedDays?: ReadonlySet<string> | null,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of ACADEMIC_DAY_KEYS) {
    if (allowedDays && !allowedDays.has(k)) continue;
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
    let mins = Math.round(v / ACADEMIC_MINUTES_STEP) * ACADEMIC_MINUTES_STEP;
    if (mins < 0) mins = 0;
    if (mins > ACADEMIC_MINUTES_DAY_MAX) mins = ACADEMIC_MINUTES_DAY_MAX;
    if (mins > 0) out[k] = mins;
  }
  return out;
}

export type AcademicWeekState = "met" | "owed" | "excused";

export function academicWeekState(
  minutes: number,
  target: number,
  released: boolean,
): AcademicWeekState {
  if (released) return "excused";
  if (minutes >= target) return "met";
  return "owed";
}

// The set of weekday keys an academic plan exposes for logging. `any-day`
// plans expose all five; otherwise the plan's meetingDays drive it (and
// when meetingDays is empty we fall back to all five so the plan is never
// un-loggable).
export function academicVisibleDays(plan: {
  academicAnyDay: boolean;
  meetingDays: string | null;
}): AcademicDayKey[] {
  if (plan.academicAnyDay) return [...ACADEMIC_DAY_KEYS];
  const parsed = (plan.meetingDays ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d): d is AcademicDayKey =>
      (ACADEMIC_DAY_KEYS as readonly string[]).includes(d),
    );
  return parsed.length > 0 ? parsed : [...ACADEMIC_DAY_KEYS];
}

// ---- week math (all in school-local YYYY-MM-DD terms) ----

// Monday-of-the-week containing `localDateStr`. Sunday counts as the prior
// Mon-Sun week (matches mtssReports.ts / interventionsBell.ts).
export function mondayOf(localDateStr: string): string {
  const d = new Date(`${localDateStr}T00:00:00Z`);
  const dow = d.getUTCDay();
  const shift = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + shift);
  return d.toISOString().slice(0, 10);
}

export function addWeeks(monday: string, n: number): string {
  const d = new Date(`${monday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n * 7);
  return d.toISOString().slice(0, 10);
}

// The earliest Monday the bell / week selector should consider for a plan:
// the later of the plan's opened week and the rework floor.
export function academicStartMonday(planOpenedMonday: string): string {
  return planOpenedMonday > ACADEMIC_MINUTES_REWORK_FLOOR
    ? planOpenedMonday
    : ACADEMIC_MINUTES_REWORK_FLOOR;
}

// All Mondays from startMonday..endMonday inclusive (ascending). Capped so a
// misconfigured opened date can't enumerate thousands of weeks; when capped
// the current week is always kept as the last entry.
export function enumerateWeeks(
  startMonday: string,
  endMonday: string,
  maxWeeks = 60,
): string[] {
  if (endMonday < startMonday) return [];
  const out: string[] = [];
  let cur = startMonday;
  while (cur <= endMonday && out.length < maxWeeks) {
    out.push(cur);
    cur = addWeeks(cur, 1);
  }
  if (out.length > 0 && out[out.length - 1] !== endMonday) {
    out[out.length - 1] = endMonday;
  }
  return out;
}

// A short, human label for a week ("week of Jun 8") used in bell text.
export function weekLabel(monday: string): string {
  const d = new Date(`${monday}T00:00:00Z`);
  const month = d.toLocaleDateString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  return `week of ${month} ${d.getUTCDate()}`;
}
