import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  studentsTable,
  staffTable,
  classSectionsTable,
  sectionRosterTable,
  bellSchedulesTable,
  bellSchedulePeriodsTable,
  hallPassesTable,
  studentAttendanceDayTable,
} from "@workspace/db";
import { and, asc, eq, ilike, inArray, or } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

// "Where is this student right now?" lookup, available to every signed-in
// staff member (hall monitors, front-office, custodians, subs all need it).
// The payload is intentionally narrow: today's bell schedule + which class
// the student is in for each period (teacher, room, subject), plus a small
// "live override" layer for hall passes and absences. No academic, behavior,
// PBIS, or safety-plan data — those have their own visibility models on the
// student profile and we do not want this finder to become a side door
// around them.

function localToday(): string {
  // Use the server's local timezone for "what day is it" — same convention
  // the rest of the app uses (see Gotchas in replit.md). Returns YYYY-MM-DD.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

// Typeahead — name or student_id, school-scoped, capped at 20 results.
router.get("/student-finder/search", async (req: Request, res: Response) => {
  if (!req.staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;

  const qRaw = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (qRaw.length < 1) {
    res.json({ students: [] });
    return;
  }
  const q = qRaw.slice(0, 64);

  const rows = await db
    .select({
      studentId: studentsTable.studentId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        or(
          ilike(studentsTable.firstName, `%${q}%`),
          ilike(studentsTable.lastName, `%${q}%`),
          ilike(studentsTable.studentId, `%${q}%`),
        ),
      ),
    )
    .orderBy(asc(studentsTable.lastName), asc(studentsTable.firstName))
    .limit(20);

  res.json({ students: rows });
});

// "Today" payload — bell schedule, the student's class per period, plus the
// live overrides (active hall pass, absent flag).
router.get(
  "/student-finder/:studentId/today",
  async (req: Request, res: Response) => {
    if (!req.staffId) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;

    const studentIdParam = String(req.params.studentId ?? "").trim();
    if (!studentIdParam) {
      res.status(400).json({ error: "studentId required" });
      return;
    }

    // 1. Student row (school-scoped — student_id is not globally unique)
    const [student] = await db
      .select({
        studentId: studentsTable.studentId,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        grade: studentsTable.grade,
      })
      .from(studentsTable)
      .where(
        and(
          eq(studentsTable.schoolId, schoolId),
          eq(studentsTable.studentId, studentIdParam),
        ),
      );
    if (!student) {
      res.status(404).json({ error: "Student not found" });
      return;
    }

    // 2. Default bell schedule for the school + its periods.
    const [schedule] = await db
      .select()
      .from(bellSchedulesTable)
      .where(
        and(
          eq(bellSchedulesTable.schoolId, schoolId),
          eq(bellSchedulesTable.isDefault, true),
          eq(bellSchedulesTable.active, true),
        ),
      );

    const bellPeriods = schedule
      ? await db
          .select()
          .from(bellSchedulePeriodsTable)
          .where(eq(bellSchedulePeriodsTable.scheduleId, schedule.id))
          .orderBy(asc(bellSchedulePeriodsTable.periodNumber))
      : [];

    // 3. Sections this student is rostered into, with teacher info.
    const sectionRows = await db
      .select({
        period: classSectionsTable.period,
        courseName: classSectionsTable.courseName,
        isPlanning: classSectionsTable.isPlanning,
        teacherStaffId: classSectionsTable.teacherStaffId,
      })
      .from(sectionRosterTable)
      .innerJoin(
        classSectionsTable,
        eq(classSectionsTable.id, sectionRosterTable.sectionId),
      )
      .where(
        and(
          // Defense-in-depth: scope BOTH joined tables by schoolId. The
          // section_roster filter alone would suffice in a healthy DB,
          // but if section_roster ever points at a class_section row in
          // another school (data-integrity glitch, bad import, race
          // during a school move), the join would silently leak that
          // section's metadata. Keep this check redundant on purpose.
          eq(sectionRosterTable.schoolId, schoolId),
          eq(classSectionsTable.schoolId, schoolId),
          eq(sectionRosterTable.studentId, studentIdParam),
          eq(classSectionsTable.isPlanning, false),
        ),
      );

    const teacherIds = Array.from(
      new Set(sectionRows.map((r) => r.teacherStaffId)),
    );
    const teachers = teacherIds.length
      ? await db
          .select({
            id: staffTable.id,
            displayName: staffTable.displayName,
            defaultRoom: staffTable.defaultRoom,
          })
          .from(staffTable)
          .where(
            and(
              eq(staffTable.schoolId, schoolId),
              inArray(staffTable.id, teacherIds),
            ),
          )
      : [];
    const teacherById = new Map(teachers.map((t) => [t.id, t]));

    // Group sections by period — co-teaching / schedule glitches can yield
    // more than one row; we surface them all rather than silently picking
    // one, since the whole point of this screen is helping a hall monitor
    // physically locate the student.
    const sectionsByPeriod = new Map<number, typeof sectionRows>();
    for (const r of sectionRows) {
      const list = sectionsByPeriod.get(r.period) ?? [];
      list.push(r);
      sectionsByPeriod.set(r.period, list);
    }

    // 4. Build the per-period rows. Drive off the bell schedule when we
    // have one (so the user sees every period of the day, including ones
    // the student has no class for — those render as "No scheduled
    // class" rather than being hidden, per the no-muting requirement).
    // If the school has no default bell schedule, fall back to just the
    // periods the student is rostered into.
    const now = nowHHMM();
    interface PeriodOut {
      periodNumber: number;
      periodName: string;
      startTime: string | null;
      endTime: string | null;
      isCurrent: boolean;
      classes: Array<{
        courseName: string;
        teacherName: string;
        room: string | null;
      }>;
    }
    const periods: PeriodOut[] = [];

    if (bellPeriods.length > 0) {
      for (const bp of bellPeriods) {
        const isCurrent = now >= bp.startTime && now < bp.endTime;
        const sections = sectionsByPeriod.get(bp.periodNumber) ?? [];
        periods.push({
          periodNumber: bp.periodNumber,
          periodName: bp.name,
          startTime: bp.startTime,
          endTime: bp.endTime,
          isCurrent,
          classes: sections.map((s) => {
            const t = teacherById.get(s.teacherStaffId);
            return {
              courseName: s.courseName,
              teacherName: t?.displayName ?? "(unknown teacher)",
              room: t?.defaultRoom ?? null,
            };
          }),
        });
      }
    } else {
      // No bell schedule configured — surface only the periods the student
      // attends. No times, no current-period highlight (we have nothing to
      // compare against).
      const periodNumbers = Array.from(sectionsByPeriod.keys()).sort(
        (a, b) => a - b,
      );
      for (const pn of periodNumbers) {
        const sections = sectionsByPeriod.get(pn) ?? [];
        periods.push({
          periodNumber: pn,
          periodName: `Period ${pn}`,
          startTime: null,
          endTime: null,
          isCurrent: false,
          classes: sections.map((s) => {
            const t = teacherById.get(s.teacherStaffId);
            return {
              courseName: s.courseName,
              teacherName: t?.displayName ?? "(unknown teacher)",
              room: t?.defaultRoom ?? null,
            };
          }),
        });
      }
    }

    // 5. Live override: active hall pass (Option A). When present this is
    // almost always more accurate than the bell schedule — the student is
    // physically in the destination, not the scheduled classroom.
    const [activePass] = await db
      .select({
        id: hallPassesTable.id,
        destination: hallPassesTable.destination,
        originRoom: hallPassesTable.originRoom,
        teacherName: hallPassesTable.teacherName,
        createdAt: hallPassesTable.createdAt,
        maxDurationMinutes: hallPassesTable.maxDurationMinutes,
      })
      .from(hallPassesTable)
      .where(
        and(
          eq(hallPassesTable.schoolId, schoolId),
          eq(hallPassesTable.studentId, studentIdParam),
          eq(hallPassesTable.status, "active"),
        ),
      )
      .limit(1);

    // 6. Absent today (Option C).
    const [attendance] = await db
      .select({ status: studentAttendanceDayTable.status })
      .from(studentAttendanceDayTable)
      .where(
        and(
          eq(studentAttendanceDayTable.schoolId, schoolId),
          eq(studentAttendanceDayTable.studentId, studentIdParam),
          eq(studentAttendanceDayTable.day, localToday()),
        ),
      )
      .limit(1);

    const absentToday =
      !!attendance &&
      typeof attendance.status === "string" &&
      attendance.status.toLowerCase() === "absent";

    // Narrow contract: schedule + room + active hall pass + absent flag
    // only. We deliberately do NOT echo the raw attendance status string
    // (could carry tardy / partial / coded reasons that belong on the
    // attendance screens, not the locator). `absentToday` is the single
    // boolean the finder needs.
    res.json({
      student,
      today: localToday(),
      now,
      scheduleName: schedule?.name ?? null,
      periods,
      activeHallPass: activePass ?? null,
      absentToday,
    });
  },
);

export default router;
