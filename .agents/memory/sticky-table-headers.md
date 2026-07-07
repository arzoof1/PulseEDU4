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
halves (bounded scroll region `max-height:calc(100vh-240px)` + sticky header +
`> table {overflow:visible !important}`). Wrap a `<table>` in
`<div className="sticky-scroll">` and it just works — used by EligibilityHub,
TeacherRoster, MTSS/Safety/StaffDir/Tour/PBIS/Store/DataChats admin tables.

**`.sticky-scroll` pins the whole `<thead>` (not per-`th`), fill on the ancestor.**
`.sticky-scroll thead {position:sticky;top:0;background:var(--surface-2)}` +
`.sticky-scroll thead th {position:static}`. This covers BOTH single-row headers and
multi-row grouped headers (e.g. Teacher Roster: a `colSpan` group-label row over a
sub-column row, `rowSpan={2}` label cells) — pinning every `<th>` to `top:0` would
stack the two header rows on top of each other. The old `.sticky-scroll--group`
variant is now redundant (base rule does it); the class may still be on markup but is
inert. Works because `border-collapse` is `separate` (thead-sticky is unreliable
under `collapse`).

**CRITICAL — never put a `background` on a `.pulse-table thead th`.** `.pulse-table`
headers paint their TEXT via `background-image:linear-gradient` + `background-clip:text`
+ `color:transparent` on the th's OWN background. Any `background`/`background-color`
on that same th is clipped to the letters and renders them in the fill color →
"header has no words" (invisible labels). This is exactly why the earlier per-`th`
`.sticky-scroll thead th {background:var(--surface-2)}` silently blanked every
`pulse-table` roster header (TeacherRoster/MTSS/StaffDir/SafetyPlans) while plain
`.table` headers (EligibilityHub) were fine. **Rule: the opaque sticky fill must live
on an ANCESTOR of the cell (the `<thead>`), never on the gradient-text `<th>` itself.**
