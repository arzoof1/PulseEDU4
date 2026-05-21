/* eslint-disable no-console */
// =============================================================================
// parrottRebuild — clean rebuild of Parrott Middle (school_id=1) operational
// data, keyed off the FAST roster as truth-set. One-shot, single transaction.
//
// Reusable as the template for future ClassLink onboarding.
//
// PRESERVES:
//  - students + FAST scores/items + accommodations library
//  - schools, houses, bell schedules, branding, settings, feature plans
//  - districts, parents (login accounts)
//  - privileged staff (SuperUser, DistrictAdmin, Admin, any Preview persona)
//  - integration metadata, audit logs, library catalogs
//
// WIPES + REBUILDS for school_id=1:
//  - all operational behavior data (cases, interactions, hall passes, etc.)
//  - master schedule (class_sections + section_roster)
//  - non-privileged staff (renamed + reassigned in-place if already exist)
//
// Locked design choices (see session_plan.md):
//  - 7 periods. Period 5 = lunch (no class for anyone — no section row at P5).
//  - Each student: 4 cores (ELA, Math, Science, Social Studies) + 2 electives
//    + lunch = 6 enrollments across periods {1,2,3,4,6,7}.
//  - Electives pool: Art, PE, Technology, Music, Digital Media.
//  - 25 students per section hard cap.
//  - Each teacher: 5 teaching periods + 1 planning + 1 lunch. Planning
//    periods are distributed evenly across {1,2,3,4,6,7} so we never
//    under-supply any single period.
//  - Collision-free by construction (student fills one period at a time).
// =============================================================================

import {
  classSectionsTable,
  db,
  hallPassesTable,
  housesTable,
  interactionCasesTable,
  pbisEntriesTable,
  safetyPlansTable,
  sectionRosterTable,
  staffTable,
  studentAccommodationsTable,
  studentAttendanceDayTable,
  studentMtssPlansTable,
  studentPickupAuthorizationsTable,
  studentsTable,
  tardiesTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";

const SCHOOL_ID = 1;
const SECTION_CAP = 25;
const LUNCH_PERIOD = 5;
const ACADEMIC_PERIODS = [1, 2, 3, 4, 6, 7] as const;

const CORE_SUBJECTS = ["ELA", "Math", "Science", "Social Studies"] as const;
const ELECTIVES = ["Art", "PE", "Technology", "Music", "Digital Media"] as const;

type CoreSubject = (typeof CORE_SUBJECTS)[number];
type Elective = (typeof ELECTIVES)[number];

// Idempotent suffix pattern on staff displayName.
const SUBJECT_SUFFIX_RE =
  /\s+-\s+(ELA|Math|Science|Social Studies|Art|PE|Technology|Music|Digital Media)(\s+G[6-8])?$/;

// Deterministic RNG so re-runs produce the same shape.
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

// Tables to wipe via straight DELETE WHERE school_id=$1. Order is dependency-
// safe even without FK CASCADE (children before parents). Tables that don't
// exist in this DB instance are skipped silently — keeps the rebuild robust
// across schema-drift environments.
const WIPE_TABLES = [
  // case-evidence + consistency (children of interaction_cases)
  "case_video_evidence_players",
  "case_video_evidence",
  "case_footage_requests",
  "case_consistency_findings",
  "case_consistency_runs",
  "case_consistency_state",
  "case_mentions",
  // interactions + cases
  "interaction_audit_log",
  "interaction_alert_dismissals",
  "interaction_case_player_impact",
  "interaction_case_notes",
  "interaction_participants",
  "interaction_cases",
  "interaction_quick_entries",
  "interactions",
  "witness_statements",
  // MTSS
  "tier3_weekly_records",
  "tier3_goals",
  "tier3_strategy_usage",
  "student_mtss_plans",
  "mtss_fast_suggestion_dismissals",
  "intervention_entries",
  "tier2_intervention_entries",
  // staff bookkeeping (ledgers + requests live per-school, wipe so the
  // repurposed teachers start with empty AST/comp banks)
  "staff_ast_requests",
  "staff_ast_ledger",
  "staff_comp_requests",
  "staff_comp_ledger",
  // pickup
  "student_pickup_authorizations",
  "pickup_queue_events",
  "badge_print_events",
  // hall passes + kiosks
  "hall_passes",
  "hall_pass_queue",
  "class_signins",
  "kiosk_viewer_tokens",
  "kiosk_enroll_tokens",
  "kiosk_activations",
  // ISS / OSS
  "iss_assignment_acknowledgements",
  "iss_attendance_day",
  "iss_roster",
  "iss_admin_log_audit",
  "iss_admin_logs",
  "oss_log_days",
  "oss_logs",
  // pullouts
  "pullouts",
  // accommodations (per-student assignments only — library preserved)
  "accommodation_logs",
  "student_accommodations",
  // PBIS
  "pbis_milestone_emails",
  "pbis_milestones",
  "pbis_entries",
  "pbis_goals",
  "pbis_note_templates",
  "spotlight_history",
  "student_house_sort_jobs",
  "student_house_changes",
  // safety plans
  "safety_plan_audit",
  "safety_plans",
  "student_trusted_adults",
  // parent / contact
  "parent_invites",
  "student_emergency_contacts",
  // watchlists + per-student limits
  "teacher_watchlist_entries",
  "teacher_watchlist_groups",
  "student_hall_pass_limits",
  // attendance + retention
  "tardies",
  "student_attendance_day",
  "student_separations",
  "student_retentions",
  "support_notes",
  // benchmarks + stores
  "benchmark_deliveries",
  "classroom_store_items",
  "school_store_items",
  // schedule
  "section_roster",
  "class_sections",
  // location bookings (rooms remain so we don't break global unique name)
  "location_allowed_destinations",
  "teacher_destination_allowlist",
  // import history (so the FAST import job rows don't dangle)
  "student_import_snapshots",
];

// tx is a Drizzle transaction; we keep the type loose because the
// transaction generic surface from drizzle-orm isn't worth threading here.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function tableExists(tx: Tx, name: string): Promise<boolean> {
  const r = await tx.execute(
    sql`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=${name}`,
  );
  return (r.rowCount ?? 0) > 0;
}

async function wipeOperationalData(tx: Tx, log: string[]): Promise<void> {
  for (const t of WIPE_TABLES) {
    if (!(await tableExists(tx, t))) continue;
    const r = await tx.execute(
      sql.raw(`DELETE FROM ${t} WHERE school_id = ${SCHOOL_ID}`),
    );
    if (r.rowCount && r.rowCount > 0) {
      log.push(`wipe ${t}: ${r.rowCount}`);
    }
  }
}

// ----- Staff plan ----------------------------------------------------------

type CoreTeacherPlan = {
  staffId: number;
  subject: CoreSubject;
  grade: 6 | 7 | 8;
  planningPeriod: number; // one of ACADEMIC_PERIODS
  teachingPeriods: number[]; // ACADEMIC_PERIODS minus planning
};
type ElectiveTeacherPlan = {
  staffId: number;
  elective: Elective;
  planningPeriod: number;
  teachingPeriods: number[];
};

// Build the required teacher pool given student counts. Each teacher will
// teach 5 sections (one period off for planning, plus lunch at P5).
//
// Allocation:
//   - For each (core_subject, grade), need ceil(students_in_grade / 25)
//     sections. We bundle sections of one subject+grade onto the FEWEST
//     teachers possible: ceil(sectionsNeeded / 5).
//   - For each elective, students_total * 2 / 5 ÷ ... we split evenly across
//     the 5 electives, then split each elective's sections across teachers.
function planTeacherCounts(g6: number, g7: number, g8: number): {
  core: Array<{ subject: CoreSubject; grade: 6 | 7 | 8; sections: number; teachers: number }>;
  electives: Array<{ elective: Elective; sections: number; teachers: number }>;
} {
  const core = CORE_SUBJECTS.flatMap((subject) =>
    ([
      [6, g6],
      [7, g7],
      [8, g8],
    ] as Array<[6 | 7 | 8, number]>).map(([grade, n]) => {
      const sections = Math.ceil(n / SECTION_CAP);
      const teachers = Math.max(1, Math.ceil(sections / 5));
      return { subject, grade, sections, teachers };
    }),
  );
  // Each student picks 2 electives. Total elective enrollments = 2*total.
  // Spread evenly across 5 electives, then ceil to sections of 25.
  const totalStudents = g6 + g7 + g8;
  const perElective = Math.ceil((totalStudents * 2) / ELECTIVES.length);
  const electives = ELECTIVES.map((elective) => {
    const sections = Math.ceil(perElective / SECTION_CAP);
    const teachers = Math.max(1, Math.ceil(sections / 5));
    return { elective, sections, teachers };
  });
  return { core, electives };
}

// Distribute N planning periods across the 6 academic periods as evenly as
// possible (round-robin). Returns an array of length N with values in
// ACADEMIC_PERIODS.
function distributePlanning(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(ACADEMIC_PERIODS[i % ACADEMIC_PERIODS.length]!);
  }
  return out;
}

// Pretty-name pool. ~50 mixed first + last names so the synthesized
// teacher roster looks like a real US middle-school faculty.
const FIRST_NAMES = [
  "Sarah", "Michael", "Linda", "James", "Patricia", "Robert", "Jennifer",
  "David", "Maria", "Daniel", "Karen", "Mark", "Lisa", "Steven", "Nancy",
  "Paul", "Susan", "Kevin", "Donna", "Brian", "Carol", "Thomas", "Sharon",
  "Charles", "Cynthia", "Joseph", "Kathleen", "Christopher", "Amy", "Matthew",
  "Shirley", "Andrew", "Angela", "Joshua", "Helen", "Kenneth", "Anna",
  "George", "Brenda", "Edward", "Pamela", "Ronald", "Nicole", "Anthony",
  "Samantha", "Jason", "Katherine", "Eric", "Christine", "Stephen", "Debra",
  "Jonathan", "Rachel", "Larry", "Catherine", "Justin", "Carolyn", "Scott",
];
const LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller",
  "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Wilson",
  "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee",
  "Perez", "Thompson", "White", "Harris", "Sanchez", "Clark", "Ramirez",
  "Lewis", "Robinson", "Walker", "Young", "Allen", "King", "Wright",
  "Scott", "Torres", "Nguyen", "Hill", "Flores", "Green", "Adams", "Nelson",
  "Baker", "Hall", "Rivera", "Campbell", "Mitchell", "Carter", "Roberts",
];

function makeNamePool(rng: () => number, count: number): string[] {
  const names = new Set<string>();
  let guard = 0;
  while (names.size < count && guard++ < count * 20) {
    const f = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)]!;
    const l = LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)]!;
    names.add(`${f} ${l}`);
  }
  return Array.from(names);
}

// Map subject → default room kind. Cores use sequential "Parrott Room NNN";
// electives use named specialty rooms.
function defaultRoomFor(
  spec: { kind: "core"; subject: CoreSubject; grade: 6 | 7 | 8 } | { kind: "elective"; elective: Elective },
  idx: number,
): string {
  if (spec.kind === "elective") {
    switch (spec.elective) {
      case "Art":
        return `Parrott Art Room ${idx + 1}`;
      case "PE":
        return idx === 0 ? "Parrott Gym" : `Parrott Gym ${idx + 1}`;
      case "Music":
        return `Parrott Music Room ${idx + 1}`;
      case "Technology":
        return `Parrott Tech Lab ${idx + 1}`;
      case "Digital Media":
        return `Parrott Media Lab ${idx + 1}`;
    }
  }
  // Cores: rooms numbered per grade floor. G6 = 100s, G7 = 200s, G8 = 300s.
  const floor = spec.grade === 6 ? 100 : spec.grade === 7 ? 200 : 300;
  return `Parrott Room ${floor + idx + 1}`;
}

// Sequential work extension. 4-digit, leading digit by grade floor.
function defaultExtensionFor(grade: 6 | 7 | 8 | null, idx: number): string {
  const floor = grade === 6 ? 2000 : grade === 7 ? 3000 : grade === 8 ? 4000 : 5000;
  return String(floor + idx + 1);
}

// =============================================================================
// Main entry
// =============================================================================
export async function rebuildParrott(): Promise<{
  ok: true;
  log: string[];
  summary: Record<string, number>;
}> {
  const log: string[] = [];

  return await db.transaction(async (tx) => {
    // ---------- Audit + truth-set ----------
    const [{ n: studentCount }] = (await tx.execute(
      sql`SELECT COUNT(*)::int AS n FROM students WHERE school_id = ${SCHOOL_ID}`,
    )).rows as Array<{ n: number }>;
    if (studentCount < 200) {
      throw new Error(
        `Refusing to rebuild — only ${studentCount} students at school_id=${SCHOOL_ID}.`,
      );
    }
    const [{ g6 }] = (await tx.execute(
      sql`SELECT COUNT(*)::int AS g6 FROM students WHERE school_id=${SCHOOL_ID} AND grade=6`,
    )).rows as Array<{ g6: number }>;
    const [{ g7 }] = (await tx.execute(
      sql`SELECT COUNT(*)::int AS g7 FROM students WHERE school_id=${SCHOOL_ID} AND grade=7`,
    )).rows as Array<{ g7: number }>;
    const [{ g8 }] = (await tx.execute(
      sql`SELECT COUNT(*)::int AS g8 FROM students WHERE school_id=${SCHOOL_ID} AND grade=8`,
    )).rows as Array<{ g8: number }>;
    log.push(`audit: students=${studentCount} g6=${g6} g7=${g7} g8=${g8}`);

    // ---------- Wipe ----------
    await wipeOperationalData(tx, log);

    // ---------- Identify privileged staff to PRESERVE as-is ----------
    // Anything with SuperUser, DistrictAdmin, Admin, or Counselor flags,
    // plus any email at @pulseedu.test (the Preview persona accounts).
    // These keep their existing displayName and won't get subject suffixes.
    const privilegedRows = await tx
      .select({
        id: staffTable.id,
        email: staffTable.email,
        displayName: staffTable.displayName,
      })
      .from(staffTable)
      .where(
        and(
          eq(staffTable.schoolId, SCHOOL_ID),
          sql`(
            ${staffTable.isSuperUser} = true OR
            ${staffTable.isDistrictAdmin} = true OR
            ${staffTable.isAdmin} = true OR
            ${staffTable.isCounselor} = true OR
            ${staffTable.isGuidanceCounselor} = true OR
            ${staffTable.isMtssCoordinator} = true OR
            ${staffTable.isPbisCoordinator} = true OR
            ${staffTable.isBehaviorSpecialist} = true OR
            ${staffTable.isDean} = true OR
            ${staffTable.isEseCoordinator} = true OR
            ${staffTable.isIssTeacher} = true OR
            ${staffTable.isSchoolPsychologist} = true OR
            ${staffTable.isSocialWorker} = true OR
            ${staffTable.email} LIKE '%@pulseedu.test'
          )`,
        ),
      );
    const privilegedIds = new Set(privilegedRows.map((r) => r.id));
    log.push(`preserve: ${privilegedIds.size} privileged staff`);

    // Strip any subject suffix from privileged-staff displayName (idempotent
    // cleanup so re-runs of this rebuild don't leave "Sally Smith - ELA G6"
    // on a Guidance Counselor who used to teach).
    for (const r of privilegedRows) {
      const cleaned = r.displayName.replace(SUBJECT_SUFFIX_RE, "");
      if (cleaned !== r.displayName) {
        await tx
          .update(staffTable)
          .set({ displayName: cleaned })
          .where(eq(staffTable.id, r.id));
      }
    }

    // ---------- Plan teacher counts ----------
    const teacherPlan = planTeacherCounts(g6, g7, g8);
    const totalCoreTeachers = teacherPlan.core.reduce((a, b) => a + b.teachers, 0);
    const totalElectiveTeachers = teacherPlan.electives.reduce((a, b) => a + b.teachers, 0);
    const totalTeachers = totalCoreTeachers + totalElectiveTeachers;
    log.push(`plan: core=${totalCoreTeachers} elective=${totalElectiveTeachers} total=${totalTeachers}`);

    // ---------- Existing non-privileged staff at this school ----------
    const candidates = await tx
      .select({ id: staffTable.id, email: staffTable.email, displayName: staffTable.displayName })
      .from(staffTable)
      .where(eq(staffTable.schoolId, SCHOOL_ID))
      .orderBy(staffTable.id);
    const reusable = candidates.filter((r) => !privilegedIds.has(r.id));
    log.push(`reusable staff rows: ${reusable.length} (need ${totalTeachers})`);

    // Repurpose existing rows; insert more if we need them; delete extras.
    const rng = mulberry32(20260521); // demo-day seed
    const namePool = makeNamePool(rng, totalTeachers);

    // Build the flat "teacher assignment" list in deterministic order.
    type TeacherSlot =
      | { kind: "core"; subject: CoreSubject; grade: 6 | 7 | 8; planning: number }
      | { kind: "elective"; elective: Elective; planning: number };

    const slots: TeacherSlot[] = [];
    // Core slots
    for (const c of teacherPlan.core) {
      for (let i = 0; i < c.teachers; i++) {
        slots.push({ kind: "core", subject: c.subject, grade: c.grade, planning: 0 });
      }
    }
    // Elective slots
    for (const e of teacherPlan.electives) {
      for (let i = 0; i < e.teachers; i++) {
        slots.push({ kind: "elective", elective: e.elective, planning: 0 });
      }
    }
    // Distribute planning periods round-robin across slots.
    const planningSlots = distributePlanning(slots.length);
    for (let i = 0; i < slots.length; i++) {
      slots[i]!.planning = planningSlots[i]!;
    }

    // Assign each slot to a staff row: reuse first, then INSERT.
    const teachers: Array<{
      staffId: number;
      slot: TeacherSlot;
      name: string;
      room: string;
      ext: string;
    }> = [];
    let roomCounters = { 6: 0, 7: 0, 8: 0 } as Record<6 | 7 | 8, number>;
    let electiveRoomCounters: Record<Elective, number> = {
      Art: 0, PE: 0, Music: 0, Technology: 0, "Digital Media": 0,
    };

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      const name = namePool[i]!;
      const grade = slot.kind === "core" ? slot.grade : null;
      const room =
        slot.kind === "core"
          ? defaultRoomFor({ kind: "core", subject: slot.subject, grade: slot.grade }, roomCounters[slot.grade]++)
          : defaultRoomFor({ kind: "elective", elective: slot.elective }, electiveRoomCounters[slot.elective]++);
      const ext = defaultExtensionFor(grade, i);
      const subjectLabel =
        slot.kind === "core" ? `${slot.subject} G${slot.grade}` : slot.elective;
      const displayName = `${name} - ${subjectLabel}`;

      const reused = reusable[i];
      let staffId: number;
      if (reused) {
        await tx
          .update(staffTable)
          .set({
            displayName,
            defaultRoom: room,
            workExtension: ext,
            active: true,
          })
          .where(eq(staffTable.id, reused.id));
        staffId = reused.id;
      } else {
        // Need a new row. Generate a non-colliding email.
        const slug = name.toLowerCase().replace(/[^a-z]+/g, ".");
        const email = `${slug}.${i}@parrott.demo`;
        const [ins] = await tx
          .insert(staffTable)
          .values({
            schoolId: SCHOOL_ID,
            email,
            passwordHash: "!disabled!",
            displayName,
            defaultRoom: room,
            workExtension: ext,
            active: true,
          })
          .returning({ id: staffTable.id });
        staffId = ins!.id;
      }
      teachers.push({ staffId, slot, name, room, ext });
    }

    // Soft-delete (set active=false) any reusable staff beyond what we need.
    // We don't hard-delete because the row might be referenced from preserved
    // historical tables (FAST imports etc) that we kept around.
    if (reusable.length > slots.length) {
      const surplusIds = reusable.slice(slots.length).map((r) => r.id);
      await tx
        .update(staffTable)
        .set({ active: false, displayName: sql`${staffTable.displayName} || ' (retired)'` })
        .where(inArray(staffTable.id, surplusIds));
      log.push(`retired ${surplusIds.length} surplus staff rows`);
    }
    log.push(`teachers active: ${teachers.length}`);

    // ---------- Build class_sections ----------
    // For each teacher: a section in each of their 5 teaching periods
    // ({1,2,3,4,6,7} minus their planning period), course_name keyed to
    // their subject (+ grade if core).
    type SectionMeta = {
      id: number;
      period: number;
      teacherStaffId: number;
      key: string; // "<subject>|G<grade>" for cores, "<elective>|*" for electives
      capacity: number;
    };
    const sectionInserts: Array<typeof classSectionsTable.$inferInsert> = [];
    const insertMeta: Array<{ teacherIdx: number; period: number; key: string; courseName: string }> = [];
    for (let tIdx = 0; tIdx < teachers.length; tIdx++) {
      const t = teachers[tIdx]!;
      const teachingPeriods = ACADEMIC_PERIODS.filter((p) => p !== t.slot.planning);
      for (const p of teachingPeriods) {
        const key =
          t.slot.kind === "core" ? `${t.slot.subject}|G${t.slot.grade}` : `${t.slot.elective}|*`;
        const courseName =
          t.slot.kind === "core"
            ? `${t.slot.subject} — Grade ${t.slot.grade}`
            : t.slot.elective;
        sectionInserts.push({
          schoolId: SCHOOL_ID,
          teacherStaffId: t.staffId,
          period: p,
          courseName,
          isPlanning: false,
        });
        insertMeta.push({ teacherIdx: tIdx, period: p, key, courseName });
      }
      // Insert a planning marker row so the UI/exports can show it.
      sectionInserts.push({
        schoolId: SCHOOL_ID,
        teacherStaffId: t.staffId,
        period: t.slot.planning,
        courseName: "Planning",
        isPlanning: true,
      });
      insertMeta.push({
        teacherIdx: tIdx,
        period: t.slot.planning,
        key: "__planning__",
        courseName: "Planning",
      });
    }

    // The unique (teacher_staff_id, period) index would block a teacher
    // having BOTH a teaching section AND a planning row at the same period.
    // Our build never does this (planning IS their off period), so the
    // constraint holds.
    const insertedSections = await tx
      .insert(classSectionsTable)
      .values(sectionInserts)
      .returning({ id: classSectionsTable.id });

    const sections: SectionMeta[] = [];
    for (let i = 0; i < insertMeta.length; i++) {
      const m = insertMeta[i]!;
      if (m.key === "__planning__") continue; // planning rows are not enrollable
      sections.push({
        id: insertedSections[i]!.id,
        period: m.period,
        teacherStaffId: teachers[m.teacherIdx]!.staffId,
        key: m.key,
        capacity: 0,
      });
    }
    log.push(`sections: total=${insertedSections.length} enrollable=${sections.length}`);

    // Index sections by (key, period) for fast pick.
    const sectionsByKeyAndPeriod = new Map<string, Map<number, SectionMeta[]>>();
    for (const s of sections) {
      let byPeriod = sectionsByKeyAndPeriod.get(s.key);
      if (!byPeriod) {
        byPeriod = new Map();
        sectionsByKeyAndPeriod.set(s.key, byPeriod);
      }
      const arr = byPeriod.get(s.period) ?? [];
      arr.push(s);
      byPeriod.set(s.period, arr);
    }

    // ---------- Enroll students (collision-free, capacity-respecting) ----------
    const students = await tx
      .select({
        studentId: studentsTable.studentId,
        grade: studentsTable.grade,
      })
      .from(studentsTable)
      .where(eq(studentsTable.schoolId, SCHOOL_ID));

    // Shuffle for fairness so early-alphabet students don't always get the
    // same teacher.
    shuffleInPlace(students, rng);

    const rosterRows: Array<typeof sectionRosterTable.$inferInsert> = [];

    // For each student, the helper picks a section for the requested key
    // (e.g. "ELA|G7" or "Art|*") that:
    //   - is in a period the student doesn't already have a class in,
    //   - has capacity left,
    //   - is the least-loaded option among the candidates (for balance).
    function pickSectionForStudent(
      key: string,
      busyPeriods: Set<number>,
    ): SectionMeta | null {
      const byPeriod = sectionsByKeyAndPeriod.get(key);
      if (!byPeriod) return null;
      let best: SectionMeta | null = null;
      for (const [period, arr] of byPeriod) {
        if (busyPeriods.has(period)) continue;
        for (const s of arr) {
          if (s.capacity >= SECTION_CAP) continue;
          if (!best || s.capacity < best.capacity) best = s;
        }
      }
      return best;
    }

    let unplaceable = 0;
    for (const st of students) {
      const grade = st.grade as 6 | 7 | 8;
      const busyPeriods = new Set<number>();

      // 4 cores in fixed order (deterministic).
      for (const subject of CORE_SUBJECTS) {
        const key = `${subject}|G${grade}`;
        const pick = pickSectionForStudent(key, busyPeriods);
        if (!pick) {
          unplaceable++;
          throw new Error(
            `Student ${st.studentId} (grade ${grade}) — no section available for ${key}`,
          );
        }
        pick.capacity++;
        busyPeriods.add(pick.period);
        rosterRows.push({
          schoolId: SCHOOL_ID,
          sectionId: pick.id,
          studentId: st.studentId,
        });
      }

      // 2 electives — shuffle pool for variety, take first 2 that fit.
      const electivePool = shuffleInPlace([...ELECTIVES], rng);
      let placed = 0;
      for (const e of electivePool) {
        if (placed >= 2) break;
        const key = `${e}|*`;
        const pick = pickSectionForStudent(key, busyPeriods);
        if (!pick) continue;
        pick.capacity++;
        busyPeriods.add(pick.period);
        rosterRows.push({
          schoolId: SCHOOL_ID,
          sectionId: pick.id,
          studentId: st.studentId,
        });
        placed++;
      }
      if (placed < 2) {
        // Fallback: try ALL electives (even repeated) to fill — we'd rather
        // give a kid a duplicate elective than leave a hole.
        for (const e of ELECTIVES) {
          if (placed >= 2) break;
          const key = `${e}|*`;
          const pick = pickSectionForStudent(key, busyPeriods);
          if (!pick) continue;
          pick.capacity++;
          busyPeriods.add(pick.period);
          rosterRows.push({
            schoolId: SCHOOL_ID,
            sectionId: pick.id,
            studentId: st.studentId,
          });
          placed++;
        }
        if (placed < 2) {
          throw new Error(
            `Student ${st.studentId} could only place ${placed}/2 electives`,
          );
        }
      }
    }

    // Chunked insert.
    for (let i = 0; i < rosterRows.length; i += 500) {
      await tx.insert(sectionRosterTable).values(rosterRows.slice(i, i + 500));
    }
    log.push(`enrollments inserted: ${rosterRows.length} (unplaceable=${unplaceable})`);

    // ---------- ESE / 504 / ELL flags (reset deterministically) ----------
    // Clear all flags first, then set fresh.
    await tx
      .update(studentsTable)
      .set({ ese: false, is504: false, ell: false })
      .where(eq(studentsTable.schoolId, SCHOOL_ID));

    const studentIds = students.map((s) => s.studentId);
    shuffleInPlace(studentIds, rng);
    const eseCount = Math.round(studentIds.length * 0.12);
    const ell504Pool = studentIds.slice(eseCount); // 504 + ELL drawn from non-ESE
    const elseShuf = [...ell504Pool];
    shuffleInPlace(elseShuf, rng);
    const fivecount = Math.round(studentIds.length * 0.05);
    const ellCount = Math.round(studentIds.length * 0.07);

    const eseIds = studentIds.slice(0, eseCount);
    const fiveIds = elseShuf.slice(0, fivecount);
    const ellIds = elseShuf.slice(fivecount, fivecount + ellCount);

    if (eseIds.length)
      await tx
        .update(studentsTable)
        .set({ ese: true })
        .where(and(eq(studentsTable.schoolId, SCHOOL_ID), inArray(studentsTable.studentId, eseIds)));
    if (fiveIds.length)
      await tx
        .update(studentsTable)
        .set({ is504: true })
        .where(and(eq(studentsTable.schoolId, SCHOOL_ID), inArray(studentsTable.studentId, fiveIds)));
    if (ellIds.length)
      await tx
        .update(studentsTable)
        .set({ ell: true })
        .where(and(eq(studentsTable.schoolId, SCHOOL_ID), inArray(studentsTable.studentId, ellIds)));
    log.push(`flags: ese=${eseIds.length} 504=${fiveIds.length} ell=${ellIds.length}`);

    // ---------- Accommodations for flagged students ----------
    const accommLib = await tx.execute(
      sql`SELECT id FROM school_accommodations WHERE school_id=${SCHOOL_ID} AND active=true`,
    );
    const accommIds = (accommLib.rows as Array<{ id: number }>).map((r) => r.id);
    if (accommIds.length === 0) {
      log.push(`WARNING: no accommodations in library for school ${SCHOOL_ID}`);
    } else {
      const flagged = new Set([...eseIds, ...fiveIds]); // 504 + ESE get accommodations
      const accomRows: Array<typeof studentAccommodationsTable.$inferInsert> = [];
      for (const sid of flagged) {
        const n = 2 + Math.floor(rng() * 3); // 2-4 accommodations
        const pool = [...accommIds];
        shuffleInPlace(pool, rng);
        for (const aid of pool.slice(0, n)) {
          accomRows.push({
            schoolId: SCHOOL_ID,
            studentId: sid,
            accommodationId: aid,
          });
        }
      }
      for (let i = 0; i < accomRows.length; i += 500) {
        await tx.insert(studentAccommodationsTable).values(accomRows.slice(i, i + 500));
      }
      log.push(`accommodations inserted: ${accomRows.length} (for ${flagged.size} students)`);
    }

    // ---------- Demo content: PBIS, attendance, hall passes, tardies ----------
    // Pick a small staff sample for PBIS attribution.
    const staffSample = [...privilegedRows, ...teachers.slice(0, 20).map((t) => ({
      id: t.staffId,
      displayName: t.name,
      email: "",
    }))];

    // PBIS — ~2000 entries over 30 days, balanced across 4 houses.
    const [houseRows] = await Promise.all([
      tx.execute(
        sql`SELECT id, name FROM houses WHERE school_id=${SCHOOL_ID} ORDER BY id`,
      ),
    ]);
    const houseList = (houseRows.rows as Array<{ id: number; name: string }>);
    // Round-robin assign students to houses (so house standings are even).
    for (let i = 0; i < students.length; i++) {
      const h = houseList[i % houseList.length]!;
      await tx
        .update(studentsTable)
        .set({ houseId: h.id })
        .where(
          and(
            eq(studentsTable.schoolId, SCHOOL_ID),
            eq(studentsTable.studentId, students[i]!.studentId),
          ),
        );
    }
    log.push(`houses assigned (round-robin across ${houseList.length})`);

    // PBIS entries
    {
      const reasons = [
        "Respect", "Responsibility", "Safety", "Kindness",
        "On-task", "Helping a classmate", "Cleaning up",
      ];
      const negReasons = ["Disruption", "Phone use", "Talking back"];
      const targetTotal = 2000;
      const rows: Array<typeof pbisEntriesTable.$inferInsert> = [];
      for (let i = 0; i < targetTotal; i++) {
        const st = students[Math.floor(rng() * students.length)]!;
        const staff = staffSample[Math.floor(rng() * staffSample.length)]!;
        const isNeg = rng() < 0.08;
        const daysAgo = Math.floor(rng() * 30);
        const d = new Date();
        d.setDate(d.getDate() - daysAgo);
        rows.push({
          schoolId: SCHOOL_ID,
          studentId: st.studentId,
          reason: isNeg
            ? negReasons[Math.floor(rng() * negReasons.length)]!
            : reasons[Math.floor(rng() * reasons.length)]!,
          points: isNeg ? -1 : 1,
          staffId: staff.id,
          staffName: staff.displayName,
          createdAt: d.toISOString(),
          polarity: isNeg ? "negative" : "positive",
        });
      }
      for (let i = 0; i < rows.length; i += 500) {
        await tx.insert(pbisEntriesTable).values(rows.slice(i, i + 500));
      }
      log.push(`pbis_entries: ${rows.length}`);
    }

    // Hall passes — ~400, 80% completed, last 30 days.
    {
      const dests = ["Restroom", "Nurse", "Office", "Counselor", "Locker", "Water"];
      const rows: Array<typeof hallPassesTable.$inferInsert> = [];
      for (let i = 0; i < 400; i++) {
        const st = students[Math.floor(rng() * students.length)]!;
        const daysAgo = Math.floor(rng() * 30);
        const issued = new Date();
        issued.setDate(issued.getDate() - daysAgo);
        issued.setHours(8 + Math.floor(rng() * 7), Math.floor(rng() * 60));
        const returned = new Date(issued.getTime() + (3 + Math.floor(rng() * 12)) * 60_000);
        const isOpen = i < 12; // 12 currently active
        const teacher = staffSample[Math.floor(rng() * staffSample.length)]!;
        rows.push({
          schoolId: SCHOOL_ID,
          studentId: st.studentId,
          originRoom: "Classroom",
          teacherName: teacher.displayName,
          destination: dests[Math.floor(rng() * dests.length)]!,
          status: isOpen ? "active" : "returned",
          createdAt: issued.toISOString(),
          endedAt: isOpen ? null : returned.toISOString(),
          maxDurationMinutes: 10,
        });
      }
      for (let i = 0; i < rows.length; i += 500) {
        await tx.insert(hallPassesTable).values(rows.slice(i, i + 500));
      }
      log.push(`hall_passes: ${rows.length}`);
    }

    // Tardies — ~150
    {
      const rows: Array<typeof tardiesTable.$inferInsert> = [];
      for (let i = 0; i < 150; i++) {
        const st = students[Math.floor(rng() * students.length)]!;
        const daysAgo = Math.floor(rng() * 30);
        const d = new Date();
        d.setDate(d.getDate() - daysAgo);
        const teacher = staffSample[Math.floor(rng() * staffSample.length)]!;
        rows.push({
          schoolId: SCHOOL_ID,
          studentId: st.studentId,
          teacherName: teacher.displayName,
          period: String(ACADEMIC_PERIODS[Math.floor(rng() * ACADEMIC_PERIODS.length)]!),
          reason: "Late to class",
          entryType: "tardy",
          notes: "",
          createdAt: d.toISOString(),
        });
      }
      for (let i = 0; i < rows.length; i += 500) {
        await tx.insert(tardiesTable).values(rows.slice(i, i + 500));
      }
      log.push(`tardies: ${rows.length}`);
    }

    // Attendance — 30 school days, ~95% present, deterministic shape.
    {
      const schoolDays: string[] = [];
      const d = new Date();
      while (schoolDays.length < 30) {
        const day = d.getDay();
        if (day !== 0 && day !== 6) schoolDays.push(d.toISOString().slice(0, 10));
        d.setDate(d.getDate() - 1);
      }
      const rows: Array<typeof studentAttendanceDayTable.$inferInsert> = [];
      for (const date of schoolDays) {
        for (const st of students) {
          const r = rng();
          let status: string;
          if (r < 0.92) status = "present";
          else if (r < 0.96) status = "absent_excused";
          else if (r < 0.99) status = "absent_unexcused";
          else status = "tardy";
          rows.push({
            schoolId: SCHOOL_ID,
            studentId: st.studentId,
            day: date,
            status,
          });
        }
      }
      for (let i = 0; i < rows.length; i += 1000) {
        await tx.insert(studentAttendanceDayTable).values(rows.slice(i, i + 1000));
      }
      log.push(`student_attendance_day: ${rows.length} (${schoolDays.length} days × ${students.length})`);
    }

    // MTSS plans — 15 mixed Tier 2/3
    {
      const titles = [
        "Behavior Check-In/Check-Out", "Small-group reading",
        "Daily progress monitoring", "Math fluency intervention",
        "Counseling check-ins", "Attendance plan",
      ];
      const rows: Array<typeof studentMtssPlansTable.$inferInsert> = [];
      const picked = students.slice(0, 15);
      for (let i = 0; i < picked.length; i++) {
        rows.push({
          schoolId: SCHOOL_ID,
          studentId: picked[i]!.studentId,
          title: titles[i % titles.length]!,
          goals: "Improve sustained on-task behavior across all academic periods.",
          tier: i < 10 ? 2 : 3,
          interventionSubType: i < 10 ? "cico" : null,
        });
      }
      await tx.insert(studentMtssPlansTable).values(rows);
      log.push(`student_mtss_plans: ${rows.length}`);
    }

    // Safety plans — 2 active
    {
      const picked = students.slice(15, 17);
      const rows = picked.map((s) => ({
        schoolId: SCHOOL_ID,
        studentId: s.studentId,
        notes: "Demo safety plan — escort to dismissal; clear backpack check daily.",
      }));
      await tx.insert(safetyPlansTable).values(rows);
      log.push(`safety_plans: ${rows.length}`);
    }

    // Interaction cases — 5 open, generic mix
    {
      const titles = [
        { title: "Bullying — 7th hallway", outcome: null },
        { title: "Fight — cafeteria", outcome: null },
        { title: "Vape detected — bathroom B", outcome: null },
        { title: "Dress code repeated violation", outcome: null },
        { title: "Chronic absenteeism — 6th grade", outcome: null },
      ];
      const lead = privilegedRows.find((r) => r.email.endsWith("@hcsb.k12.fl.us"))
        ?? privilegedRows[0];
      if (lead) {
        const rows: Array<typeof interactionCasesTable.$inferInsert> = [];
        for (let i = 0; i < titles.length; i++) {
          rows.push({
            schoolId: SCHOOL_ID,
            caseNumber: i + 1,
            schoolYearLabel: "25-26",
            title: titles[i]!.title,
            status: "open",
            leadStaffId: lead.id,
            leadStaffName: lead.displayName,
            summary: "Demo case for dashboard population.",
            createdByStaffId: lead.id,
            createdByName: lead.displayName,
          });
        }
        await tx.insert(interactionCasesTable).values(rows);
        log.push(`interaction_cases: ${rows.length}`);
      }
    }

    // Pickup authorizations — 30. pickup_authorizations uses students.id PK
    // (integer), not the FLEID; look it up.
    {
      const picked = students.slice(0, 30);
      const fleids = picked.map((s) => s.studentId);
      const idRowsResp = await tx
        .select({ id: studentsTable.id, studentId: studentsTable.studentId })
        .from(studentsTable)
        .where(and(eq(studentsTable.schoolId, SCHOOL_ID), inArray(studentsTable.studentId, fleids)));
      const fleidToId = new Map(idRowsResp.map((r) => [r.studentId, r.id]));
      const rows: Array<typeof studentPickupAuthorizationsTable.$inferInsert> = [];
      for (let i = 0; i < picked.length; i++) {
        const sid = fleidToId.get(picked[i]!.studentId);
        if (!sid) continue;
        rows.push({
          schoolId: SCHOOL_ID,
          studentId: sid,
          guardianLabel: i % 2 === 0 ? "Mom" : "Dad",
          pickupNumber: String(2000 + i),
          active: true,
        });
      }
      if (rows.length) {
        await tx.insert(studentPickupAuthorizationsTable).values(rows);
        log.push(`student_pickup_authorizations: ${rows.length}`);
      }
    }

    // ---------- Final verification ----------
    const [{ collisions }] = (await tx.execute(sql`
      WITH stacks AS (
        SELECT sr.student_id, cs.period, COUNT(*) AS cnt
        FROM section_roster sr
        JOIN class_sections cs ON cs.id = sr.section_id
        WHERE sr.school_id = ${SCHOOL_ID}
        GROUP BY sr.student_id, cs.period
      )
      SELECT COALESCE(MAX(cnt), 0)::int AS collisions FROM stacks
    `)).rows as Array<{ collisions: number }>;
    if (collisions > 1) {
      throw new Error(`POST-BUILD AUDIT: period collisions detected (max=${collisions})`);
    }
    const [{ oversize }] = (await tx.execute(sql`
      SELECT COALESCE(MAX(c), 0)::int AS oversize FROM (
        SELECT COUNT(*) AS c
        FROM section_roster sr
        JOIN class_sections cs ON cs.id = sr.section_id
        WHERE sr.school_id = ${SCHOOL_ID} AND cs.is_planning = false
        GROUP BY sr.section_id
      ) t
    `)).rows as Array<{ oversize: number }>;
    if (oversize > SECTION_CAP) {
      throw new Error(`POST-BUILD AUDIT: section over cap (max=${oversize})`);
    }
    log.push(`verify: max_per_period=${collisions} max_section_size=${oversize}`);

    return {
      ok: true as const,
      log,
      summary: {
        students: students.length,
        teachers: teachers.length,
        sections: insertedSections.length,
        enrollments: rosterRows.length,
        eseFlagged: eseIds.length,
        flag504: fiveIds.length,
        ellFlagged: ellIds.length,
      },
    };
  });
}
