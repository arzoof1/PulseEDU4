import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  studentsTable,
  staffTable,
  classSectionsTable,
  sectionRosterTable,
  hallPassesTable,
  studentAttendanceDayTable,
  schoolSettingsTable,
} from "@workspace/db";
import { and, asc, eq, ilike, inArray, or } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { isCoreTeam } from "../lib/coreTeam.js";
import {
  loadDayTypeContext,
  variantForGrade,
  contextForVariant,
  minutesOfDayInTz,
  type DayTypeContext,
} from "../lib/scheduleResolver.js";

const router: IRouter = Router();

// "Where is this student right now?" lookup, available to every signed-in
// staff member (hall monitors, front-office, custodians, subs all need it).
// The payload is intentionally narrow: today's bell schedule + which class
// the student is in for each period (teacher, room, subject), plus a small
// "live override" layer for hall passes and absences. No academic, behavior,
// PBIS, or safety-plan data — those have their own visibility models on the
// student profile and we do not want this finder to become a side door
// around them.

// School-local clock — uses the per-school IANA timezone the schedule
// resolver carries (schools.timezone). MULTI-SCHEDULE: "what period is it"
// is now resolved per STUDENT via their grade's schedule variant; nothing
// here assumes one school-wide bell schedule.
function localToday(tz: string): string {
  // en-CA gives ISO-style YYYY-MM-DD.
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

function fmtHm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

// Current instructional period for a grade under the active Day Type, or
// null between bells / outside the school day / unconfigured.
function currentPeriodForGrade(
  ctx: DayTypeContext,
  grade: number | null | undefined,
  now: Date,
): { periodNumber: number; name: string } | null {
  const sc = contextForVariant(ctx, variantForGrade(ctx, grade), now);
  if (sc.status !== "ok" || sc.periodNumber === null || !sc.currentBlock) {
    return null;
  }
  return { periodNumber: sc.periodNumber, name: sc.currentBlock.name };
}

// Typeahead — name or student_id, school-scoped, capped at 20 results.
// Each hit is enriched with the student's CURRENT-period room +
// teacher extension so the searcher can read the answer to "where is
// this kid right now / who do I call?" without clicking through to the
// schedule. When the school has no default bell schedule configured
// (or it's outside the school day) the location fields come back null
// and the row degrades to the original name + grade + ID display.
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
      localSisId: studentsTable.localSisId,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      grade: studentsTable.grade,
      // Photo fields feed the tap-to-enlarge avatar on the finder rows.
      // Same consent-gated photo the Teacher Roster shows — no new exposure.
      photoObjectKey: studentsTable.photoObjectKey,
      photoConsent: studentsTable.photoConsent,
    })
    .from(studentsTable)
    .where(
      and(
        eq(studentsTable.schoolId, schoolId),
        or(
          // Prefix match on first or last name (and student ID). Typing
          // "joh" returns "John Smith" or "Mike Johnson" but NOT
          // "Stephanie Cohen" — substring matches anywhere in the name
          // were noisy and pulled in unrelated kids.
          ilike(studentsTable.firstName, `${q}%`),
          ilike(studentsTable.lastName, `${q}%`),
          // Match local SIS ID only — that's the 6-digit credential
          // staff know the kid by. FLEID is never visible in the UI;
          // it stays server-side for FAST + state reporting.
          ilike(studentsTable.localSisId, `${q}%`),
        ),
      ),
    )
    .orderBy(asc(studentsTable.lastName), asc(studentsTable.firstName))
    .limit(20);

  // Resolve the school's current bell-schedule period (if any) and join
  // each hit's section roster against it. We do this in two queries
  // total (one for the period, one bulk join across all 20 hits)
  // rather than per-row, to keep the typeahead snappy.
  type Enrichment = {
    currentPeriodName: string | null;
    currentRoom: string | null;
    currentTeacherName: string | null;
    currentWorkExtension: string | null;
  };
  const enrichmentByStudent = new Map<string, Enrichment>();

  if (rows.length > 0) {
    // MULTI-SCHEDULE: resolve each hit's CURRENT period through their own
    // grade's schedule variant — a 6th grader may be at lunch while an 8th
    // grader is in Period 5. One bulk section query covers the union of
    // current periods across all variants, then each row keeps only the
    // match for ITS period.
    const ctx = await loadDayTypeContext(schoolId);
    if (ctx.status === "ok") {
      const now = new Date();
      const currentByStudent = new Map<
        string,
        { periodNumber: number; name: string }
      >();
      const periodSet = new Set<number>();
      for (const r of rows) {
        const cur = currentPeriodForGrade(ctx, r.grade, now);
        if (cur) {
          currentByStudent.set(r.studentId, cur);
          periodSet.add(cur.periodNumber);
        }
      }
      if (periodSet.size > 0) {
        const ids = Array.from(currentByStudent.keys());
        const sectionRows = await db
          .select({
            studentId: sectionRosterTable.studentId,
            period: classSectionsTable.period,
            room: staffTable.defaultRoom,
            teacherName: staffTable.displayName,
            workExtension: staffTable.workExtension,
          })
          .from(sectionRosterTable)
          .innerJoin(
            classSectionsTable,
            eq(classSectionsTable.id, sectionRosterTable.sectionId),
          )
          .innerJoin(
            staffTable,
            eq(staffTable.id, classSectionsTable.teacherStaffId),
          )
          .where(
            and(
              eq(sectionRosterTable.schoolId, schoolId),
              eq(classSectionsTable.schoolId, schoolId),
              eq(staffTable.schoolId, schoolId),
              eq(classSectionsTable.isPlanning, false),
              inArray(classSectionsTable.period, Array.from(periodSet)),
              inArray(sectionRosterTable.studentId, ids),
            ),
          );
        // First-row-wins on co-teaching; the locator just needs A room.
        for (const r of sectionRows) {
          const cur = currentByStudent.get(r.studentId);
          if (!cur || cur.periodNumber !== r.period) continue;
          if (enrichmentByStudent.has(r.studentId)) continue;
          enrichmentByStudent.set(r.studentId, {
            currentPeriodName: cur.name,
            currentRoom: r.room ?? null,
            currentTeacherName: r.teacherName ?? null,
            currentWorkExtension: r.workExtension ?? null,
          });
        }
      }
    }
  }

  const students = rows.map((r) => {
    const e = enrichmentByStudent.get(r.studentId);
    return {
      ...r,
      currentPeriodName: e?.currentPeriodName ?? null,
      currentRoom: e?.currentRoom ?? null,
      currentTeacherName: e?.currentTeacherName ?? null,
      currentWorkExtension: e?.currentWorkExtension ?? null,
    };
  });

  res.json({ students });
});

// Staff typeahead — name search, school-scoped, capped at 20 results.
// Returns the columns that make it usable as a quick "where do I find this
// person / what's their extension" lookup: displayName, defaultRoom,
// workExtension, and (gated) cellPhone. Cell visibility mirrors the
// /today endpoint: caller is Core Team OR per-school toggle is on.
router.get(
  "/student-finder/staff-search",
  async (req: Request, res: Response) => {
    if (!req.staffId) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;

    const qRaw = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (qRaw.length < 1) {
      res.json({ staff: [] });
      return;
    }
    const q = qRaw.slice(0, 64);

    const [me] = await db
      .select()
      .from(staffTable)
      .where(eq(staffTable.id, req.staffId!));
    const callerIsCoreTeam = !!me && isCoreTeam(me);
    const [visibilitySettings] = await db
      .select({
        staffDirectoryShowCellPhone:
          schoolSettingsTable.staffDirectoryShowCellPhone,
      })
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId))
      .limit(1);
    const showCellPhone =
      callerIsCoreTeam ||
      Boolean(visibilitySettings?.staffDirectoryShowCellPhone);

    const rows = await db
      .select({
        id: staffTable.id,
        displayName: staffTable.displayName,
        email: staffTable.email,
        defaultRoom: staffTable.defaultRoom,
        workExtension: staffTable.workExtension,
        cellPhone: staffTable.cellPhone,
        isAdmin: staffTable.isAdmin,
        isDistrictAdmin: staffTable.isDistrictAdmin,
        isSuperUser: staffTable.isSuperUser,
        isPbisCoordinator: staffTable.isPbisCoordinator,
        isBehaviorSpecialist: staffTable.isBehaviorSpecialist,
        isMtssCoordinator: staffTable.isMtssCoordinator,
        isSchoolPsychologist: staffTable.isSchoolPsychologist,
        isCounselor: staffTable.isCounselor,
        isSocialWorker: staffTable.isSocialWorker,
        isGuidanceCounselor: staffTable.isGuidanceCounselor,
        isDean: staffTable.isDean,
        isEseCoordinator: staffTable.isEseCoordinator,
        isIssTeacher: staffTable.isIssTeacher,
      })
      .from(staffTable)
      .where(
        and(
          eq(staffTable.schoolId, schoolId),
          or(
            ilike(staffTable.displayName, `${q}%`),
            // Allow substring match on the back end of name so "Smith"
            // finds "John Smith" — staff often searched by last name.
            ilike(staffTable.displayName, `% ${q}%`),
            ilike(staffTable.email, `${q}%`),
          ),
        ),
      )
      .orderBy(asc(staffTable.displayName))
      .limit(20);

    // Derive a single human-friendly role label for display. Most staff
    // will have one role flag set; if multiple, we pick the highest-tier.
    function roleLabel(r: typeof rows[number]): string {
      if (r.isSuperUser) return "SuperUser";
      if (r.isDistrictAdmin) return "District Admin";
      if (r.isAdmin) return "Admin";
      if (r.isBehaviorSpecialist) return "Behavior Specialist";
      if (r.isMtssCoordinator) return "MTSS Coordinator";
      if (r.isSchoolPsychologist) return "School Psychologist";
      if (r.isPbisCoordinator) return "PBIS Coordinator";
      if (r.isGuidanceCounselor) return "Guidance Counselor";
      if (r.isCounselor) return "School Counselor";
      if (r.isSocialWorker) return "Social Worker";
      if (r.isEseCoordinator) return "ESE Coordinator";
      if (r.isDean) return "Dean";
      if (r.isIssTeacher) return "ISS Teacher";
      return "Teacher";
    }

    res.json({
      staff: rows.map((r) => ({
        id: r.id,
        displayName: r.displayName,
        email: r.email,
        role: roleLabel(r),
        defaultRoom: r.defaultRoom ?? null,
        workExtension: r.workExtension ?? null,
        cellPhone: showCellPhone ? (r.cellPhone ?? null) : null,
      })),
    });
  },
);

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
        // Feed the tap-to-enlarge avatar in the finder detail header —
        // same consent-gated photo as the roster.
        photoObjectKey: studentsTable.photoObjectKey,
        photoConsent: studentsTable.photoConsent,
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

    // 2. THIS STUDENT's schedule variant under the active Day Type
    // (multi-schedule aware — their grade decides the timing they follow).
    const ctx = await loadDayTypeContext(schoolId);
    const variant =
      ctx.status === "ok" ? variantForGrade(ctx, student.grade) : null;
    const bellPeriods = (variant?.blocks ?? [])
      .filter((b) => b.blockType === "period" && b.periodNumber != null)
      .map((b) => ({
        periodNumber: b.periodNumber as number,
        name: b.name,
        startTime: fmtHm(b.startMin),
        endTime: fmtHm(b.endMin),
      }))
      .sort((a, b) => a.periodNumber - b.periodNumber);

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
            workExtension: staffTable.workExtension,
            cellPhone: staffTable.cellPhone,
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

    // Cell-phone visibility on schedule rows mirrors the Staff Directory
    // gate: caller is Core Team OR the per-school toggle is on. Server
    // redacts before the response so the value never leaves the API
    // when the caller isn't entitled. We resolve this BEFORE building
    // the period payload because the period mappers below read
    // `showCellPhone` directly.
    const [me] = await db
      .select()
      .from(staffTable)
      .where(eq(staffTable.id, req.staffId!));
    const callerIsCoreTeam = !!me && isCoreTeam(me);
    const [visibilitySettings] = await db
      .select({
        staffDirectoryShowCellPhone:
          schoolSettingsTable.staffDirectoryShowCellPhone,
      })
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId))
      .limit(1);
    const showCellPhone =
      callerIsCoreTeam ||
      Boolean(visibilitySettings?.staffDirectoryShowCellPhone);

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
    const nowMin = minutesOfDayInTz(new Date(), ctx.timezone);
    const now = fmtHm(Math.floor(nowMin));
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
              workExtension: t?.workExtension ?? null,
              cellPhone: showCellPhone ? (t?.cellPhone ?? null) : null,
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
              workExtension: t?.workExtension ?? null,
              cellPhone: showCellPhone ? (t?.cellPhone ?? null) : null,
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

    // 6. Absent today (Option C). Gated behind a per-school toggle that
    // defaults OFF: most schools' attendance feed comes from the SIS on
    // a delay (not same-day), so an "Absent today" banner driven off
    // stale data would actively mis-locate a student who is on campus.
    // The query is skipped entirely when the toggle is off — both for
    // performance and to make it impossible to accidentally surface the
    // raw status anywhere downstream.
    const [settings] = await db
      .select({
        finderShowAbsentBanner: schoolSettingsTable.finderShowAbsentBanner,
      })
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId))
      .limit(1);
    const showAbsentBanner = Boolean(settings?.finderShowAbsentBanner);

    let absentToday = false;
    if (showAbsentBanner) {
      const [attendance] = await db
        .select({ status: studentAttendanceDayTable.status })
        .from(studentAttendanceDayTable)
        .where(
          and(
            eq(studentAttendanceDayTable.schoolId, schoolId),
            eq(studentAttendanceDayTable.studentId, studentIdParam),
            eq(studentAttendanceDayTable.day, localToday(ctx.timezone)),
          ),
        )
        .limit(1);
      absentToday =
        !!attendance &&
        typeof attendance.status === "string" &&
        attendance.status.toLowerCase() === "absent";
    }

    // Narrow contract: schedule + room + active hall pass + absent flag
    // only. We deliberately do NOT echo the raw attendance status string
    // (could carry tardy / partial / coded reasons that belong on the
    // attendance screens, not the locator). `absentToday` is the single
    // boolean the finder needs.
    res.json({
      student,
      today: localToday(ctx.timezone),
      now,
      scheduleName:
        ctx.status === "ok" && ctx.dayType
          ? variant && !variant.isDefault
            ? `${ctx.dayType.name} — ${variant.name}`
            : ctx.dayType.name
          : null,
      periods,
      activeHallPass: activePass ?? null,
      absentToday,
    });
  },
);

export default router;
