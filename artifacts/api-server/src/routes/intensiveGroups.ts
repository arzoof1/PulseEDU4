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
import { and, eq, inArray, sql } from "drizzle-orm";
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

// -----------------------------------------------------------------------------
// PM-readiness probe — shared by the Admin Hub banner and the
// "Run Class Composer after PM upload" onboarding step.
//
// "Ready" = the school has PM3 FAST item responses for BOTH ELA and
// Math in the current school year. We pick PM3 deliberately: PM1 is
// baseline, PM2 is mid-year, PM3 is the most actionable window for
// proposing next-quarter intensive groupings.
//
// Returns { schoolYear, window, ready, subjects: ['ela','math'],
//           dismissed: boolean }. The dismissal token compares
// "<sy>|<window>" so the banner re-appears when a NEW window arrives
// even if the admin dismissed the previous one.
// -----------------------------------------------------------------------------
async function probePmReadiness(schoolId: number): Promise<{
  schoolYear: string;
  window: "pm3";
  ready: boolean;
  subjects: { ela: boolean; math: boolean };
  dismissed: boolean;
  dismissedToken: string | null;
}> {
  const schoolYear = schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ);
  // Single round-trip grouped by subject. The composite index on
  // fast_item_results covers (school_id, subject, school_year, window).
  const r = await db.execute(sql`
    SELECT subject, COUNT(*)::int AS c
      FROM student_fast_item_responses
     WHERE school_id = ${schoolId}
       AND school_year = ${schoolYear}
       AND window = 'pm3'
       AND subject IN ('ela','math')
     GROUP BY subject
  `);
  const counts = new Map<string, number>();
  for (const row of r.rows as Array<{ subject: string; c: number }>) {
    counts.set(row.subject, Number(row.c ?? 0));
  }
  const ela = (counts.get("ela") ?? 0) > 0;
  const math = (counts.get("math") ?? 0) > 0;
  const ready = ela && math;

  const [settings] = await db
    .select({
      dismissed: schoolSettingsTable.classComposerBannerDismissedSy,
    })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId))
    .limit(1);
  const dismissedToken = settings?.dismissed ?? null;
  const currentToken = `${schoolYear}|pm3`;
  const dismissed = dismissedToken === currentToken;

  return {
    schoolYear,
    window: "pm3",
    ready,
    subjects: { ela, math },
    dismissed,
    dismissedToken,
  };
}

// Exposed for the onboarding step's autoCheck so it doesn't duplicate
// the readiness probe logic.
export async function isPmReadinessComplete(schoolId: number): Promise<boolean> {
  const p = await probePmReadiness(schoolId);
  return p.ready;
}

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
// GET /pm-readiness — Admin Hub banner + onboarding-step probe.
// Returns whether ELA + Math PM3 are both loaded for the current SY,
// plus the per-school dismissal state. Admin/Core-Team gated.
// ---------------------------------------------------------------------
router.get("/intensive-groups/pm-readiness", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!canManageGroups(staff)) {
    res.status(403).json({ error: "Admin or Core Team required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const probe = await probePmReadiness(schoolId);
  res.json(probe);
});

// ---------------------------------------------------------------------
// POST /pm-readiness/dismiss — record dismissal for current SY+window.
// Body: {} (idempotent — token is derived server-side). Admin only.
// The banner re-appears automatically when a new window arrives.
// ---------------------------------------------------------------------
router.post("/intensive-groups/pm-readiness/dismiss", async (req, res) => {
  const staff = await loadStaff(req, res);
  if (!staff) return;
  if (!Boolean(staff.isAdmin) && !isCoreTeamShared(staff)) {
    res.status(403).json({ error: "Admin or Core Team required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const schoolYear = schoolYearLabelFor(new Date(), DEFAULT_SCHOOL_TZ);
  const token = `${schoolYear}|pm3`;
  await db
    .update(schoolSettingsTable)
    .set({ classComposerBannerDismissedSy: token })
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  req.log?.info(
    { schoolId, token, by: staff.id },
    "[intensive-groups] PM banner dismissed",
  );
  res.json({ ok: true, dismissedToken: token });
});

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
  // Group Insights works for any section (regular or intensive) —
  // the engine just needs FAST scores for enrolled students. We
  // still tag `isIntensive` in the response so the UI can badge
  // intensive sections, but we no longer filter them out here.
  const filtered = rows
    .filter((r) => canManageGroups(staff) || r.teacherStaffId === staff.id)
    .map((r) => ({ ...r, isIntensive: isIntensiveCourseName(r.courseName) }));
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
      localSisId: p.localSisId,
      firstName: p.firstName,
      lastName: p.lastName,
      grade: p.grade,
      overallPct: p.overallPct,
      topGaps: p.topGaps,
    })),
    unscored: unscored.map((p) => ({
      studentId: p.studentId,
      localSisId: p.localSisId,
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

  // NOTE: an earlier draft tried to surface a "ceiling" comparison by
  // re-clustering the same roster into one group, but clustering a
  // fixed set into k=1 just returns that same set — the comparison
  // was meaningless. A real counterfactual would require pulling a
  // grade-wide candidate pool and recruiting a fresh section of the
  // same seat count; that belongs in the Composer, not on a teacher's
  // read-only roster tab. Field intentionally omitted from the
  // response until that work lands.

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
