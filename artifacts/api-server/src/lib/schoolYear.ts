// School-year label helper. US convention: a school year runs from
// July of year N to June of year N+1, and is written as "26-27" for
// the 2026-27 academic year. Used as the year prefix on case numbers
// (Case "26-27-0042") so admins can file/filter by year.
//
// We intentionally do this in *local* time so a Friday-evening
// August case opened at 9pm ET doesn't slip to UTC-Saturday and
// land in a phantom future year on the boundary day. Cases are
// inherently bound to the school's calendar.
export function schoolYearLabelFor(d: Date): string {
  const y = d.getFullYear();
  const m = d.getMonth() + 1; // 1-12
  const start = m >= 7 ? y : y - 1;
  const end = start + 1;
  const yy = (n: number) => String(n % 100).padStart(2, "0");
  return `${yy(start)}-${yy(end)}`;
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
