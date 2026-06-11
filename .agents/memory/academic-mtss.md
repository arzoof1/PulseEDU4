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
  - Tier 3 academic = **minutes-based small group** (reworked 2026-06-08, was
    per-day 1–5 scoring). The plan carries a weekly `academicMinutesTarget`
    (default 30) and an `academicAnyDay` flag. Day-mode: `academicAnyDay=false`
    → log only on `meetingDays`; `true` → any weekday. Completion is driven by
    the WEEKLY minutes total vs target, never per-day. Per-day minutes live in
    `tier3WeeklyRecords.academicMinutes` jsonb `{mon:30,tue:0,...}`. A week is
    `met` (minutes≥target) / `owed` (below) / `excused` (released "no group").
    Release valve: `releasedNoIntervention` + `releaseReason`/`releasedBy`/`At`.

## Invariants (don't break these)

- **`fastSubject` is the academic discriminator, not `meetingDays` alone.**
  Bell suppression for LIGHT Tier 2 must gate on `!p.fastSubject`. Only academic
  Tier 3 plans should ever carry `meetingDays`; the create/edit modal must clear
  `meetingDays` for behavior plans (send `[]`) and only default Tue/Thu for
  academic — otherwise a behavior Tier 3 plan silently drops from 5 expected
  days to Tue/Thu.
- **Weekly-form day rendering vs storage diverge on purpose (BEHAVIOR Tier 3).**
  The behavior Tier 3 form renders/gates completion on `visibleDays` (all 5),
  but the save/hydrate loops still iterate all 5 days so off-day cells stay null.
  (Academic Tier 3 now uses a separate minutes form, see below — this invariant
  is behavior-only post-rework.)
- **Academic Tier 3 renders a SEPARATE minutes form, not the score grid.**
  `Tier3WeeklyForm` early-returns `Tier3AcademicMinutesForm` when
  `isAcademic` (tier3 + fastSubject). It has its own week selector (met/owed/
  excused badges), needs-attention strip of owed weeks, per-day 5-min minutes
  dropdowns, running X/target bar, and release valve. Completion = weekly
  minutes ≥ target OR released. The bell/report met-owed-excused math lives in
  shared `lib/academicMinutes.ts` — bell, completion-report, and the form must
  all agree via that helper (don't reimplement the verdict in any one surface).
  Bell owed-week backlog floors at the rework ship date (2026-06-08) so
  pre-rework academic weeks never retroactively show as owed.

**Why:** these three were real bugs caught in review — academic weeks that
couldn't complete, Tier 2 academic plans wrongly owing bell entries, and a
behavior-plan cadence regression from a shared Tue/Thu default.

## Suggestions ("Generate from FAST + iReady" → Tier 3 Academic)

- DUAL-GATE qualification: a (student, subject) row surfaces ONLY when BOTH
  FAST **PM1** places at **Level 1** (`placeOnChart` level === 1, PM1
  specifically — not latest window) AND iReady **AP1** scale score is
  **strictly below** the configured cut for that (grade, subject).
- Cut scores are per-grade per-subject, stored in
  `schoolSettings.ireadyAp1Cuts` jsonb `{ela:{gradeStr:num}, math:{}}`.
  Missing cut OR missing iReady AP1 ⇒ no suggestion. iReady AP1 is read from
  the generic `assessments` table (source ~ iready, name ~ ap1, reading→ela /
  math→math, latest by `administeredAt`) — name matching is brittle but is the
  documented importer path (no schoolYear column on assessments).
  **GOTCHA: check "math" BEFORE "read" when classifying subject.** Every iReady
  assessment name starts with "iReady", and "iready" contains the substring
  "read" — so a `name.includes("read")`-first test misclassifies
  `iReady Math AP1` as ELA, leaving the math bucket empty and zero math
  suggestions. Real names seen: `iReady Reading AP1`/`AP2`/`AP3`,
  `iReady Math AP1`/`AP2`/`AP3`, source `iReady`.
- `gradesPresent` (response field) = grades among PM1 Level-1 candidates
  collected BEFORE the iReady gate, so the cut-score grid can show a grade that
  needs a cut even when zero suggestions surface yet.
- `saveCuts` (client) merges the draft over persisted `cuts` so cuts for grades
  not currently shown are preserved (only mutates `gradesPresent` keys).
- "Create Plan" → **Tier 3** academic (`tier:3` + `fastSubject`); the editor
  auto-defaults `meetingDays` Tue/Thu via `isAcademic`. Exclude students with
  an active academic plan for that subject. Dismiss keyed by (student, subject)
  in the `fast_benchmark_code` dismissal column.
- Panel does NOT auto-load — gated behind a "Generate suggestions" button.
- **Tier 2 light list was removed from this panel** — it is Tier 3 only now.
  (Existing Tier 2 academic plans created earlier still exist and show under
  the "All" tab; there is no Tier 2 academic tab.)
