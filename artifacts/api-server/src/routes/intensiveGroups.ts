// Intensive Group Insights — Phase A (suggestion) + Phase B (insights).
//
// Routes (all admin/Core-Team gated; read-only on existing tables):
//
//   GET /api/intensive-groups/windows?subject=
//        → list of {schoolYear, window, label} this school has data
//          for in the given subject, newest first.
//
//   GET /api/intensive-groups/suggest
//          ?subject=&grade=&sections=N&seats=S
//          &schoolYear=&window=&eligibilityMaxPct=70
//        → N proposed groups built from FAST item responses. Read-
//          only; nothing is persisted.
//
//   GET /api/intensive-groups/insights?sectionId=
//        → group profile + sub-groups + homogeneity score + drift
//          for the section's CURRENTLY-ENROLLED roster. Reads from
//          section_roster (which is rebuilt from RosterOne).
//
//   GET /api/intensive-groups/sections
//        → all intensive sections at this school (course-name
//          heuristic), grouped by teacher. Powers the Class
//          Composer + the teacher tab's "switch section" picker.

import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  classSectionsTable,
  sectionRosterTable,
  staffTable,
  studentsTable,
  studentFastItemResponsesTable,
  schoolSettingsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam as isCoreTeamShared } from "../lib/coreTeam.js";
import { schoolYearLabelFor, DEFAULT_SCHOOL_TZ } from "../lib/schoolYear.js";
import {
  computeSkillProfiles,
  clusterProfilesIntoGroups,
  summarizeSection,
  isIntensiveCourseName,
  type StudentSkillProfile,
} from "../lib/skillProfile.js";

const router: IRouter = Router();

const VALID_SUBJECTS = new Set(["ela", "math", "algebra1", "geometry"]);
const VALID_WINDOWS = new Set(["pm1", "pm2", "pm3"]);

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request, res: Response): Promise<StaffRow | null> {
  if (!req.staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, req.staffId));
  if (!s || !s.active) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  return s;
}

// Admin OR Core Team (admin, BS, MTSS coord, PBIS coord, superuser).
// Plain teachers and ESE coordinators are out — same gate the rest of
// insights uses.
function canManageGroups(s: StaffRow): boolean {
  return Boolean(s.isAdmin) || isCoreTeamShared(s);
}

// Teacher tab insights are visible to the section's own teacher OR
// any Core Team member. Same gate as TeacherRosterPage's "view
// another teacher's roster".
function canViewSectionInsights(s: StaffRow, teacherStaffId: number): boolean {
  if (s.id === teacherStaffId) return true;
  return Boolean(s.isAdmin) || isCoreTeamShared(s);
}

function pickWindow(
  req: Request,
  available: Array<{ schoolYear: string; window: string }>,
): { schoolYear: string; window: string } {
  const rawWindow = req.query.window;
  const rawSY = req.query.schoolYear;
  if (
    typeof rawWindow === "string" &&
    VALID_WINDOWS.has(rawWindow) &&
    typeof rawSY === "string" &&
    rawSY.length > 0
  ) {
    return { schoolYear: rawSY, window: rawWindow };
  }
  if (available.length > 0) return available[0];
  return {
    schoolYear: schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ),
    window: "pm3",
  };
}

async function listAvailableWindows(
  schoolId: number,
  subject: string,
  studentIds: string[] | null,
): Promise<Array<{ schoolYear: string; window: string; label: string }>> {
  const conds = [
    eq(studentFastItemResponsesTable.schoolId, schoolId),
    eq(studentFastItemResponsesTable.subject, subject),
  ];
  if (studentIds !== null) {
    if (studentIds.length === 0) return [];
    conds.push(inArray(studentFastItemResponsesTable.studentId, studentIds));
  }
  const rows = await db
    .selectDistinct({
      schoolYear: studentFastItemResponsesTable.schoolYear,
      window: studentFastItemResponsesTable.window,
    })
    .from(studentFastItemResponsesTable)
    .where(and(...conds));
  const rank: Record<string, number> = { pm3: 0, pm2: 1, pm1: 2 };
  rows.sort((a, b) => {
    if (a.schoolYear !== b.schoolYear) {
      return b.schoolYear.localeCompare(a.schoolYear);
    }
    return (rank[a.window] ?? 9) - (rank[b.window] ?? 9);
  });
  return rows.map((r) => ({
    schoolYear: r.schoolYear,
    window: r.window,
    label: `${r.schoolYear} ${r.window.toUpperCase()}`,
  }));
}

// ---------------------------------------------------------------------
// GET /windows
// ---------------------------------------------------------------------
router.get("/intensive-groups/windows", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!canManageGroups(staff)) {
    res.status(403).json({ error: "Admin or Core Team required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const subject =
    typeof req.query.subject === "string" ? req.query.subject : "ela";
  if (!VALID_SUBJECTS.has(subject)) {
    res.status(400).json({ error: "Invalid subject" });
    return;
  }
  const available = await listAvailableWindows(schoolId, subject, null);
  res.json({ subject, available });
});

// ---------------------------------------------------------------------
// GET /sections — all intensive sections at this school.
// ---------------------------------------------------------------------
router.get("/intensive-groups/sections", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  // Visible scope: a teacher sees only their own; Core Team sees all.
  const rows = await db
    .select({
      id: classSectionsTable.id,
      period: classSectionsTable.period,
      courseName: classSectionsTable.courseName,
      teacherStaffId: classSectionsTable.teacherStaffId,
      teacherName: staffTable.displayName,
    })
    .from(classSectionsTable)
    .innerJoin(
      staffTable,
      eq(staffTable.id, classSectionsTable.teacherStaffId),
    )
    .where(
      and(
        eq(classSectionsTable.schoolId, schoolId),
        eq(classSectionsTable.isPlanning, false),
      ),
    );
  const filtered = rows.filter(
    (r) =>
      isIntensiveCourseName(r.courseName) &&
      (canManageGroups(staff) || r.teacherStaffId === staff.id),
  );
  filtered.sort((a, b) => {
    const t = (a.teacherName ?? "").localeCompare(b.teacherName ?? "");
    if (t !== 0) return t;
    return a.period - b.period;
  });
  res.json({ sections: filtered });
});

// ---------------------------------------------------------------------
// GET /suggest — Phase A scheduler-facing recommendation.
// ---------------------------------------------------------------------
router.get("/intensive-groups/suggest", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!canManageGroups(staff)) {
    res.status(403).json({ error: "Admin or Core Team required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const subject =
    typeof req.query.subject === "string" ? req.query.subject : "ela";
  if (!VALID_SUBJECTS.has(subject)) {
    res.status(400).json({ error: "Invalid subject" });
    return;
  }
  const grade = Number(req.query.grade);
  if (!Number.isInteger(grade) || grade < 0 || grade > 12) {
    res.status(400).json({ error: "Invalid grade" });
    return;
  }
  const sections = Math.max(1, Math.min(20, Number(req.query.sections) || 4));
  const seats = Math.max(2, Math.min(35, Number(req.query.seats) || 22));
  const eligibilityMaxPct = Math.max(
    0,
    Math.min(
      100,
      req.query.eligibilityMaxPct == null
        ? 70
        : Number(req.query.eligibilityMaxPct),
    ),
  );

  // Grade-scoped roster: all students at this school in the grade.
  const studentsAtGrade = await db
    .select({ studentId: studentsTable.studentId })
    .from(studentsTable)
    .where(
      and(eq(studentsTable.schoolId, schoolId), eq(studentsTable.grade, grade)),
    );
  const studentIds = studentsAtGrade.map((s) => s.studentId);

  const available = await listAvailableWindows(schoolId, subject, studentIds);
  const { schoolYear, window } = pickWindow(req, available);

  const profiles = await computeSkillProfiles({
    schoolId,
    subject,
    schoolYear,
    window,
    studentIds,
  });

  // Eligibility filter: students at or below the threshold overall.
  // Students with no data are excluded from the suggestion entirely
  // (they go in the "unscored" tail so admins can place them
  // manually).
  const eligible = profiles.filter(
    (p) => p.overallPct != null && p.overallPct <= eligibilityMaxPct,
  );
  const unscored = profiles.filter((p) => p.overallPct == null);

  const clustered = clusterProfilesIntoGroups(eligible, sections, seats);

  res.json({
    subject,
    grade,
    schoolYear,
    window,
    available,
    eligibilityMaxPct,
    requested: { sections, seats },
    candidatePool: {
      totalAtGrade: profiles.length,
      eligible: eligible.length,
      unscored: unscored.length,
    },
    groups: clustered.groups,
    overflow: clustered.overflow.map((p) => ({
      studentId: p.studentId,
      firstName: p.firstName,
      lastName: p.lastName,
      grade: p.grade,
      overallPct: p.overallPct,
      topGaps: p.topGaps,
    })),
    unscored: unscored.map((p) => ({
      studentId: p.studentId,
      firstName: p.firstName,
      lastName: p.lastName,
      grade: p.grade,
    })),
  });
});

// ---------------------------------------------------------------------
// GET /insights?sectionId= — Phase B teacher-facing insights.
// ---------------------------------------------------------------------
router.get("/intensive-groups/insights", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const sectionId = Number(req.query.sectionId);
  if (!Number.isInteger(sectionId) || sectionId <= 0) {
    res.status(400).json({ error: "Invalid sectionId" });
    return;
  }
  const [section] = await db
    .select()
    .from(classSectionsTable)
    .where(
      and(
        eq(classSectionsTable.id, sectionId),
        eq(classSectionsTable.schoolId, schoolId),
      ),
    );
  if (!section) {
    res.status(404).json({ error: "Section not found" });
    return;
  }
  if (!canViewSectionInsights(staff, section.teacherStaffId)) {
    res.status(403).json({ error: "Not your section" });
    return;
  }

  // Subject inferred from course name. ELA-ish → ela, else math.
  const courseLower = section.courseName.toLowerCase();
  let subject: string = "ela";
  if (/math|algebra|geometry/.test(courseLower)) {
    if (/algebra\s*1|algebra\s*i\b/.test(courseLower)) subject = "algebra1";
    else if (/geometry/.test(courseLower)) subject = "geometry";
    else subject = "math";
  }

  const rosterRows = await db
    .select({ studentId: sectionRosterTable.studentId })
    .from(sectionRosterTable)
    .where(
      and(
        eq(sectionRosterTable.schoolId, schoolId),
        eq(sectionRosterTable.sectionId, sectionId),
      ),
    );
  const studentIds = Array.from(new Set(rosterRows.map((r) => r.studentId)));

  const available = await listAvailableWindows(schoolId, subject, studentIds);
  const { schoolYear, window } = pickWindow(req, available);

  // Roster profiles for the current window.
  const profiles = await computeSkillProfiles({
    schoolId,
    subject,
    schoolYear,
    window,
    studentIds,
  });

  const sectionProfile = summarizeSection(profiles);

  // Sub-groups: cluster within the period into k=3 mini-groups.
  // Seats per sub-group ceil(rosterSize/3) so all kids land.
  const k = Math.min(3, Math.max(1, Math.ceil(profiles.length / 6)));
  const subgroupSeats = Math.ceil(Math.max(profiles.length, 1) / k);
  const subgroupResult = clusterProfilesIntoGroups(profiles, k, subgroupSeats);
  const subgroups = subgroupResult.groups;

  // Drift panel — only meaningful when there's an earlier window
  // in the same school year to compare against.
  let drift: {
    comparedWindow: string | null;
    outgrew: Array<{ studentId: string; name: string | null }>;
    wouldNowFit: Array<{ studentId: string; name: string | null }>;
  } | null = null;

  // "Earlier" = the immediately-prior PM window in the SAME school
  // year. `available` is sorted PM3→PM2→PM1 within each SY, so
  // picking the first entry whose rank is strictly higher than the
  // current window guarantees chronological "prior" (PM2 compares
  // against PM1, PM3 against PM2). Never compares across SYs and
  // never picks a later window.
  const rank: Record<string, number> = { pm3: 0, pm2: 1, pm1: 2 };
  const currentRank = rank[window] ?? -1;
  const earlier = available.find(
    (a) =>
      a.schoolYear === schoolYear &&
      a.window !== window &&
      (rank[a.window] ?? -1) > currentRank,
  );
  if (earlier && profiles.length > 0) {
    // Pull THIS section's prior-window profiles and the rest of the
    // grade's current-window profiles in parallel.
    const sectionGrades = Array.from(
      new Set(
        profiles.map((p) => p.grade).filter((g): g is number => g != null),
      ),
    );
    const peerStudentsRows =
      sectionGrades.length === 0
        ? []
        : await db
            .select({ studentId: studentsTable.studentId })
            .from(studentsTable)
            .where(
              and(
                eq(studentsTable.schoolId, schoolId),
                inArray(studentsTable.grade, sectionGrades),
              ),
            );
    const peerIds = peerStudentsRows
      .map((r) => r.studentId)
      .filter((id) => !studentIds.includes(id));

    const [priorProfiles, peerProfiles] = await Promise.all([
      computeSkillProfiles({
        schoolId,
        subject,
        schoolYear,
        window: earlier.window,
        studentIds,
      }),
      peerIds.length > 0
        ? computeSkillProfiles({
            schoolId,
            subject,
            schoolYear,
            window,
            studentIds: peerIds,
          })
        : Promise.resolve([] as StudentSkillProfile[]),
    ]);

    const focusCats = new Set(
      sectionProfile.dominantCategories.slice(0, 2).map((d) => d.category),
    );
    // Outgrew = was below 80% in focus cat in prior window, now above.
    const priorById = new Map(priorProfiles.map((p) => [p.studentId, p]));
    const outgrew: Array<{ studentId: string; name: string | null }> = [];
    for (const p of profiles) {
      if (focusCats.size === 0) break;
      const cur = p.categories.find((c) => focusCats.has(c.category));
      const prior = priorById.get(p.studentId);
      const old = prior?.categories.find((c) => focusCats.has(c.category));
      if (cur && old && old.pct < 80 && cur.pct >= 80) {
        outgrew.push({
          studentId: p.studentId,
          name:
            p.firstName && p.lastName ? `${p.firstName} ${p.lastName}` : null,
        });
      }
    }
    // Would now fit = NOT in this section, top-2 gap matches focus
    // categories, and overall pct ≤ section avg.
    const sectionAvg =
      profiles.length > 0
        ? profiles.reduce((s, p) => s + (p.overallPct ?? 100), 0) /
          profiles.length
        : 100;
    const wouldNowFit: Array<{ studentId: string; name: string | null }> = [];
    for (const p of peerProfiles) {
      if (p.overallPct == null || p.overallPct > sectionAvg) continue;
      const studentTop2 = new Set(p.topGaps.slice(0, 2));
      let hit = false;
      for (const c of focusCats) {
        if (studentTop2.has(c)) {
          hit = true;
          break;
        }
      }
      if (hit) {
        wouldNowFit.push({
          studentId: p.studentId,
          name:
            p.firstName && p.lastName ? `${p.firstName} ${p.lastName}` : null,
        });
      }
    }
    // Cap each at 10 so the UI panel stays scannable.
    drift = {
      comparedWindow: earlier.window,
      outgrew: outgrew.slice(0, 10),
      wouldNowFit: wouldNowFit.slice(0, 10),
    };
  }

  // Before/after concentration — admin-only. "Before" = current
  // homogeneity of the actual section. "After" = simulated
  // homogeneity if the same kids were re-clustered tightly (k=1).
  let beforeAfter: { current: number; ifReclustered: number } | null = null;
  if (canManageGroups(staff) && profiles.length > 0) {
    const reclustered = clusterProfilesIntoGroups(profiles, 1, profiles.length);
    const reSummary = summarizeSection(
      reclustered.groups[0]?.students ?? [],
    );
    beforeAfter = {
      current: sectionProfile.homogeneityPct,
      ifReclustered: reSummary.homogeneityPct,
    };
  }

  res.json({
    section: {
      id: section.id,
      period: section.period,
      courseName: section.courseName,
      teacherStaffId: section.teacherStaffId,
      isIntensive: isIntensiveCourseName(section.courseName),
    },
    subject,
    schoolYear,
    window,
    available,
    rosterSize: studentIds.length,
    sectionProfile,
    subgroups,
    drift,
    beforeAfter,
    profiles: profiles.map((p) => ({
      studentId: p.studentId,
      firstName: p.firstName,
      lastName: p.lastName,
      grade: p.grade,
      topGaps: p.topGaps,
      overallPct: p.overallPct,
    })),
  });
});

export default router;
