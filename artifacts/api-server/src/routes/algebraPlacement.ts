// Algebra I Placement Review (Phase 1 of Historical FAST work).
//
// Surfaces the state-mandated 7th-grade → Algebra I placement cohort
// (every current 7th grader whose Math PM3 for the current school
// year is L3+) alongside their multi-year PM3 FAST trajectory and
// any per-student opt-out override that's been recorded.
//
// Routes:
//   GET  /api/algebra-placement                  — full report (JSON)
//   GET  /api/algebra-placement/csv              — same report as CSV
//   GET  /api/algebra-placement/pdf              — printable PDF
//   POST /api/algebra-placement/overrides        — save / replace
//                                                  override row
//   DELETE /api/algebra-placement/overrides/:id  — undo override
//
// Role gates:
//   - View routes: canViewAlgebraPlacement (admin + Core Team +
//     Counselor / Guidance Counselor).
//   - Save / delete: canSaveAlgebraPlacementOverride (admin +
//     Counselor / Guidance Counselor only — Core Team without admin
//     cannot record opt-outs).
//
// All routes are multi-tenant — req.schoolId is the only data
// boundary. No SuperUser cross-tenant view here (placement decisions
// are school-local).

import { Router, type Request, type Response } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  studentFastScoresTable,
  studentFastItemResponsesTable,
  studentsTable,
  schoolsTable,
  algebraPlacementOverridesTable,
  schoolSettingsTable,
  staffTable,
} from "@workspace/db";
import { requireSchool } from "../lib/scope";
import {
  canViewAlgebraPlacement,
  canSaveAlgebraPlacementOverride,
} from "../lib/coreTeam";
import { getSchoolTimezone, schoolYearLabelFor } from "../lib/schoolYear";

async function currentSchoolYearLabelForSchool(
  schoolId: number,
): Promise<string> {
  const tz = await getSchoolTimezone(schoolId);
  return schoolYearLabelFor(new Date(), tz);
}
import { bindObjectToSchool } from "./storage";
import { renderAlgebraPlacementPdf } from "../lib/algebraPlacementPdf";

const router: Router = Router();

// Load the acting staff row for an authenticated request. The global
// session middleware only sets `req.staffId` (a number); routes that
// need role flags must hydrate the row themselves. This mirrors the
// `loadStaff` pattern used by digest.ts, parentEmail.ts, customRoles.ts.
async function loadActingStaff(req: Request) {
  const id = (req as Request & { staffId?: number | null }).staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

// FAST Math PM3 → level mapping uses the same per-grade bands as the
// Class Composer (`deriveLevelForWindow` in intensiveGroups.ts). For
// the Placement Review report we only need the LEVEL (not the strand
// breakdown) and only for grade-7 Math, so we compute the level by a
// flat lookup against the 7th-grade Math PM3 cut scores. The 6th /
// 5th / 4th grade rows are rendered for trajectory CONTEXT — we
// still need their levels, so the helper resolves each row's level
// using the grade-at-time-of-test, which is captured by the row's
// schoolYear + the student's current grade.
//
// Simplification: we don't have a stored "grade at time of test"
// column on studentFastScores. We approximate by walking back from
// the student's current grade — for a current 7th grader, schoolYear
// N-0 was grade 7, N-1 was grade 6, etc. This is correct in the
// common case (no retention / promotion). Retained students get a
// slightly off-by-one chart grade for prior years; the report
// renders "—" rather than the wrong level when in doubt.
const MATH_PM3_L3_MIN: Record<number, number> = {
  3: 198,
  4: 211,
  5: 222,
  6: 229,
  7: 235,
  8: 244,
};

function mathPm3Level(score: number | null, grade: number): 1 | 2 | 3 | 4 | 5 | null {
  if (score == null) return null;
  const l3 = MATH_PM3_L3_MIN[grade];
  if (l3 == null) return null;
  // Coarse 3-bucket placement: L1/L2 = below L3 min, L3 = at-or-above
  // L3 min, L4+ uses approximate +20 / +35 deltas (used only for
  // trajectory chip color). Good enough for the report — the L3+
  // distinction is the only one Florida statute cares about for
  // Algebra placement.
  if (score < l3 - 15) return 1;
  if (score < l3) return 2;
  if (score >= l3 + 30) return 5;
  if (score >= l3 + 15) return 4;
  return 3;
}

function schoolYearLabelOffset(currentLabel: string, yearsBack: number): string {
  // Labels are "YY-YY" (e.g. "25-26"). Subtract yearsBack from both
  // halves. Wraps single-digit (e.g. 22-23 → 21-22).
  const m = /^(\d{2})-(\d{2})$/.exec(currentLabel);
  if (!m) return currentLabel;
  const start = parseInt(m[1], 10) - yearsBack;
  const end = parseInt(m[2], 10) - yearsBack;
  const pad = (n: number) => (n < 0 ? `${100 + n}` : n < 10 ? `0${n}` : `${n}`);
  return `${pad(start)}-${pad(end)}`;
}

interface PlacementRow {
  studentId: string;
  localSisId: string | null;
  firstName: string;
  lastName: string;
  grade: number;
  // Most-recent-first array of { schoolYear, score, level, gradeAtTime }.
  trajectory: Array<{
    schoolYear: string;
    score: number | null;
    level: 1 | 2 | 3 | 4 | 5 | null;
    gradeAtTime: number;
    isHistorical: boolean;
  }>;
  override: {
    id: number;
    decision: string;
    justification: string;
    optOutFileObjectKey: string | null;
    decidedByStaffId: number;
    decidedByName: string | null;
    decidedAt: string;
  } | null;
  // Derived: "Algebra I" by default; flipped to opt-out when override
  // is present.
  proposedPlacement: string;
  // Current-year (PM3) strand mastery percent for Number Sense &
  // Operations and Algebraic Reasoning. Null when item-level data
  // is unavailable. Used for placement defensibility — a high-level
  // student with a weak AR strand is worth a second look.
  nsoPct: number | null;
  arPct: number | null;
  // Convenience: the current-year level (l3/l4/l5). Always present
  // because cohort filter requires currentLevel >= 3.
  currentLevel: 3 | 4 | 5;
}

// FAST strand category-name matchers. The importer uses the raw
// FLDOE category labels (e.g. "1. Number Sense and Operations",
// "2. Algebraic Reasoning"). 7th-grade Math PM3 has one row per
// strand per item; we sum (earned, possible) across all items in a
// strand and compute a mastery percent. The matchers tolerate the
// number prefix being absent + match case-insensitively + handle the
// two combined-strand labels FAST uses at lower grades by treating
// them as BOTH NSO and AR (since this report is 7th-grade-only the
// combined labels effectively never fire, but the guard is cheap).
function categoryMatchesNSO(category: string | null): boolean {
  if (!category) return false;
  return /number sense and operations/i.test(category);
}
function categoryMatchesAR(category: string | null): boolean {
  if (!category) return false;
  return /algebraic reasoning/i.test(category);
}

async function buildReport(schoolId: number): Promise<{
  schoolYear: string;
  windowVisible: number;
  rows: PlacementRow[];
  overrideCount: number;
  levelCounts: { l5: number; l4: number; l3: number };
}> {
  const schoolYear = await currentSchoolYearLabelForSchool(schoolId);

  // Pull the visibility setting (clamped 2..5 by the route validator
  // — clamp again defensively here so a manually-edited DB row can't
  // crash the report).
  const [settings] = await db
    .select({
      fastHistoryYearsVisible: schoolSettingsTable.fastHistoryYearsVisible,
    })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  const windowVisible = Math.max(
    2,
    Math.min(5, settings?.fastHistoryYearsVisible ?? 3),
  );

  // 1) Find every current 7th grader at this school.
  const seventhGraders = await db
    .select({
      studentId: studentsTable.studentId,
      localSisId: studentsTable.localSisId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        eq(studentsTable.grade, 7),
      ),
    );
  if (seventhGraders.length === 0) {
    return {
      schoolYear,
      windowVisible,
      rows: [],
      overrideCount: 0,
      levelCounts: { l5: 0, l4: 0, l3: 0 },
    };
  }
  const studentIds = seventhGraders.map((s) => s.studentId);

  // 2) Pull all Math FAST score rows for these students across the
  //    visible-history window. We grab every row (any year) so we
  //    can render the trajectory; the L3+ cohort filter is applied
  //    AFTER we resolve the current-year PM3 level.
  const fastRows = await db
    .select({
      studentId: studentFastScoresTable.studentId,
      schoolYear: studentFastScoresTable.schoolYear,
      pm3: studentFastScoresTable.pm3,
      isHistorical: studentFastScoresTable.isHistorical,
    })
    .from(studentFastScoresTable)
    .where(
      and(
        eq(studentFastScoresTable.schoolId, schoolId),
        eq(studentFastScoresTable.subject, "math"),
        inArray(studentFastScoresTable.studentId, studentIds),
      ),
    );

  // 2b) Pull current-year Math PM3 item responses for the cohort so
  //     we can compute per-strand mastery (NSO / AR). Item responses
  //     only exist for current-year imports (the Phase-1 historical
  //     importer is score-only), so we don't query prior years here.
  const itemRows = await db
    .select({
      studentId: studentFastItemResponsesTable.studentId,
      category: studentFastItemResponsesTable.category,
      pointsEarned: studentFastItemResponsesTable.pointsEarned,
      pointsPossible: studentFastItemResponsesTable.pointsPossible,
    })
    .from(studentFastItemResponsesTable)
    .where(
      and(
        eq(studentFastItemResponsesTable.schoolId, schoolId),
        eq(studentFastItemResponsesTable.subject, "math"),
        eq(studentFastItemResponsesTable.schoolYear, schoolYear),
        eq(studentFastItemResponsesTable.window, "pm3"),
        inArray(studentFastItemResponsesTable.studentId, studentIds),
      ),
    );

  // Aggregate per (student, strand). Stored as
  // Map<studentId, { nso: {e,p}, ar: {e,p} }>.
  type StrandTally = { earned: number; possible: number };
  const strandByStudent = new Map<
    string,
    { nso: StrandTally; ar: StrandTally }
  >();
  for (const r of itemRows) {
    const e = r.pointsEarned ?? 0;
    const p = r.pointsPossible ?? 0;
    if (p <= 0) continue;
    let agg = strandByStudent.get(r.studentId);
    if (!agg) {
      agg = { nso: { earned: 0, possible: 0 }, ar: { earned: 0, possible: 0 } };
      strandByStudent.set(r.studentId, agg);
    }
    if (categoryMatchesNSO(r.category)) {
      agg.nso.earned += e;
      agg.nso.possible += p;
    }
    if (categoryMatchesAR(r.category)) {
      agg.ar.earned += e;
      agg.ar.possible += p;
    }
  }
  function pctOrNull(t: StrandTally | undefined): number | null {
    if (!t || t.possible <= 0) return null;
    return Math.round((t.earned / t.possible) * 100);
  }

  // 3) Pull every override on file for this school+year. Map by
  //    student so we can attach in O(1) below.
  const overrides = await db
    .select({
      id: algebraPlacementOverridesTable.id,
      studentId: algebraPlacementOverridesTable.studentId,
      decision: algebraPlacementOverridesTable.decision,
      justification: algebraPlacementOverridesTable.justification,
      optOutFileObjectKey:
        algebraPlacementOverridesTable.optOutFileObjectKey,
      decidedByStaffId: algebraPlacementOverridesTable.decidedByStaffId,
      createdAt: algebraPlacementOverridesTable.createdAt,
      updatedAt: algebraPlacementOverridesTable.updatedAt,
    })
    .from(algebraPlacementOverridesTable)
    .where(
      and(
        eq(algebraPlacementOverridesTable.schoolId, schoolId),
        eq(algebraPlacementOverridesTable.schoolYear, schoolYear),
        inArray(algebraPlacementOverridesTable.studentId, studentIds),
      ),
    );
  const decidedByIds = Array.from(
    new Set(overrides.map((o) => o.decidedByStaffId)),
  );
  const decidedByName = new Map<number, string>();
  if (decidedByIds.length > 0) {
    const staff = await db
      .select({ id: staffTable.id, displayName: staffTable.displayName })
      .from(staffTable)
      .where(inArray(staffTable.id, decidedByIds));
    for (const s of staff) decidedByName.set(s.id, s.displayName);
  }
  const overrideByStudent = new Map<string, (typeof overrides)[number]>();
  for (const o of overrides) overrideByStudent.set(o.studentId, o);

  // 4) Bucket FAST rows by (student, schoolYear).
  const fastByStudentYear = new Map<string, (typeof fastRows)[number]>();
  for (const r of fastRows) {
    fastByStudentYear.set(`${r.studentId}|${r.schoolYear}`, r);
  }

  // 5) Build rows. Filter to the L3+ cohort: current-year Math PM3
  //    must resolve to level 3+. Students with no current-year PM3
  //    score are excluded (placement decision can't be made without
  //    the trigger score).
  const rows: PlacementRow[] = [];
  for (const s of seventhGraders) {
    const current = fastByStudentYear.get(`${s.studentId}|${schoolYear}`);
    const currentLevel = mathPm3Level(current?.pm3 ?? null, 7);
    if (currentLevel == null || currentLevel < 3) continue;

    const trajectory: PlacementRow["trajectory"] = [];
    for (let back = 0; back < windowVisible; back++) {
      const year = back === 0 ? schoolYear : schoolYearLabelOffset(schoolYear, back);
      const gradeAtTime = s.grade - back; // current grade 7 → 6 → 5 …
      if (gradeAtTime < 3) break; // Math PM3 only meaningful K-8+
      const row = fastByStudentYear.get(`${s.studentId}|${year}`);
      trajectory.push({
        schoolYear: year,
        score: row?.pm3 ?? null,
        level: mathPm3Level(row?.pm3 ?? null, gradeAtTime),
        gradeAtTime,
        isHistorical: row?.isHistorical ?? false,
      });
    }

    const ov = overrideByStudent.get(s.studentId);
    const strand = strandByStudent.get(s.studentId);
    rows.push({
      studentId: s.studentId,
      localSisId: s.localSisId,
      firstName: s.firstName,
      lastName: s.lastName,
      grade: s.grade,
      trajectory,
      override: ov
        ? {
            id: ov.id,
            decision: ov.decision,
            justification: ov.justification,
            optOutFileObjectKey: ov.optOutFileObjectKey,
            decidedByStaffId: ov.decidedByStaffId,
            decidedByName: decidedByName.get(ov.decidedByStaffId) ?? null,
            decidedAt: (ov.updatedAt ?? ov.createdAt).toISOString(),
          }
        : null,
      proposedPlacement: ov ? "Regular 8th Math (parent opt-out)" : "Algebra I",
      nsoPct: pctOrNull(strand?.nso),
      arPct: pctOrNull(strand?.ar),
      currentLevel: currentLevel as 3 | 4 | 5,
    });
  }

  // Sort: group by current PM3 level (L5 → L4 → L3) so the printable
  // sections line up with the on-screen breakdown. Within each level,
  // sort by AR strand mastery descending (strongest first) so the
  // best-prepared kids anchor the top of each section. Null AR sorts
  // to the bottom of its level (no strand data — typically a Phase-1
  // historical-only student). Tie-break by last name A→Z for stable
  // printout ordering.
  const levelOrder: Record<3 | 4 | 5, number> = { 5: 0, 4: 1, 3: 2 };
  rows.sort((a, b) => {
    const lv = levelOrder[a.currentLevel] - levelOrder[b.currentLevel];
    if (lv !== 0) return lv;
    const aNull = a.arPct == null;
    const bNull = b.arPct == null;
    if (aNull && !bNull) return 1;
    if (!aNull && bNull) return -1;
    if (!aNull && !bNull && a.arPct !== b.arPct) {
      return (b.arPct as number) - (a.arPct as number);
    }
    return `${a.lastName} ${a.firstName}`.localeCompare(
      `${b.lastName} ${b.firstName}`,
    );
  });

  const levelCounts = { l5: 0, l4: 0, l3: 0 };
  for (const r of rows) {
    if (r.currentLevel === 5) levelCounts.l5++;
    else if (r.currentLevel === 4) levelCounts.l4++;
    else levelCounts.l3++;
  }

  return {
    schoolYear,
    windowVisible,
    rows,
    overrideCount: rows.filter((r) => r.override != null).length,
    levelCounts,
  };
}

router.get("/algebra-placement", async (req: Request, res: Response) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staff = await loadActingStaff(req);
  if (!staff || !canViewAlgebraPlacement(staff)) {
    res.status(403).json({ error: "Not authorized" });
    return;
  }
  const report = await buildReport(schoolId);
  // canSave drives whether the client renders the Override button —
  // returned here so the page can render in read-only mode for Core
  // Team without admin.
  res.json({
    ...report,
    canSaveOverride: canSaveAlgebraPlacementOverride(staff),
  });
});

router.get("/algebra-placement/csv", async (req: Request, res: Response) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staff = await loadActingStaff(req);
  if (!staff || !canViewAlgebraPlacement(staff)) {
    res.status(403).json({ error: "Not authorized" });
    return;
  }
  const report = await buildReport(schoolId);

  const header = [
    "local_sis_id",
    "last_name",
    "first_name",
    "grade",
    "current_pm3_score",
    "current_pm3_level",
    "nso_pct",
    "ar_pct",
    "trajectory",
    "proposed_placement",
    "override_decision",
    "override_justification",
    "override_decided_by",
    "override_decided_at",
  ];
  const escape = (v: string | number | null | undefined): string => {
    if (v == null) return "";
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  // Preamble: cohort summary as CSV comments (lines starting with #
  // — Excel/Sheets treat them as text rows; downstream consumers can
  // skip lines that don't start with the header word).
  const lines: string[] = [
    `# Algebra I Placement Review · ${report.schoolYear}`,
    `# Cohort: ${report.rows.length} · L5: ${report.levelCounts.l5} · L4: ${report.levelCounts.l4} · L3: ${report.levelCounts.l3} · Overrides: ${report.overrideCount}`,
    header.join(","),
  ];
  for (const r of report.rows) {
    const current = r.trajectory[0];
    const trajStr = r.trajectory
      .map((t) =>
        `${t.schoolYear}:${t.level != null ? `L${t.level}` : "—"}${t.score != null ? `(${t.score})` : ""}`,
      )
      .join(" ← ");
    lines.push(
      [
        r.localSisId ?? "",
        r.lastName,
        r.firstName,
        r.grade,
        current?.score ?? "",
        current?.level != null ? `L${current.level}` : "",
        r.nsoPct != null ? `${r.nsoPct}%` : "",
        r.arPct != null ? `${r.arPct}%` : "",
        trajStr,
        r.proposedPlacement,
        r.override?.decision ?? "",
        r.override?.justification ?? "",
        r.override?.decidedByName ?? "",
        r.override?.decidedAt ?? "",
      ]
        .map(escape)
        .join(","),
    );
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="algebra-placement-${report.schoolYear}.csv"`,
  );
  res.send(lines.join("\n"));
});

router.get("/algebra-placement/pdf", async (req: Request, res: Response) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const staff = await loadActingStaff(req);
  if (!staff || !canViewAlgebraPlacement(staff)) {
    res.status(403).json({ error: "Not authorized" });
    return;
  }
  const report = await buildReport(schoolId);
  const [school] = await db
    .select({ name: schoolsTable.name })
    .from(schoolsTable)
    .where(eq(schoolsTable.id, schoolId));
  const reportId = `ALG-PLACE-${report.schoolYear}`;
  const reportUrl =
    `${req.protocol}://${req.get("host")}/?section=algebra-placement`;
  const pdf = await renderAlgebraPlacementPdf({
    schoolName: school?.name ?? "School",
    schoolYear: report.schoolYear,
    reportId,
    reportUrl,
    generatedAt: new Date(),
    overrideCount: report.overrideCount,
    levelCounts: report.levelCounts,
    rows: report.rows.map((r) => ({
      studentId: r.studentId,
      localSisId: r.localSisId,
      firstName: r.firstName,
      lastName: r.lastName,
      trajectory: r.trajectory.map((t) =>
        `${t.schoolYear} ${t.level != null ? `L${t.level}` : "—"}`,
      ),
      placement: r.proposedPlacement,
      justification: r.override?.justification ?? null,
      decidedByName: r.override?.decidedByName ?? null,
      decidedAt: r.override?.decidedAt ? new Date(r.override.decidedAt) : null,
      nsoPct: r.nsoPct,
      arPct: r.arPct,
      currentLevel: r.currentLevel,
    })),
  });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="algebra-placement-${report.schoolYear}.pdf"`,
  );
  res.send(pdf);
});

router.post(
  "/algebra-placement/overrides",
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = await loadActingStaff(req);
    if (!staff || !canSaveAlgebraPlacementOverride(staff)) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }
    const {
      studentId,
      justification,
      parentOptOutConfirmed,
      optOutFileObjectKey,
    } = (req.body ?? {}) as {
      studentId?: unknown;
      justification?: unknown;
      parentOptOutConfirmed?: unknown;
      optOutFileObjectKey?: unknown;
    };
    if (typeof studentId !== "string" || !studentId.trim()) {
      res.status(400).json({ error: "studentId is required" });
      return;
    }
    if (
      typeof justification !== "string" ||
      justification.trim().length < 10 ||
      justification.length > 2000
    ) {
      res.status(400).json({
        error: "Justification must be 10–2000 characters.",
      });
      return;
    }
    if (parentOptOutConfirmed !== true) {
      res.status(400).json({
        error:
          "You must confirm that the parent opt-out conversation took place.",
      });
      return;
    }
    let boundObjectKey: string | null = null;
    if (typeof optOutFileObjectKey === "string" && optOutFileObjectKey.trim()) {
      const ok = await bindObjectToSchool(optOutFileObjectKey, schoolId);
      if (!ok) {
        res.status(403).json({
          error:
            "Opt-out file could not be bound to this school. Re-upload and try again.",
        });
        return;
      }
      boundObjectKey = optOutFileObjectKey.trim();
    }
    const schoolYear = await currentSchoolYearLabelForSchool(schoolId);
    const staffId = staff.id;
    // Verify the student really is a current 7th grader at this
    // school — prevents an admin from saving placements for someone
    // else's tenant or for a student in the wrong grade.
    const [student] = await db
      .select({ grade: studentsTable.grade })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          eq(studentsTable.studentId, studentId),
        ),
      );
    if (!student) {
      res.status(404).json({ error: "Student not found at this school." });
      return;
    }
    if (student.grade !== 7) {
      res.status(400).json({
        error:
          "Placement overrides can only be saved for current 7th graders.",
      });
      return;
    }
    const now = new Date();
    const [saved] = await db
      .insert(algebraPlacementOverridesTable)
      .values({
        schoolId,
        studentId: studentId.trim(),
        schoolYear,
        decision: "regular_8th",
        justification: justification.trim(),
        optOutFileObjectKey: boundObjectKey,
        decidedByStaffId: staffId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          algebraPlacementOverridesTable.schoolId,
          algebraPlacementOverridesTable.studentId,
          algebraPlacementOverridesTable.schoolYear,
        ],
        set: {
          decision: "regular_8th",
          justification: justification.trim(),
          optOutFileObjectKey: boundObjectKey,
          decidedByStaffId: staffId,
          updatedAt: now,
        },
      })
      .returning({ id: algebraPlacementOverridesTable.id });
    req.log.info(
      {
        schoolId,
        studentId: studentId.trim(),
        schoolYear,
        staffId,
        overrideId: saved.id,
      },
      "[algebra-placement] override saved",
    );
    res.json({ id: saved.id, ok: true });
  },
);

router.delete(
  "/algebra-placement/overrides/:id",
  async (req: Request, res: Response) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = await loadActingStaff(req);
    if (!staff || !canSaveAlgebraPlacementOverride(staff)) {
      res.status(403).json({ error: "Not authorized" });
      return;
    }
    const rawId = req.params.id;
    const id = parseInt(typeof rawId === "string" ? rawId : "", 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid override id" });
      return;
    }
    // school_id is the only data boundary — never delete cross-tenant.
    const deleted = await db
      .delete(algebraPlacementOverridesTable)
      .where(
        and(
          eq(algebraPlacementOverridesTable.id, id),
          eq(algebraPlacementOverridesTable.schoolId, schoolId),
        ),
      )
      .returning({ id: algebraPlacementOverridesTable.id });
    if (deleted.length === 0) {
      res.status(404).json({ error: "Override not found" });
      return;
    }
    req.log.info(
      { schoolId, overrideId: id },
      "[algebra-placement] override deleted",
    );
    res.json({ ok: true });
  },
);

// Silence the lint warning about unused desc import — it's kept for
// future ledger queries (per-student history of overrides).
void desc;

export default router;
