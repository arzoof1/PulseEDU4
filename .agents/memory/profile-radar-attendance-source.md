---
name: Student Profile radar Attendance axis source
description: The whole-child radar "flow" axis is a separate calc from the shared attendance reader and must load absences explicitly.
---

The Student Profile endpoint `GET /api/insights/students/:studentId/profile`
builds the whole-child radar. Its "flow" axis is **labeled "Attendance"** but was
historically computed only from tardies + ISS days + hall passes — it never read
student absences. The handler even imported `loadAttendanceMetrics` but did not
call it, so absences uploaded via the Eligibility Hub (`eligibility_absences`)
never reached the profile radar or the "Attendance & Flow" section.

**Rule:** any surface that shows a student's attendance/absences must read from
`loadAttendanceMetrics` (`lib/attendanceMetrics.ts`, backed by
`eligibility_absences`) — the SAME reader used by Insights lists, Teacher Roster,
and Early Warning. The profile radar is a separate computation and does NOT
inherit that automatically; call the reader explicitly in the handler.

**Why:** the Eligibility Hub is the school-wide source of truth for cumulative
semester absences. Surfaces that roll their own attendance calc silently disagree
(e.g. a student with 11 uploaded absences showed Attendance=100). Users treat any
disagreement as "attendance isn't updating app-wide."

**How to apply:** when the "flow"/Attendance axis or the profile Attendance
section is wrong, check whether the handler actually calls `loadAttendanceMetrics`
and feeds `daysAbsent`/`attendancePct` into the score + rationale + payload.
Note the timeframe mix: absences are semester-cumulative; tardy/ISS/hall-pass
counts are windowed — label this in the UI to avoid confusion.
