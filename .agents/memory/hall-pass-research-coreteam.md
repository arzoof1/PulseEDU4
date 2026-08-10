---
name: Hall Pass Research Core Team gate
description: School-wide research dashboard gate + visibility alignment for hall-pass research endpoints
---

The school-wide Hall Pass Research surface (school-summary endpoint + whole-school student search) is gated by `canResearchSchoolwide()` in api-server `lib/coreTeam.ts` = `isCoreTeam()` OR guidance counselor / school counselor / social worker / dean. Client mirror: `canResearchSchoolwideClient` near `isCoreTeamMember` in App.tsx — keep both in sync.

**Why:** the director defined this audience explicitly (student-support roles, not just Core Team proper). Review caught that gating aggregates on one predicate while student search still used `getVisibleStudentIds` left deans/social workers able to see school-wide charts but unable to search students.

**How to apply:** all `/hall-passes/research/*` endpoints resolve visibility via the route-local `researchVisibility()` wrapper (full visibility when the gate passes, else normal roster visibility). Any new research endpoint must use the same wrapper, and any change to who can research must touch gate + wrapper + client mirror together.

Other notes:
- Student `summary` returns Core-Team extras (windowPassCount/windowLostMin/windowTardyCount/absenceCount/schedule) as null for teachers — teacher response shape is a compatibility contract.
- "Avg passes per school day" denominator = distinct school-local days with ≥1 pass in the selected window (robust on frozen demo data; don't count wall-clock weekdays).
- Demo pass data lives ~Apr–Jul 2026, so Q1–Q3 windows are legitimately empty; use Year window when testing.
