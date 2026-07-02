---
name: Gradebook course_desc is 15-char truncated
description: Subject inference against imported gradebook course names must handle truncation
---

The gradebook import stores `student_course_grades.course_desc` truncated to
~15 chars ("M/J LANG ARTS 2", "M/J GRADE 7 MAT", "M/J COMPRE SCI").

**Why:** Any regex/keyword subject sniff written against full course names
silently matches NOTHING on this table — e.g. "math" never appears (truncated
to trailing "MAT"), "language arts" appears only as "LANG ARTS". A D/F scope
filter returned 0 students because of this; the query was correct, the
matcher wasn't.

**How to apply:** When inferring ela/math (or any subject) from
`course_desc`, include truncated variants (`lang\s*arts`, trailing `\bmat\b`)
— see `inferFastSubject` in `routes/dataChats.ts`. Verify against real rows
(`SELECT DISTINCT course_desc`) rather than assuming full names. Section
`class_sections.course_name` is NOT truncated; only the gradebook import is.
