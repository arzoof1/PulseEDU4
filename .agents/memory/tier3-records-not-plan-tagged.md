---
name: Tier 3 records are not plan-tagged
description: Why per-plan MTSS Tier 3 reports must scope to a plan's effective teachers, or multi-plan students cross-contaminate.
---

`tier3_weekly_records` (and `tier2_intervention_entries`) are keyed by
`(school_id, student_id, teacher_staff_id, week)` — they are NOT tagged with
the originating MTSS plan id.

**Consequence:** a student with BOTH a behavior Tier 3 plan (auto-assign =
whole schedule) and an academic Tier 3 plan (manual mode, single named
interventionist) will have records from EVERY schedule teacher. A naive
per-plan report that pulls all records for the plan's students credits every
teacher to every plan — so the academic report wrongly showed all ~6 schedule
teachers instead of just the academic interventionist.

**Rule:** any per-plan / per-segment Tier 3 (or Tier 2) aggregation in
`routes/mtssReports.ts` must restrict records to the teachers responsible for
the *filtered* plans, derived from `effectiveTeacherIdsForPlan`. Build an
allowed `${studentId}::${teacherStaffId}` Set from the filtered plans and
guard every record loop. There are 4 T3 loops (weeklyTrend, perTeacher,
t3GoalTrend, t3DayOfWeek) — scope all of them in lockstep or the panels
disagree.

**Why manual vs auto matters:** academic Tier 3 plans are manual-mode with a
single `assignedTeacherIds` interventionist → strict to that list. Auto-assign
plans (typical behavior plans) additionally union in any teacher who logged a
record in range, to preserve past-contributor credit when a schedule changes
(documented intent in `effectiveTeachers.ts`).
