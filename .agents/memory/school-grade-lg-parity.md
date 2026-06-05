---
name: School Grade LG parity with Teacher Roster
description: Where the School Grade Calculator must source prior-year FAST evidence for learning gains.
---

# School Grade learning-gain prior-year source

The School Grade Estimated Calculator engine (`schoolGradeEngine.ts`) must
source prior-year evidence for its ELA/Math Learning-Gain components from the
**FL importer historical PM3 rows** via `loadFastHistory(...)` — the exact same
source the Teacher Roster green-check uses (`buildSubjectBlock → priorPm3`).
Place that prior PM3 on the test-administration grade chart with
`placeOnChart(pm3, subject, grade - 1)`, then feed `decideLearningGain` (PM3) or
`projectLearningGain` (PM1/PM2).

**Do NOT** use `student_fast_scores.priorYearScore` as the prior for learning
gains. It is a separate (often stale / partial) column; using it makes the two
surfaces disagree on whether a student earned a gain.

**Why:** Code review flagged that an early version used `priorYearScore`,
producing different LG values than the Teacher Roster for the same students. The
roster is the canonical learning-gain surface; the School Grade estimate has to
match it student-for-student or admins lose trust in both.

**How to apply:** Any new FAST learning-gain computation (new windows, new
components, new reports) resolves prior PM3 through `loadFastHistory`, not the
`priorYearScore` column. `priorYearBq` is still fine as the Lowest-25% cohort
*filter* — that is a separate bottom-quartile flag, not the gain evidence.
