---
name: Contact-rate escalation grouping
description: Why teacher escalation/grouping must key on staff id, not display name
---

When grouping students by responsible teacher to send per-teacher emails (e.g.
Contact Rate "email teachers with incomplete calls"), group and resolve the
recipient by `staff.id`, never by `staff.displayName`.

**Why:** Display names are not unique within a school (two "J. Smith" rows).
Grouping by name merges two teachers' outstanding-student lists and sends one
teacher another teacher's student roster — a student-data privacy leak.

**How to apply:** Carry `teacherStaffId` on the report row alongside the
display name (display name is for rendering only). Build the group Map keyed by
staff id and resolve email via an `id -> email` map. Also school-scope the
teacher join on `staff.school_id` (not just section_roster/class_sections).
