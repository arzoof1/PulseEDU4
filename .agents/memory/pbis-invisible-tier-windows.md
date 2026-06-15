---
name: PBIS Invisible Student tier windows
description: The "invisible student" PBIS alert is tier-aware; two surfaces must compute it identically.
---

# PBIS "Invisible Student" tier-aware windows

A student is "invisible" when they have **0 non-voided PBIS recognitions**
within the alert window for their **highest active MTSS tier**. Windows are
per-school, default Tier 1 = 8 / Tier 2 = 5 / Tier 3 = 3 school days
(`schoolSettings.pbisInvisibleDaysTier1/2/3`). Tier 1 = no active MTSS plan;
active plan = `studentMtssPlansTable.closedAt IS NULL`. Tier resolution:
take the MAX active tier, null → Tier 1, anything ≥3 clamps to the Tier 3
window.

**Why:** higher-need students should surface faster; a single flat window
(the old `pbisInvisibleStudentDays`, kept but unused) treated everyone the
same.

**How to apply / invariant:** invisibility is computed in TWO places —
`/pbis/needs-attention` (`routes/pbis.ts`) and the Teacher Roster
(`routes/teacherRoster.ts`). They MUST stay logically identical or the two
surfaces will disagree on who is invisible (same bug class as the School
Grade LG parity rule). Both use the same pattern: fetch non-voided entries
since the WIDEST of the three windows, build a per-student latest-recognition
timestamp, then flag `lastSeen === undefined || lastSeen < tierCutoff` where
the cutoff is `subtractSchoolDays(windowForTier)`. Any change to one surface's
window math, tier resolution, or comparison strictness (`<` vs `<=`) must be
mirrored in the other.
