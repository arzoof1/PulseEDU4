---
name: Sticky table headers (overflow:hidden capture)
description: Why position:sticky <th> silently fails in this app's tables and the one-line fix.
---

# Sticky `<th>` headers don't pin in client tables

**Rule:** to make a sticky table header (or sticky first column) work in
`artifacts/client`, add `overflow: "visible"` inline on that specific `<table>`,
and put the real scroll on a wrapper around it (`flex:1; min-height:0; overflow:auto`,
inside a height-bounded parent).

**Why:** the shared table stylesheet (`index.css`, `/* Tables */`) sets
`table { overflow: hidden }` (no `!important`). `overflow: hidden` turns the
`<table>` box itself into the sticky scrollport, so a `position: sticky; top:0`
`<th>` pins to the table — which scrolls away inside any outer wrapper — instead of
to your wrapper. The clip context is invisible in the component markup; it lives in
the global stylesheet, so every "fix the scroll container" attempt fails identically.
`border-collapse` is already `separate !important` globally, so that is not the cause.

**How to apply:** inline `overflow: "visible"` wins over the global rule. Precedent:
`components/AlgebraPlacementReview.tsx`. Note `border-top` on `<tr>` does not render
under `border-collapse: separate` — use cell borders for row dividers.

**App convention:** the reusable `.sticky-scroll` class in `index.css` does both
halves (bounded scroll region `max-height:calc(100vh-240px)` + sticky `thead th` +
`> table {overflow:visible !important}`). Wrap a `<table>` in
`<div className="sticky-scroll">` and it just works — used by EligibilityHub,
TeacherRoster, MTSS/Safety/StaffDir/Tour/PBIS/Store/DataChats admin tables.

**Multi-row grouped headers** (e.g. Teacher Roster: a `colSpan` group-label row over
a sub-column row, with `rowSpan={2}` label cells): pinning every `<th>` to `top:0`
stacks the two header rows on top of each other. Use the `.sticky-scroll--group`
variant instead — it pins the whole `<thead>` as ONE sticky block
(`thead {position:sticky;top:0}`) and neutralizes per-`th` sticky
(`thead th {position:static}`). No fragile per-row `top` offset needed.
Works because `border-collapse` is `separate` (thead-sticky is unreliable under
`collapse`).
