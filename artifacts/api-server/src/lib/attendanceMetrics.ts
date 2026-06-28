// Shared attendance-metrics helper — the SINGLE SOURCE OF TRUTH for the
// per-student "Days Absent (+ approx %)" columns surfaced across Insights
// (Academic Trajectories drill-down, Academics band drawer, Teacher
// Roster, Early Warning).
//
// Source of truth: the Eligibility Hub daily upload (`eligibility_absences`).
// Each upload REPLACES the per-student total for the current semester, so
// `absenceTotal` is the official "days missed" count straight from the SIS
// attendance file. We deliberately surface the RAW uploaded count (not the
// eligibility-rule "counted absences" that nets out approved parent notes /
// tardy spillover) — the columns are a plain attendance read, not an
// eligibility-status read.
//
// The percentage is APPROXIMATE by design (product-accepted): there is no
// instructional-day calendar in the system, so the denominator is the count
// of weekdays (Mon–Fri) elapsed from the school-configured semester start to
// today (school-local), clamped at the semester end. It does not subtract
// holidays/teacher-workdays, so it will read a few points low. Always label
// it as an estimate in the UI. When no semester start is configured we
// cannot derive a denominator, so `attendancePct` is null (the raw count
// still renders).

import { db, eligibilityAbsencesTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { loadEligibilitySettings } from "./eligibility.js";
import { getSchoolTimezone } from "./schoolYear.js";

export interface AttendanceMetric {
  // Official days-missed count from the latest Eligibility Hub upload for
  // the current semester (raw `absence_total`).
  daysAbsent: number;
  // Tardies for the current semester (raw `days_tardy`). Surfaced for
  // callers that want it; the Insights columns currently show daysAbsent.
  daysTardy: number;
  // Approximate attendance % (integer 0–100), or null when no semester
  // start is configured to derive a denominator. APPROXIMATE — see header.
  attendancePct: number | null;
}

// Count weekdays (Mon–Fri) from `startYmd` to `endYmd` inclusive. Both are
// local YYYY-MM-DD strings. Pure UTC date math is used only to step the
// day-of-week; no timezone drift because both endpoints are treated in the
// same frame. Bounded by ~one semester (about 100 days) so a loop is fine.
function countWeekdays(startYmd: string, endYmd: string): number {
  const [sy, sm, sd] = startYmd.split("-").map((n) => Number(n));
  const [ey, em, ed] = endYmd.split("-").map((n) => Number(n));
  if (!sy || !sm || !sd || !ey || !em || !ed) return 0;
  const start = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(ey, em - 1, ed);
  if (end < start) return 0;
  let count = 0;
  for (let t = start; t <= end; t += 86_400_000) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) count += 1;
  }
  return count;
}

// School-local YYYY-MM-DD for "now" in the given IANA timezone.
function todayYmdInTz(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Batch-load attendance metrics for a set of students within one school,
// keyed by canonical studentId. Students with no eligibility_absences row
// for the current semester are simply absent from the map — callers should
// render "—" (no attendance data uploaded), never a fabricated 0%.
export async function loadAttendanceMetrics(
  schoolId: number,
  studentIds: string[],
): Promise<Map<string, AttendanceMetric>> {
  const out = new Map<string, AttendanceMetric>();
  if (studentIds.length === 0) return out;

  const settings = await loadEligibilitySettings(schoolId);

  const rows = await db
    .select({
      studentId: eligibilityAbsencesTable.studentId,
      absenceTotal: eligibilityAbsencesTable.absenceTotal,
      daysTardy: eligibilityAbsencesTable.daysTardy,
    })
    .from(eligibilityAbsencesTable)
    .where(
      and(
        eq(eligibilityAbsencesTable.schoolId, schoolId),
        eq(eligibilityAbsencesTable.semesterLabel, settings.semesterLabel),
        inArray(eligibilityAbsencesTable.studentId, studentIds),
      ),
    );

  // Denominator is shared across all students in the school — compute once.
  let denom = 0;
  if (settings.semesterStart) {
    const tz = await getSchoolTimezone(schoolId);
    let endYmd = todayYmdInTz(tz);
    // Clamp to the configured semester end if we're past it (summer reads).
    if (settings.semesterEnd && endYmd > settings.semesterEnd) {
      endYmd = settings.semesterEnd;
    }
    denom = countWeekdays(settings.semesterStart, endYmd);
  }

  for (const r of rows) {
    const daysAbsent = r.absenceTotal ?? 0;
    const daysTardy = r.daysTardy ?? 0;
    let attendancePct: number | null = null;
    if (denom > 0) {
      const present = Math.max(0, denom - daysAbsent);
      attendancePct = Math.round((present / denom) * 100);
    }
    out.set(r.studentId, { daysAbsent, daysTardy, attendancePct });
  }

  return out;
}
