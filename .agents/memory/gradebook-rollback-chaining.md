---
name: Gradebook rollback via job-chaining
description: Why the Gradebook (current grades) importer keeps two generations and only allows single-step rollback
---

# Gradebook current-grades rollback

The Gradebook importer is a school-wide full-replace snapshot, but rollback must
RESTORE the prior snapshot (not just empty the grades). It does this with
**job-chaining** instead of a destructive delete-all:

- Commit keeps the new job's rows + the prior latest committed gradebook job's
  rows, pruning everything older (two-generation retention).
- Reads (`loadCurrentGrades` in `studentMetrics.ts`) only ever read the rows of
  the **latest committed gradebook job** for the school (scope by `schoolId` +
  `importJobId`, pick MAX id where `kind='gradebook' AND status='committed'`).
- Rollback deletes the rolled-back job's rows and flips its status to
  `rolled_back`, so the prior committed job becomes "latest" and its grades are
  restored automatically.

**Invariant (load-bearing):** because only two generations are retained,
rollback is a strict **single-step, newest-first undo**. The rollback route must
reject (409) any gradebook job that is not the current latest committed one —
otherwise rolling back an older job leaves the chain pointing at a generation
whose rows were already pruned (grades silently go empty).

**Why:** the original implementation did delete-all on commit + delete-this-job
on rollback, which matched "full replace" but failed the "rollback restores"
requirement. The architect caught both this and the multi-step edge case
(`J1→J2→J3`, rollback `J2`, rollback `J3` → empty).

**How to apply:** any future change to gradebook commit/rollback/read must keep
all three in lockstep — retention window size, the latest-job read filter, and
the newest-first rollback guard. If you ever widen retention for multi-level
undo, you must also relax the rollback guard accordingly.

## GPA semester scoping (same loader)

GPA (when `schoolSettings.gpaEnabled`) averages 4.0 grade points over the
**current semester only**: semester derived from the upload's effective quarter
(`Q3`/`Q4` = Spring → `["Q3","Q4"]`, else Fall → `["Q1","Q2"]`). Per course it
uses the effective quarter's grade if in-semester, else the latest populated
quarter WITHIN the semester; courses with no in-semester grade are excluded.
This is a SEPARATE computation from the displayed per-course current grade,
which can fall back across the whole year (`Q4→Q1`).
