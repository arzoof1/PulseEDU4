// Shared parent-snapshot data builder. Used by both the JSON endpoint
// (`routes/parentSnapshot.ts`) and the PDF endpoint
// (`routes/parentSnapshotPdf.ts`) so the visibility contract and field
// shape stay identical across both surfaces. Auth/parent-id resolution
// stays at the route layer; this helper assumes the caller has already
// produced a verified `parentId` and just needs the data for that
// (parent, student) pair.

import {
  db,
  parentsTable,
  parentStudentsTable,
  studentsTable,
  pbisEntriesTable,
  hallPassesTable,
  tardiesTable,
  supportNotesTable,
  studentAccommodationsTable,
  schoolAccommodationsTable,
  schoolHeartbeatSettingsTable,
  schoolSettingsTable,
  parentHeartbeatPrefsTable,
  studentFastScoresTable,
  interventionEntriesTable,
  studentMtssPlansTable,
  ossLogsTable,
  ossLogDaysTable,
  studentRetentionsTable,
  studentAttendanceDayTable,
  bellSchedulesTable,
  bellSchedulePeriodsTable,
  benchmarkReteachLogTable,
  housesTable,
  attendanceCheckinsTable,
} from "@workspace/db";
import { and, eq, desc, isNull, sql, gte, lt } from "drizzle-orm";
import {
  schoolYearLabelFor,
  DEFAULT_SCHOOL_TZ,
  getSchoolTimezone,
} from "./schoolYear.js";
import { loadRestroomDestinationNames } from "./oneWayPass.js";
import {
  loadDefaultPeriodWindows,
  tardyLostMinutes,
  hallPassLostMinutes,
  periodLengthMinutes,
} from "./lostInstruction.js";

// Returns the YYYY-MM-DD bounds of the current school year. The cutover
// is Aug 1 — anything before that rolls back to the previous Aug 1 so a
// July report still reflects the year that just ended. The upper bound
// is the *next* Aug 1, exclusive, so future-dated entries (e.g. an
// admin pre-logging next year's days) don't bleed into the current
// year's count.
function schoolYearBounds(): { startIso: string; endExclusiveIso: string } {
  const now = new Date();
  const y = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return { startIso: `${y}-08-01`, endExclusiveIso: `${y + 1}-08-01` };
}

export interface ParentSnapshot {
  parent: { displayName: string; email: string };
  student: {
    id: number;
    studentId: string;
    localSisId: string | null;
    firstName: string;
    lastName: string;
    grade: number;
    // Grades the student was retained in, ascending. Empty when none.
    // Drives the "R" indicator on the parent portal student card.
    retainedGrades: number[];
    // Staff-authored parent-facing note for THIS week's HeartBEAT, written
    // from the Student Snapshot page. null/empty = no note (block skipped).
    heartbeatNote: string | null;
  };
  sectionsAvailable: {
    recognition: boolean;
    attendance: boolean;
    hallPasses: boolean;
    accommodations: boolean;
    fastScores: boolean;
    commHistory: boolean;
    pullouts: boolean;
    interventions: boolean;
    staffNotes: boolean;
    iss: boolean;
    mtss: boolean;
    oss: boolean;
    // Learning at Home — academic work-sample cards. Gated solely by the
    // per-school admin feature toggle (super && admin), no parent pref.
    academicEvidence: boolean;
    // Reteach activity rollup. Gated by BOTH the school-wide
    // `showReteach` flag AND per-student
    // `students.reteach_logs_parent_visible`. Teacher notes /
    // strategy are never included in the payload — only counts +
    // benchmark codes.
    reteach: boolean;
  };
  pbis: {
    total: number;
    thisWeek: number;
    weeklyCounts: { positive: number; negative: number };
    sparkline: number[];
    recent: Array<{
      id: number;
      reason: string;
      points: number;
      polarity: string;
      staffName: string;
      createdAt: string;
      note: string | null;
    }>;
  };
  hallPasses: {
    thisWeekCount: number;
    recent: Array<{
      id: number;
      destination: string;
      originRoom: string;
      teacherName: string;
      status: string;
      createdAt: string;
      endedAt: string | null;
      arrivedAt?: string | null;
      endedBy?: string | null;
      // True for one-way (non-restroom) passes. Restroom passes are
      // round-trip; the client must not show them an "in route" state.
      oneWay: boolean;
    }>;
  };
  // School-year-to-date "Lost Instructional Time" summary, surfaced at the
  // TOP of the parent portal. Three contributors, each with a count and the
  // minutes of instruction lost, plus a grand total. Pieces whose parent
  // section is hidden are zeroed (and excluded from `totalMinutes`). See the
  // computation block for the definitions — note ABSENCES are kiosk-derived
  // (class periods with no door-kiosk check-in), not official SIS attendance.
  lostInstruction: {
    hallPasses: { count: number; minutes: number };
    tardies: { count: number; minutes: number };
    absences: { count: number; minutes: number };
    totalMinutes: number;
  };
  attendance: {
    tardiesThisWeek: number;
    checkInsThisWeek: number;
    // Aggregated attendance %. `null` when the window has zero logged
    // school days for the student (avoids showing a meaningless "0%").
    // `present` counts attendance_day rows with status='present' OR
    // 'tardy' (tardy still counts as in-attendance, matching FLDOE
    // reporting). `total` is every logged day in the window.
    pct: {
      ytd: { presentDays: number; totalDays: number; pct: number } | null;
      last30: { presentDays: number; totalDays: number; pct: number } | null;
    };
    // Period-level on-time streak. "On-time" = student was present
    // that day AND not marked tardy for that counted period (counted =
    // included_in_on_time_streak=true on the school's default bell
    // schedule). Absent days (excused or unexcused) are skipped — they
    // neither add to nor reset the streak. A tardy in any counted
    // period resets `current` to 0; `longestYtd` is the longest run
    // inside this school year. `pctYtd` is on-time counted periods /
    // total counted periods the student was present for (null when
    // the denominator is 0). The whole block is `null` when the school
    // hasn't configured a default bell schedule yet — required setup,
    // hides the tiles entirely on the parent surface.
    onTimeStreak: {
      current: number;
      longestYtd: number;
      pctYtd: number | null;
      countedPeriods: number;
    } | null;
    // Kiosk On-Time Attendance ledger (attendance_checkins), YTD. Distinct
    // from the tardy-derived `onTimeStreak` above: this counts only the
    // door-kiosk check-ins logged this school year. `ratePct` is on-time
    // arrivals (pre-bell) / total check-ins, null when the student has no
    // check-ins yet. `lotteryWins` counts Tardy-Lottery bonus rows. The
    // whole block is `null` when the school has zero check-ins logged for
    // the student so the surface hides cleanly.
    onTimeArrivals: {
      checkinCount: number;
      onTimeCount: number;
      ratePct: number | null;
      lotteryWins: number;
    } | null;
    recent: Array<{
      id: number;
      entryType: string;
      period: string;
      teacherName: string;
      reason: string;
      createdAt: string;
    }>;
  };
  accommodations: Array<{ id: number; name: string; category: string }>;
  staffNotes: Array<{
    id: number;
    noteType: string;
    noteText: string;
    staffName: string;
    createdAt: string;
  }>;
  fastScores: Array<{
    subject: string;
    pm1: number | null;
    pm2: number | null;
    pm3: number | null;
    priorYearScore: number | null;
    priorYearBq: boolean;
  }>;
  interventions: Array<{
    interventionType: string;
    note: string | null;
    staffName: string;
    createdAt: string;
  }>;
  mtss: {
    tier: number;
    plans: Array<{
      id: number;
      title: string;
      tier: number;
      openedAt: string;
      goals: string | null;
    }>;
  };
  // OSS (out-of-school suspension) — `daysThisYear` is always populated
  // when sectionsAvailable.oss is true; `recent` lists the most recent
  // assigned days. Reason text is included only when the school enabled
  // the separate `showOssReason` flag (per-parent gating doesn't apply
  // to reason — it's an all-or-nothing school policy decision).
  oss: {
    daysThisYear: number;
    recent: Array<{
      day: string;
      reason: string | null;
      notes: string | null;
    }>;
  };
  // Reteach activity for this school year. Empty array when the
  // section is gated off or simply has no rows. Each entry is one
  // benchmark code with counts of 1:1 and small-group reteach
  // moments. Strategy / notes / teacher attribution are NEVER
  // included — counts + benchmark codes only.
  reteach: {
    items: Array<{
      benchmarkCode: string;
      oneOnOne: number;
      smallGroup: number;
      total: number;
      lastAt: string;
    }>;
  };
  // PBIS house affiliation. Null when the student isn't assigned to a
  // house (or the school doesn't run houses). Gated under the same
  // `recognition` flag as PBIS points since house standing is the
  // school-wide PBIS rollup. `totalPoints` is the sum of all active
  // (non-voided) PBIS points across every member of the house in the
  // current school — same calculation as the houses signage and the
  // staff-facing Houses panel, so the number a parent sees matches
  // what the kids see on the hallway TVs.
  house: {
    id: number;
    name: string;
    color: string;
    motto: string | null;
    iconKey: string | null;
    iconObjectKey: string | null;
    totalPoints: number;
  } | null;
}

export type SnapshotResult =
  | { ok: true; data: ParentSnapshot }
  | { ok: false; status: number; error: string };

function startOfDayN(daysAgo: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(0, 0, 0, 0);
  return d;
}

function isWithinDays(iso: string, days: number): boolean {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return t >= startOfDayN(days).getTime();
}

export async function buildParentSnapshot(
  parentId: number,
  studentId: number,
): Promise<SnapshotResult> {
  // Tenant check — only data lookup beyond this point if parent owns
  // the requested student.
  const [link] = await db
    .select({ id: parentStudentsTable.id })
    .from(parentStudentsTable)
    .where(
      and(
        eq(parentStudentsTable.parentId, parentId),
        eq(parentStudentsTable.studentId, studentId),
      ),
    );
  if (!link) return { ok: false, status: 403, error: "Not your student" };

  const [student] = await db
    .select()
    .from(studentsTable)
    .where(eq(studentsTable.id, studentId));
  if (!student)
    return { ok: false, status: 404, error: "Student not found" };

  // Retention indicator (R-in-circle on the parent portal student card).
  // Cheap query — at most a handful of rows per student.
  const retentionRows = await db
    .select({ gradeLevel: studentRetentionsTable.gradeLevel })
    .from(studentRetentionsTable)
    .where(
      and(
        eq(studentRetentionsTable.schoolId, student.schoolId),
        eq(studentRetentionsTable.studentId, student.studentId),
      ),
    );
  const retainedGradesForStudent = retentionRows
    .map((r) => r.gradeLevel)
    .sort((a, b) => a - b);

  const [parent] = await db
    .select({ displayName: parentsTable.displayName, email: parentsTable.email })
    .from(parentsTable)
    .where(eq(parentsTable.id, parentId));

  // School + parent visibility prefs in parallel; gate() enforces the
  // contract: schoolEnabled AND parentPref !== false.
  const [settingsRow, prefsRow, featureRow] = await Promise.all([
    db
      .select()
      .from(schoolHeartbeatSettingsTable)
      .where(eq(schoolHeartbeatSettingsTable.schoolId, student.schoolId))
      .then((rows) => rows[0]),
    db
      .select()
      .from(parentHeartbeatPrefsTable)
      .where(
        and(
          eq(parentHeartbeatPrefsTable.parentId, parentId),
          eq(parentHeartbeatPrefsTable.studentId, studentId),
        ),
      )
      .then((rows) => rows[0]),
    db
      .select({
        admin: schoolSettingsTable.featureAcademicEvidence,
        sup: schoolSettingsTable.superFeatureAcademicEvidence,
      })
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, student.schoolId))
      .then((rows) => rows[0]),
  ]);
  const gate = (
    schoolFlag: boolean | null | undefined,
    schoolDefault: boolean,
    parentPref: boolean | null | undefined,
  ): boolean => {
    const schoolEnabled = schoolFlag ?? schoolDefault;
    if (!schoolEnabled) return false;
    if (parentPref === false) return false;
    return true;
  };
  const sectionsAvailable: ParentSnapshot["sectionsAvailable"] = {
    recognition: gate(settingsRow?.showRecognition, true, prefsRow?.showRecognition),
    attendance: gate(settingsRow?.showAttendance, true, prefsRow?.showAttendance),
    hallPasses: gate(settingsRow?.showHallPasses, true, prefsRow?.showHallPasses),
    accommodations: gate(settingsRow?.showAccommodations, true, prefsRow?.showAccommodations),
    fastScores: gate(settingsRow?.showFastScores, true, prefsRow?.showFastScores),
    commHistory: gate(settingsRow?.showCommHistory, true, prefsRow?.showCommHistory),
    pullouts: gate(settingsRow?.showPullouts, true, prefsRow?.showPullouts),
    interventions: gate(settingsRow?.showInterventions, false, prefsRow?.showInterventions),
    staffNotes: gate(settingsRow?.showStaffNotes, false, prefsRow?.showStaffNotes),
    iss: gate(settingsRow?.showIss, false, prefsRow?.showIss),
    mtss: gate(settingsRow?.showMtss, false, prefsRow?.showMtss),
    oss: gate(settingsRow?.showOss, false, prefsRow?.showOss),
    // Admin feature toggle only (super && admin); defaults ON when no row.
    academicEvidence:
      (featureRow?.admin ?? true) && (featureRow?.sup ?? true),
    // Reteach requires school flag AND parent pref AND per-student
    // opt-in. Per-student flag defaults FALSE so a school flipping
    // showReteach on doesn't accidentally expose students whose
    // admins haven't approved visibility.
    reteach:
      gate(settingsRow?.showReteach, false, prefsRow?.showReteach) &&
      Boolean(student.reteachLogsParentVisible),
  };

  // ----- PBIS -----
  const pbisRows = sectionsAvailable.recognition
    ? await db
        .select()
        .from(pbisEntriesTable)
        .where(
          and(
            eq(pbisEntriesTable.schoolId, student.schoolId),
            eq(pbisEntriesTable.studentId, student.studentId),
          ),
        )
        .orderBy(desc(pbisEntriesTable.createdAt))
        .limit(50)
    : [];
  const pbisActive = pbisRows.filter((r) => r.voidedAt === null);

  const weekStartIso = startOfDayN(7).toISOString();
  const weeklyPbisCounts = sectionsAvailable.recognition
    ? await (async () => {
        const rows = await db
          .select({
            polarity: pbisEntriesTable.polarity,
            count: sql<number>`COUNT(*)::int`,
          })
          .from(pbisEntriesTable)
          .where(
            and(
              eq(pbisEntriesTable.schoolId, student.schoolId),
              eq(pbisEntriesTable.studentId, student.studentId),
              isNull(pbisEntriesTable.voidedAt),
              sql`${pbisEntriesTable.createdAt} >= ${weekStartIso}`,
            ),
          )
          .groupBy(pbisEntriesTable.polarity);
        let positive = 0;
        let negative = 0;
        for (const r of rows) {
          if (r.polarity === "positive") positive = r.count;
          else if (r.polarity === "negative") negative = r.count;
        }
        return { positive, negative };
      })()
    : { positive: 0, negative: 0 };
  const pbisTotal = pbisActive.reduce((sum, r) => sum + r.points, 0);
  const pbisThisWeek = pbisActive
    .filter((r) => isWithinDays(r.createdAt, 7))
    .reduce((sum, r) => sum + r.points, 0);
  const pbisDailyBuckets: number[] = Array(7).fill(0);
  for (const r of pbisActive) {
    const t = new Date(r.createdAt).getTime();
    if (Number.isNaN(t)) continue;
    const daysAgo = Math.floor((Date.now() - t) / (24 * 3600 * 1000));
    if (daysAgo >= 0 && daysAgo < 7) {
      pbisDailyBuckets[6 - daysAgo] += r.points;
    }
  }

  // ----- Hall passes -----
  const hpRows = sectionsAvailable.hallPasses
    ? await db
        .select()
        .from(hallPassesTable)
        .where(
          and(
            eq(hallPassesTable.schoolId, student.schoolId),
            eq(hallPassesTable.studentId, student.studentId),
          ),
        )
        .orderBy(desc(hallPassesTable.createdAt))
        .limit(50)
    : [];
  // Restroom passes are round-trip ("I'm back" at origin) and never get a
  // one-way "in route → checked in" lifecycle, so the parent UI must not
  // mislabel an active restroom pass as "in route". `oneWay` is the flag.
  const restroomNames =
    hpRows.length > 0
      ? await loadRestroomDestinationNames(student.schoolId)
      : new Set<string>();
  const hpThisWeekCount = hpRows.filter((r) =>
    isWithinDays(r.createdAt, 7),
  ).length;

  // ----- Tardies / check-ins -----
  const tardyRows = sectionsAvailable.attendance
    ? await db
        .select()
        .from(tardiesTable)
        .where(
          and(
            eq(tardiesTable.schoolId, student.schoolId),
            eq(tardiesTable.studentId, student.studentId),
          ),
        )
        .orderBy(desc(tardiesTable.createdAt))
        .limit(50)
    : [];
  const tardyThisWeek = tardyRows.filter(
    (r) => r.entryType === "tardy" && isWithinDays(r.createdAt, 7),
  ).length;
  const checkInThisWeek = tardyRows.filter(
    (r) =>
      (r.entryType === "checkin" || r.entryType === "checkout") &&
      isWithinDays(r.createdAt, 7),
  ).length;

  // ----- Attendance % + on-time streak -----
  // Uses studentAttendanceDayTable as the source of truth for daily
  // status. Rows are typically inserted by the SIS importer with one
  // of {present, tardy, excused, unexcused}; missing rows (e.g.
  // weekends, school-closed days) are not present in the table at
  // all so they neither help nor hurt the denominator. We pull only
  // the current school year (Aug 1 → next Aug 1) so the SUM is
  // bounded; the last-30 window is then derived in-memory by date
  // string comparison.
  const { startIso: syStartIso, endExclusiveIso: syEndIso } = schoolYearBounds();
  // YYYY-MM-DD for "30 days ago" in server-local time. We compare as
  // strings against attendance_day.day (also a YYYY-MM-DD date). Build
  // the string from local Date getters — do NOT use toISOString(),
  // which serializes in UTC and silently shifts the cutoff by a day
  // near midnight depending on server timezone.
  const thirtyAgo = new Date();
  thirtyAgo.setDate(thirtyAgo.getDate() - 30);
  const pad = (n: number) => String(n).padStart(2, "0");
  const thirtyAgoIso = `${thirtyAgo.getFullYear()}-${pad(thirtyAgo.getMonth() + 1)}-${pad(thirtyAgo.getDate())}`;

  const attendanceDayRows = sectionsAvailable.attendance
    ? await db
        .select({
          day: studentAttendanceDayTable.day,
          status: studentAttendanceDayTable.status,
        })
        .from(studentAttendanceDayTable)
        .where(
          and(
            eq(studentAttendanceDayTable.schoolId, student.schoolId),
            eq(studentAttendanceDayTable.studentId, student.studentId),
            gte(studentAttendanceDayTable.day, syStartIso),
            lt(studentAttendanceDayTable.day, syEndIso),
          ),
        )
        .orderBy(studentAttendanceDayTable.day)
    : [];

  function pctBucket(rows: typeof attendanceDayRows) {
    if (rows.length === 0) return null;
    const present = rows.filter(
      (r) => r.status === "present" || r.status === "tardy",
    ).length;
    return {
      presentDays: present,
      totalDays: rows.length,
      // One decimal, e.g. 96.4. Clamp to [0, 100] for paranoia.
      pct: Math.max(0, Math.min(100, Math.round((present / rows.length) * 1000) / 10)),
    };
  }
  const ytdRows = attendanceDayRows; // already bounded by query
  const last30Rows = attendanceDayRows.filter((r) => r.day >= thirtyAgoIso);
  const attendancePct = {
    ytd: pctBucket(ytdRows),
    last30: pctBucket(last30Rows),
  };

  // ----- Period-level on-time streak -----
  // Pulls the school's default bell schedule (required setup; the
  // snapshot exposes `null` when missing so the parent UI hides the
  // tiles entirely). Then walks YTD attendance days in date order:
  //   - excused / unexcused absences: skip (don't add, don't reset)
  //   - present / tardy day: for each counted period in periodNumber
  //     order, check the tardies table for a (day, period) match. A
  //     match resets the streak to 0; no match increments it.
  // We also tally on-time vs total counted periods to produce
  // `pctYtd` (the year-to-date on-time percentage).
  let onTimeStreak: ParentSnapshot["attendance"]["onTimeStreak"] = null;
  if (sectionsAvailable.attendance) {
    // First confirm the school has a default active bell schedule at
    // all. The spec says the whole block is null ONLY when no default
    // schedule exists; "default schedule present but all periods opted
    // out" still returns a non-null (zero-filled) block so the UI can
    // distinguish "school hasn't set this up" from "school set it up
    // but nothing counts toward the streak right now."
    const [defaultSchedule] = await db
      .select({ id: bellSchedulesTable.id })
      .from(bellSchedulesTable)
      .where(
        and(
          eq(bellSchedulesTable.schoolId, student.schoolId),
          eq(bellSchedulesTable.isDefault, true),
          eq(bellSchedulesTable.active, true),
        ),
      );

    if (defaultSchedule) {
      const countedPeriods = await db
        .select({
          periodNumber: bellSchedulePeriodsTable.periodNumber,
        })
        .from(bellSchedulePeriodsTable)
        .where(
          and(
            eq(bellSchedulePeriodsTable.scheduleId, defaultSchedule.id),
            eq(bellSchedulePeriodsTable.includedInOnTimeStreak, true),
          ),
        )
        .orderBy(bellSchedulePeriodsTable.periodNumber);

      // Pull YTD tardies for the student. We query the tardies table
      // directly (the existing `tardyRows` is capped at 50, too narrow
      // for a year-long streak scan).
      const ytdTardies =
        countedPeriods.length > 0
          ? await db
              .select({
                createdAt: tardiesTable.createdAt,
                period: tardiesTable.period,
              })
              .from(tardiesTable)
              .where(
                and(
                  eq(tardiesTable.schoolId, student.schoolId),
                  eq(tardiesTable.studentId, student.studentId),
                  eq(tardiesTable.entryType, "tardy"),
                  // tardies.createdAt is TEXT (ISO); lexicographic
                  // comparison against YYYY-MM-DD works because ISO sorts.
                  gte(tardiesTable.createdAt, syStartIso),
                  lt(tardiesTable.createdAt, syEndIso),
                ),
              )
          : [];
      const tardySet = new Set<string>();
      for (const t of ytdTardies) {
        // tardies.period varies across SISes ("3", "03", "P3"). Extract
        // digits and parse as a number so the comparison against
        // schedule period numbers is canonical (matches "1" / "01" /
        // "P1" all to period 1).
        const m = t.period.match(/\d+/);
        if (!m) continue;
        const periodNum = Number(m[0]);
        if (!Number.isFinite(periodNum)) continue;
        const day = t.createdAt.slice(0, 10);
        tardySet.add(`${day}|${periodNum}`);
      }

      let run = 0;
      let longest = 0;
      let onTimeCount = 0;
      let totalCount = 0;
      for (const r of attendanceDayRows) {
        if (r.status === "excused" || r.status === "unexcused") continue;
        for (const cp of countedPeriods) {
          totalCount += 1;
          // `cp.periodNumber` is already a number; coerced to string by
          // template literal, matching the numeric form we put in
          // `tardySet`.
          const key = `${r.day}|${cp.periodNumber}`;
          if (tardySet.has(key)) {
            run = 0;
          } else {
            run += 1;
            onTimeCount += 1;
            if (run > longest) longest = run;
          }
        }
      }
      onTimeStreak = {
        current: run,
        longestYtd: longest,
        pctYtd:
          totalCount > 0
            ? Math.max(0, Math.min(100, Math.round((onTimeCount / totalCount) * 1000) / 10))
            : null,
        countedPeriods: totalCount,
      };
    }
  }

  // ----- Kiosk On-Time Attendance ledger (attendance_checkins) -----
  // YTD door-kiosk check-ins. Separate from `onTimeStreak` (tardy-derived).
  // Gated on the attendance section flag. `ratePct` = pre-bell arrivals /
  // total check-ins. The whole block is null when no check-ins exist.
  let onTimeArrivals: ParentSnapshot["attendance"]["onTimeArrivals"] = null;
  if (sectionsAvailable.attendance) {
    const { startIso: caStartIso, endExclusiveIso: caEndIso } =
      schoolYearBounds();
    const caRows = await db
      .select({
        kind: attendanceCheckinsTable.kind,
        postBell: attendanceCheckinsTable.postBell,
      })
      .from(attendanceCheckinsTable)
      .where(
        and(
          eq(attendanceCheckinsTable.schoolId, student.schoolId),
          eq(attendanceCheckinsTable.studentId, student.studentId),
          gte(attendanceCheckinsTable.day, caStartIso),
          lt(attendanceCheckinsTable.day, caEndIso),
        ),
      );
    if (caRows.length > 0) {
      const checkins = caRows.filter((r) => r.kind === "checkin");
      const checkinCount = checkins.length;
      const onTimeCount = checkins.filter((r) => !r.postBell).length;
      const lotteryWins = caRows.filter((r) => r.kind === "lottery").length;
      onTimeArrivals = {
        checkinCount,
        onTimeCount,
        ratePct:
          checkinCount > 0
            ? Math.round((onTimeCount / checkinCount) * 100)
            : null,
        lotteryWins,
      };
    }
  }

  // ----- Lost Instructional Time (top-of-portal SY-to-date summary) -----
  // Three contributors, all school-year-to-date, per child. Each piece is
  // gated on its parent section toggle so a hidden section never leaks a
  // count/minutes into this summary or its grand total.
  //  • Hall passes — minutes out of class (return − checkout, capped).
  //  • Tardies     — lateness minutes (check-in − scheduled period start).
  //  • Absences    — KIOSK-DERIVED: class periods the student never scanned
  //    into at a door kiosk. "Expected" periods are the (day, period) slots
  //    where the attendance module actually ran for the school (some student
  //    checked in) AND the period is on the default bell schedule; each is
  //    valued by that period's length. This is an estimate, NOT official SIS
  //    attendance — it over-counts when kiosks aren't run every period.
  let hpLostCount = 0;
  let hpLostMinutes = 0;
  if (sectionsAvailable.hallPasses) {
    const syPasses = await db
      .select({
        createdAt: hallPassesTable.createdAt,
        endedAt: hallPassesTable.endedAt,
      })
      .from(hallPassesTable)
      .where(
        and(
          eq(hallPassesTable.schoolId, student.schoolId),
          eq(hallPassesTable.studentId, student.studentId),
          gte(hallPassesTable.createdAt, syStartIso),
          lt(hallPassesTable.createdAt, syEndIso),
        ),
      );
    hpLostCount = syPasses.length;
    for (const p of syPasses) {
      const m = hallPassLostMinutes(p.createdAt, p.endedAt);
      if (m != null) hpLostMinutes += m;
    }
  }

  let tardiesYtd = 0;
  let lostInstructionMinutesYtd = 0;
  let absenceCount = 0;
  let absenceMinutes = 0;
  if (sectionsAvailable.attendance) {
    const windows = await loadDefaultPeriodWindows(student.schoolId);

    // Tardies — count works even with no bell schedule; minutes need it.
    const syTardyRows = await db
      .select({
        createdAt: tardiesTable.createdAt,
        period: tardiesTable.period,
      })
      .from(tardiesTable)
      .where(
        and(
          eq(tardiesTable.schoolId, student.schoolId),
          eq(tardiesTable.studentId, student.studentId),
          eq(tardiesTable.entryType, "tardy"),
          gte(tardiesTable.createdAt, syStartIso),
          lt(tardiesTable.createdAt, syEndIso),
        ),
      );
    tardiesYtd = syTardyRows.length;
    if (syTardyRows.length > 0 && windows.size > 0) {
      const tz = await getSchoolTimezone(student.schoolId);
      for (const t of syTardyRows) {
        const lm = tardyLostMinutes(windows, t.period, t.createdAt, tz);
        if (lm != null) lostInstructionMinutesYtd += lm;
      }
    }

    // Absences — only computable once a bell schedule exists (to value the
    // missed minutes) AND the attendance module has actually run this SY.
    if (windows.size > 0) {
      const operatingSlots = await db
        .selectDistinct({
          day: attendanceCheckinsTable.day,
          periodNumber: attendanceCheckinsTable.periodNumber,
        })
        .from(attendanceCheckinsTable)
        .where(
          and(
            eq(attendanceCheckinsTable.schoolId, student.schoolId),
            eq(attendanceCheckinsTable.kind, "checkin"),
            gte(attendanceCheckinsTable.day, syStartIso),
            lt(attendanceCheckinsTable.day, syEndIso),
          ),
        );
      if (operatingSlots.length > 0) {
        const studentSlots = await db
          .selectDistinct({
            day: attendanceCheckinsTable.day,
            periodNumber: attendanceCheckinsTable.periodNumber,
          })
          .from(attendanceCheckinsTable)
          .where(
            and(
              eq(attendanceCheckinsTable.schoolId, student.schoolId),
              eq(attendanceCheckinsTable.studentId, student.studentId),
              eq(attendanceCheckinsTable.kind, "checkin"),
              gte(attendanceCheckinsTable.day, syStartIso),
              lt(attendanceCheckinsTable.day, syEndIso),
            ),
          );
        const present = new Set(
          studentSlots.map((r) => `${r.day}|${r.periodNumber}`),
        );
        for (const slot of operatingSlots) {
          const w = windows.get(slot.periodNumber);
          if (!w) continue; // off-schedule / non-instructional period
          if (present.has(`${slot.day}|${slot.periodNumber}`)) continue;
          absenceCount += 1;
          absenceMinutes += periodLengthMinutes(w);
        }
      }
    }
  }

  const lostInstruction = {
    hallPasses: { count: hpLostCount, minutes: hpLostMinutes },
    tardies: { count: tardiesYtd, minutes: lostInstructionMinutesYtd },
    absences: { count: absenceCount, minutes: absenceMinutes },
    totalMinutes: hpLostMinutes + lostInstructionMinutesYtd + absenceMinutes,
  };

  // ----- Accommodations -----
  let accommodations: Array<{ id: number; name: string; category: string }> = [];
  if (sectionsAvailable.accommodations) {
    const rows = await db
      .select({
        id: studentAccommodationsTable.id,
        name: schoolAccommodationsTable.name,
        category: schoolAccommodationsTable.category,
      })
      .from(studentAccommodationsTable)
      .innerJoin(
        schoolAccommodationsTable,
        eq(
          studentAccommodationsTable.accommodationId,
          schoolAccommodationsTable.id,
        ),
      )
      .where(
        and(
          eq(studentAccommodationsTable.schoolId, student.schoolId),
          eq(studentAccommodationsTable.studentId, student.studentId),
          isNull(studentAccommodationsTable.removedAt),
        ),
      );
    accommodations = rows;
  }

  // ----- Staff notes -----
  const staffNotes = sectionsAvailable.staffNotes
    ? await db
        .select()
        .from(supportNotesTable)
        .where(
          and(
            eq(supportNotesTable.schoolId, student.schoolId),
            eq(supportNotesTable.studentId, student.studentId),
          ),
        )
        .orderBy(desc(supportNotesTable.createdAt))
        .limit(20)
    : [];

  // ----- FAST scores -----
  const fastScoresRows = sectionsAvailable.fastScores
    ? await db
        .select({
          subject: studentFastScoresTable.subject,
          pm1: studentFastScoresTable.pm1,
          pm2: studentFastScoresTable.pm2,
          pm3: studentFastScoresTable.pm3,
          priorYearScore: studentFastScoresTable.priorYearScore,
          priorYearBq: studentFastScoresTable.priorYearBq,
        })
        .from(studentFastScoresTable)
        .where(
          and(
            eq(studentFastScoresTable.schoolId, student.schoolId),
            eq(studentFastScoresTable.studentId, student.studentId),
            // FAST Phase 1: filter to current SY — parent snapshot
            // is intended for current-year data; prior-year backfill
            // rows should not surface in the parent portal.
            eq(
              studentFastScoresTable.schoolYear,
              schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ),
            ),
          ),
        )
    : [];

  // ----- Interventions -----
  const interventions = sectionsAvailable.interventions
    ? await db
        .select({
          interventionType: interventionEntriesTable.interventionType,
          note: interventionEntriesTable.note,
          staffName: interventionEntriesTable.staffName,
          createdAt: interventionEntriesTable.createdAt,
        })
        .from(interventionEntriesTable)
        .where(
          and(
            eq(interventionEntriesTable.schoolId, student.schoolId),
            eq(interventionEntriesTable.studentId, student.studentId),
          ),
        )
        .orderBy(desc(interventionEntriesTable.createdAt))
        .limit(10)
    : [];

  // ----- MTSS plans -----
  const mtssPlans = sectionsAvailable.mtss
    ? await db
        .select({
          id: studentMtssPlansTable.id,
          title: studentMtssPlansTable.title,
          tier: studentMtssPlansTable.tier,
          openedAt: studentMtssPlansTable.openedAt,
          goals: studentMtssPlansTable.goals,
        })
        .from(studentMtssPlansTable)
        .where(
          and(
            eq(studentMtssPlansTable.schoolId, student.schoolId),
            eq(studentMtssPlansTable.studentId, student.studentId),
            isNull(studentMtssPlansTable.closedAt),
          ),
        )
        .orderBy(desc(studentMtssPlansTable.openedAt))
    : [];
  const mtssTier =
    mtssPlans.length === 0
      ? 1
      : mtssPlans.reduce((m, p) => Math.max(m, p.tier), 1);

  // ----- OSS (out-of-school suspension) -----
  // Pulls non-cancelled assigned days for the current school year, joined
  // to the parent log so we can surface the reason text when the school
  // chose to expose it. We only count + return rows where the day-row
  // itself is non-cancelled AND the parent log is non-cancelled, so a
  // mid-suspension cancellation cleanly removes those days from view.
  let ossDaysThisYear = 0;
  let ossRecent: ParentSnapshot["oss"]["recent"] = [];
  if (sectionsAvailable.oss) {
    const { startIso, endExclusiveIso } = schoolYearBounds();
    const showReason = Boolean(settingsRow?.showOssReason);
    // Defense-in-depth: scope BOTH tables in the join by school + student.
    // The day row is already constrained, but explicitly constraining the
    // parent log row too means a corrupted `log_id` cross-link can't leak
    // another tenant's reason/notes text into this snapshot.
    const ossWhere = and(
      eq(ossLogDaysTable.schoolId, student.schoolId),
      eq(ossLogDaysTable.studentId, student.studentId),
      eq(ossLogDaysTable.cancelled, false),
      eq(ossLogsTable.schoolId, student.schoolId),
      eq(ossLogsTable.studentId, student.studentId),
      isNull(ossLogsTable.cancelledAt),
      gte(ossLogDaysTable.day, startIso),
      lt(ossLogDaysTable.day, endExclusiveIso),
    );
    // Two queries: an exact COUNT(*) for the year tile (no LIMIT — a
    // student can easily exceed 10/20 OSS days in a year), and the
    // bounded recent list for the body. Run in parallel.
    const [countRow, dayRows] = await Promise.all([
      db
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(ossLogDaysTable)
        .innerJoin(ossLogsTable, eq(ossLogDaysTable.logId, ossLogsTable.id))
        .where(ossWhere)
        .then((rows) => rows[0]),
      db
        .select({
          day: ossLogDaysTable.day,
          reasonText: ossLogsTable.reasonText,
          notes: ossLogsTable.notes,
        })
        .from(ossLogDaysTable)
        .innerJoin(ossLogsTable, eq(ossLogDaysTable.logId, ossLogsTable.id))
        .where(ossWhere)
        .orderBy(desc(ossLogDaysTable.day))
        .limit(10),
    ]);
    ossDaysThisYear = countRow?.n ?? 0;
    ossRecent = dayRows.map((r) => ({
      day: r.day,
      reason: showReason ? (r.reasonText ?? null) : null,
      notes: showReason ? (r.notes ?? null) : null,
    }));
  }

  // ----- Reteach activity (parent-safe rollup) -----
  // Strict whitelist of fields. Strategy / note / teacher_staff_id are
  // intentionally EXCLUDED from the SELECT so they can never leak into
  // the parent payload even on a refactor mistake. Soft-deleted rows
  // are excluded. Scoped to current school year by created_at.
  let reteachItems: ParentSnapshot["reteach"]["items"] = [];
  if (sectionsAvailable.reteach) {
    const { startIso, endExclusiveIso } = schoolYearBounds();
    const rows = await db
      .select({
        benchmarkCode: benchmarkReteachLogTable.benchmarkCode,
        format: benchmarkReteachLogTable.format,
        createdAt: benchmarkReteachLogTable.createdAt,
      })
      .from(benchmarkReteachLogTable)
      .where(
        and(
          eq(benchmarkReteachLogTable.schoolId, student.schoolId),
          eq(benchmarkReteachLogTable.studentId, student.studentId),
          isNull(benchmarkReteachLogTable.deletedAt),
          sql`${benchmarkReteachLogTable.createdAt} >= ${startIso}`,
          sql`${benchmarkReteachLogTable.createdAt} < ${endExclusiveIso}`,
        ),
      );
    const byCode = new Map<
      string,
      { oneOnOne: number; smallGroup: number; lastAt: string }
    >();
    for (const r of rows) {
      const code = r.benchmarkCode;
      const at =
        r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt);
      const cur = byCode.get(code) ?? {
        oneOnOne: 0,
        smallGroup: 0,
        lastAt: at,
      };
      if (r.format === "one_on_one") cur.oneOnOne += 1;
      else if (r.format === "small_group") cur.smallGroup += 1;
      if (at > cur.lastAt) cur.lastAt = at;
      byCode.set(code, cur);
    }
    reteachItems = [...byCode.entries()]
      .map(([benchmarkCode, v]) => ({
        benchmarkCode,
        oneOnOne: v.oneOnOne,
        smallGroup: v.smallGroup,
        total: v.oneOnOne + v.smallGroup,
        lastAt: v.lastAt,
      }))
      .sort((a, b) => b.total - a.total || (a.benchmarkCode < b.benchmarkCode ? -1 : 1));
  }

  // ----- House affiliation (PBIS) -----
  // Gated under `recognition` because house standings are the school-
  // wide PBIS rollup; if a parent has hidden recognition (or the
  // school disabled it) we suppress house too rather than leaking the
  // PBIS competition through a side door. Two cheap queries when the
  // student actually has a houseId: one to fetch the house row, one to
  // sum the house's all-time active points (same calc as the staff
  // Houses panel — sum across every PBIS entry whose student belongs
  // to the same house in this school, excluding voided rows).
  let housePayload: ParentSnapshot["house"] = null;
  if (sectionsAvailable.recognition && student.houseId !== null) {
    const [houseRow] = await db
      .select()
      .from(housesTable)
      .where(
        and(
          eq(housesTable.id, student.houseId),
          eq(housesTable.schoolId, student.schoolId),
        ),
      );
    if (houseRow) {
      // Sum points across all students in this house. We join through
      // students so we can scope by (school_id, house_id) without
      // trusting pbis_entries to carry a house_id of its own.
      const [{ points } = { points: 0 }] = await db
        .select({
          points: sql<number>`COALESCE(SUM(${pbisEntriesTable.points}), 0)::int`,
        })
        .from(pbisEntriesTable)
        .innerJoin(
          studentsTable,
          eq(pbisEntriesTable.studentId, studentsTable.studentId),
        )
        .where(
          and(
            eq(pbisEntriesTable.schoolId, student.schoolId),
            eq(studentsTable.schoolId, student.schoolId),
            eq(studentsTable.houseId, houseRow.id),
            isNull(pbisEntriesTable.voidedAt),
          ),
        );
      housePayload = {
        id: houseRow.id,
        name: houseRow.name,
        color: houseRow.color,
        motto: houseRow.motto,
        iconKey: houseRow.iconKey,
        iconObjectKey: houseRow.iconObjectKey,
        totalPoints: points ?? 0,
      };
    }
  }

  return {
    ok: true,
    data: {
      parent: {
        displayName: parent?.displayName ?? "",
        email: parent?.email ?? "",
      },
      student: {
        id: student.id,
        studentId: student.studentId,
        localSisId: student.localSisId ?? null,
        firstName: student.firstName,
        lastName: student.lastName,
        grade: student.grade,
        retainedGrades: retainedGradesForStudent,
        heartbeatNote: student.heartbeatNote ?? null,
      },
      sectionsAvailable,
      pbis: {
        total: pbisTotal,
        thisWeek: pbisThisWeek,
        weeklyCounts: weeklyPbisCounts,
        sparkline: pbisDailyBuckets,
        recent: pbisActive.slice(0, 10).map((r) => ({
          id: r.id,
          reason: r.reason,
          points: r.points,
          polarity: r.polarity,
          staffName: r.staffName,
          createdAt: r.createdAt,
          note: r.note,
        })),
      },
      hallPasses: {
        thisWeekCount: hpThisWeekCount,
        recent: hpRows.slice(0, 10).map((r) => ({
          id: r.id,
          destination: r.destination,
          originRoom: r.originRoom,
          teacherName: r.teacherName,
          status: r.status,
          createdAt: r.createdAt,
          endedAt: r.endedAt,
          arrivedAt: r.arrivedAt,
          endedBy: r.endedBy,
          oneWay: !restroomNames.has(r.destination),
        })),
      },
      lostInstruction,
      attendance: {
        tardiesThisWeek: tardyThisWeek,
        checkInsThisWeek: checkInThisWeek,
        pct: attendancePct,
        onTimeStreak,
        onTimeArrivals,
        recent: tardyRows.slice(0, 10).map((r) => ({
          id: r.id,
          entryType: r.entryType,
          period: r.period,
          teacherName: r.teacherName,
          reason: r.reason,
          createdAt: r.createdAt,
        })),
      },
      accommodations,
      staffNotes: staffNotes.map((n) => ({
        id: n.id,
        noteType: n.noteType,
        noteText: n.noteText,
        staffName: n.staffName,
        createdAt: n.createdAt,
      })),
      fastScores: fastScoresRows,
      interventions,
      mtss: {
        tier: mtssTier,
        plans: mtssPlans.map((p) => ({
          id: p.id,
          title: p.title,
          tier: p.tier,
          openedAt:
            p.openedAt instanceof Date
              ? p.openedAt.toISOString()
              : String(p.openedAt),
          goals: p.goals ?? null,
        })),
      },
      oss: { daysThisYear: ossDaysThisYear, recent: ossRecent },
      reteach: { items: reteachItems },
      house: housePayload,
    },
  };
}
