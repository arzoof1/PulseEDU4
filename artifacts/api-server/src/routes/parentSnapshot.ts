import { Router, type IRouter } from "express";
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
import { verifyParentAuthToken } from "../lib/authToken.js";

const router: IRouter = Router();

router.use(async (req, _res, next) => {
  let pid: number | null = req.session.parentId ?? null;
  if (!pid) {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      pid = verifyParentAuthToken(auth.slice(7).trim());
    }
  }
  req.parentId = pid;
  next();
});

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

router.get("/parent/snapshot", async (req, res) => {
  const pid = req.parentId;
  if (!pid) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }

  const requestedStudentId = Number(req.query.studentId);
  if (!Number.isFinite(requestedStudentId)) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }

  // Confirm the parent owns this student. This is the ONLY tenant check;
  // every downstream query is scoped by the resulting student row.
  const [link] = await db
    .select({ id: parentStudentsTable.id })
    .from(parentStudentsTable)
    .where(
      and(
        eq(parentStudentsTable.parentId, pid),
        eq(parentStudentsTable.studentId, requestedStudentId),
      ),
    );
  if (!link) {
    res.status(403).json({ error: "Not your student" });
    return;
  }

  const [student] = await db
    .select()
    .from(studentsTable)
    .where(eq(studentsTable.id, requestedStudentId));
  if (!student) {
    res.status(404).json({ error: "Student not found" });
    return;
  }

  const [parent] = await db
    .select({ displayName: parentsTable.displayName, email: parentsTable.email })
    .from(parentsTable)
    .where(eq(parentsTable.id, pid));

  // Pull school heartbeat settings (or sane defaults if no row exists yet)
  // and the parent's per-student override prefs in parallel. Effective
  // visibility is `schoolEnabled AND parentPref !== false`. The school
  // OFF flag always wins; a parent can only HIDE a section the school
  // has shown, never reveal one the school has hidden.
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
          eq(parentHeartbeatPrefsTable.parentId, pid),
          eq(parentHeartbeatPrefsTable.studentId, requestedStudentId),
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
  const sectionsAvailable = {
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

  // Dedicated SQL aggregate for the full-week positive/negative counts so
  // parent mood meter math doesn't depend on the 50-row sample above.
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
  // 7-day buckets, oldest → newest, for the sparkline.
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
  let accommodations: Array<{ id: number; name: string; category: string }> =
    [];
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

  // ----- Staff notes (only if school enabled) -----
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

  // ----- FAST scores (academics) — only if school enabled -----
  // Surfaces PM1/2/3 plus prior-year scale score and the BQ flag. The
  // parent UI uses BQ to render the "needs support" banner.
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

  // ----- Recent interventions — only if school enabled -----
  // Redacted shape: type / note / staffName / createdAt only. We never
  // expose staffId or internal voiding flags on the parent surface.
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

  // ----- Active MTSS plans — only if school enabled -----
  // Plans with closedAt IS NULL. We send the parent the plan title,
  // tier, and openedAt so they understand the level of support, plus
  // the goals text (parent-facing by design — schools that don't want
  // goals shared can keep showMtss=false at the school level).
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
  // Highest active tier — drives a header chip on the parent page. Tier
  // 1 means "no active plan" and is the default. Mirrors the convention
  // used by the staff-side Insights profile endpoint.
  const mtssTier =
    mtssPlans.length === 0
      ? 1
      : mtssPlans.reduce((m, p) => Math.max(m, p.tier), 1);

  res.json({
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
      // Full-week counts so the parent mood meter can render an accurate
      // positive/negative ratio. We use a dedicated SQL aggregate (rather
      // than filtering `pbisActive`) because the row sample above is
      // capped at 50 — high-PBIS students would otherwise have truncated
      // counts. Voided entries are excluded.
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
    // Insights v2 — gated parent-facing pillars. Each section is empty
    // (not omitted) when the school has it disabled, so the parent
    // client can render a single shape without optional-chaining every
    // sub-field.
    fastScores: fastScoresRows,
    interventions,
    mtss: { tier: mtssTier, plans: mtssPlans },
  });
});

// quiet the unused-import lint for sql (kept for future range filters)
void sql;

export default router;
