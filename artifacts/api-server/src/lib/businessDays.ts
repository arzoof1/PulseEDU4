// Add N business days (Mon–Fri) to a date, preserving the time-of-day.
// Weekends are skipped; public holidays are NOT considered (out of scope — the
// same simplification the rest of the tours SLA math uses). Day-of-week is read
// in the server's local time; a per-school timezone is tracked as future work
// (see DEFAULT_SCHOOL_TZ). Used for the "Still deciding" follow-up clock and
// the background escalation job.
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  let remaining = Math.max(0, Math.floor(days));
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) remaining -= 1;
  }
  return d;
}
