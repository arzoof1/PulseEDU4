// Skill-profile engine — shared core for Intensive Group Insights.
//
// Given a set of students, a FAST subject, a school year, and a PM
// window, returns each student's instructional-category weakness
// vector built from `student_fast_item_responses` (Phase 1 import).
//
// Read-only on top of existing tables. No writes. School-scoped.

import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  studentsTable,
  studentFastItemResponsesTable,
} from "@workspace/db";
import { strategyCategoryForBenchmark } from "../routes/mtssPlans.js";

export interface CategoryWeakness {
  category: string;
  pct: number;
  responseCount: number;
  benchmarkCodes: string[];
}

export interface StudentSkillProfile {
  studentId: string;
  firstName: string | null;
  lastName: string | null;
  grade: number | null;
  // All instructional categories the student has any response for,
  // sorted weakest-first (lowest pct).
  categories: CategoryWeakness[];
  // Convenience top-3 weakest. Empty when student has no response
  // data for this (subject, schoolYear, window).
  topGaps: string[];
  // Overall average mastery percent across all benchmarks (rough
  // "where is this student" indicator — used to seed the
  // eligibility filter in the composer).
  overallPct: number | null;
}

export interface SkillProfileInput {
  schoolId: number;
  subject: string;
  schoolYear: string;
  window: string;
  studentIds: string[];
}

interface ItemRow {
  studentId: string;
  category: string | null;
  benchmarkCode: string;
  pointsEarned: number | null;
  pointsPossible: number | null;
}

interface StudentRow {
  studentId: string;
  firstName: string | null;
  lastName: string | null;
  grade: number | null;
}

// Same grade-gate the heatmap uses — drop benchmark rows whose
// grade segment doesn't match the student's roster grade so a
// 7th-grader's stray 8th-grade rows don't pollute the profile.
function codeMatchesGrade(
  code: string,
  grade: number | null,
): boolean {
  if (grade == null) return true;
  const seg = Number(code.split(".")[1]);
  if (!Number.isFinite(seg)) return false;
  return seg === grade;
}

export async function computeSkillProfiles(
  input: SkillProfileInput,
): Promise<StudentSkillProfile[]> {
  const { schoolId, subject, schoolYear, window, studentIds } = input;
  if (studentIds.length === 0) return [];

  const [students, items] = (await Promise.all([
    db
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
          inArray(studentsTable.studentId, studentIds),
        ),
      ),
    db
      .select({
        studentId: studentFastItemResponsesTable.studentId,
        category: studentFastItemResponsesTable.category,
        benchmarkCode: studentFastItemResponsesTable.benchmarkCode,
        pointsEarned: studentFastItemResponsesTable.pointsEarned,
        pointsPossible: studentFastItemResponsesTable.pointsPossible,
      })
      .from(studentFastItemResponsesTable)
      .where(
        and(
          eq(studentFastItemResponsesTable.schoolId, schoolId),
          eq(studentFastItemResponsesTable.subject, subject),
          eq(studentFastItemResponsesTable.schoolYear, schoolYear),
          eq(studentFastItemResponsesTable.window, window),
          inArray(studentFastItemResponsesTable.studentId, studentIds),
        ),
      ),
  ])) as [StudentRow[], ItemRow[]];

  const gradeById = new Map(students.map((s) => [s.studentId, s.grade]));

  // Aggregate (student, benchmark) → {earned, possible, category}.
  interface BAgg {
    earned: number;
    possible: number;
    category: string | null;
  }
  const benchmarkAgg = new Map<string, BAgg>();
  for (const r of items) {
    if (r.pointsPossible == null) continue;
    if (!codeMatchesGrade(r.benchmarkCode, gradeById.get(r.studentId) ?? null)) {
      continue;
    }
    const key = `${r.studentId}|${r.benchmarkCode}`;
    const prior = benchmarkAgg.get(key) ?? {
      earned: 0,
      possible: 0,
      category: r.category,
    };
    prior.earned += r.pointsEarned ?? 0;
    prior.possible += r.pointsPossible;
    if (!prior.category && r.category) prior.category = r.category;
    benchmarkAgg.set(key, prior);
  }

  // Roll up to (student, instructional-category): points-weighted
  // mastery percent so a 10-point benchmark counts more than a
  // 2-point one inside the same category.
  interface CAgg {
    earned: number;
    possible: number;
    codes: Set<string>;
  }
  const studentCatAgg = new Map<string, Map<string, CAgg>>();
  // Overall totals for the headline overall pct.
  const overall = new Map<string, { earned: number; possible: number }>();
  for (const [key, b] of benchmarkAgg) {
    const [studentId, code] = key.split("|");
    if (!studentId || !code || b.possible === 0) continue;
    const cat = strategyCategoryForBenchmark(b.category, code);
    let perStudent = studentCatAgg.get(studentId);
    if (!perStudent) {
      perStudent = new Map();
      studentCatAgg.set(studentId, perStudent);
    }
    const prior = perStudent.get(cat) ?? {
      earned: 0,
      possible: 0,
      codes: new Set<string>(),
    };
    prior.earned += b.earned;
    prior.possible += b.possible;
    prior.codes.add(code);
    perStudent.set(cat, prior);

    const o = overall.get(studentId) ?? { earned: 0, possible: 0 };
    o.earned += b.earned;
    o.possible += b.possible;
    overall.set(studentId, o);
  }

  return students.map((s) => {
    const cats = studentCatAgg.get(s.studentId);
    let categories: CategoryWeakness[] = [];
    if (cats) {
      categories = Array.from(cats.entries())
        .map(([category, a]) => ({
          category,
          pct: Math.round((a.earned / a.possible) * 100),
          responseCount: a.codes.size,
          benchmarkCodes: Array.from(a.codes).sort(),
        }))
        .sort((a, b) => {
          if (a.pct !== b.pct) return a.pct - b.pct;
          if (a.responseCount !== b.responseCount) {
            return b.responseCount - a.responseCount;
          }
          return a.category.localeCompare(b.category);
        });
    }
    const o = overall.get(s.studentId);
    return {
      studentId: s.studentId,
      firstName: s.firstName,
      lastName: s.lastName,
      grade: s.grade,
      categories,
      topGaps: categories.slice(0, 3).map((c) => c.category),
      overallPct:
        o && o.possible > 0 ? Math.round((o.earned / o.possible) * 100) : null,
    };
  });
}

// Pure helper — given a set of profiles, partition them into N groups
// of approximately `seats` students each by maximizing intra-group
// similarity of weakness profiles. Algorithm: rank candidates by
// their dominant weak category, fill groups one dominant-category
// bucket at a time. Greedy, deterministic, O(n log n + n*g).
//
// Eligibility filtering (e.g. "only students below X% overall") is
// the caller's responsibility — pass only the eligible profiles in.
export interface SuggestedGroup {
  index: number;
  // The category this group is built around. May be null if the
  // group is a leftover bucket of students with no item data.
  dominantCategory: string | null;
  students: StudentSkillProfile[];
  // Average dominant-gap mastery pct across the group (lower = more
  // homogeneously weak in this skill).
  avgDominantPct: number | null;
  // Share of group whose top-1 weak category matches the group's
  // dominantCategory. High = clean fit.
  cohesionPct: number;
}

export interface ClusterResult {
  groups: SuggestedGroup[];
  // Students who couldn't be placed without exceeding `seatsPerGroup`.
  // Surfaced to the caller so the UI can show "X students need
  // additional sections" rather than silently overflowing one card.
  overflow: StudentSkillProfile[];
}

// Stable secondary sort key — name then studentId — keeps cluster
// output reproducible across DB return order tie-shuffles.
function stableProfileKey(p: StudentSkillProfile): string {
  return `${p.lastName ?? ""}|${p.firstName ?? ""}|${p.studentId}`;
}

export function clusterProfilesIntoGroups(
  profiles: StudentSkillProfile[],
  numGroups: number,
  seatsPerGroup: number,
): ClusterResult {
  if (numGroups <= 0) return { groups: [], overflow: [] };

  // Defensive pre-sort: lock input order so clustering output is
  // deterministic regardless of how the DB returned rows.
  profiles = [...profiles].sort((a, b) =>
    stableProfileKey(a).localeCompare(stableProfileKey(b)),
  );

  // Profiles with no data go in a separate "unknown" bucket — we
  // never strand them in a category they don't belong to.
  const withData = profiles.filter((p) => p.topGaps.length > 0);
  const unknown = profiles.filter((p) => p.topGaps.length === 0);

  // Tally dominant-category frequency.
  const tally = new Map<string, number>();
  for (const p of withData) {
    const top = p.topGaps[0];
    tally.set(top, (tally.get(top) ?? 0) + 1);
  }
  // Categories ordered by frequency descending; ties broken by
  // alphabetical so output is deterministic.
  const ranked = Array.from(tally.entries())
    .sort((a, b) => {
      if (a[1] !== b[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .map(([cat]) => cat);

  // Allocate groups: walk the ranked category list, assigning each
  // group to the next category. If we run out of categories, repeat
  // (e.g. 5 groups, 3 categories → categories[0], 1, 2, 0, 1).
  const groupCategories: (string | null)[] = [];
  for (let i = 0; i < numGroups; i += 1) {
    groupCategories.push(ranked[i % Math.max(ranked.length, 1)] ?? null);
  }

  // Bucket students by their top category for cheap pulling.
  const byTop = new Map<string, StudentSkillProfile[]>();
  for (const p of withData) {
    const top = p.topGaps[0];
    const arr = byTop.get(top) ?? [];
    arr.push(p);
    byTop.set(top, arr);
  }
  // Within each category, sort weakest-first so the most-in-need
  // students get assigned first (so leftover seats absorb the
  // less-acute kids). Tie-break on stable key for determinism.
  for (const arr of byTop.values()) {
    arr.sort((a, b) => {
      const ap = a.categories[0]?.pct ?? 100;
      const bp = b.categories[0]?.pct ?? 100;
      if (ap !== bp) return ap - bp;
      return stableProfileKey(a).localeCompare(stableProfileKey(b));
    });
  }

  const assigned = new Set<string>();
  const groups: SuggestedGroup[] = groupCategories.map((cat, i) => ({
    index: i + 1,
    dominantCategory: cat,
    students: [],
    avgDominantPct: null,
    cohesionPct: 0,
  }));

  // Pass 1: fill each group with its matching-category students
  // up to seatsPerGroup.
  for (const g of groups) {
    if (!g.dominantCategory) continue;
    const pool = byTop.get(g.dominantCategory) ?? [];
    while (g.students.length < seatsPerGroup && pool.length > 0) {
      const next = pool.shift()!;
      if (assigned.has(next.studentId)) continue;
      g.students.push(next);
      assigned.add(next.studentId);
    }
  }

  // Pass 2: spill leftovers — anyone unassigned (because their
  // category's bucket was bigger than its group's seats, or because
  // the seats outnumbered candidates in this category) gets pushed
  // into the most-under-capacity group whose dominantCategory is
  // in their top-3 gaps. Falls back to least-full group.
  const leftovers: StudentSkillProfile[] = [];
  for (const p of withData) {
    if (!assigned.has(p.studentId)) leftovers.push(p);
  }
  leftovers.sort((a, b) => {
    const ap = a.categories[0]?.pct ?? 100;
    const bp = b.categories[0]?.pct ?? 100;
    if (ap !== bp) return ap - bp;
    return stableProfileKey(a).localeCompare(stableProfileKey(b));
  });
  const overflow: StudentSkillProfile[] = [];
  for (const p of leftovers) {
    let target: SuggestedGroup | null = null;
    let bestScore = -1;
    for (const g of groups) {
      if (g.students.length >= seatsPerGroup) continue;
      const inTop =
        g.dominantCategory && p.topGaps.includes(g.dominantCategory) ? 1 : 0;
      // Score: prefer matching top-gap, then least-filled.
      const score = inTop * 1000 + (seatsPerGroup - g.students.length);
      if (score > bestScore) {
        bestScore = score;
        target = g;
      }
    }
    if (!target) {
      // Hard cap honored — surface unplaced students to the caller
      // instead of silently overflowing a card.
      overflow.push(p);
      continue;
    }
    target.students.push(p);
    assigned.add(p.studentId);
  }

  // Pass 3: unknown (no data) students. Distribute round-robin to
  // the smallest groups, but honor the seat cap. Stable order keeps
  // assignment reproducible.
  const orderedUnknown = [...unknown].sort((a, b) =>
    stableProfileKey(a).localeCompare(stableProfileKey(b)),
  );
  for (const p of orderedUnknown) {
    const candidates = groups.filter((g) => g.students.length < seatsPerGroup);
    if (candidates.length === 0) {
      overflow.push(p);
      continue;
    }
    const target = candidates.reduce((best, g) =>
      g.students.length < best.students.length ? g : best,
    );
    target.students.push(p);
  }

  // Compute cohesion + average dominant pct per group.
  for (const g of groups) {
    if (g.students.length === 0) continue;
    if (g.dominantCategory) {
      let matched = 0;
      let sumPct = 0;
      let sumPctCount = 0;
      for (const s of g.students) {
        if (s.topGaps[0] === g.dominantCategory) matched += 1;
        const cat = s.categories.find((c) => c.category === g.dominantCategory);
        if (cat) {
          sumPct += cat.pct;
          sumPctCount += 1;
        }
      }
      g.cohesionPct = Math.round((matched / g.students.length) * 100);
      g.avgDominantPct =
        sumPctCount > 0 ? Math.round(sumPct / sumPctCount) : null;
    }
  }

  return { groups, overflow };
}

// Reduce a set of profiles to an aggregate "section profile" — the
// dominant gap categories with student counts and the homogeneity
// score (share of students whose top-2 gaps overlap with the
// section's top-2).
export interface SectionProfile {
  totalStudents: number;
  studentsWithData: number;
  dominantCategories: Array<{
    category: string;
    studentCount: number;
    avgPct: number;
  }>;
  homogeneityPct: number;
  recommendedFocusCodes: string[];
}

export function summarizeSection(
  profiles: StudentSkillProfile[],
): SectionProfile {
  const totalStudents = profiles.length;
  const withData = profiles.filter((p) => p.topGaps.length > 0);
  // Tally top-1 categories.
  const tally = new Map<string, { count: number; sumPct: number }>();
  for (const p of withData) {
    const top = p.topGaps[0];
    const cat = p.categories[0];
    const prior = tally.get(top) ?? { count: 0, sumPct: 0 };
    prior.count += 1;
    prior.sumPct += cat?.pct ?? 0;
    tally.set(top, prior);
  }
  const dominantCategories = Array.from(tally.entries())
    .sort((a, b) => {
      if (a[1].count !== b[1].count) return b[1].count - a[1].count;
      return a[0].localeCompare(b[0]);
    })
    .slice(0, 4)
    .map(([category, v]) => ({
      category,
      studentCount: v.count,
      avgPct: Math.round(v.sumPct / v.count),
    }));

  // Homogeneity: share of withData whose top-1 OR top-2 overlaps
  // with the section's top-2 dominant categories.
  const sectionTop2 = new Set(dominantCategories.slice(0, 2).map((d) => d.category));
  let homogeneousCount = 0;
  for (const p of withData) {
    const studentTop2 = new Set(p.topGaps.slice(0, 2));
    let hit = false;
    for (const c of sectionTop2) {
      if (studentTop2.has(c)) {
        hit = true;
        break;
      }
    }
    if (hit) homogeneousCount += 1;
  }
  const homogeneityPct =
    withData.length > 0
      ? Math.round((homogeneousCount / withData.length) * 100)
      : 0;

  // Recommended focus codes: pick the weakest 5 codes whose
  // category appears in the dominant list, ranked by aggregate
  // weakness across the section.
  const codeAgg = new Map<
    string,
    { sumPct: number; count: number; category: string }
  >();
  const focusCats = new Set(dominantCategories.map((d) => d.category));
  for (const p of withData) {
    for (const c of p.categories) {
      if (!focusCats.has(c.category)) continue;
      for (const code of c.benchmarkCodes) {
        const prior = codeAgg.get(code) ?? {
          sumPct: 0,
          count: 0,
          category: c.category,
        };
        prior.sumPct += c.pct;
        prior.count += 1;
        codeAgg.set(code, prior);
      }
    }
  }
  const recommendedFocusCodes = Array.from(codeAgg.entries())
    .map(([code, v]) => ({
      code,
      avgPct: v.sumPct / v.count,
      count: v.count,
    }))
    .sort((a, b) => {
      if (a.avgPct !== b.avgPct) return a.avgPct - b.avgPct;
      if (a.count !== b.count) return b.count - a.count;
      return a.code.localeCompare(b.code);
    })
    .slice(0, 5)
    .map((x) => x.code);

  return {
    totalStudents,
    studentsWithData: withData.length,
    dominantCategories,
    homogeneityPct,
    recommendedFocusCodes,
  };
}

// Intensive section detection. v1 is heuristic-only on the course
// name; a later admin override column on class_sections can layer
// on top without changing callers.
const INTENSIVE_NAME_RE =
  /\b(intensive|reading\s+lab|math\s+lab|read\s*180|math\s*180|iii|tier\s*[23]|saxon)\b/i;

export function isIntensiveCourseName(name: string | null | undefined): boolean {
  if (!name) return false;
  return INTENSIVE_NAME_RE.test(name);
}
