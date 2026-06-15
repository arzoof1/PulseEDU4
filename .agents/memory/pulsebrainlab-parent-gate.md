---
name: PulseBrainLab parent visibility gate
description: Every parent-facing Brain Lab route must enforce BOTH ownership AND group membership, not ownership alone.
---

# PulseBrainLab parent-facing visibility gate

A family sees Brain Lab content ONLY when the child belongs to a PulseBrainLab
small group (`pulse_brain_lab_group_members` by `(school_id, student_id=FLEID)`).
The card list (`buildHomeCards`) returns `[]` with no membership.

**Rule:** the group-membership gate is a per-route invariant, not just a list
filter. Any NEW parent Brain Lab route — especially one that streams raw bytes
like the work-sample image route — must re-check group membership on top of
parent-ownership + school-scope. Ownership alone is insufficient: a parent of an
owned-but-non-grouped child could otherwise fetch that child's sample image by a
known/guessed sample id, bypassing "no group = no family Brain Lab content".

**Why:** code review caught exactly this — the image route had ownership +
school + FLEID match but skipped the membership gate, opening a quiet bypass.

**How to apply:** after `resolveOwnedStudent`, query
`pulseBrainLabGroupMembersTable` by `(owned.schoolId, owned.fleid)`; empty →
respond as if the resource doesn't exist (404), don't 403 (avoid confirming the
sample exists).

Related: the per-sample `shared` toggle is now a STAFF annotation only — it no
longer gates family visibility. Group membership is the sole family gate.
