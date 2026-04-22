// Returns today's date in America/New_York as YYYY-MM-DD.
export function todayInSchoolTz(): string {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}
