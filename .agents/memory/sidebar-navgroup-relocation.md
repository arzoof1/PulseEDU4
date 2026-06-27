---
name: Relocating a gated nav item between sidebar NavGroups
description: The three lockstep edits required when moving a capability-gated sidebar item from one NavGroup to another in artifacts/client/src/App.tsx, plus the silent-hide trap.
---

Moving a capability-gated nav item from one sidebar `NavGroup` to another is NOT a
one-line JSX move. Three things must change in lockstep or you silently break access
or deep links:

1. **The destination group's `show<Group>` visibility flag must be a SUPERSET of the
   moved item's gate.** Each `NavGroup` only renders when its `show*` flag is true. If
   the moved item's viewers aren't all covered by the destination group's flag, those
   users see neither the group nor the item — a silent hide. Fix by *additively* OR-ing
   the item's exact gate into the destination flag (e.g. `showSchoolAdmin = ... || (canManageBehaviorLists && !isBehaviorSpec)`).

2. **`NAV_GROUP_OWNERSHIP` must move the `activeSection` key too** (remove from the old
   group's array, add to the new one). This drives force-expand: when the user is on
   that page, `groupContainsActive` expands the owning group. Wrong owner = the group
   collapses on top of the page you're viewing.

3. **Keep the item's per-item gate verbatim.** Broadening the group flag is safe ONLY
   because every item inside the group keeps its own gate, so a newly-admitted group
   viewer still sees only items they're individually authorized for — no privilege leak.

**Why:** Done for the "Interventions" behavior-lists editor (Phase 1 sidebar
consolidation). Its gate is `canManageBehaviorLists && !isBehaviorSpec` = MTSS
coordinators + Deans (admins & behavior-specs are excluded because `isBehaviorSpec`
includes `isAdmin`). The old admin-group flag `canManageBellSchedules || isAdmin`
covered MTSS coords (via `isMtss`) but NOT pure Deans, so the naive move would have
hidden the item from Deans.

**Role-flag facts (App.tsx, ~9470-9484):** `isBehaviorSpec = isBehaviorSpecialist || isAdmin`;
`isDean = isDean || isAdmin`; `isMtss = isMtssCoordinator || isAdmin`. So `isMtss` and
`isMtssCoordinator` are effectively the same for non-admins. A `!isBehaviorSpec` filter
therefore *also* excludes admins.

**How to apply:** Before moving any gated sidebar item, write out who currently sees it,
confirm the destination group's `show*` flag admits all of them (broaden additively if
not), and update `NAV_GROUP_OWNERSHIP`. Don't leave the source group's `show*` clause if
it becomes the source of an empty rendered group for some role.
