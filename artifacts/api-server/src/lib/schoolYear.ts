// School-year label helper. US convention: a school year runs from
// July of year N to June of year N+1, and is written as "26-27" for
// the 2026-27 academic year. Used as the year prefix on case numbers
// (Case "26-27-0042") so admins can file/filter by year.
//
// TIMEZONE
// --------
// We compute the calendar parts in a *school-local* timezone (default
// America/New_York) using `Intl.DateTimeFormat`. Previously this used
// `d.getFullYear()` / `d.getMonth()`, which silently read server-local
// time — fine for a single-TZ deployment, broken the moment a Pacific
// or Mountain tenant onboarded (a case opened 9pm PT on June 30 would
// land in next year's bucket because UTC was already July 1).
//
// Default fallback TZ. The `schools.timezone` column (added 2026)
// is the source of truth per-school; this constant only matters for
// callers that don't have a schoolId in scope (test fixtures, cron
// pre-loops, and the in-memory date math in `formatCaseNumber`).
export const DEFAULT_SCHOOL_TZ = "America/New_York";

import { db, schoolsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// Process-lifetime cache of school → IANA timezone. School TZ is set
// once at onboarding and almost never changes, so a tiny LRU-free
// Map keyed by id is fine — worst case we re-read on a cold worker.
// Clearing is manual (`clearSchoolTimezoneCache`) for tests or after
// a SuperUser edit; production never needs it.
const schoolTzCache = new Map<number, string>();

export async function getSchoolTimezone(schoolId: number): Promise<string> {
  const cached = schoolTzCache.get(schoolId);
  if (cached) return cached;
  const [row] = await db
    .select({ timezone: schoolsTable.timezone })
    .from(schoolsTable)
    .where(eq(schoolsTable.id, schoolId));
  const tz = row?.timezone || DEFAULT_SCHOOL_TZ;
  schoolTzCache.set(schoolId, tz);
  return tz;
}

export function clearSchoolTimezoneCache(schoolId?: number): void {
  if (schoolId == null) schoolTzCache.clear();
  else schoolTzCache.delete(schoolId);
}

// Compute the UTC instant for "local midnight today" in a given IANA
// timezone. Used by daily roll-call/queue queries that want a stable
// per-school day boundary instead of UTC-noon-ish heuristics.
//
// Algorithm: start from the local YYYY-MM-DD that `now` lives in,
// then iteratively converge a UTC guess so that, when re-formatted in
// the target tz, it reads as exactly y-m-d 00:00. Two passes handle
// DST transitions correctly — a noon-probe offset is wrong on the
// spring-forward day because midnight and noon sit on opposite sides
// of the 02:00 jump (architect-flagged regression, May 2026).
export function startOfDayUtc(now: Date, tz: string): Date {
  const dayFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const ymd = dayFmt.format(now); // YYYY-MM-DD
  const [yStr, mStr, dStr] = ymd.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  const tzFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const targetMs = Date.UTC(y, m - 1, d, 0, 0, 0);
  let guess = targetMs; // naive: treat local midnight as if it were UTC
  for (let i = 0; i < 3; i++) {
    const parts = tzFmt.formatToParts(new Date(guess));
    const ly = Number(parts.find((p) => p.type === "year")?.value);
    const lm = Number(parts.find((p) => p.type === "month")?.value);
    const ld = Number(parts.find((p) => p.type === "day")?.value);
    let lh = Number(parts.find((p) => p.type === "hour")?.value);
    const lmin = Number(parts.find((p) => p.type === "minute")?.value);
    // Intl in some runtimes emits "24" for midnight; normalize.
    if (lh === 24) lh = 0;
    const localMs = Date.UTC(ly, lm - 1, ld, lh, lmin, 0);
    const diff = targetMs - localMs;
    if (diff === 0) return new Date(guess);
    guess += diff;
  }
  return new Date(guess);
}

function calendarPartsInTz(d: Date, tz: string): { y: number; m: number } {
  // en-US YYYY-MM-DD via Intl, then parse. Avoids any locale ambiguity.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  return { y, m };
}

export function schoolYearLabelFor(
  d: Date,
  tz: string = DEFAULT_SCHOOL_TZ,
): string {
  const { y, m } = calendarPartsInTz(d, tz);
  const start = m >= 7 ? y : y - 1;
  const end = start + 1;
  const yy = (n: number) => String(n % 100).padStart(2, "0");
  return `${yy(start)}-${yy(end)}`;
}

// Advance a "YY-YY" school-year label forward by one year ("25-26" -> "26-27").
// Used by the school-controlled year flip to compute the incoming reporting
// year. Returns the input unchanged if it is not a valid label.
export function nextSchoolYear(label: string): string {
  const m = /^(\d{2})-(\d{2})$/.exec(label);
  if (!m) return label;
  const start = Number(m[1]) + 1;
  const yy = (n: number) => String(n % 100).padStart(2, "0");
  return `${yy(start)}-${yy(start + 1)}`;
}

// Rewind a "YY-YY" school-year label back by one year ("26-27" -> "25-26").
// Used to identify the outgoing year when reversing a flip.
export function prevSchoolYear(label: string): string {
  const m = /^(\d{2})-(\d{2})$/.exec(label);
  if (!m) return label;
  const start = Number(m[1]) - 1;
  if (start < 0) return label;
  const yy = (n: number) => String(n % 100).padStart(2, "0");
  return `${yy(start)}-${yy(start + 1)}`;
}

// First instant of the current school year, in the given timezone.
// Used by year-end aggregations (AST insights, case-year filters) so
// they bucket the boundary day correctly. Returns a Date positioned
// at midnight school-local on July 1 of the school-year *start*.
export function schoolYearStartDate(
  d: Date,
  tz: string = DEFAULT_SCHOOL_TZ,
): Date {
  const { y, m } = calendarPartsInTz(d, tz);
  const start = m >= 7 ? y : y - 1;
  // Constructing a Date at midnight in an arbitrary IANA TZ requires
  // a round-trip through formatted parts — JS has no first-class
  // "midnight in TZ" constructor. We get the UTC offset for July 1
  // noon (always inside DST), then back off to midnight local.
  const probe = new Date(Date.UTC(start, 6, 1, 12, 0, 0));
  const tzFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = tzFmt.formatToParts(probe);
  const lh = Number(parts.find((p) => p.type === "hour")?.value);
  // offset (in hours, ahead of UTC) such that probeUTC + offset = lh:00 local
  const offsetHours = lh - 12;
  // Midnight local on July 1 = UTC midnight - offsetHours
  return new Date(Date.UTC(start, 6, 1, -offsetHours, 0, 0));
}

// "26-27-0042" — paired with the integer caseNumber returned by the
// per-(school, year) sequence. Pad to 4 so cases sort correctly as
// strings up to 9999/year. If a school exceeds that, we'll have
// other problems first.
export function formatCaseNumber(c: {
  schoolYearLabel: string;
  caseNumber: number;
}): string {
  return `${c.schoolYearLabel}-${String(c.caseNumber).padStart(4, "0")}`;
}
