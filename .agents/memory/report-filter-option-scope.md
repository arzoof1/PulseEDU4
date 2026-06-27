---
name: Report filter-option scope
description: A report's filter dropdown options must be scoped by the report's OWN privilege gate, not borrowed from a parent component's narrower scope.
---

When a report/page is gated to privilege set A but reuses filter options
(sections, teachers, etc.) that a parent component loaded under a narrower
privilege set B, users in `A − B` see the filter controls but get incomplete
(self-only) options — the controls silently under-serve them.

**Why:** In the PBIS Hub, the Reports view was privileged for
superuser/admin/ESE/**PBIS coordinator**, but the hub's section/teacher props
were loaded under `adminScope` = superuser/admin/ESE only. A PBIS coordinator
saw the teacher/class filters but only their own sections.

**How to apply:** Give the report a self-contained options endpoint that
mirrors the report's own privilege gate (same role set, same school scope),
and have the view fetch its own options instead of taking parent props.
Don't widen the parent's scope (that changes unrelated tabs). Precedent:
`GET /reports/pbis-wallets/options` in `routes/reports.ts` feeding
`PbisPointsReportView` in `PbisPointsHub.tsx`.
