---
name: Family Messages teacher-scoped sending
description: How the teacher opt-in for Family Messages is scoped server-side, and the visibility.full leak it must guard against.
---

Family Messages is Core-Team-only by default. An admin toggle
(`teacherFamilyMessagingEnabled`, school_settings, default FALSE) lets ordinary
classroom teachers compose too — but ONLY to families of one of their OWN class
periods, or to individual students hand-picked from their own visible roster.
Never school / grade / house (those stay Core Team).

**Rule 1 — admission is teacher-gated, not just non-Core.** A non-Core actor may
enter only when the toggle is on AND they are an actual classroom teacher
(own ≥1 live non-planning `class_sections` row). Role flags drift; "owns a
roster to message" is the stable, data-driven definition. Front office /
counselors-without-a-section are excluded even with the toggle on.

**Rule 2 — never honor `getVisibleStudentIds().full` for a non-Core sender.**
`getVisibleStudentIds` (in insights.ts) grants `full=true` to its OWN broader
`isCoreTeam` set PLUS `isCounselor`/`isGuidanceCounselor` — a set WIDER than this
file's `isCoreTeam` (from `lib/coreTeam.js`). So a counselor who isn't in the
narrow core-team set is non-Core here yet has full read visibility. If the scope
helper passes `full` through, that actor can message school-wide. The send-path
scope for non-Core actors therefore falls back to their OWN taught roster
(`ownRosterStudentIds`) when `full`, and otherwise uses `visibility.ids`.

**Why:** the two `isCoreTeam` definitions diverge; broad *read* visibility must
never widen who a non-Core actor may *message*.

**How to apply:** the "period" audience already resolves against the acting
teacher's own sections (`teacherStaffId = staff.id`), so it's safe by
construction. The "students" audience is the dangerous one — it must always run
through the non-Core scope narrowing. Any future audience type a teacher can use
must be intersected the same way. Client (FamilyMessagesHub.tsx) role-aware modes
are UX only; the server (`parentMessages.ts`) is the sole enforcement point.
