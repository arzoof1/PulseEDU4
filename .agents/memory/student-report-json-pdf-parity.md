---
name: Student report JSON + PDF parity
description: The per-student Classroom Intervention Report serves JSON and a printable PDF from one shared loader; keep them in lock-step.
---

# Classroom Intervention Report — JSON + PDF parity

`GET /interventions/student-report/:studentId` (JSON) and
`GET /interventions/student-report/:studentId/pdf?teacher=` both build from the
shared `loadStudentReport()` + `summarizeInterventions()` +
`filterReportByTeacher()` helpers in `routes/interventions.ts`.

**Invariants:**
- Both routes gated `requireStaff` + `isCoreTeam` (admin/Core-Team only).
- The JSON response shape must stay unchanged (windowDays/student/behaviors/
  interventions/summary) — the staff client depends on it.
- PDF renders `student.localSisId ?? "—"` only — never the FLEID `studentId`.
- PDF text uses WinAnsi-safe glyphs only (• and — OK; no ✓/↻/emoji).

**How to apply:** add new fields/filters in the shared helpers so JSON, PDF,
CSV (client) and the on-screen tables all agree.
