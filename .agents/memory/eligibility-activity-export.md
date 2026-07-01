---
name: Eligibility per-activity CSV/PDF export
description: How the Eligibility Hub roster export derives its "as of" date and avoids UI/file date drift.
---

Per-activity eligibility export (select a team/club, then Download CSV or PDF)
lives in `routes/eligibility.ts` as `GET /eligibility/activities/:id/roster.csv|.pdf`.

- The "Attendance Eligibility as of <date>" date is the latest attendance
  upload for the school+semester (`eligibility_uploads.created_at`, filtered by
  `schoolId` + `semesterLabel`), NOT "now".
- **Format the date server-side once** and hand the SAME formatted string to
  every surface: the roster GET JSON returns `asOfLabel`, and the CSV/PDF
  headers use the same `formatAsOf()` output.
  **Why:** an earlier pass formatted the file server-side (Eastern tz) but the
  UI label with browser-local `toLocaleDateString()` — that produced off-by-one
  date drift between the on-screen label and the downloaded file header.
  **How to apply:** any new surface showing this date must consume the
  server-formatted `asOfLabel`, never re-format the ISO `asOf` client-side.
- Exports reuse `rosterForActivity()`, are `requireStaff + requireManager` and
  school-scoped via `activityInSchool()` (returns null for bad/foreign id).
- FLEID boundary: CSV "SIS ID" column is `localSisId`, never `studentId`.
