---
name: Hall-pass report feed scoping + first day of school
description: How Overview/YTD hall-pass reports are scoped and where YTD windows start
---
- Client Overview/YTD hall-pass reports must compute ONLY from the scoped `report-feed` endpoint (`/hall-passes/research/report-feed`), never from the unscoped `GET /api/hall-passes` list (that list stays school-wide for the live pass board).
- Privileged for hall-pass reports = isCoreTeam ∪ isEseCoordinator (school-wide); everyone else is scoped via getVisibleStudentIds. Daily `/reports/hall-passes` and the feed both return `scoped` so the UI can label "your students only".
- All hall-pass YTD windows start on the admin-set `school_settings.first_day_of_school` when it belongs to the current school year, else Aug 1 (yearOpenDay/quarterWindow in hallPassResearch.ts). Q1 opens on it too.
- **Why:** report sections used to derive from the whole-school pass list client-side (teacher data leak) and the YTD chart started Jan 1.
- **How to apply:** any new report card in the hall-pass reports hub must read hpFeed (passes + students), keep empty-visibility responses shape-stable (`students: []`, deterministic firstDay), and never fall back to the global roster/pass state.
