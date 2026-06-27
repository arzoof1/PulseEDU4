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

## Manage Lists tab (admin-only)

The hub also has an admin-only top-level tab **"Manage Lists"** (appended to
`TAB_LABELS` via `visibleTabs` when `canManageLists`) grouping three sub-tabs:
Negative Behaviors / Interventions / Pullout Reasons. `ManageListsView` renders
them: Negative Behaviors reuses `SettingsView` with the new optional
`initialFilter` prop set to `"negative"`; Interventions/Pullout Reasons are
self-contained CRUD components (`InterventionTypesAdmin`,
`PulloutReasonsAdmin`) hitting the SAME endpoints as App.tsx Site Management
(intentionally NOT extracted from App.tsx's deeply-coupled inline JSX).

**Why `canManageLists` excludes dean:** it is the INTERSECTION of the three
server write gates. `/intervention-types` + `/pullout-reasons` admit
admin/BS/MTSS/dean, but the negative-behavior list (`/pbis-reasons`
school-scope) admits admin/BS/MTSS only. Gating the whole tab on the narrower
set guarantees every visible sub-tab is fully writable (no dean-only 403 on the
Negative Behaviors sub-tab). Server still enforces all writes.

**How to apply:** if you add a 4th sub-tab with a looser server gate, keep
`canManageLists` as the intersection (or split per-sub-tab visibility) — don't
widen it past the most restrictive sub-tab's write gate.
