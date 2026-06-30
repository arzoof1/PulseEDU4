---
name: Notify-recipient broadening = PII re-audit
description: When a feature widens who receives a notification, re-audit the message body for leaks and keep stale selections removable.
---

When you add a feature that broadens the audience of an existing dispatch
(extra recipients, role-agnostic recipients, new channels like SMS), the
message body's contents are now seen by more people.

**Rule:** before shipping, audit the existing body/subject for the
`NO FLEID forward-facing` invariant. The canonical `students.student_id`
(FLEID) must never render; use `students.local_sis_id` (carried as
`localSisId`). The Request Pullout dispatch email had a pre-existing
`(${p.studentId})` label that became in-scope once extra recipients were
added — replaced with `localSisId` (fallback to "Student", never FLEID).

**Why:** a leak that was "contained" to a few role holders becomes a wider
disclosure the moment you let admins add arbitrary staff.

**How to apply:** also keep the recipient picker complete — a GET that only
returns *active* staff strands an already-selected extra who later went
inactive (no row to toggle off). Query `active OR id IN (selected ids)` and
flag inactive rows so admins can still remove them.
