---
name: Attendance — two independent systems + canonical status strings
description: How PulseEDU computes attendance; the official-vs-kiosk split and the only valid student_attendance_day.status strings.
---

# Two attendance systems (do not conflate)

1. **Official daily attendance** — `student_attendance_day` (one row per student/day).
   Drives the parent-portal attendance **percentage** (`presentDays/totalDays`,
   where present = status `present` OR `tardy`) and the staff **Insights ADA /
   chronic-absenteeism** dashboard.
2. **Kiosk check-ins** — `attendance_checkins` (per student/period door scans).
   Drives on-time streaks, points, the on-time lottery, AND the
   **Lost Instructional Time "absences" row** (operating `(day,period)` slots
   minus the student's check-ins, valued by bell windows).

**Why it matters:** the Lost-Instruction "absences" number is KIOSK-derived and
will NOT match the official attendance % — by design. Seeding
`student_attendance_day` changes the % and ADA but leaves the lost-instruction
absence row untouched (and vice-versa). Don't "fix" a mismatch between them.

# Canonical status strings (the only ones consumers recognize)

`student_attendance_day.status` MUST be one of: `present` | `tardy` |
`excused` | `unexcused`. (`tardy` counts as present for %/ADA.)

**Why:** the on-time-streak walker (`parentSnapshot`) and Insights ADA branch
ONLY on those four. Legacy/importer values like `absent_excused` /
`absent_unexcused` are still counted as "absent" by the % formula (anything not
present/tardy), but they silently FALL THROUGH the streak-skip and the ADA
absence counters → undercounted absences and a broken streak. A repo grep for
`absent_excused` should return nothing in live write paths.

**How to apply:** any seed/importer/rebuild that writes attendance days must emit
the canonical four. The school-1 demo generator is `lib/parrottRebuild.ts`; it
buckets students per-rate (~2% chronic ~60%, ~60% at ~92%, balance 100%) rather
than per-day random noise.
