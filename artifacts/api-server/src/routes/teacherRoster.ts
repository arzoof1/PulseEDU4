// Teacher Roster — per-teacher student list with FAST PM scores, level
// placement, BQ flag, and bucket-icon target gap.
//
// Routes:
//   GET /api/teacher-roster?teacherId=&period=
//
// Auth model:
//   - A signed-in teacher with no teacherId param sees ONLY their own
//     roster (their staffId is implied).
//   - A signed-in teacher who passes ?teacherId= must be on the "core
//     team" (admin / superuser / ESE / behavior specialist / MTSS
//     coordinator). Plain teachers cannot view another teacher's roster.
//   - period is optional. When provided, only sections with that period
//     are returned (matches the existing Class View picker).
//
// Response is enriched server-side: cut-score placement (PM3 uses the
// PRIOR-grade chart, PM1/PM2 use the CURRENT-grade chart) and the
// bucket gap (next-level min on current-grade chart minus PM3 score).
// Bucket is intentionally suppressed for grade 3 and for any subject
// without a chart (Algebra 1 / Geometry — not in this v1).
import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  classSectionsTable,
  sectionRosterTable,
  staffTable,
  studentsTable,
  studentFastScoresTable,
  pbisEntriesTable,
  studentMtssPlansTable,
  schoolSettingsTable,
  studentAccommodationsTable,
  schoolAccommodationsTable,
  safetyPlansTable,
  studentRetentionsTable,
  issAttendanceDayTable,
  ossLogDaysTable,
  issAcknowledgementsTable,
} from "@workspace/db";
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { schoolYearLabelFor, DEFAULT_SCHOOL_TZ } from "../lib/schoolYear.js";
import {
  loadFastHistory,
  pickHistory,
  type FastHistoryEntry,
  type FastHistoryMap,
} from "../lib/fastHistory.js";
import {
  bucketFor,
  hasChart,
  placeOnChart,
  placePm3,
  withGap,
  type Subject,
  type PlacementWithGap,
  type BucketInfo,
} from "../lib/fastCutScores.js";
import { decideLearningGain } from "../lib/learningGains.js";
import { inferDepartment } from "../lib/teacherDepartments.js";
import { loadAttendanceMetrics } from "../lib/attendanceMetrics.js";

// Per-PM placement enriched with the gap-to-next-sublevel caption is now
// single-sourced in fastCutScores.ts (`withGap` / `PlacementWithGap`) so the
// Roster, Student Snapshot, and Insights band drawer captions can never
// silently diverge.

const router: IRouter = Router();

async function resolveStaff(
  req: Request,
): Promise<typeof staffTable.$inferSelect | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

// Same gate as schedule.ts ?all=1 plus superuser. Keep in sync with the
// client-side `canViewAnyRoster` check in App.tsx.
function isCoreTeam(s: typeof staffTable.$inferSelect): boolean {
  return Boolean(
    s.isSuperUser ||
      s.isAdmin ||
      s.isEseCoordinator ||
      s.isMtssCoordinator ||
      s.isBehaviorSpecialist,
  );
}

// Mirror of the Mon–Fri "school day" subtraction used in pbis.ts so the
// roster view stays consistent with PBIS Needs Attention.
function subtractSchoolDays(n: number): Date {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(today);
  let remaining = n;
  while (remaining > 0) {
    d.setDate(d.getDate() - 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) remaining -= 1;
  }
  return d;
}

interface PriorPm3 {
  // School-year label (e.g. "24-25") from the FL historical importer.
  schoolYear: string;
  pm3: number;
  // Placement is computed against the PRIOR grade's chart (the year
  // this PM3 was actually administered), so the color-banded pill
  // reads as "end of last year's grade" not "end of this year's."
  placement: PlacementWithGap | null;
}

interface SubjectBlock {
  pm1: number | null;
  pm2: number | null;
  pm3: number | null;
  // Placement of EACH PM score on its own chart. PM1/PM2 use current
  // grade; PM3 uses prior grade (so it represents end-of-prior-year
  // mastery before fall regression).
  pm1Placement: PlacementWithGap | null;
  pm2Placement: PlacementWithGap | null;
  pm3Placement: PlacementWithGap | null;
  bucket: BucketInfo;
  priorYearScore: number | null;
  priorYearBq: boolean;
  // Most-recent prior-year PM3 from the FL Florida importer's
  // historical mode (the row tagged is_historical=true). Rendered as
  // a real pill in its own column on the roster — the leftmost cell
  // in the chronological story Prior → PM1 → PM2 → PM3 → LG. Null
  // when no historical row has been uploaded for this (student,
  // subject) yet. Only one prior year is surfaced on the roster;
  // multi-year history still lives on the student profile FAST card.
  priorPm3: PriorPm3 | null;
  // Multi-year PM3 growth series (PM3-only) for the roster growth chip.
  // Prior-year historical PM3 rows within the school's visible window,
  // ordered NEWEST-FIRST. `delta` is the year-over-year change vs. the
  // immediately-older year (this entry's pm3 − next-older entry's pm3);
  // null on the oldest entry (nothing older to compare against). NOTE:
  // FAST scale scores are per-grade re-referenced, so year-over-year
  // deltas are directional signal only — never sum them into a total.
  // Empty when no historical rows exist for this (student, subject).
  pm3History: Array<{ schoolYear: string; pm3: number; delta: number | null }>;
  // FAST Learning Gain (FLDOE rule, Phase 1 subset).
  //   true  — student demonstrated a learning gain this year. Either
  //           moved up a performance level vs. prior-year PM3, or
  //           maintained L3 / L4 / L5. The roster swaps the LG-column
  //           bucket icon for a green check when this is true.
  //   false — prior + current PM3 are both known but the student did
  //           NOT meet the move-up / maintain-L3+ test. Bucket icon
  //           still renders, unchanged.
  //   null  — not enough data to decide (missing prior-year PM3,
  //           missing current-year PM3, no chart, or grade band has
  //           no placement). Bucket icon renders, unchanged.
  // Phase 1 caveats (documented in replit.md "Open work"):
  //   * Within-level point growth for students stuck at L1/L2 is NOT
  //     credited yet — that rule needs per-grade thresholds the
  //     district has not confirmed. Those students will read `false`
  //     (no check) even when FLDOE would credit them. Conservative
  //     default; never falsely awards a check.
  //   * Subject-band promotions (e.g. 7th grader on Algebra I) are
  //     not credited — we compare against prior-year MATH PM3 by
  //     default. Out-of-scope for Phase 1; the FL importer would
  //     need to capture the prior course code.
  //   * Retention/skip uses (currentGrade − 1) for the prior chart;
  //     same caveat already documented on `priorPm3.placement`.
  learningGain: boolean | null;
  // True when no chart exists for this subject/grade combo (e.g. Algebra
  // 1 / Geometry / Math past G8). Client uses this to render only a
  // "—" instead of empty pills.
  noChart: boolean;
}

function buildSubjectBlock(
  row: typeof studentFastScoresTable.$inferSelect | undefined,
  subject: Subject,
  grade: number,
  history: FastHistoryEntry[],
): SubjectBlock {
  const noChart = !hasChart(subject, grade);
  // Most-recent prior-year PM3, with placement computed against the
  // chart for the grade the student was IN when they took the test
  // (i.e. current grade − 1). We deliberately use `placeOnChart` here
  // rather than `placePm3`: `placePm3` is a current-PM3 convenience
  // that internally subtracts a grade (it interprets its arg as the
  // student's *current* grade and looks up the prior-grade chart).
  // For a historical row we already know the test-administration grade
  // directly, so `placeOnChart(score, subject, priorGrade)` produces
  // the correct band — no double subtraction.
  //
  // Caveats this implementation accepts (logged for follow-up):
  //   * Retention/skip: we assume prior test grade = current − 1.
  //     For a retained student that's wrong (last-year PM3 was the
  //     same grade); for a skip it's wrong in the other direction.
  //     The FL historical importer doesn't currently capture grade-
  //     at-test, so there's no reliable signal to disambiguate. The
  //     score number on the pill stays correct in all cases — only
  //     the color band could mis-label for these edge cases.
  //   * Grade < 1 / no chart / EOC subjects → placement: null
  //     (pill renders score only, no color band). Safer than a
  //     misleading band.
  const priorPm3: PriorPm3 | null = (() => {
    const top = history[0];
    if (!top) return null;
    const priorGrade = grade - 1;
    const canPlace =
      priorGrade >= 1 &&
      (subject === "ela" || subject === "math") &&
      hasChart(subject, priorGrade);
    return {
      schoolYear: top.schoolYear,
      pm3: top.pm3,
      placement: canPlace
        ? withGap(
            placeOnChart(top.pm3, subject, priorGrade),
            top.pm3,
            subject,
            priorGrade,
          )
        : null,
    };
  })();
  // Multi-year PM3 growth series (newest-first, PM3-only). `delta` for
  // each entry compares against the immediately-older year; the oldest
  // year has no comparison so its delta is null. Do NOT sum these —
  // FAST scale scores are re-referenced per grade year to year.
  const pm3History = history.map((h, i) => {
    const older = history[i + 1];
    return {
      schoolYear: h.schoolYear,
      pm3: h.pm3,
      delta: older ? h.pm3 - older.pm3 : null,
    };
  });
  if (!row) {
    return {
      pm1: null,
      pm2: null,
      pm3: null,
      pm1Placement: null,
      pm2Placement: null,
      pm3Placement: null,
      bucket: {
        targetScore: null,
        gap: null,
        color: null,
        currentSubLevel: null,
        nextStopLabel: null,
      },
      priorYearScore: null,
      priorYearBq: false,
      priorPm3,
      pm3History,
      learningGain: null,
      noChart,
    };
  }
  const pm1Placement = withGap(
    row.pm1 != null ? placeOnChart(row.pm1, subject, grade) : null,
    row.pm1,
    subject,
    grade,
  );
  const pm2Placement = withGap(
    row.pm2 != null ? placeOnChart(row.pm2, subject, grade) : null,
    row.pm2,
    subject,
    grade,
  );
  const pm3Placement = withGap(
    row.pm3 != null ? placePm3(row.pm3, subject, grade) : null,
    row.pm3,
    subject,
    grade,
  );
  const bucket =
    row.pm3 != null
      ? bucketFor(row.pm3, subject, grade)
      : {
          targetScore: null,
          gap: null,
          color: null,
          currentSubLevel: null,
          nextStopLabel: null,
        };
  // Learning Gain decision. We need BOTH a prior-year PM3 level and a
  // current-year PM3 level on charts. PM3 placement uses the prior-grade
  // chart by FAST convention (placePm3 internally subtracts a grade), so
  // pm3Placement.level reads as "what level did they hit at end of last
  // year's grade band" — exactly what FLDOE compares to.
  // Note: priorPm3.placement uses the *test administration* grade chart
  // (computed above with `placeOnChart(..., grade-1)`); that's the same
  // chart pm3Placement uses, so the two levels are directly comparable.
  //
  // Rule (per district guidance, confirmed May 2026):
  //   - Moved up a performance level → MET
  //   - Stayed at L5 → MET (top of scale; growth not measurable)
  //   - Stayed at L3 or L4 → MET only when this year's PM3 is at least
  //     last year's PM3 + 1 (i.e. some scale-score growth, not flat).
  //     "Maintaining proficiency" requires evidence of forward motion;
  //     a flat or declining score within the same band does not count.
  //   - Stayed at L1 or L2 → MET only when this year's PM3 sub-tier is
  //     HIGHER than last year's sub-tier. Same or lower sub-tier within
  //     the band does not count. Sub-tiers come from `placeOnChart`:
  //       L1 splits into thirds → "1.1" / "1.2" / "1.3"
  //       L2 splits into halves → "2.1" / "2.2"  (no "2.3" today; if the
  //         FLDOE chart adds a Level-2 Upper third, extend the L2 ranges
  //         in `fastCutScores.ts` and this branch picks it up for free).
  //   - Dropped a level → NOT MET.
  const learningGain: boolean | null = decideLearningGain({
    priorLevel: priorPm3?.placement?.level ?? null,
    currentLevel: pm3Placement?.level ?? null,
    priorScore: priorPm3?.pm3 ?? null,
    currentScore: row.pm3 ?? null,
    priorSubLevel: priorPm3?.placement?.subLevel ?? null,
    currentSubLevel: pm3Placement?.subLevel ?? null,
  });
  return {
    pm1: row.pm1,
    pm2: row.pm2,
    pm3: row.pm3,
    pm1Placement,
    pm2Placement,
    pm3Placement,
    bucket,
    priorYearScore: row.priorYearScore,
    priorYearBq: row.priorYearBq,
    priorPm3,
    pm3History,
    learningGain,
    noChart,
  };
}

router.get("/teacher-roster", async (req: Request, res: Response) => {
  const staff = await resolveStaff(req);
  if (!staff) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  // Resolve target teacher: explicit ?teacherId= (core-team only) or
  // implied self.
  const rawTeacherId = req.query.teacherId;
  let targetTeacherId = staff.id;
  if (typeof rawTeacherId === "string" && rawTeacherId.length > 0) {
    const parsed = Number(rawTeacherId);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      res.status(400).json({ error: "Invalid teacherId" });
      return;
    }
    if (parsed !== staff.id && !isCoreTeam(staff)) {
      res.status(403).json({
        error: "Only core team can view another teacher's roster",
      });
      return;
    }
    targetTeacherId = parsed;
  }

  // Optional period filter (1..7+ in the existing seed).
  const rawPeriod = req.query.period;
  let periodFilter: number | null = null;
  if (typeof rawPeriod === "string" && rawPeriod.length > 0) {
    const p = Number(rawPeriod);
    if (!Number.isInteger(p) || p <= 0) {
      res.status(400).json({ error: "Invalid period" });
      return;
    }
    periodFilter = p;
  }

  // Verify target teacher exists in this school (defense-in-depth).
  const [targetTeacher] = await db
    .select()
    .from(staffTable)
    .where(
      and(
        eq(staffTable.id, targetTeacherId),
        eq(staffTable.schoolId, schoolId),
      ),
    );
  if (!targetTeacher) {
    res.status(404).json({ error: "Teacher not found" });
    return;
  }

  // Find sections for the target teacher.
  const sectionWhere = periodFilter
    ? and(
        eq(classSectionsTable.schoolId, schoolId),
        eq(classSectionsTable.teacherStaffId, targetTeacherId),
        eq(classSectionsTable.period, periodFilter),
      )
    : and(
        eq(classSectionsTable.schoolId, schoolId),
        eq(classSectionsTable.teacherStaffId, targetTeacherId),
      );
  const sections = await db
    .select()
    .from(classSectionsTable)
    .where(sectionWhere);

  // Available periods (always returned so the client can render the
  // period selector even when the current filter is empty).
  const allSections = periodFilter
    ? await db
        .select()
        .from(classSectionsTable)
        .where(
          and(
            eq(classSectionsTable.schoolId, schoolId),
            eq(classSectionsTable.teacherStaffId, targetTeacherId),
          ),
        )
    : sections;
  const availablePeriods = Array.from(
    new Set(
      allSections
        .filter((s) => !s.isPlanning)
        .map((s) => s.period),
    ),
  ).sort((a, b) => a - b);

  if (sections.length === 0) {
    res.json({
      teacher: {
        id: targetTeacher.id,
        displayName: targetTeacher.displayName,
      },
      availablePeriods,
      students: [],
    });
    return;
  }

  // Roster: dedupe across periods.
  const sectionIds = sections.map((s) => s.id);
  const rosterRows = await db
    .select()
    .from(sectionRosterTable)
    .where(
      and(
        eq(sectionRosterTable.schoolId, schoolId),
        inArray(sectionRosterTable.sectionId, sectionIds),
      ),
    );
  const studentIds = Array.from(new Set(rosterRows.map((r) => r.studentId)));

  if (studentIds.length === 0) {
    res.json({
      teacher: {
        id: targetTeacher.id,
        displayName: targetTeacher.displayName,
      },
      availablePeriods,
      students: [],
    });
    return;
  }

  // Resolve the school's invisible-student window (mirrors PBIS Needs
  // Attention). Default 10 school days when no row exists.
  const [settingsRow] = await db
    .select()
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  // Tier-aware "Invisible Student" windows (school days). Tier 1 = no
  // active MTSS plan (general population); Tier 2 / Tier 3 = most intensive
  // open plan. A student is invisible when they have 0 non-voided PBIS
  // recognitions within their tier's window. Pull entries since the WIDEST
  // window, then compare each student's latest recognition to their own
  // tier cutoff below.
  const invisibleDaysTier1 = settingsRow?.pbisInvisibleDaysTier1 ?? 8;
  const invisibleDaysTier2 = settingsRow?.pbisInvisibleDaysTier2 ?? 5;
  const invisibleDaysTier3 = settingsRow?.pbisInvisibleDaysTier3 ?? 3;
  const widestInvisibleDays = Math.max(
    invisibleDaysTier1,
    invisibleDaysTier2,
    invisibleDaysTier3,
  );
  const invisibleWindowIso = subtractSchoolDays(
    widestInvisibleDays,
  ).toISOString();

  // Pull demographics + FAST scores + recent PBIS entries + active MTSS
  // plans in parallel. The PBIS query only returns studentId since
  // that's all we need to mark "has been recognized recently".
  // "Today" in YYYY-MM-DD for the ISS / OSS pill lookups below.
  const today = new Date().toISOString().slice(0, 10);

  const [
    students,
    scores,
    recentPbis,
    activeMtss,
    accommodations,
    safetyPlans,
    issToday,
    ossToday,
    issAcksToday,
    retentions,
  ] = await Promise.all([
    db
      .select()
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          inArray(studentsTable.studentId, studentIds),
        ),
      ),
    db
      .select()
      .from(studentFastScoresTable)
      .where(
        and(
          eq(studentFastScoresTable.schoolId, schoolId),
          inArray(studentFastScoresTable.studentId, studentIds),
          // FAST Phase 1: scores are now keyed by school_year. Filter
          // to current SY so prior-year backfill rows don't shadow
          // current-year rows in the per-(student, subject) map below.
          // Legacy rows were backfilled to the current SY by the
          // ensureFastScoresSchema migration, so this is safe.
          eq(
            studentFastScoresTable.schoolYear,
            schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ),
          ),
        ),
      ),
    db
      .select({
        studentId: pbisEntriesTable.studentId,
        createdAt: pbisEntriesTable.createdAt,
      })
      .from(pbisEntriesTable)
      .where(
        and(
          eq(pbisEntriesTable.schoolId, schoolId),
          isNull(pbisEntriesTable.voidedAt),
          gte(pbisEntriesTable.createdAt, invisibleWindowIso),
          inArray(pbisEntriesTable.studentId, studentIds),
        ),
      ),
    db
      .select({
        studentId: studentMtssPlansTable.studentId,
        tier: studentMtssPlansTable.tier,
      })
      .from(studentMtssPlansTable)
      .where(
        and(
          eq(studentMtssPlansTable.schoolId, schoolId),
          isNull(studentMtssPlansTable.closedAt),
          inArray(studentMtssPlansTable.studentId, studentIds),
        ),
      ),
    // Active accommodations (those with no removedAt). Joined to the
    // school catalog so we can return both the human name and the
    // category, which the client uses to group + color the popover
    // shown when the teacher hovers a student's Programs cell.
    // Same school-AND-filter pattern as routes/students.ts to defend
    // against student_id collisions across schools.
    db
      .select({
        studentId: studentAccommodationsTable.studentId,
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
          eq(studentAccommodationsTable.schoolId, schoolId),
          isNull(studentAccommodationsTable.removedAt),
          inArray(studentAccommodationsTable.studentId, studentIds),
        ),
      ),
    // Active safety plans for these students (status='active'). Used to
    // render the red SP pill on each row + the hover popover with the
    // checklist items.
    db
      .select({
        studentId: safetyPlansTable.studentId,
        items: safetyPlansTable.items,
        notes: safetyPlansTable.notes,
        updatedAt: safetyPlansTable.updatedAt,
        updatedByName: safetyPlansTable.updatedByName,
      })
      .from(safetyPlansTable)
      .where(
        and(
          eq(safetyPlansTable.schoolId, schoolId),
          eq(safetyPlansTable.status, "active"),
          inArray(safetyPlansTable.studentId, studentIds),
        ),
      ),
    // ISS roster today — orange pill on the teacher roster row. Includes
    // any source (manual/pullout/admin) so the pill is honest about the
    // student being out of class.
    db
      .select({
        studentId: issAttendanceDayTable.studentId,
        source: issAttendanceDayTable.source,
        adminLogId: issAttendanceDayTable.adminLogId,
      })
      .from(issAttendanceDayTable)
      .where(
        and(
          eq(issAttendanceDayTable.schoolId, schoolId),
          eq(issAttendanceDayTable.day, today),
          inArray(issAttendanceDayTable.studentId, studentIds),
        ),
      ),
    // OSS today — red pill. Cancelled rows don't count.
    db
      .select({ studentId: ossLogDaysTable.studentId })
      .from(ossLogDaysTable)
      .where(
        and(
          eq(ossLogDaysTable.schoolId, schoolId),
          eq(ossLogDaysTable.day, today),
          eq(ossLogDaysTable.cancelled, false),
          inArray(ossLogDaysTable.studentId, studentIds),
        ),
      ),
    // Acknowledgements this teacher has already filed today (so we can
    // dim the "Posted in Canvas" / "Sent hard copy" buttons that are
    // already done).
    db
      .select({
        studentId: issAcknowledgementsTable.studentId,
        period: issAcknowledgementsTable.period,
        method: issAcknowledgementsTable.method,
      })
      .from(issAcknowledgementsTable)
      .where(
        and(
          eq(issAcknowledgementsTable.schoolId, schoolId),
          eq(issAcknowledgementsTable.day, today),
          eq(issAcknowledgementsTable.teacherStaffId, targetTeacherId),
          inArray(issAcknowledgementsTable.studentId, studentIds),
        ),
      ),
    // Retention indicator (R-in-circle on the roster). One row per
    // (student, repeated grade); a kid retained twice has two rows.
    db
      .select({
        studentId: studentRetentionsTable.studentId,
        gradeLevel: studentRetentionsTable.gradeLevel,
      })
      .from(studentRetentionsTable)
      .where(
        and(
          eq(studentRetentionsTable.schoolId, schoolId),
          inArray(studentRetentionsTable.studentId, studentIds),
        ),
      ),
  ]);

  // Multi-year FAST history (PM3-only, prior years within the school's
  // configured visible window). Loaded outside the parent Promise.all
  // because it needs a second round-trip for the
  // fast_history_years_visible setting; keeping it here avoids
  // serializing the much heavier roster joins above. ELA + Math only —
  // EOC subjects render no history chip on the roster.
  const historyMap: FastHistoryMap = await loadFastHistory({
    schoolId,
    studentIds,
    subjects: ["ela", "math"],
  });

  const retentionsByStudent = new Map<string, number[]>();
  for (const r of retentions) {
    const list = retentionsByStudent.get(r.studentId) ?? [];
    list.push(r.gradeLevel);
    retentionsByStudent.set(r.studentId, list);
  }
  for (const [, list] of retentionsByStudent) list.sort((a, b) => a - b);

  const issByStudent = new Map<string, { source: string; adminLogId: number | null }>();
  for (const r of issToday) {
    issByStudent.set(r.studentId, {
      source: r.source,
      adminLogId: r.adminLogId,
    });
  }
  const ossSet = new Set(ossToday.map((r) => r.studentId));
  const ackByStudent = new Map<
    string,
    Array<{ period: number; method: string }>
  >();
  for (const a of issAcksToday) {
    const list = ackByStudent.get(a.studentId) ?? [];
    list.push({ period: a.period, method: a.method });
    ackByStudent.set(a.studentId, list);
  }

  const safetyPlanByStudent = new Map<string, (typeof safetyPlans)[number]>();
  for (const p of safetyPlans) safetyPlanByStudent.set(p.studentId, p);

  // Group accommodations by studentId so the row builder can attach
  // them in O(1).
  const accommodationsByStudent = new Map<
    string,
    Array<{ name: string; category: string }>
  >();
  for (const a of accommodations) {
    const list = accommodationsByStudent.get(a.studentId) ?? [];
    list.push({ name: a.name, category: a.category });
    accommodationsByStudent.set(a.studentId, list);
  }

  // Most-recent non-voided PBIS recognition per student (ms since epoch),
  // within the widest tier window. Combined with the per-tier cutoffs below
  // to decide invisibility per student.
  const lastSeenByStudent = new Map<string, number>();
  for (const r of recentPbis) {
    const t = new Date(r.createdAt).getTime();
    const cur = lastSeenByStudent.get(r.studentId) ?? 0;
    if (t > cur) lastSeenByStudent.set(r.studentId, t);
  }
  // Per-tier window cutoffs (tier 1/2/3) as ms since epoch.
  const tierWindowCutoff = new Map<number, number>([
    [1, subtractSchoolDays(invisibleDaysTier1).getTime()],
    [2, subtractSchoolDays(invisibleDaysTier2).getTime()],
    [3, subtractSchoolDays(invisibleDaysTier3).getTime()],
  ]);

  // Highest active MTSS tier per student (a student can have multiple
  // active plans — we surface the most intensive one).
  const mtssTierByStudent = new Map<string, number>();
  for (const p of activeMtss) {
    const cur = mtssTierByStudent.get(p.studentId) ?? 0;
    if (p.tier > cur) mtssTierByStudent.set(p.studentId, p.tier);
  }

  // (studentId, subject) → row
  const scoreKey = (sid: string, subj: Subject) => `${sid}::${subj}`;
  const scoreMap = new Map<
    string,
    typeof studentFastScoresTable.$inferSelect
  >();
  for (const s of scores) {
    scoreMap.set(scoreKey(s.studentId, s.subject as Subject), s);
  }

  // Sort: by last name then first.
  const studentSorted = [...students].sort((a, b) => {
    const an = `${a.lastName ?? ""} ${a.firstName ?? ""}`.toLowerCase();
    const bn = `${b.lastName ?? ""} ${b.firstName ?? ""}`.toLowerCase();
    return an.localeCompare(bn);
  });

  // Additive read-only attendance metric (shared source of truth). Batch-
  // loaded once for the roster's students; FAST gap columns already exist
  // on the subject blocks via buildSubjectBlock/bucketFor.
  const attMap = await loadAttendanceMetrics(
    schoolId,
    studentSorted.map((s) => s.studentId),
  );

  const out = studentSorted.map((stu) => {
    const grade = Number(stu.grade);
    const elaRow = scoreMap.get(scoreKey(stu.studentId, "ela"));
    const mathRow = scoreMap.get(scoreKey(stu.studentId, "math"));
    const mtssTier = mtssTierByStudent.get(stu.studentId) ?? null;
    // Resolve the student's invisible window from their highest active tier
    // (no plan → tier 1). Invisible when their most-recent recognition (if
    // any) falls before that tier's cutoff.
    const invisibleTier =
      mtssTier && mtssTier >= 3 ? 3 : mtssTier === 2 ? 2 : 1;
    const invisibleCutoff = tierWindowCutoff.get(invisibleTier) ?? 0;
    const lastSeen = lastSeenByStudent.get(stu.studentId);
    const isInvisible = lastSeen === undefined || lastSeen < invisibleCutoff;
    return {
      studentId: stu.studentId,
      // District-level Local SIS ID (6-digit). Co-exists with FLEID in
      // student_id; FLEID stays canonical for FAST. UI prefers this for
      // visible identifier labels everywhere outside FAST screens.
      localSisId: stu.localSisId ?? null,
      firstName: stu.firstName,
      lastName: stu.lastName,
      grade: stu.grade,
      // Student photo (single-entry: yearbook upload OR camera). When
      // null OR consent=false the client renders a colored initials
      // bubble. Surface here so the roster row can show a face — many
      // teachers know returning students by sight long before they
      // memorize their names.
      photoObjectKey: stu.photoObjectKey,
      photoConsent: stu.photoConsent,
      // Additive read-only attendance (from the Eligibility Hub upload).
      // daysAbsent is the raw absence total; attendancePct is an ESTIMATE
      // (weekday denominator since the semester start). Null when the
      // student has no eligibility row / no semester start configured.
      attendance: (() => {
        const a = attMap.get(stu.studentId);
        return {
          daysAbsent: a?.daysAbsent ?? null,
          daysTardy: a?.daysTardy ?? null,
          attendancePct: a?.attendancePct ?? null,
        };
      })(),
      ela: buildSubjectBlock(
        elaRow,
        "ela",
        grade,
        pickHistory(historyMap, stu.studentId, "ela"),
      ),
      math: buildSubjectBlock(
        mathRow,
        "math",
        grade,
        pickHistory(historyMap, stu.studentId, "math"),
      ),
      // Invisibility = no non-voided PBIS entry in the school's
      // invisibleDays window. Tier is the highest active MTSS plan
      // tier (or null when the student has no open plan).
      isInvisible,
      mtssTier,
      // Whole-child program flags from the SIS / roster import.
      // Surfaced here so a teacher can see at a glance which of their
      // students have an ESE plan, a 504 plan, or are an ELL — common
      // context they need before reaching out to specialists.
      ese: stu.ese,
      is504: stu.is504,
      ell: stu.ell,
      // Active accommodations (no removedAt) attached so the Programs
      // cell on the Teacher Roster page can pop up a category-grouped
      // list on hover. Empty array when the student has none.
      accommodations: accommodationsByStudent.get(stu.studentId) ?? [],
      // ISS / OSS today (Admin Hub surface). issToday is non-null when
      // the student is on the ISS roster today regardless of source —
      // the client renders the orange pill. ossToday flips the red OSS
      // pill. acks lists the (period, method) pairs this teacher has
      // already filed today.
      issToday: issByStudent.get(stu.studentId) ?? null,
      ossToday: ossSet.has(stu.studentId),
      issAcks: ackByStudent.get(stu.studentId) ?? [],
      // Grades the student was retained in (ascending). Empty array
      // when the student has no retention rows. The roster renders an
      // R-in-a-circle pill after the chain icon when this is non-empty.
      retainedGrades: retentionsByStudent.get(stu.studentId) ?? [],
      // Active safety plan summary (or null). The roster pill / hover
      // popover use this directly — no extra round-trip needed.
      safetyPlan: (() => {
        const sp = safetyPlanByStudent.get(stu.studentId);
        if (!sp) return null;
        const activeItems = (sp.items ?? []).filter(
          (i: { active?: boolean }) => i && i.active,
        );
        return {
          itemCount: activeItems.length,
          items: activeItems,
          notes: sp.notes,
          updatedAt: sp.updatedAt,
          updatedByName: sp.updatedByName,
        };
      })(),
    };
  });

  res.json({
    teacher: {
      id: targetTeacher.id,
      displayName: targetTeacher.displayName,
    },
    availablePeriods,
    selectedPeriod: periodFilter,
    // Tier-aware invisible windows (school days) for the legend + per-row
    // eye-icon tooltip. Tier 1 = no active MTSS plan.
    invisibleDaysByTier: {
      "1": invisibleDaysTier1,
      "2": invisibleDaysTier2,
      "3": invisibleDaysTier3,
    },
    students: out,
  });
});

// List teachers (for the core-team picker). Always school-scoped. Plain
// teachers can also call this — they just get back their own row,
// which is fine and avoids a separate endpoint.
router.get("/teacher-roster/teachers", async (req: Request, res: Response) => {
  const staff = await resolveStaff(req);
  if (!staff) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  if (!isCoreTeam(staff)) {
    res.json({
      teachers: [
        { id: staff.id, displayName: staff.displayName },
      ],
    });
    return;
  }

  // Core team: every staff in this school who teaches at least one
  // non-planning section. (We surface only people who actually have a
  // roster — surfacing every staff would clutter the dropdown.) We
  // also pull course names so we can infer each teacher's department
  // for grouping in the picker — no DB column needed today.
  const sections = await db
    .select({
      teacherStaffId: classSectionsTable.teacherStaffId,
      courseName: classSectionsTable.courseName,
      isPlanning: classSectionsTable.isPlanning,
    })
    .from(classSectionsTable)
    .where(eq(classSectionsTable.schoolId, schoolId));
  const coursesByTeacher = new Map<number, string[]>();
  for (const s of sections) {
    if (s.isPlanning) continue;
    const list = coursesByTeacher.get(s.teacherStaffId) ?? [];
    list.push(s.courseName);
    coursesByTeacher.set(s.teacherStaffId, list);
  }
  const teacherIds = [...coursesByTeacher.keys()];
  if (teacherIds.length === 0) {
    res.json({ teachers: [] });
    return;
  }
  const teachers = await db
    .select()
    .from(staffTable)
    .where(
      and(
        eq(staffTable.schoolId, schoolId),
        inArray(staffTable.id, teacherIds),
      ),
    );
  const out = teachers
    .filter((t) => t.active)
    .map((t) => ({
      id: t.id,
      displayName: t.displayName,
      department: inferDepartment(coursesByTeacher.get(t.id) ?? []),
    }))
    .sort((a, b) =>
      (a.displayName ?? "").localeCompare(b.displayName ?? ""),
    );
  res.json({ teachers: out });
});

// inferDepartment now lives in ../lib/teacherDepartments.js (shared with
// the staff-directory route so every teacher picker groups identically).

// Teacher acknowledgement of an ISS-day soft reminder. The teacher clicks
// "Posted in Canvas" or "Sent hard copy" on the roster banner. We record
// the (student, teacher, period, day, method) tuple. Re-clicking the same
// button is a no-op (idempotent on the unique index).
router.post(
  "/teacher-roster/iss-acknowledge",
  async (req: Request, res: Response) => {
    const staff = await resolveStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const studentId =
      typeof body.studentId === "string" ? body.studentId.trim() : "";
    const period = Number(body.period);
    const method = body.method === "hardcopy" ? "hardcopy" : "canvas";
    if (!studentId || !Number.isInteger(period) || period <= 0) {
      res.status(400).json({ error: "studentId and period are required" });
      return;
    }
    const day =
      typeof body.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.day)
        ? body.day
        : new Date().toISOString().slice(0, 10);

    // Confirm the teacher actually teaches this student in this period.
    // Defends against a teacher acking another teacher's banner.
    // NB: class_sections's teacher FK column is `teacher_staff_id`, not
    // `teacher_id` — the schema renamed years ago when staff replaced the
    // legacy teachers table. Using `teacher_id` raises a Postgres "column
    // does not exist" error and 500s the ack post.
    const matches = await db.execute(
      sql`SELECT 1 FROM section_roster sr
            JOIN class_sections cs ON cs.id = sr.section_id
           WHERE cs.school_id = ${schoolId}
             AND cs.teacher_staff_id = ${staff.id}
             AND cs.period = ${period}
             AND sr.student_id = ${studentId}
           LIMIT 1`,
    );
    if (matches.rows.length === 0) {
      res.status(403).json({ error: "Not your class" });
      return;
    }

    await db
      .insert(issAcknowledgementsTable)
      .values({
        schoolId,
        studentId,
        teacherStaffId: staff.id,
        teacherName: staff.displayName,
        period,
        day,
        method,
      })
      .onConflictDoUpdate({
        target: [
          issAcknowledgementsTable.schoolId,
          issAcknowledgementsTable.studentId,
          issAcknowledgementsTable.teacherStaffId,
          issAcknowledgementsTable.period,
          issAcknowledgementsTable.day,
        ],
        set: { method },
      });
    res.status(201).json({ ok: true });
  },
);

export default router;
