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
// Single canonical TZ for now (matches the seed migration and the AST
// cron). When a real cross-TZ tenant onboards, swap the default for
// a per-school IANA column threaded through every caller.
export const DEFAULT_SCHOOL_TZ = "America/New_York";

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
