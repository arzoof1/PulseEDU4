---
name: Academic vs Behavior MTSS
description: How academic MTSS plans differ from behavior plans and the invariants that keep bell/check-in logic correct
---

# Academic vs Behavior MTSS

PulseEDU MTSS plans come in two flavors that share the same tables/routes:

- **Behavior plans**: meet every weekday (Mon–Fri). PRIDE + strategy grids
  apply. Tier 2 = weekly check-in owed; Tier 3 = per-day check-ins all 5 days.
- **Academic plans**: marked by `fastSubject` (`ela`|`math`) on the plan row.
  - Tier 2 academic = LIGHT: the student's intensive class IS the monitoring.
    NO bell, NO scheduled check-ins.
  - Tier 3 academic = closely monitored on configurable `meetingDays` (CSV
    "mon".."fri"). Bell + check-ins fire ONLY on meeting days; the week isn't
    "complete" until each scheduled meeting day is logged.

## Invariants (don't break these)

- **`fastSubject` is the academic discriminator, not `meetingDays` alone.**
  Bell suppression for LIGHT Tier 2 must gate on `!p.fastSubject`. Only academic
  Tier 3 plans should ever carry `meetingDays`; the create/edit modal must clear
  `meetingDays` for behavior plans (send `[]`) and only default Tue/Thu for
  academic — otherwise a behavior Tier 3 plan silently drops from 5 expected
  days to Tue/Thu.
- **Weekly-form day rendering vs storage diverge on purpose.** The Tier 3 form
  renders/gates completion on `visibleDays` (meeting days for academic, all 5
  for behavior), but the save/hydrate loops still iterate all 5 days so off-day
  cells stay null. Completion gating (`allDaysAccounted`) MUST use `visibleDays`
  or academic Tue/Thu weeks can never be submitted.

**Why:** these three were real bugs caught in review — academic weeks that
couldn't complete, Tier 2 academic plans wrongly owing bell entries, and a
behavior-plan cadence regression from a shared Tue/Thu default.

## Suggestions ("Generate from FAST")

- One row per (student, subject) for ELA + Math. Qualify by `placeOnChart`
  level ≤ 2 (below-grade L3 cut) using latest FAST scale score pm3→pm2→pm1.
- No gap inputs. Weak standards live in an expandable per-row dropdown.
- "Create Plan" → light Tier 2 academic (sets `fastSubject`). Exclude students
  with an active academic plan for that subject. Dismiss is keyed by
  (student, subject), stored in the `fast_benchmark_code` dismissal column.
- Panel does NOT auto-load — gated behind a "Generate suggestions" button.
