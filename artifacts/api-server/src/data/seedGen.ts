// Deterministic seed data generator for PulseED.
// 35 teachers + 1 admin + 1 ESE coordinator. Each teacher has 7 periods: 6
// teaching + 1 planning. Planning periods are distributed evenly across the 7
// periods (5 teachers per period) so every period has exactly 30 teaching
// teachers. 600 students, each enrolled in all 7 periods via round-robin
// section assignment, yielding exactly 20 students per non-planning section.
// ~25% of students get 1-3 accommodations from a master list spanning
// IEP/504/ELL/Strategy.

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function shuffle<T>(rng: () => number, arr: T[]): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const FIRST_NAMES = [
  "Ava","Liam","Sophia","Noah","Mia","Ethan","Olivia","Lucas","Isabella","Mason",
  "Charlotte","Logan","Amelia","Elijah","Harper","James","Evelyn","Benjamin","Abigail","Henry",
  "Emily","Alexander","Ella","Daniel","Scarlett","Matthew","Grace","Jack","Chloe","Sebastian",
  "Aria","Jackson","Lily","Aiden","Zoe","Owen","Layla","Levi","Hazel","Wyatt",
  "Aurora","Carter","Nora","Jayden","Riley","Julian","Stella","Asher","Hannah","Leo",
  "Violet","Caleb","Lucy","Mateo","Aaliyah","Isaiah","Ruby","Eli","Bella","Connor",
  "Camila","Adam","Eva","Tucker","Maya","Dylan","Sadie","Andrew","Naomi","Easton",
  "Penelope","Cooper","Brooklyn","Adrian","Quinn","Christian","Isla","Joseph","Anna","Hudson",
];

const LAST_NAMES = [
  "Johnson","Martinez","Nguyen","Patel","Brown","Garcia","Smith","Davis","Lopez","Wilson",
  "Anderson","Thomas","Taylor","Moore","Jackson","White","Harris","Clark","Lewis","Walker",
  "Hall","Young","King","Wright","Scott","Green","Adams","Baker","Nelson","Carter",
  "Mitchell","Perez","Roberts","Turner","Phillips","Campbell","Parker","Evans","Edwards","Collins",
  "Stewart","Sanchez","Morris","Rogers","Reed","Cook","Morgan","Bell","Murphy","Bailey",
];

const TEACHER_FIRST = [
  "Sarah","Michael","Linda","James","Patricia","Robert","Jennifer","David","Maria","Daniel",
  "Karen","Mark","Lisa","Steven","Nancy","Paul","Susan","Kevin","Donna","Brian",
  "Carol","George","Sandra","Edward","Ashley","Anthony","Kimberly","Charles","Donna","Jason",
];

const TEACHER_LAST = [
  "Rivera","Johnson","Lee","Patel","Davis","Garcia","Smith","Brown","Wilson","Martinez",
  "Anderson","Thomas","Taylor","Moore","Jackson","White","Harris","Clark","Lewis","Walker",
  "Hall","Young","King","Wright","Scott","Green","Adams","Baker","Nelson","Carter",
];

export interface SeedTeacher {
  email: string;
  displayName: string;
  isAdmin: boolean;
  isEseCoordinator: boolean;
  // Periods 1..7. The single missing period is planning.
  teachingPeriods: number[];
  planningPeriod: number;
}

export interface SeedStudent {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number;
  parentName: string | null;
  parentEmail: string | null;
  parentPhone: string | null;
  // Schedule: period -> teacher index (0..29). Always 7 entries.
  schedule: Record<number, number>;
  // Indices into MASTER_ACCOMMODATIONS
  accommodationIndices: number[];
}

export interface SeedAccommodation {
  name: string;
  category: "IEP" | "504" | "ELL" | "Strategy";
}

export const MASTER_ACCOMMODATIONS: SeedAccommodation[] = [
  { name: "Extended Time", category: "IEP" },
  { name: "Small Group Testing", category: "IEP" },
  { name: "Read Aloud Directions", category: "IEP" },
  { name: "Frequent Breaks", category: "IEP" },
  { name: "Reduced Workload", category: "IEP" },
  { name: "Visual Schedule", category: "IEP" },
  { name: "Copies of Notes", category: "IEP" },
  { name: "Preferential Seating", category: "504" },
  { name: "Movement Breaks", category: "504" },
  { name: "Use of Fidgets", category: "504" },
  { name: "Extended Deadlines", category: "504" },
  { name: "Bilingual Dictionary", category: "ELL" },
  { name: "Native Language Clarification", category: "ELL" },
  { name: "Sentence Stems", category: "ELL" },
  { name: "Check for Understanding", category: "Strategy" },
  { name: "Reduced Distractions", category: "Strategy" },
];

export interface SeedData {
  teachers: SeedTeacher[];
  students: SeedStudent[];
  accommodations: SeedAccommodation[];
}

export function generateSeedData(opts?: {
  numTeachers?: number;
  numStudents?: number;
  studentsPerSection?: number;
  accommodationRate?: number;
  seed?: number;
}): SeedData {
  const numTeachers = opts?.numTeachers ?? 35;
  const numStudents = opts?.numStudents ?? 600;
  const accommodationRate = opts?.accommodationRate ?? 0.25;
  const rng = makeRng(opts?.seed ?? 42);

  // Distribute planning periods evenly across the 7 periods so every period
  // has the same number of teaching teachers. With 35 teachers / 7 periods,
  // each period gets exactly 5 teachers on planning, leaving 30 teaching.
  const teacherOrder = shuffle(
    rng,
    Array.from({ length: numTeachers }, (_, i) => i),
  );
  const planningByTeacher: number[] = new Array(numTeachers);
  for (let i = 0; i < numTeachers; i++) {
    planningByTeacher[teacherOrder[i]] = (i % 7) + 1;
  }

  // Build teachers. Mr. Davis admin and Ms. Garcia ESE coord are added
  // separately in seed.ts so the testable accounts still log in.
  const teachers: SeedTeacher[] = [];
  const usedEmails = new Set<string>();
  for (let i = 0; i < numTeachers; i++) {
    const first = TEACHER_FIRST[i % TEACHER_FIRST.length];
    const last = TEACHER_LAST[i % TEACHER_LAST.length];
    let email = `${first.toLowerCase()}.${last.toLowerCase()}${i}@school.local`;
    while (usedEmails.has(email)) email = `${email}.x`;
    usedEmails.add(email);
    const planning = planningByTeacher[i];
    const teachingPeriods = [1, 2, 3, 4, 5, 6, 7].filter((p) => p !== planning);
    teachers.push({
      email,
      displayName: `${first.charAt(0)}. ${last}`,
      isAdmin: false,
      isEseCoordinator: false,
      teachingPeriods,
      planningPeriod: planning,
    });
  }

  // Per-period rotation lists so we can round-robin students into sections
  // and end up with an even ~20 students per non-planning section.
  const teachersByPeriod: Record<number, number[]> = {};
  const periodCounters: Record<number, number> = {};
  for (let p = 1; p <= 7; p++) {
    const list: number[] = [];
    for (let t = 0; t < numTeachers; t++) {
      if (teachers[t].teachingPeriods.includes(p)) list.push(t);
    }
    teachersByPeriod[p] = shuffle(rng, list);
    periodCounters[p] = 0;
  }

  // Build students with balanced section assignment.
  const students: SeedStudent[] = [];
  for (let i = 0; i < numStudents; i++) {
    const studentId = `S${(2000 + i).toString()}`;
    const first = pick(rng, FIRST_NAMES);
    const last = pick(rng, LAST_NAMES);
    const grade = 9 + Math.floor(rng() * 4);

    const schedule: Record<number, number> = {};
    for (let period = 1; period <= 7; period++) {
      const list = teachersByPeriod[period];
      if (list.length > 0) {
        schedule[period] = list[periodCounters[period] % list.length];
        periodCounters[period]++;
      }
    }

    // Accommodations: ~25% of students get 1-3 accommodations.
    const accommodationIndices: number[] = [];
    if (rng() < accommodationRate) {
      const count = 1 + Math.floor(rng() * 3); // 1-3
      const idxs = shuffle(rng, MASTER_ACCOMMODATIONS.map((_, k) => k)).slice(0, count);
      accommodationIndices.push(...idxs);
    }

    const hasParent = rng() > 0.2;
    students.push({
      studentId,
      firstName: first,
      lastName: last,
      grade,
      parentName: hasParent ? `${pick(rng, FIRST_NAMES)} ${last}` : null,
      parentEmail: hasParent
        ? `${last.toLowerCase()}.family${i}@example.com`
        : null,
      parentPhone: hasParent
        ? `555-2${String(100 + (i % 900)).padStart(3, "0")}-${String(1000 + i).slice(-4)}`
        : null,
      schedule,
      accommodationIndices,
    });
  }

  return {
    teachers,
    students,
    accommodations: MASTER_ACCOMMODATIONS,
  };
}
