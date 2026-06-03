// Multi-year FAST history reader. Loads prior-year PM3 rows for a set
// of students (already filtered to the caller's school) and shapes them
// into a per-(studentId, subject) map of {schoolYear, pm3} entries
// sorted newest-first.
//
// Why this exists: the FL FAST Florida importer, when the admin checks
// "Import as historical (prior school year)", writes a SEPARATE
// student_fast_scores row keyed to (student, subject, school_year=YY-YY)
// with pm3 populated and is_historical=true. The current-year read
// paths (teacher roster, student profile FAST card, MTSS plan editor)
// filter to the current school_year and would otherwise never see those
// rows. This helper is the join site.
//
// Scope decisions:
//   - PM3-only. The importer contract is PM3-only for historical rows
//     (end-of-year scale score is the only signal we accept for prior
//     years — no partial-year backfill). Rows with no pm3 are dropped.
//   - Window cap. school_settings.fast_history_years_visible (default
//     3, max 5) controls how many prior years are returned per student.
//     5 is the hard ceiling because FAST launched in FL in 22-23 —
//     anything older is FSA on a non-comparable scale.
//   - Multi-tenancy. Every read filters on schoolId — never JOIN a
//     student_fast_scores row from another tenant.
//
// Returned shape is intentionally a Map-of-Maps so callers can do a
// cheap per-student lookup without re-grouping in the route handler.

import { and, eq, inArray, lt, isNotNull } from "drizzle-orm";
import { db, studentFastScoresTable, schoolSettingsTable } from "@workspace/db";
import { schoolYearLabelFor, DEFAULT_SCHOOL_TZ } from "./schoolYear.js";

export interface FastHistoryEntry {
  schoolYear: string;
  pm3: number;
}

export type FastHistoryMap = Map<string, Map<string, FastHistoryEntry[]>>;

const DEFAULT_YEARS_VISIBLE = 3;
const MAX_YEARS_VISIBLE = 5;

// Build the set of school-year labels strictly older than `current`
// going back `yearsVisible` steps. E.g. current="25-26", yearsVisible=3
// → ["24-25","23-24","22-23"]. Keeps the year-math out of route code
// so the chip's "how many years" window can change without touching
// every caller.
export function priorSchoolYearLabels(
  current: string,
  yearsVisible: number,
): string[] {
  const m = /^(\d{2})-(\d{2})$/.exec(current);
  if (!m) return [];
  let startYY = Number(m[1]);
  const out: string[] = [];
  for (let i = 0; i < yearsVisible; i++) {
    startYY -= 1;
    if (startYY < 0) break;
    const endYY = startYY + 1;
    const pad = (n: number) => String(n % 100).padStart(2, "0");
    out.push(`${pad(startYY)}-${pad(endYY)}`);
  }
  return out;
}

export async function loadFastHistoryYearsVisible(
  schoolId: number,
): Promise<number> {
  const [row] = await db
    .select({ years: schoolSettingsTable.fastHistoryYearsVisible })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  const raw = row?.years ?? DEFAULT_YEARS_VISIBLE;
  // Contract is 2..5 (default 3): FAST launched in FL in 22-23, so a
  // 1-year window can never show a prior-year comparison. Clamp the
  // lower bound to 2 to match the server validation and prevent a
  // manually-edited DB value of 1 from yielding an empty history.
  return Math.min(MAX_YEARS_VISIBLE, Math.max(2, raw));
}

export interface LoadFastHistoryArgs {
  schoolId: number;
  studentIds: string[];
  // Optional subject filter — caller passes ["ela","math"] to skip
  // EOC rows the roster doesn't render. Empty/undefined returns all.
  subjects?: string[];
  // Optional explicit window override. When omitted, reads from
  // school_settings.fast_history_years_visible.
  yearsVisible?: number;
  // Optional current school-year label override. Tests + callers that
  // already computed it can pass it in to avoid the calendar round-trip.
  currentSchoolYear?: string;
}

export async function loadFastHistory(
  args: LoadFastHistoryArgs,
): Promise<FastHistoryMap> {
  const out: FastHistoryMap = new Map();
  if (args.studentIds.length === 0) return out;

  const current =
    args.currentSchoolYear ??
    schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ);
  const yearsVisible =
    args.yearsVisible ?? (await loadFastHistoryYearsVisible(args.schoolId));
  const wantedYears = priorSchoolYearLabels(current, yearsVisible);
  if (wantedYears.length === 0) return out;

  // Single bulk read. Pull all prior-year rows in the visible window
  // for this student set, then filter in JS (the wantedYears list is
  // small — 3-5 entries — so we use lt(current) + a JS Set filter
  // rather than inArray, which keeps the index plan simpler).
  const rows = await db
    .select({
      studentId: studentFastScoresTable.studentId,
      subject: studentFastScoresTable.subject,
      schoolYear: studentFastScoresTable.schoolYear,
      pm3: studentFastScoresTable.pm3,
    })
    .from(studentFastScoresTable)
    .where(
      and(
        eq(studentFastScoresTable.schoolId, args.schoolId),
        inArray(studentFastScoresTable.studentId, args.studentIds),
        lt(studentFastScoresTable.schoolYear, current),
        isNotNull(studentFastScoresTable.pm3),
        // Only importer-tagged historical rows. Current-year rows
        // sometimes carry stale prior-SY copies for in-year transfers;
        // those are NOT what the "multi-year FAST history" chip is
        // meant to show. The FL Florida importer is the sole writer of
        // is_historical=true rows.
        eq(studentFastScoresTable.isHistorical, true),
      ),
    );

  const wanted = new Set(wantedYears);
  const subjectFilter =
    args.subjects && args.subjects.length > 0
      ? new Set(args.subjects)
      : null;

  for (const r of rows) {
    if (!wanted.has(r.schoolYear)) continue;
    if (subjectFilter && !subjectFilter.has(r.subject)) continue;
    if (r.pm3 == null) continue;
    let byStudent = out.get(r.studentId);
    if (!byStudent) {
      byStudent = new Map();
      out.set(r.studentId, byStudent);
    }
    let bySubject = byStudent.get(r.subject);
    if (!bySubject) {
      bySubject = [];
      byStudent.set(r.subject, bySubject);
    }
    bySubject.push({ schoolYear: r.schoolYear, pm3: r.pm3 });
  }

  // Newest first within each subject so the chip renders most-recent
  // prior year on the left without the caller re-sorting.
  for (const byStudent of out.values()) {
    for (const arr of byStudent.values()) {
      arr.sort((a, b) => b.schoolYear.localeCompare(a.schoolYear));
    }
  }

  return out;
}

// Convenience for callers that just want one student's history for
// one subject (student profile FAST card, MTSS suggestion chip).
export function pickHistory(
  map: FastHistoryMap,
  studentId: string,
  subject: string,
): FastHistoryEntry[] {
  return map.get(studentId)?.get(subject) ?? [];
}
