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
