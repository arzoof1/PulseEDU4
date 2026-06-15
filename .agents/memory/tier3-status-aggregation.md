---
name: Tier 3 status per-student aggregation
description: Why /interventions/my-tier3-status must collapse plan rows to one row per student server-side, using MAX not SUM.
---

The Teacher Roster Tier 3 pill consumes `GET /interventions/my-tier3-status`
and builds a `Map<studentId, missingDayCount>` on the client. The producer
(`computeTier3StatusForTeacher` in `routes/interventionsBell.ts`) iterates
active Tier 3 plans, so a student with >1 active Tier 3 plan would emit
multiple rows and the client map would silently drop all but the last.

**Rule:** any status endpoint whose client collapses rows by an id must
aggregate by that id server-side.

**Why MAX, not SUM:** the Tier 3 weekly record is keyed by
`(student, teacher, week)` — NOT by plan. Summing per-plan missing-day
counts double-counts the shared record's already-scored days. MAX = "you
owe up to N days this week."

**How to apply:** keep the per-student collapse in
`computeTier3StatusForTeacher` (max missing days, highest plan id). If a
new surface needs per-plan granularity, add a separate field rather than
un-collapsing this one.
