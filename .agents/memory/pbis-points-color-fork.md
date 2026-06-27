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

## Manage Lists — lives on the Behavior Specialist hub (NOT the PBIS hub)

The PBIS Points entry chooser shows ONLY the Positive/Negative buttons. The
"Manage Lists" admin surface lives as a **tile on the Behavior Specialist hub**
(App.tsx `behaviorSpecialist` hub → `manageLists` tile → `activeSection ===
"manageLists"` section rendering `<ManageListsView/>`). It groups three
sub-tabs: Negative Behaviors / Interventions / Pullout Reasons.

`ManageListsView` (exported from `PbisPointsHub.tsx`) is **self-contained**: it
fetches its own `/api/auth/me` + `/api/pbis-reasons?scope=school` +
`/api/pbis-note-templates?scope=school` (mirrors `SchoolWidePbisAdminView`) and
owns its sub-tab state — it takes NO props. Negative Behaviors reuses
`SettingsView` with `lockedScope="school"` + `initialFilter="negative"`;
Interventions/Pullout Reasons are self-contained CRUD components
(`InterventionTypesAdmin`, `PulloutReasonsAdmin`) hitting the SAME endpoints as
App.tsx Site Management (intentionally NOT extracted from App.tsx's
deeply-coupled inline JSX).

**Why the gate excludes dean:** the combined view exposes the negative-behavior
list, and `/pbis-reasons` (school-scope writes) admits admin/BS/MTSS only —
`/intervention-types` + `/pullout-reasons` also admit dean. So the tile + section
gate on `canManageAllPbisLists` (admin/BS/MTSS), NOT the broader
`canManageBehaviorLists` (which includes dean), so no dean hits a 403 on the
Negative Behaviors sub-tab. Server still enforces all writes.

**How to apply:** keep the tile `show` and the section render guard on the SAME
gate. If you add a 4th sub-tab with a looser server gate, keep the gate as the
intersection (or split per-sub-tab visibility) — don't widen it past the most
restrictive sub-tab's write gate.
