---
name: Sidebar nav chokepoint
description: Where left-sidebar clicks are centralized in the staff client, and the one button that bypasses it.
---

# Sidebar nav chokepoint (staff client App.tsx)

Almost every left-sidebar button is rendered through `renderNavItem` (and
`renderGatedNavItem`, which delegates to it for unlocked items). That is the
single place to change sidebar click behavior app-wide.

**Gotcha:** `SpotlightLaunchButton` (bottom of Quick Access) is a custom button
that does NOT go through `renderNavItem` — it wires its own `onClick`. Any
app-wide sidebar-nav behavior must update it too, or Spotlight silently opts out.

**Re-click-returns-home behavior:** clicking a nav item while already on that
section returns it to its home view via `handleNavClick(key)`:
- bump `navHomeTick` only when `key === activeSection`; `<main className="app-main">`
  is keyed on `navHomeTick`, so a re-click remounts the content region and resets
  sub-navigation held inside child page components.
- always `setSettingsTile(null)` — `settingsTile` is the ONLY App-level hub
  sub-state (every other section keeps its sub-nav inside child components, so the
  remount is what resets them).

**Why:** switching to a *different* section already unmounts the outgoing
section, so no forced remount is needed there; the tick only fires on re-click to
avoid remounting/​refetching on ordinary navigation. Header notification bells and
banner deep-links set the section/tile directly (not via `handleNavClick`) on
purpose — leave them.
