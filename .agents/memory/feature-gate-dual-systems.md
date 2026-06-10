---
name: Dual feature-gate systems (client)
description: The staff client has two independent feature-resolution paths that can disagree; nav gate and page gate must use the same one.
---

The staff app (`artifacts/client/src/App.tsx`) has **two** feature systems that
resolve the same feature differently:

- **Nav gating** → `effectiveFeatures` map, sourced from `/api/school-settings`
  (`getOrCreate` always inserts a row with all-TRUE column defaults).
- **Page gating** → `<FeatureGate feature="X">` / `useFeatures()`, sourced from
  `/api/me/features` (`loadEffectiveFeatures`), which reads the `school_settings`
  row directly and only falls back to the plan when **no row exists**.

These can disagree for a given school. FeatureGate renders `null` (blank) when a
feature is neither enabled nor upsell, so a page can go blank while its nav item
is still visible.

**Rule:** if you wrap a page in `<FeatureGate feature="X">`, you MUST also gate
its nav entry on the *same* source — the codebase pattern is
`useFeatureVisible("X")` (see MTSS / ISS / Displays + the comment block above the
`renderGatedNavItem` helper). A page gated on `X` whose nav is gated on a
different key (or the other system) produces a visible nav item that dead-clicks
into a blank section.

**Why:** the House Rankings regression — the page was wrapped in
`FeatureGate("houses")` while its nav stayed on `effectiveFeatures.Pbis`,
yielding a blank House Rankings section. Sibling PBIS Points page renders with no
page-level FeatureGate (nav-gated on PBIS only); House Rankings was made
consistent by dropping its page gate.

**How to apply:** when adding/auditing a `FeatureGate`-wrapped page, confirm the
nav entry uses `useFeatureVisible` with the identical feature key, or that the
page intentionally has no page-level gate and relies solely on its nav gate.
