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
} from "@workspace/db";
import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import {
  bucketFor,
  hasChart,
  placeOnChart,
  placePm3,
  type Subject,
  type Placement,
  type BucketInfo,
} from "../lib/fastCutScores.js";

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

interface SubjectBlock {
  pm1: number | null;
  pm2: number | null;
  pm3: number | null;
  // Placement of EACH PM score on its own chart. PM1/PM2 use current
  // grade; PM3 uses prior grade (so it represents end-of-prior-year
  // mastery before fall regression).
  pm1Placement: Placement | null;
  pm2Placement: Placement | null;
  pm3Placement: Placement | null;
  bucket: BucketInfo;
  priorYearScore: number | null;
  priorYearBq: boolean;
  // True when no chart exists for this subject/grade combo (e.g. Algebra
  // 1 / Geometry / Math past G8). Client uses this to render only a
  // "—" instead of empty pills.
  noChart: boolean;
}

function buildSubjectBlock(
  row: typeof studentFastScoresTable.$inferSelect | undefined,
  subject: Subject,
  grade: number,
): SubjectBlock {
  const noChart = !hasChart(subject, grade);
  if (!row) {
    return {
      pm1: null,
      pm2: null,
      pm3: null,
      pm1Placement: null,
      pm2Placement: null,
      pm3Placement: null,
      bucket: { targetScore: null, gap: null, color: null },
      priorYearScore: null,
      priorYearBq: false,
      noChart,
    };
  }
  const pm1Placement =
    row.pm1 != null ? placeOnChart(row.pm1, subject, grade) : null;
  const pm2Placement =
    row.pm2 != null ? placeOnChart(row.pm2, subject, grade) : null;
  const pm3Placement =
    row.pm3 != null ? placePm3(row.pm3, subject, grade) : null;
  const bucket =
    row.pm3 != null
      ? bucketFor(row.pm3, subject, grade)
      : { targetScore: null, gap: null, color: null };
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
  const invisibleDays = settingsRow?.pbisInvisibleStudentDays ?? 10;
  const invisibleWindow = subtractSchoolDays(invisibleDays);
  const invisibleWindowIso = invisibleWindow.toISOString();

  // Pull demographics + FAST scores + recent PBIS entries + active MTSS
  // plans in parallel. The PBIS query only returns studentId since
  // that's all we need to mark "has been recognized recently".
  const [students, scores, recentPbis, activeMtss] = await Promise.all([
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
        ),
      ),
    db
      .select({ studentId: pbisEntriesTable.studentId })
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
  ]);

  // Set of students with at least one non-voided PBIS entry in the window.
  const recognizedIds = new Set<string>();
  for (const r of recentPbis) recognizedIds.add(r.studentId);

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

  const out = studentSorted.map((stu) => {
    const grade = Number(stu.grade);
    const elaRow = scoreMap.get(scoreKey(stu.studentId, "ela"));
    const mathRow = scoreMap.get(scoreKey(stu.studentId, "math"));
    const mtssTier = mtssTierByStudent.get(stu.studentId) ?? null;
    const isInvisible = !recognizedIds.has(stu.studentId);
    return {
      studentId: stu.studentId,
      firstName: stu.firstName,
      lastName: stu.lastName,
      grade: stu.grade,
      ela: buildSubjectBlock(elaRow, "ela", grade),
      math: buildSubjectBlock(mathRow, "math", grade),
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
    };
  });

  res.json({
    teacher: {
      id: targetTeacher.id,
      displayName: targetTeacher.displayName,
    },
    availablePeriods,
    selectedPeriod: periodFilter,
    invisibleDays,
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
  // roster — surfacing every staff would clutter the dropdown.)
  const teachersWithSections = await db
    .selectDistinct({
      teacherStaffId: classSectionsTable.teacherStaffId,
    })
    .from(classSectionsTable)
    .where(eq(classSectionsTable.schoolId, schoolId));
  const teacherIds = teachersWithSections.map((t) => t.teacherStaffId);
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
    .map((t) => ({ id: t.id, displayName: t.displayName }))
    .sort((a, b) =>
      (a.displayName ?? "").localeCompare(b.displayName ?? ""),
    );
  res.json({ teachers: out });
});

export default router;
