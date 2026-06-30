---
name: ClassPhotoDay class-flow transient state
description: Why per-class confirm/back/retake state must reset on roster-context and mode changes in ClassPhotoDayPage
---

The class-mode capture flow keeps transient state — `classSavedFor`, `retakeStudentId`, `prevHandled` (plus `previewBlob`) — that is meaningful ONLY within the currently loaded class queue.

**Rule:** reset ALL of these whenever the roster context changes (teacher/period load success) and when switching capture mode (class ↔ single), not just `status`/`cursor`.

**Why:** `prevHandled` is an index into the current queue; `handleBack()` does `queue[prevHandled]`. If it survives a teacher/period switch, "Back / retake previous" reopens an unrelated student from the old class. Same class for a stale `retakeStudentId`/`classSavedFor` driving the confirm step on the wrong student.

**How to apply:** any new per-class flow state added here must also be cleared in the roster-load effect and in `switchMode`. Treat "reset on queue identity change" as the invariant.
