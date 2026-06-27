---
name: PBIS Points color-first fork
description: PBIS Points entry splits Positive vs Negative; how negatives are written and which reasons feed which modal.
---

# PBIS Points color-first fork

The real PBIS Points page is `components/PbisPointsHub.tsx` (the App.tsx
search-box form is legacy/dead). On entry it shows a `mode` chooser
(green Positive / red Negative) BEFORE student selection.

- **Positive** = the existing award hub. Its `AwardModal` + `BulkAwardModal`
  receive `positiveReasons` only — negatives are NOT awardable there.
- **Negative** = reuse `ClassesView` (with `hideBulk`) to pick a student, then
  `NegativeLogModal` writes a behavior + intervention(s) via
  `POST /api/interventions/quick-log` (the SAME write path as the Teacher
  Roster quick-log; negatives are loggable in BOTH places by design).

**Why:** keeps the PBIS system unified (one set of `pbis_reasons` split by
`polarity`) while giving teachers a clear color-coded entry and forcing
negatives through the intervention-capture flow.

**How to apply:** if you touch the hub's reason wiring, keep the polarity
split — positive award modals get `positiveReasons`, the negative modal gets
`negativeReasons`. Negative entries are written by the quick-log endpoint, not
`/api/pbis`; refresh roster totals by refetching `/api/pbis`
(`refreshTotals()`).
