import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  studentsTable,
  staffTable,
  classSectionsTable,
  sectionRosterTable,
} from "@workspace/db";
import { eq, and, or, ilike } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { getVisibleStudentIds } from "./insights.js";
import {
  placePmSet,
  placeOnChart,
  type Placement,
  type Subject,
} from "../lib/fastCutScores.js";
import { decideLearningGain } from "../lib/learningGains.js";
import {
  loadFastFullHistory,
  resolveCurrentFastYear,
} from "../lib/fastHistory.js";

const router: IRouter = Router();

// Inline requireStaff — matches the self-contained pattern every route file
// in this codebase follows (students.ts / pickup.ts / interventions.ts).
async function requireStaff(req: Request, res: Response, next: NextFunction) {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Staff not found or inactive" });
    return;
  }
  (req as Request & { staff: typeof staffTable.$inferSelect }).staff = staff;
  next();
}

// ---------------------------------------------------------------------------
// GET /api/student-lookup/search?q=
//
// Typeahead for the Student Lookup sidebar surface. Visibility-scoped via the
// SAME resolver the Student Profile endpoint uses (getVisibleStudentIds) so a
// teacher only ever finds their own roster (+ trusted-adult) students while
// core team / admin / counselor find anyone in the school. Returning exactly
// the openable set avoids the "found but can't open" mismatch.
//
// NO FLEID forward-facing: the canonical studentId is returned only as the
// join key the client passes back to the (already-gated) profile endpoint; the
// human-readable id rendered in results is localSisId.
// ---------------------------------------------------------------------------
router.get("/student-lookup/search", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;
  const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
    .staff;

  const qRaw = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const q = qRaw.slice(0, 64);

  const visibility = await getVisibleStudentIds(staff, schoolId);
  // A non-core-team member with an empty visible set can never match — short
  // circuit so we don't run a school-wide query and then filter to nothing.
  if (!visibility.full && visibility.ids.size === 0) {
    res.json({ students: [] });
    return;
  }

  const where = q
    ? and(
        eq(studentsTable.schoolId, schoolId),
        or(
          ilike(studentsTable.firstName, `${q}%`),
          ilike(studentsTable.lastName, `${q}%`),
          ilike(studentsTable.localSisId, `${q}%`),
        ),
      )
    : eq(studentsTable.schoolId, schoolId);

  const rows = await db
    .select({
      studentId: studentsTable.studentId,
      localSisId: studentsTable.localSisId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
    })
    .from(studentsTable)
    .where(where)
    .orderBy(studentsTable.lastName, studentsTable.firstName);

  const scoped = visibility.full
    ? rows
    : rows.filter((r) => visibility.ids.has(r.studentId));
  // Cap the payload — a blank query from a core-team member would otherwise
  // return the whole school; the UI is a picker, not a roster export.
  res.json({ students: scoped.slice(0, 50) });
});

// ---------------------------------------------------------------------------
// GET /api/student-lookup/:studentId/schedule
//
// Per-student class/period schedule (course + teacher per period) for the
// "View schedule" affordance on the Student Profile. Visibility-scoped via
// the SAME resolver as the rest of this router (getVisibleStudentIds) so a
// teacher can only see the schedule of a student they can already open.
//
// student_id is NOT globally unique across schools — both section_roster and
// class_sections are AND-filtered by schoolId so a sister school's section
// can never surface. Planning periods are excluded. Ordered by period.
// ---------------------------------------------------------------------------
router.get(
  "/student-lookup/:studentId/schedule",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
      .staff;
    const studentId = String(req.params.studentId ?? "").trim();
    if (!studentId) {
      res.status(400).json({ error: "studentId required" });
      return;
    }

    // Visibility check FIRST — never leak the existence of an out-of-scope
    // student (mirror the profile + heartbeat-note endpoints).
    const visibility = await getVisibleStudentIds(staff, schoolId);
    if (!visibility.full && !visibility.ids.has(studentId)) {
      res
        .status(403)
        .json({ error: "Not in your roster or trusted-adult list" });
      return;
    }

    const rows = await db
      .select({
        period: classSectionsTable.period,
        courseName: classSectionsTable.courseName,
        teacherName: staffTable.displayName,
      })
      .from(sectionRosterTable)
      .innerJoin(
        classSectionsTable,
        eq(sectionRosterTable.sectionId, classSectionsTable.id),
      )
      .innerJoin(
        staffTable,
        eq(staffTable.id, classSectionsTable.teacherStaffId),
      )
      .where(
        and(
          eq(sectionRosterTable.schoolId, schoolId),
          eq(classSectionsTable.schoolId, schoolId),
          eq(sectionRosterTable.studentId, studentId),
          eq(classSectionsTable.isPlanning, false),
        ),
      )
      .orderBy(classSectionsTable.period);

    res.json({
      schedule: rows.map((r) => ({
        period: r.period,
        courseName: r.courseName,
        teacherName: r.teacherName ?? "",
      })),
    });
  },
);

// ---------------------------------------------------------------------------
// GET /api/student-lookup/:studentId/heartbeat-note
//
// Visibility-scoped read of the current note. We deliberately DON'T reuse
// GET /api/students/:id here — that endpoint is only school-scoped, which
// would let a teacher read an out-of-roster student's note by guessing the
// id. This path gates on the same getVisibleStudentIds set as the snapshot.
// ---------------------------------------------------------------------------
router.get(
  "/student-lookup/:studentId/heartbeat-note",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
      .staff;
    const studentId = String(req.params.studentId ?? "").trim();
    if (!studentId) {
      res.status(400).json({ error: "studentId required" });
      return;
    }

    // Visibility check FIRST — never leak the existence of an out-of-scope
    // student (mirror the profile endpoint's behaviour).
    const visibility = await getVisibleStudentIds(staff, schoolId);
    if (!visibility.full && !visibility.ids.has(studentId)) {
      res
        .status(403)
        .json({ error: "Not in your roster or trusted-adult list" });
      return;
    }

    const [row] = await db
      .select({
        heartbeatNote: studentsTable.heartbeatNote,
        heartbeatNoteUpdatedAt: studentsTable.heartbeatNoteUpdatedAt,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.studentId, studentId),
          eq(studentsTable.schoolId, schoolId),
        ),
      );
    if (!row) {
      res.status(404).json({ error: "Student not found in this school" });
      return;
    }
    res.json({
      message: row.heartbeatNote ?? "",
      updatedAt: row.heartbeatNoteUpdatedAt ?? null,
    });
  },
);

// ---------------------------------------------------------------------------
// PUT /api/student-lookup/:studentId/heartbeat-note
//
// The ONE editable field on the otherwise read-only Student Snapshot: a short
// parent-facing note that surfaces on the student's weekly Friday HeartBEAT
// (PDF + email). Edit is visibility-scoped (a teacher can only write notes for
// students they can see). Empty/whitespace clears the note. Stamps who/when.
// ---------------------------------------------------------------------------
const MAX_NOTE_LEN = 1000;
router.put(
  "/student-lookup/:studentId/heartbeat-note",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
      .staff;
    const studentId = String(req.params.studentId ?? "").trim();
    if (!studentId) {
      res.status(400).json({ error: "studentId required" });
      return;
    }

    const rawMessage =
      typeof req.body?.message === "string" ? req.body.message : "";
    const trimmed = rawMessage.trim();
    if (trimmed.length > MAX_NOTE_LEN) {
      res
        .status(400)
        .json({ error: `Message must be ${MAX_NOTE_LEN} characters or fewer.` });
      return;
    }

    // Visibility check FIRST — never leak the existence of an out-of-scope
    // student, and never let a teacher write to one.
    const visibility = await getVisibleStudentIds(staff, schoolId);
    if (!visibility.full && !visibility.ids.has(studentId)) {
      res
        .status(403)
        .json({ error: "Not in your roster or trusted-adult list" });
      return;
    }

    const value = trimmed.length === 0 ? null : trimmed;
    const nowIso = new Date().toISOString();
    const updated = await db
      .update(studentsTable)
      .set({
        heartbeatNote: value,
        heartbeatNoteUpdatedBy: value === null ? null : staff.id,
        heartbeatNoteUpdatedAt: value === null ? null : nowIso,
      })
      .where(
        and(
          eq(studentsTable.studentId, studentId),
          eq(studentsTable.schoolId, schoolId),
        ),
      )
      .returning({
        heartbeatNote: studentsTable.heartbeatNote,
        heartbeatNoteUpdatedAt: studentsTable.heartbeatNoteUpdatedAt,
      });

    if (updated.length === 0) {
      res.status(404).json({ error: "Student not found in this school" });
      return;
    }
    res.json({
      message: updated[0].heartbeatNote,
      updatedAt: updated[0].heartbeatNoteUpdatedAt,
      updatedByName: staff.displayName ?? null,
    });
  },
);

// ---------------------------------------------------------------------------
// GET /api/student-lookup/:studentId/fast-history
//
// Multi-year FAST table for one student: the CURRENT year as the top anchor
// row plus every seeded/imported historical year (PM1/PM2/PM3), placed on the
// grade the student was in THAT year. Powers the Teacher Roster "PM3 history"
// book-icon drawer. Not surfaced in the parent portal or HeartBEAT.
//
// Gates, in order: requireStaff → same getVisibleStudentIds visibility set as
// the rest of this router. A classroom teacher is therefore limited to their
// own roster + trusted-adult set; admins / Core Team get the school-wide set.
// FLEID is never returned — the only student id echoed is localSisId.
// ---------------------------------------------------------------------------
type PillPlacement = {
  score: number;
  level: Placement["level"];
  subLevel: Placement["subLevel"];
} | null;

function pill(score: number | null, placement: Placement | null): PillPlacement {
  if (score == null || placement == null) return null;
  return { score, level: placement.level, subLevel: placement.subLevel };
}

router.get(
  "/student-lookup/:studentId/fast-history",
  requireStaff,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (schoolId == null) return;
    const staff = (req as Request & { staff: typeof staffTable.$inferSelect })
      .staff;

    // No role/capability gate: any staff member may view FAST history for a
    // student they can already see. The roster-visibility check below
    // (getVisibleStudentIds) is the security boundary — a classroom teacher is
    // limited to their own roster + trusted-adult set, admins / Core Team get
    // the school-wide set. This powers the Teacher Roster "PM3 history" drawer.
    const studentId = String(req.params.studentId ?? "").trim();
    if (!studentId) {
      res.status(400).json({ error: "studentId required" });
      return;
    }

    // Visibility check — never leak an out-of-scope student's existence.
    const visibility = await getVisibleStudentIds(staff, schoolId);
    if (!visibility.full && !visibility.ids.has(studentId)) {
      res
        .status(403)
        .json({ error: "Not in your roster or trusted-adult list" });
      return;
    }

    const [student] = await db
      .select({
        grade: studentsTable.grade,
        localSisId: studentsTable.localSisId,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.studentId, studentId),
          eq(studentsTable.schoolId, schoolId),
        ),
      );
    if (!student) {
      res.status(404).json({ error: "Student not found in this school" });
      return;
    }

    // Anchor on the DATA's current year (newest non-historical row), not the
    // wall clock — frozen demo datasets drift past the July boundary and a
    // wall-clock "current" would drop the real current-year anchor row and
    // shift grade-in-year math by a year.
    const currentSchoolYear = await resolveCurrentFastYear(schoolId);
    const curYY = Number(/^(\d{2})-/.exec(currentSchoolYear)?.[1] ?? "");
    const currentGrade = Number(student.grade);

    const rows = await loadFastFullHistory({
      schoolId,
      studentId,
      subjects: ["ela", "math"],
      currentSchoolYear,
    });

    // Grade the student was in during a given school year. Derived from the
    // current grade minus how many years back the row is. null when we can't
    // resolve it (bad label / non-numeric grade) — the pill just renders
    // neutral in that case.
    const gradeInYearFor = (schoolYear: string): number | null => {
      if (!Number.isInteger(currentGrade)) return null;
      const rowYY = Number(/^(\d{2})-/.exec(schoolYear)?.[1] ?? "");
      if (!Number.isFinite(curYY) || !Number.isFinite(rowYY)) return null;
      return currentGrade - (curYY - rowYY);
    };

    const bySubject = new Map<
      string,
      {
        subject: string;
        rows: Array<{
          schoolYear: string;
          gradeInYear: number | null;
          isCurrent: boolean;
          pm1: PillPlacement;
          pm2: PillPlacement;
          pm3: PillPlacement;
          withinYearGrowth: number | null;
          learningGain: boolean | null;
        }>;
      }
    >();

    for (const r of rows) {
      const subject = r.subject as Subject;
      const gradeInYear = gradeInYearFor(r.schoolYear);
      // Display placements — single-sourced via placePmSet so these pills
      // match the Teacher Roster / Insights conventions exactly (PM1/PM2 on
      // the in-year grade chart, PM3 on the prior-grade chart per FAST).
      const placed =
        gradeInYear != null
          ? placePmSet(subject, gradeInYear, {
              priorYearScore: null,
              pm1: r.pm1,
              pm2: r.pm2,
              pm3: r.pm3,
            })
          : { pm1: null, pm2: null, pm3: null, priorYearScore: null };

      // Within-year growth: latest populated PM minus PM1, same grade + same
      // scale → a VALID scale-score delta (unlike cross-grade/cross-year).
      const latest = r.pm3 ?? r.pm2;
      const withinYearGrowth =
        r.pm1 != null && latest != null ? latest - r.pm1 : null;

      // Per-year learning-gain flag. Both PM1 and PM3 are the SAME year and
      // grade, so place BOTH on that in-year chart (placeOnChart) for a truly
      // comparable decideLearningGain call — do NOT use the prior-grade PM3
      // placement here (that convention is for cross-year roster semantics).
      let learningGain: boolean | null = null;
      if (gradeInYear != null && r.pm1 != null && r.pm3 != null) {
        const p1 = placeOnChart(r.pm1, subject, gradeInYear);
        const p3 = placeOnChart(r.pm3, subject, gradeInYear);
        learningGain = decideLearningGain({
          priorLevel: p1?.level ?? null,
          currentLevel: p3?.level ?? null,
          priorScore: r.pm1,
          currentScore: r.pm3,
          priorSubLevel: p1?.subLevel ?? null,
          currentSubLevel: p3?.subLevel ?? null,
        });
      }

      let entry = bySubject.get(r.subject);
      if (!entry) {
        entry = { subject: r.subject, rows: [] };
        bySubject.set(r.subject, entry);
      }
      entry.rows.push({
        schoolYear: r.schoolYear,
        gradeInYear,
        isCurrent: r.isCurrent,
        pm1: pill(r.pm1, placed.pm1),
        pm2: pill(r.pm2, placed.pm2),
        pm3: pill(r.pm3, placed.pm3),
        withinYearGrowth,
        learningGain,
      });
    }

    // Stable subject order (ELA then Math), rows already newest-first.
    const order = ["ela", "math"];
    const subjects = [...bySubject.values()].sort(
      (a, b) => order.indexOf(a.subject) - order.indexOf(b.subject),
    );

    res.json({
      localSisId: student.localSisId ?? null,
      currentGrade: Number.isInteger(currentGrade) ? currentGrade : null,
      currentSchoolYear,
      subjects,
    });
  },
);

export default router;
