---
name: Multi-grade bell schedule variants
description: Day Type → variant architecture; per-student period resolution; legacy compat rules
---
A bell_schedules row is a "Day Type"; grade-level timing lives in bell_schedule_variants / bell_variant_blocks (typed: period|lunch|passing|advisory|homeroom|custom) / bell_variant_assignments (kind='grade').

Rules:
- ALL "what period is it now" logic must go through lib/scheduleResolver.ts (loadDayTypeContext → variantForGrade → contextForVariant). Never read bell_schedule_periods for runtime resolution — it is a dormant legacy mirror.
- Resolution order: grade assignment → default variant → explicit not-configured (status "no_day_type"/"no_default"); never guess. Consumers must check ctx.status !== "ok".
- **Why:** grades run simultaneous staggered timelines (different lunches); any default-schedule shortcut silently miscredits/mistimes other grades.
- On-time window math (onTimeAttendance computeWindow): explicit passing blocks are BRIDGES (window stays open across them); lunch/advisory are non-bridge (window closed while they run, their END opens the next period's passing window). Post-bell grace only for included instructional periods.
- periodKey idempotency compat: default variant keeps legacy `s<schedId>:p<n>:<day>`; non-default variants use `s<schedId>:v<variantId>:p<n>:<day>` — don't collapse them.
- Legacy flat-period editor (POST/PUT /bell-schedules) mirrors into the default variant ONLY while the schedule has ≤1 variant; once grade variants exist, the variant editor is authoritative and legacy saves must not touch variants (a promoted grade variant may be default).
- Per-student lost-instruction/tardy minutes use lostInstruction loadGradePeriodWindows(schoolId).windowsForGrade(student.grade), not loadDefaultPeriodWindows.
