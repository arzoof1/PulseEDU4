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
  studentFastScoresTable,
} from "@workspace/db";
import { strategyCategoryForBenchmark } from "../routes/mtssPlans.js";
import {
  hasChart,
  placeOnChart,
  placePm3,
  type Subject,
} from "./fastCutScores.js";

const FAST_SUBJECTS = new Set<Subject>(["ela", "math", "algebra1", "geometry"]);

function deriveFastLevel(
  score: number | null | undefined,
  subject: string,
  grade: number | null,
  window: string,
): 1 | 2 | 3 | 4 | 5 | null {
  if (score == null) return null;
  if (grade == null) return null;
  if (!FAST_SUBJECTS.has(subject as Subject)) return null;
  const s = subject as Subject;
  if (!hasChart(s, grade)) return null;
  const placement =
    window === "pm3"
      ? placePm3(score, s, grade)
      : placeOnChart(score, s, grade);
  return placement ? placement.level : null;
}

export interface CategoryWeakness {
  category: string;
  pct: number;
  responseCount: number;
  benchmarkCodes: string[];
}

// Per-benchmark mastery row used by skill-cluster mode. Exposed on
// StudentSkillProfile so the cluster engine can build per-student
// deficit vectors without re-querying item responses. Empty array
// when the student has no item responses for the window.
export interface BenchmarkMastery {
  benchmarkCode: string;
  category: string | null;
  pct: number; // 0..100, integer
  pointsEarned: number;
  pointsPossible: number;
}

export interface StudentSkillProfile {
  studentId: string;
  localSisId: string | null;
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
  // FAST achievement level (1..5) for this (subject, schoolYear,
  // window). Derived from student_fast_scores via fastCutScores
  // placement. Null when no PM score exists, no chart exists for
  // the subject/grade, or grade is unknown.
  fastLevel: 1 | 2 | 3 | 4 | 5 | null;
  // Raw FAST scale score for the requested window. Used by the Cusp
  // Composer to compute "distance from cut" against a chart cut
  // score. Null when no PM score exists.
  fastScore: number | null;
  // True iff the student has at least one instructional category at
  // < 50% mastery — flags a "Below-strand" weakness, even for
  // students whose overall pct is otherwise healthy. Used by the
  // strand-cusp filter for Level-3 kids hiding a weak strand.
  hasBelowStrand: boolean;
  // Per-benchmark mastery (skill-cluster mode input). Always present;
  // empty when the student has no item responses for the window.
  // Sorted by benchmarkCode for stable downstream iteration.
  benchmarks: BenchmarkMastery[];
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
  localSisId: string | null;
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

  const [students, items, scores] = (await Promise.all([
    db
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
    db
      .select({
        studentId: studentFastScoresTable.studentId,
        pm1: studentFastScoresTable.pm1,
        pm2: studentFastScoresTable.pm2,
        pm3: studentFastScoresTable.pm3,
      })
      .from(studentFastScoresTable)
      .where(
        and(
          eq(studentFastScoresTable.schoolId, schoolId),
          eq(studentFastScoresTable.subject, subject),
          eq(studentFastScoresTable.schoolYear, schoolYear),
          inArray(studentFastScoresTable.studentId, studentIds),
        ),
      ),
  ])) as [
    StudentRow[],
    ItemRow[],
    Array<{
      studentId: string;
      pm1: number | null;
      pm2: number | null;
      pm3: number | null;
    }>,
  ];

  const gradeById = new Map(students.map((s) => [s.studentId, s.grade]));
  // Pick the score column matching the requested window; level
  // derivation happens at map-time below using the student's grade.
  const scoreByStudent = new Map<string, number | null>();
  for (const r of scores) {
    const raw =
      window === "pm1" ? r.pm1 : window === "pm2" ? r.pm2 : r.pm3;
    scoreByStudent.set(r.studentId, raw ?? null);
  }

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

  // Per-student benchmark mastery list — built from the same
  // benchmarkAgg map used to roll up categories so the two views
  // are exactly consistent.
  const benchmarksByStudent = new Map<string, BenchmarkMastery[]>();
  for (const [key, b] of benchmarkAgg) {
    const [studentId, code] = key.split("|");
    if (!studentId || !code || b.possible === 0) continue;
    const arr = benchmarksByStudent.get(studentId) ?? [];
    arr.push({
      benchmarkCode: code,
      category: b.category,
      pct: Math.round((b.earned / b.possible) * 100),
      pointsEarned: b.earned,
      pointsPossible: b.possible,
    });
    benchmarksByStudent.set(studentId, arr);
  }
  for (const arr of benchmarksByStudent.values()) {
    arr.sort((a, b) => a.benchmarkCode.localeCompare(b.benchmarkCode));
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
    const rawScore = scoreByStudent.get(s.studentId) ?? null;
    return {
      studentId: s.studentId,
      localSisId: s.localSisId,
      firstName: s.firstName,
      lastName: s.lastName,
      grade: s.grade,
      categories,
      topGaps: categories.slice(0, 3).map((c) => c.category),
      overallPct:
        o && o.possible > 0 ? Math.round((o.earned / o.possible) * 100) : null,
      fastLevel: deriveFastLevel(rawScore, subject, s.grade, window),
      fastScore: rawScore,
      hasBelowStrand: categories.some((c) => c.pct < 50),
      benchmarks: benchmarksByStudent.get(s.studentId) ?? [],
    };
  });
}

// Per-group level mix tally — exported so the route can compute the
// same shape for candidatePool. Keys are "1".."5" plus "unknown".
export type LevelMix = {
  l1: number;
  l2: number;
  l3: number;
  l4: number;
  l5: number;
  unknown: number;
};

export function tallyLevelMix(profiles: StudentSkillProfile[]): LevelMix {
  const mix: LevelMix = { l1: 0, l2: 0, l3: 0, l4: 0, l5: 0, unknown: 0 };
  for (const p of profiles) {
    if (p.fastLevel === 1) mix.l1 += 1;
    else if (p.fastLevel === 2) mix.l2 += 1;
    else if (p.fastLevel === 3) mix.l3 += 1;
    else if (p.fastLevel === 4) mix.l4 += 1;
    else if (p.fastLevel === 5) mix.l5 += 1;
    else mix.unknown += 1;
  }
  return mix;
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
  // Skill-cluster mode only — the N focus standards picked from
  // this group's combined item responses. Empty in other modes.
  focusStandards?: SuggestedFocusStandard[];
}

// Mirror of ClassComposerFocusStandard but without source-window
// fields (the route stamps those before persisting).
export interface SuggestedFocusStandard {
  benchmarkCode: string;
  friendlyLabel: string;
  groupAvgPct: number;
  coverage: number; // 0..1
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

// Balanced clusterer — distributes profiles across N groups so each
// group has a similar level mix AND a similar dominant-skill mix.
// Used by the Regular Class Composer "Balanced" arrangement: a
// scheduler who wants fair / heterogeneous sections rather than
// skill-concentrated intensive groups.
//
// Algorithm: bucket by fastLevel (5..1 then unknown — strongest
// first, mirrors typical roster sweeps), within each bucket sort
// by top-gap category then stable key, then round-robin into the
// N groups. The same level distribution per bucket guarantees each
// group ends with floor/ceil(count/N) of each level, and the
// in-bucket category sort spreads skill weaknesses too.
//
// Honors `seatsPerGroup` as a hard cap — anyone who can't fit is
// returned in `overflow`, same contract as clusterProfilesIntoGroups.
export function clusterProfilesBalanced(
  profiles: StudentSkillProfile[],
  numGroups: number,
  seatsPerGroup: number,
): ClusterResult {
  if (numGroups <= 0) return { groups: [], overflow: [] };

  const groups: SuggestedGroup[] = Array.from({ length: numGroups }, (_, i) => ({
    index: i + 1,
    // Balanced arrangement is intentionally mixed-focus — no single
    // dominant category. UI shows "Mixed" when null.
    dominantCategory: null,
    students: [],
    avgDominantPct: null,
    cohesionPct: 0,
  }));

  // Level buckets, strongest-first so the FIRST round-robin position
  // each group fills is its highest-level student — keeps level
  // distribution visually obvious in the UI's first row.
  const buckets: StudentSkillProfile[][] = [[], [], [], [], [], []];
  // index: 0=L5, 1=L4, 2=L3, 3=L2, 4=L1, 5=unknown
  const idxFor = (lvl: 1 | 2 | 3 | 4 | 5 | null): number => {
    if (lvl == null) return 5;
    return 5 - lvl;
  };
  for (const p of profiles) buckets[idxFor(p.fastLevel)].push(p);
  // Within each bucket: sort by top-gap category then stable key
  // so consecutive round-robin picks tend to land different skill
  // weaknesses in adjacent groups.
  for (const b of buckets) {
    b.sort((a, c) => {
      const ag = a.topGaps[0] ?? "";
      const cg = c.topGaps[0] ?? "";
      if (ag !== cg) return ag.localeCompare(cg);
      return stableProfileKey(a).localeCompare(stableProfileKey(c));
    });
  }

  // Round-robin across groups, with a rotating start per bucket so
  // group 1 isn't always the first to get a high-level student.
  const overflow: StudentSkillProfile[] = [];
  let rotation = 0;
  for (const bucket of buckets) {
    for (let i = 0; i < bucket.length; i += 1) {
      const p = bucket[i];
      // Try N positions starting at (rotation + i) % N, skipping any
      // group already at seat cap.
      let placed = false;
      for (let attempt = 0; attempt < numGroups; attempt += 1) {
        const slot = (rotation + i + attempt) % numGroups;
        if (groups[slot].students.length < seatsPerGroup) {
          groups[slot].students.push(p);
          placed = true;
          break;
        }
      }
      if (!placed) overflow.push(p);
    }
    // Advance rotation by bucket size so the next level starts at a
    // different group — keeps the per-group level mix even when one
    // bucket isn't a clean multiple of N.
    rotation = (rotation + bucket.length) % numGroups;
  }

  // Cohesion / avgDominantPct in balanced mode: leave avgDominantPct
  // null (no single focus), and report cohesion as the share of
  // students whose top-1 gap matches the most-common top-1 in the
  // group — useful as an "even spread" sanity check (lower = more
  // varied, which is the GOAL for balanced).
  for (const g of groups) {
    if (g.students.length === 0) continue;
    const tally = new Map<string, number>();
    for (const s of g.students) {
      const top = s.topGaps[0];
      if (!top) continue;
      tally.set(top, (tally.get(top) ?? 0) + 1);
    }
    let max = 0;
    for (const c of tally.values()) if (c > max) max = c;
    g.cohesionPct = Math.round((max / g.students.length) * 100);
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

// =====================================================================
// Skill-cluster mode — vector clustering on per-benchmark deficits.
//
// Why a separate algorithm from clusterProfilesIntoGroups?
//   The category-based clusterer groups by *which broad strand* each
//   student is weakest in (e.g. "Reading: Vocabulary"). It produces
//   readable groups but two students whose top category matches can
//   still have very different specific-benchmark gaps inside that
//   category. Skill-cluster instead treats each student as a vector
//   of (benchmark → deficit) and uses farthest-first centroid seeding
//   + nearest-centroid assignment to find tight specific-benchmark
//   clusters.
//
// Determinism: profiles are pre-sorted by stableProfileKey; the
// farthest-first seed walks profiles in that fixed order, breaking
// distance ties by stable index. Tie-broken nearest-centroid
// assignment uses min distance then min centroid index. Output is
// reproducible for the same input.
//
// Capacity: each group caps at `seatsPerGroup`. Overflow students
// (no remaining seat in their nearest centroid AND no remaining
// seat in any other group) are surfaced on the result so the UI
// can prompt the admin to add another section, mirroring the
// existing intensive/regular ClusterResult contract.
// =====================================================================

function deficitVector(p: StudentSkillProfile): Map<string, number> {
  const v = new Map<string, number>();
  for (const b of p.benchmarks) {
    // Deficit normalized to 0..1 (100% mastery → 0 deficit; 0% → 1).
    v.set(b.benchmarkCode, Math.max(0, Math.min(1, (100 - b.pct) / 100)));
  }
  return v;
}

// Sparse Euclidean distance over the union of two deficit vectors.
// Missing benchmarks default to 0 (no evidence of deficit) — a
// reasonable null treatment because absence of data is treated as
// "no signal of weakness here" rather than "infinitely weak".
function vectorDistance(
  a: Map<string, number>,
  b: Map<string, number>,
): number {
  let sumSq = 0;
  const keys = new Set<string>();
  for (const k of a.keys()) keys.add(k);
  for (const k of b.keys()) keys.add(k);
  for (const k of keys) {
    const av = a.get(k) ?? 0;
    const bv = b.get(k) ?? 0;
    const d = av - bv;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq);
}

export function clusterByBenchmarkDeficit(
  profiles: StudentSkillProfile[],
  numGroups: number,
  seatsPerGroup: number,
): ClusterResult {
  if (numGroups <= 0) return { groups: [], overflow: [] };

  // Deterministic input order.
  const sorted = [...profiles].sort((a, b) =>
    stableProfileKey(a).localeCompare(stableProfileKey(b)),
  );

  // Split: students with at least one benchmark response go into the
  // clusterable pool; the rest fall through to the round-robin
  // backfill pass (same treatment clusterProfilesIntoGroups gives
  // its "unknown" bucket).
  const withData = sorted.filter((p) => p.benchmarks.length > 0);
  const unknown = sorted.filter((p) => p.benchmarks.length === 0);

  const vectors = withData.map((p) => deficitVector(p));

  // Farthest-first seeding. Seed #0 = student whose total deficit
  // sum is highest (biggest overall weakness, anchors the densest
  // cluster). Subsequent seeds = whichever unseeded student maximizes
  // min distance to existing seeds. Robust against duplicates and
  // converges quickly for the small k (≤ 8) Class Composer uses.
  const seedIndices: number[] = [];
  if (withData.length > 0) {
    let maxSum = -1;
    let maxIdx = 0;
    for (let i = 0; i < vectors.length; i += 1) {
      let s = 0;
      for (const v of vectors[i].values()) s += v;
      if (s > maxSum) {
        maxSum = s;
        maxIdx = i;
      }
    }
    seedIndices.push(maxIdx);
    while (seedIndices.length < numGroups && seedIndices.length < vectors.length) {
      let bestIdx = -1;
      let bestMinDist = -1;
      for (let i = 0; i < vectors.length; i += 1) {
        if (seedIndices.includes(i)) continue;
        let minDist = Infinity;
        for (const s of seedIndices) {
          const d = vectorDistance(vectors[i], vectors[s]);
          if (d < minDist) minDist = d;
        }
        if (minDist > bestMinDist) {
          bestMinDist = minDist;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) break;
      seedIndices.push(bestIdx);
    }
  }

  // Build groups around the seeds. dominantCategory is the seed
  // student's first topGap (a hint for UI labelling; the real
  // semantic content is focusStandards, added downstream).
  const groups: SuggestedGroup[] = [];
  for (let g = 0; g < numGroups; g += 1) {
    const seedI = seedIndices[g];
    const seed = seedI != null ? withData[seedI] : null;
    groups.push({
      index: g + 1,
      dominantCategory: seed?.topGaps[0] ?? null,
      students: [],
      avgDominantPct: null,
      cohesionPct: 0,
    });
  }

  // Place each seed in its own group up front.
  const assigned = new Set<string>();
  for (let g = 0; g < seedIndices.length; g += 1) {
    const seed = withData[seedIndices[g]];
    groups[g].students.push(seed);
    assigned.add(seed.studentId);
  }

  // Compute each remaining student's nearest centroid (by seed
  // vector). Process in descending order of distance-to-nearest so
  // the most clearly-clustered students get their preferred seat
  // before the ambiguous ones spill.
  const remaining: Array<{
    idx: number;
    nearestGroup: number;
    distToNearest: number;
    rankedGroups: number[];
  }> = [];
  for (let i = 0; i < withData.length; i += 1) {
    if (assigned.has(withData[i].studentId)) continue;
    const dists: Array<{ g: number; d: number }> = [];
    for (let g = 0; g < seedIndices.length; g += 1) {
      const d = vectorDistance(vectors[i], vectors[seedIndices[g]]);
      dists.push({ g, d });
    }
    // Sort ascending — closest centroid first; break ties on
    // centroid index for determinism.
    dists.sort((a, b) => (a.d !== b.d ? a.d - b.d : a.g - b.g));
    remaining.push({
      idx: i,
      nearestGroup: dists[0]?.g ?? 0,
      distToNearest: dists[0]?.d ?? 0,
      rankedGroups: dists.map((d) => d.g),
    });
  }
  // Process well-separated students first.
  remaining.sort((a, b) =>
    a.distToNearest !== b.distToNearest
      ? a.distToNearest - b.distToNearest // small distance = high confidence; place first
      : a.idx - b.idx,
  );

  const overflow: StudentSkillProfile[] = [];
  for (const r of remaining) {
    let placed = false;
    for (const g of r.rankedGroups) {
      if (groups[g].students.length < seatsPerGroup) {
        groups[g].students.push(withData[r.idx]);
        assigned.add(withData[r.idx].studentId);
        placed = true;
        break;
      }
    }
    if (!placed) overflow.push(withData[r.idx]);
  }

  // Unknown-data students: round-robin into least-filled groups,
  // honoring the seat cap.
  for (const p of unknown) {
    let target: SuggestedGroup | null = null;
    let lowest = Infinity;
    for (const g of groups) {
      if (g.students.length >= seatsPerGroup) continue;
      if (g.students.length < lowest) {
        lowest = g.students.length;
        target = g;
      }
    }
    if (target) {
      target.students.push(p);
    } else {
      overflow.push(p);
    }
  }

  // Compute avgDominantPct + cohesionPct per group. For skill-cluster
  // the cohesion metric is "fraction of group members whose personal
  // top-3 gaps overlap the group's seed dominantCategory" — a rough
  // homogeneity proxy until pickFocusStandards lands.
  for (const g of groups) {
    if (g.students.length === 0) continue;
    if (g.dominantCategory) {
      let dominantSum = 0;
      let dominantCount = 0;
      let hits = 0;
      for (const s of g.students) {
        const cat = s.categories.find((c) => c.category === g.dominantCategory);
        if (cat) {
          dominantSum += cat.pct;
          dominantCount += 1;
        }
        if (s.topGaps.includes(g.dominantCategory)) hits += 1;
      }
      g.avgDominantPct =
        dominantCount > 0 ? Math.round(dominantSum / dominantCount) : null;
      g.cohesionPct = Math.round((hits / g.students.length) * 100);
    }
  }

  // Stable display order inside each group.
  for (const g of groups) {
    g.students.sort((a, b) =>
      stableProfileKey(a).localeCompare(stableProfileKey(b)),
    );
  }

  return { groups, overflow };
}

// =====================================================================
// Focus standards picker — pick the N benchmarks the teacher should
// target with this group, given the group's combined item responses.
//
// Rules:
//   * Aggregate per-benchmark points-earned / points-possible across
//     the whole group (points-weighted, so a 6-point benchmark
//     contributes more than a 2-point one — same logic the per-
//     student mastery uses).
//   * Coverage = (# group members who attempted the benchmark) /
//     (group size). The floor (default 60%) prevents picking a
//     standard that only a handful of kids in the group actually
//     attempted, which would over-weight noise.
//   * Mastery floor (default ≤ 50%) prevents picking a "weak"
//     standard the group already has working knowledge of.
//   * Sort ascending by groupAvgPct (weakest first), break ties on
//     higher coverage, then stable benchmarkCode lex order.
//   * Take top N. Returns fewer than N if not enough benchmarks
//     meet both floors.
//
// friendlyLabel is currently the same value as the strategy-category
// rollup, prefixed with the benchmark code, e.g.
//   "MA.7.AR.1.1 · Algebraic Reasoning". A later catalog table can
// swap in the FLDOE benchmark long-text without changing callers.
// =====================================================================
export interface PickFocusStandardsOpts {
  count: number;
  masteryFloorPct?: number; // default 50
  coverageFloor?: number; // default 0.6
}

export function pickFocusStandards(
  groupProfiles: StudentSkillProfile[],
  opts: PickFocusStandardsOpts,
): SuggestedFocusStandard[] {
  const masteryFloor = opts.masteryFloorPct ?? 50;
  const coverageFloor = opts.coverageFloor ?? 0.6;
  const groupSize = groupProfiles.length;
  if (groupSize === 0 || opts.count <= 0) return [];

  interface Agg {
    earned: number;
    possible: number;
    studentsWithData: number;
    category: string | null;
  }
  const agg = new Map<string, Agg>();
  for (const p of groupProfiles) {
    if (p.benchmarks.length === 0) continue;
    for (const b of p.benchmarks) {
      const prior = agg.get(b.benchmarkCode) ?? {
        earned: 0,
        possible: 0,
        studentsWithData: 0,
        category: b.category,
      };
      prior.earned += b.pointsEarned;
      prior.possible += b.pointsPossible;
      prior.studentsWithData += 1;
      if (!prior.category && b.category) prior.category = b.category;
      agg.set(b.benchmarkCode, prior);
    }
  }

  const candidates: Array<{
    code: string;
    pct: number;
    coverage: number;
    category: string | null;
  }> = [];
  for (const [code, v] of agg) {
    if (v.possible <= 0) continue;
    const pct = Math.round((v.earned / v.possible) * 100);
    const coverage = v.studentsWithData / groupSize;
    if (pct > masteryFloor) continue;
    if (coverage < coverageFloor) continue;
    candidates.push({ code, pct, coverage, category: v.category });
  }
  candidates.sort((a, b) => {
    if (a.pct !== b.pct) return a.pct - b.pct;
    if (a.coverage !== b.coverage) return b.coverage - a.coverage;
    return a.code.localeCompare(b.code);
  });

  return candidates.slice(0, opts.count).map((c) => ({
    benchmarkCode: c.code,
    friendlyLabel: c.category ? `${c.code} · ${c.category}` : c.code,
    groupAvgPct: c.pct,
    coverage: Math.round(c.coverage * 1000) / 1000,
  }));
}

// Per-student improvement % a move into a different group would yield
// — used by the PM1 check-fit drift report. Returns the *fractional*
// reduction in distance-to-centroid the student would experience by
// moving from their current group to the candidate group.
//   improvementPct =
//     (currentDist - candidateDist) / currentDist
//
// Returns 0 when currentDist is 0 (already perfectly matched). Caller
// thresholds against this value (default 25%) before suggesting.
export function deficitMoveImprovement(
  student: StudentSkillProfile,
  currentGroup: StudentSkillProfile[],
  candidateGroup: StudentSkillProfile[],
): number {
  const sv = deficitVector(student);
  const centroid = (members: StudentSkillProfile[]): Map<string, number> => {
    const c = new Map<string, number>();
    let count = 0;
    for (const m of members) {
      if (m.studentId === student.studentId) continue;
      const v = deficitVector(m);
      for (const [k, val] of v) {
        c.set(k, (c.get(k) ?? 0) + val);
      }
      count += 1;
    }
    if (count === 0) return c;
    for (const k of c.keys()) c.set(k, (c.get(k) ?? 0) / count);
    return c;
  };
  const currentDist = vectorDistance(sv, centroid(currentGroup));
  const candidateDist = vectorDistance(sv, centroid(candidateGroup));
  if (currentDist === 0) return 0;
  return Math.max(0, (currentDist - candidateDist) / currentDist);
}
