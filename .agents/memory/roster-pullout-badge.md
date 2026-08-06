---
name: Roster pull-out badge + inline request
description: Teacher Roster 📤 button — YTD pull-out count keyed by referring teacher, prefilled request handoff, sidebar entry hidden for plain teachers.
---
- Count attribution is `referring_teacher_staff_id = target teacher` (NOT requested_by), so admin-on-behalf requests count toward the teacher. All statuses count (incl. rejected); the hover card shows per-request status.
- YTD window = `schoolYearStartDate(new Date(), await getSchoolTimezone(schoolId))` — the tz arg is REQUIRED; the default is Eastern and mis-buckets July-1 boundary requests for other zones. pullouts.requestedAt is text ISO, lexicographic gte is fine.
- Hidden-but-reachable nav pattern: hiding a sidebar item (all THREE spots — Quick Access add(), static quickAccessBase canShow, grouped renderNavItem) does not block the activeSection; there is no section-level role guard on requestPullout, so the roster button handoff still works.
- Prefill handoff: App-level `pulloutPrefillStudentId` + `initialStudentId` prop; an App useEffect clears it whenever activeSection ≠ requestPullout so sidebar visits by support staff never preselect a stale student.
- Badge UX: no number at 0 (button is still the request entry), gray 1–2, amber 3+; popover copies BehaviorPill's fixed-position pattern.

**Why:** teachers requested pull-outs from a sidebar form with no context; the badge surfaces "this student leaves your class a lot" at the point of action.
