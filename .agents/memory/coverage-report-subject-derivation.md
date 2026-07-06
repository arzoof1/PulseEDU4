---
name: Coverage Report subject derivation
description: How the FAST Coverage Report picks a teacher's subject, and why it must come from course names not roster data.
---

# Coverage Report — subject follows the teacher

The Coverage Report (teacher effectiveness) reads `student_fast_item_responses`
(item-level, subject-tagged). Florida FAST only has benchmark-level data for
**ELA, grade-level Math, Algebra 1 EOC, Geometry EOC**. Science / Social Studies
have only aggregate PM3 (School Grade, `schoolGrade.ts`), NOT item-level — so a
per-benchmark coverage report is impossible for them.

**Rule:** the teacher's subject is derived server-side from their
`class_sections.course_name` via `fastSubjectsForCourses()` (route
`/coverage-report/context`), NOT from their roster's FAST data.

**Why:** roster students carry FAST data for *every* subject they take, so a
math teacher's roster also has ELA responses — roster data can't tell you what a
teacher *teaches*. Course name is the only reliable signal.

**How to apply:**
- Classifier gotchas (all verified against real data): the Florida `M/J` prefix
  = Middle/Junior and appears on every subject (M/J Science, M/J Civics) — it is
  NOT a math signal. Algebra 2 has no FAST EOC (exclude). Pre-algebra is
  grade-level Math. `geometry`→geometry, `algebra`(not 2/pre)→algebra1.
- Demo school with real FAST data is `school_id=1`; its course names are clean
  and descriptive ("Math — Grade 6", "ELA — Grade 7", "Science — Grade 8").
  A different school uses opaque names ("Section P5") but has zero FAST data, so
  its report is empty regardless.
- 0 subjects → client shows a "not FAST-assessed" empty state; 1 → static label
  (no buttons); >1 (elementary ELA+Math, or Math+Algebra1) → compact toggle.
- Report fetch is gated to only run when the selected subject ∈ availableSubjects;
  the context effect needs a stale-response guard (cancelled flag) since teacher
  changes fire it repeatedly.

## Department content-affinity (subjects shown before own-subject data exists)

On top of the course-name derivation, `resolveTeacherSubjects(courseNames, dept)`
adds a **department content-affinity baseline**: Science→FAST Math, Social
Studies→FAST ELA (ELA→ela, Math→math map to themselves). Rationale: a teacher's
students are FAST-assessed on the subject their content leans on even when the
teacher isn't FAST-tested. The affinity subject is added **only when that content
FAMILY isn't already covered** — `fastFamilyOf()` collapses math/algebra1/geometry
into one "math" family, so a Math teacher who also teaches Algebra 1 does NOT get a
redundant plain-Math add. Department comes from `clampDepartment(staff.department)`
falling back to `inferDepartment(courseNames)` (same source the teacher pickers use).

**Why the split:** Science/SS teachers' OWN benchmark subject (their own item-level
data) will surface later once a *separate* benchmark-level upload feature exists —
that is purely data-driven and needs no change to this resolver.

## Data-driven Term (window) selector

The window/term selector is data-driven for ALL kinds: FAST uses PM1–PM3, quarter-
assessed benchmark subjects use Q1–Q4. `VALID_WINDOWS` includes `pm1..pm3 + q1..q4`;
a single module-level `WINDOW_RANK` orders newest-first (pm3/pm2/pm1=0/1/2,
q4/q3/q2/q1=0/1/2/3). **Invariant relied on:** PM and quarter windows never coexist
for one subject, so one rank table is unambiguous. `availableWindows` only lists
windows that actually have data, so quarters appear automatically once a quarter
upload lands — no code change. The per-benchmark `growth` map is
`Record<string, number|null>` looped over `VALID_WINDOWS`; extra q-keys are harmless
(client reads only growth.pm1/2/3).

## Client teacher-default race (fixed)

The picker must match the Teacher Roster (search + dept-grouped + alpha within dept;
no custom selectStyle, no "Me" option; picker only rendered when teachers.length>1).
`teacherId` defaults to the signed-in user via a `defaultTeacherId` prop
(App passes `authUser?.id`). **Gotcha:** `defaultTeacherId` can hydrate AFTER mount
(auth still loading). Do NOT self-default inside the `[]`-scoped teacher-fetch effect
(stale closure) and do NOT use a null-guarded late-arrival effect alone (it can't
correct an already-auto-picked teachers[0]). Correct pattern: one effect on
`[defaultTeacherId, teachers, teacherId]` that sets self when known (else teachers[0]
fallback), guarded by a `userPickedRef` set in the picker's onChange so it never
reverts a deliberate core-team pick.
