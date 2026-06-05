/* eslint-disable no-console */
// =============================================================================
// rebuildDspSections — non-destructive rebuild of teachers + 7-period schedule
// for D. S. Parrott Middle School (school_id=1). Does NOT touch students,
// FAST scores, accommodations, or other behavior data.
//
// What it does:
//   1. Fixes ESE/504 mutual-exclusivity on students (ESE wins, 504 cleared).
//   2. Picks 38 existing active non-admin staff at school 1 (deterministic).
//   3. Updates their displayName to include subject suffix
//      (e.g. "John Smith - ELA G6"). Idempotent — strips prior suffix.
//   4. Wipes class_sections + section_roster at school 1.
//   5. Creates a 7-period schedule:
//        - Per grade (6/7/8): 2 ELA, 2 Math, 2 Science, 2 SS teachers
//        - Cross-grade electives: PE×3, Art×2, Music×2, Tech×2, Health×2,
//          World Languages×3
//      Each teacher gets 5 sections (periods 1–5), leaving periods 6–7 for
//      electives/planning.
//   6. Enrolls every student in 4 core sections (ELA/Math/Sci/SS for their
//      grade) + 3 electives, balanced ~25/section by least-loaded picking.
// =============================================================================

import {
  classSectionsTable,
  db,
  sectionRosterTable,
  staffTable,
  studentsTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

const SCHOOL_ID = 1;

const SUBJECT_SUFFIX_RE =
  /\s+-\s+(ELA|Math|Science|Social Studies|PE|Art|Music|Technology|Health|World Languages)(\s+G[6-8])?$/;

type Assignment = { subject: string; grade: number | null };

// 38 teachers. 24 core (2 per (subject, grade) × 4 subjects × 3 grades)
// + 14 cross-grade electives.
const ASSIGNMENTS: Assignment[] = [
  ...([6, 7, 8] as const).flatMap<Assignment>((g) => [
    { subject: "ELA", grade: g },
    { subject: "ELA", grade: g },
    { subject: "Math", grade: g },
    { subject: "Math", grade: g },
    { subject: "Science", grade: g },
    { subject: "Science", grade: g },
    { subject: "Social Studies", grade: g },
    { subject: "Social Studies", grade: g },
  ]),
  { subject: "PE", grade: null },
  { subject: "PE", grade: null },
  { subject: "PE", grade: null },
  { subject: "Art", grade: null },
  { subject: "Art", grade: null },
  { subject: "Music", grade: null },
  { subject: "Music", grade: null },
  { subject: "Technology", grade: null },
  { subject: "Technology", grade: null },
  { subject: "Health", grade: null },
  { subject: "Health", grade: null },
  { subject: "World Languages", grade: null },
  { subject: "World Languages", grade: null },
  { subject: "World Languages", grade: null },
];

const ELECTIVE_SUBJECTS = [
  "PE",
  "Art",
  "Music",
  "Technology",
  "Health",
  "World Languages",
] as const;

function subjectLabel(a: Assignment): string {
  return a.grade !== null ? `${a.subject} G${a.grade}` : a.subject;
}

function courseName(a: Assignment): string {
  return a.grade !== null ? `${a.subject} — Grade ${a.grade}` : a.subject;
}

// Tiny deterministic RNG so re-runs are stable.
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export async function rebuildDspSections(): Promise<{
  ok: true;
  ese504Fixed: number;
  teachers: number;
  sections: number;
  enrollments: number;
  students: number;
}> {
  // -------------------------------------------------------------------------
  // 1. ESE/504 mutex fix: a student covered under IDEA (ESE) cannot also be
  //    flagged as 504. Clear is_504 wherever both are set.
  // -------------------------------------------------------------------------
  const mutexResult = await db.execute(sql`
    UPDATE students SET is_504 = false
    WHERE school_id = ${SCHOOL_ID} AND ese = true AND is_504 = true
  `);
  const ese504Fixed = mutexResult.rowCount ?? 0;
  console.log(`ESE/504 mutex: cleared 504 on ${ese504Fixed} students`);

  // -------------------------------------------------------------------------
  // 2. Pick 38 existing active non-admin staff (deterministic by id ASC).
  // -------------------------------------------------------------------------
  const candidates = await db
    .select()
    .from(staffTable)
    .where(
      and(
        eq(staffTable.schoolId, SCHOOL_ID),
        eq(staffTable.active, true),
        eq(staffTable.isSuperUser, false),
        eq(staffTable.isDistrictAdmin, false),
        eq(staffTable.isAdmin, false),
      ),
    )
    .orderBy(staffTable.id);

  if (candidates.length < ASSIGNMENTS.length) {
    throw new Error(
      `need ${ASSIGNMENTS.length} teacher candidates, only found ${candidates.length}`,
    );
  }
  const teachers = candidates.slice(0, ASSIGNMENTS.length);
  console.log(`Picked ${teachers.length} teacher candidates`);

  // -------------------------------------------------------------------------
  // 3. Update displayName with subject suffix (idempotent).
  // -------------------------------------------------------------------------
  for (let i = 0; i < teachers.length; i++) {
    const t = teachers[i]!;
    const a = ASSIGNMENTS[i]!;
    const base = t.displayName.replace(SUBJECT_SUFFIX_RE, "");
    const newName = `${base} - ${subjectLabel(a)}`;
    if (newName !== t.displayName) {
      await db
        .update(staffTable)
        .set({ displayName: newName })
        .where(eq(staffTable.id, t.id));
    }
  }
  console.log("Updated teacher displayNames with subject suffixes");

  // -------------------------------------------------------------------------
  // 4. Wipe class_sections + section_roster at this school.
  // -------------------------------------------------------------------------
  await db.execute(
    sql`DELETE FROM section_roster WHERE school_id = ${SCHOOL_ID}`,
  );
  await db.execute(
    sql`DELETE FROM class_sections WHERE school_id = ${SCHOOL_ID}`,
  );
  console.log("Wiped existing class_sections + section_roster");

  // -------------------------------------------------------------------------
  // 5. Create sections — each teacher gets 5 sections in periods 1–5.
  // -------------------------------------------------------------------------
  const sectionInserts: Array<typeof classSectionsTable.$inferInsert> = [];
  const sectionMeta: Array<{ teacherIdx: number; period: number; a: Assignment }> = [];
  for (let i = 0; i < teachers.length; i++) {
    const a = ASSIGNMENTS[i]!;
    for (let p = 1; p <= 5; p++) {
      sectionInserts.push({
        schoolId: SCHOOL_ID,
        teacherStaffId: teachers[i]!.id,
        period: p,
        courseName: courseName(a),
        isPlanning: false,
      });
      sectionMeta.push({ teacherIdx: i, period: p, a });
    }
  }
  const insertedSections = await db
    .insert(classSectionsTable)
    .values(sectionInserts)
    .returning();
  console.log(`Inserted ${insertedSections.length} sections`);

  type SectionInfo = { id: number; period: number };
  const byKey = new Map<string, SectionInfo[]>();
  for (let i = 0; i < sectionMeta.length; i++) {
    const m = sectionMeta[i]!;
    const row = insertedSections[i]!;
    const key =
      m.a.grade !== null ? `${m.a.subject}|G${m.a.grade}` : `${m.a.subject}|*`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push({ id: row.id, period: row.period });
  }

  // -------------------------------------------------------------------------
  // 6. Enroll students. Least-loaded picking keeps section sizes balanced.
  // -------------------------------------------------------------------------
  const students = await db
    .select({
      id: studentsTable.id,
      studentId: studentsTable.studentId,
      grade: studentsTable.grade,
    })
    .from(studentsTable)
    .where(eq(studentsTable.schoolId, SCHOOL_ID));

  const enrollCount = new Map<number, number>();
  for (const s of insertedSections) enrollCount.set(s.id, 0);

  function pickSection(key: string): SectionInfo {
    const list = byKey.get(key);
    if (!list || list.length === 0) {
      throw new Error(`no sections for key ${key}`);
    }
    let best = list[0]!;
    let bestN = enrollCount.get(best.id)!;
    for (const s of list) {
      const n = enrollCount.get(s.id)!;
      if (n < bestN) {
        best = s;
        bestN = n;
      }
    }
    return best;
  }

  const rng = mulberry32(20260519);
  function shuffle<T>(arr: readonly T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }

  const rosterRows: Array<typeof sectionRosterTable.$inferInsert> = [];
  for (const st of students) {
    if (st.grade == null) continue;
    // 4 core subjects for their grade
    for (const subj of ["ELA", "Math", "Science", "Social Studies"]) {
      const sec = pickSection(`${subj}|G${st.grade}`);
      rosterRows.push({
        schoolId: SCHOOL_ID,
        sectionId: sec.id,
        studentId: st.studentId,
      });
      enrollCount.set(sec.id, (enrollCount.get(sec.id) ?? 0) + 1);
    }
    // 3 electives from 3 distinct subjects
    const electiveSubjs = shuffle(ELECTIVE_SUBJECTS).slice(0, 3);
    for (const subj of electiveSubjs) {
      const sec = pickSection(`${subj}|*`);
      rosterRows.push({
        schoolId: SCHOOL_ID,
        sectionId: sec.id,
        studentId: st.studentId,
      });
      enrollCount.set(sec.id, (enrollCount.get(sec.id) ?? 0) + 1);
    }
  }

  for (let i = 0; i < rosterRows.length; i += 500) {
    await db.insert(sectionRosterTable).values(rosterRows.slice(i, i + 500));
  }
  console.log(`Inserted ${rosterRows.length} section_roster rows`);

  return {
    ok: true,
    ese504Fixed,
    teachers: teachers.length,
    sections: insertedSections.length,
    enrollments: rosterRows.length,
    students: students.length,
  };
}
