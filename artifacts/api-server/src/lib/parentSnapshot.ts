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
} from "@workspace/db";
import { and, eq, desc, isNull, sql } from "drizzle-orm";

export interface ParentSnapshot {
  parent: { displayName: string; email: string };
  student: {
    id: number;
    studentId: string;
    firstName: string;
    lastName: string;
    grade: number;
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
      mtss: { tier: mtssTier, plans: mtssPlans },
    },
  };
}
