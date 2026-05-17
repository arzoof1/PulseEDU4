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
  parentHeartbeatPrefsTable,
  studentFastScoresTable,
  interventionEntriesTable,
  studentMtssPlansTable,
  ossLogsTable,
  ossLogDaysTable,
  studentRetentionsTable,
  studentAttendanceDayTable,
} from "@workspace/db";
import { and, eq, desc, isNull, sql, gte, lt } from "drizzle-orm";

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
    firstName: string;
    lastName: string;
    grade: number;
    // Grades the student was retained in, ascending. Empty when none.
    // Drives the "R" indicator on the parent portal student card.
    retainedGrades: number[];
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
    }>;
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
    // Consecutive on-time days. "On-time" = status='present' (a tardy
    // breaks the streak). `current` walks back from the most recent
    // logged day; `longestYtd` is the longest run inside this school
    // year. Both are zero (not null) when the student has no logged
    // attendance days at all.
    onTimeStreak: { current: number; longestYtd: number };
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
  const [settingsRow, prefsRow] = await Promise.all([
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

  // On-time streak: walk attendance_day rows in date order. "On-time"
  // is status==='present' (a tardy breaks the streak; absent days do
  // too). `current` is the run that ends on the most recent row.
  let currentStreak = 0;
  let longestStreak = 0;
  let run = 0;
  for (const r of attendanceDayRows) {
    if (r.status === "present") {
      run += 1;
      if (run > longestStreak) longestStreak = run;
    } else {
      run = 0;
    }
  }
  // `run` after the loop is the trailing run = current streak (rows
  // are ASC by day, so the loop ends on the latest day).
  currentStreak = run;
  const onTimeStreak = { current: currentStreak, longestYtd: longestStreak };

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
        firstName: student.firstName,
        lastName: student.lastName,
        grade: student.grade,
        retainedGrades: retainedGradesForStudent,
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
        })),
      },
      attendance: {
        tardiesThisWeek: tardyThisWeek,
        checkInsThisWeek: checkInThisWeek,
        pct: attendancePct,
        onTimeStreak,
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
    },
  };
}
