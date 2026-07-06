---
name: Section Support Access
description: ESE/co-teacher period-scoped access to another teacher's whole section — key on stable business identity, LOG-only boundary, coordinator-only grants.
---

# Section Support Access

Lets an ESE/co-teacher SEE and LOG accommodation delivery (incl. bulk/small-group)
for another teacher's WHOLE class section for a given period. Assigned ONLY by an
ESE Coordinator (or admin/superuser). Naming is "Support Access" — never "pullout".

## Load-bearing decisions

- **Grant key = stable business identity `(school_id, teacher_staff_id, period, support_staff_id)`, NOT `class_sections.id`.**
  **Why:** `class_sections.id` is not stable across roster re-imports (wipe + reinsert),
  so a grant pinned to an id would silently break after any Skyward/RosterOne import.
  **How to apply:** every read (visibility, schedule, logging) must RE-RESOLVE the live
  `class_sections` row from `(school_id, owner teacher_staff_id, period, isPlanning=false)`
  on each request — never store or trust a section id on the grant.

- **LOG-only, never edit accommodations.** Support teachers can write `accommodation_logs`
  but must NOT touch the student's accommodation list. Keep them off the accommodation
  admin routes; only the bulk-per-student log path honors `sectionTeacherStaffId`.

- **Two distinct delegation paths on bulk-per-student, mutually exclusive:**
  - `actingAsStaffId` (elevated admin/coord) REASSIGNS log identity to the target teacher.
  - `sectionTeacherStaffId` (support access) keeps log identity = the acting support
    teacher; it only re-points which section's roster/accommodations are logged against,
    AFTER verifying a coordinator grant exists for `(school, owner, period, support=principal.id)`.
  Combining the two is a 400.

- **Coordinator routes gated `requireEseOrAdmin` (admin || eseCoordinator || superUser),
  all school-scoped.** Create is idempotent (`onConflictDoNothing` on the unique key).

## Auth pipeline gotcha (accommodationLogs `requireStaff`)

`requireStaff` has a `?staffId=`/`body.staffId` fallback for the Replit preview iframe.
It is NOT exploitable for impersonation on school-scoped routes because `req.staffId`
and `req.schoolId` both derive from the same session/bearer `sid` (app.ts): a live
session always wins (`sessionId ?? queryId ?? bodyId`), and with no session `req.schoolId`
is null so `requireSchool` 401s first. A tenant-alignment guard (reject non-superuser
when `staff.schoolId !== req.schoolId`) makes the invariant explicit so the fallback can
never bind a cross-school principal. Do NOT remove the fallback — it is load-bearing for
the preview iframe across the app.
