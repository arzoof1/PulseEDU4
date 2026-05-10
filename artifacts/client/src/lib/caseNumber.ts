// Mirrors artifacts/api-server/src/lib/schoolYear.ts on the client.
// Cases are displayed as "26-27-0042" — school year prefix + a
// per-year sequence padded to 4. If `schoolYearLabel` is missing
// (e.g. an old cached payload from before the migration shipped),
// fall back to the bare number so we never render "Case undefined".
export function formatCaseNumber(c: {
  schoolYearLabel?: string | null;
  caseNumber: number;
}): string {
  const padded = String(c.caseNumber).padStart(4, "0");
  if (!c.schoolYearLabel) return padded;
  return `${c.schoolYearLabel}-${padded}`;
}
