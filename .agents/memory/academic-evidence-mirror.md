---
name: Academic evidence mirror (Partnering with Parents / Learning at Home)
description: Invariants for the academic work-sample feature that mirrors PulseBrainLab — staff capture, parent view.
---

The academic-evidence feature is the ACADEMIC sibling of PulseBrainLab: staff
"Partnering with Parents" hub captures student formative work samples per class
section + `fastSubject`, publishes to families; parent "Learning at Home" section
on the Academics tab shows one card per class.

Invariants that must hold (same shape as the PulseBrainLab gates):

- **Publish-gate parity.** Parent visibility = sample `publishedAt IS NOT NULL`.
  BOTH the parent cards route AND the parent image route must independently
  re-check `publishedAt IS NOT NULL` (plus student ownership), or draft images
  leak. Same precedent as `pulsebrainlab-publish-gate.md`.
- **Read-only roster.** Teacher recipient picker reads `class_sections` +
  `section_roster` only; NEVER writes them (Skyward is source of truth). Non-core
  staff are constrained to their own sections (`teacherStaffId === staff.id`);
  Core Team reaches any teacher via a `teacherId` param (`resolveTargetTeacherId`).
- **FLEID boundary.** Every user-facing surface renders `localSisId` (or name),
  never the canonical `student_id` (FLEID). `student_id` stays a join key/path
  param only.
- **Parent AcademicsTab empty-state.** `LearningAtHomeSection` self-gates (renders
  nothing with no shared work) and reports its card count via `onLoaded`; the tab's
  TabEmpty shows only when `!hasAny && learningAtHomeCount === 0`, so a child with
  only shared classwork (no FAST/MTSS) still sees content, not an empty state.

**Why:** these four are the same correctness/tenancy traps that bit PulseBrainLab;
the academic mirror reuses the pattern, so any change here must keep both the
cards and image routes gated in lockstep.
