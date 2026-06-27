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

## Folding a redundant entry point (Phase 2)

When the SAME capability has two sidebar entry points and one audience can reach it
through both, gate the redundant row out for that audience instead of deleting it.
Concretely: the standalone read-only "School Store" row was visible to everyone, but
every `canAccessPbisHub` user is also `canEditSchoolStore` (identical role set) and so
already reaches the store via the PBIS Hub's manage tile. Gating the standalone row
`effectiveFeatures.SchoolStore && !canAccessPbisHub` removes it for hub-havers while
keeping it for non-hub teachers (their only catalog entry) — no access lost.

**Why:** "fold hubs" means one canonical entry point PER AUDIENCE, not deleting the
page. The `schoolStore` activeSection + its `NAV_GROUP_OWNERSHIP.recognition` entry must
stay so deep links still render + force-expand the group.

**Companion trap — stale `show<Group>` OR-terms make empty headers.** A group's `show*`
flag must stay in lockstep with the items that can actually render inside it. After PBIS
Points was promoted to Quick Access, `showRecognition` still OR-ed `effectiveFeatures.Pbis`
even though no Recognition row is gated on it — a Pbis-on / no-hub / store-off user saw an
empty "Recognition" header. Fix: make the flag exactly the OR of its children's gates
(`effectiveFeatures.SchoolStore || canAccessPbisHub`). **How to apply:** whenever you
add/remove/move a row in a group, re-derive that group's `show*` as the disjunction of
the surviving rows' gates.

## Healing a split workflow / promoting an unrendered nav-section (Phase 3)

When one workflow is split across two sidebar GROUPS, give the missing piece a
sidebar row in the group that already holds the rest of the workflow — don't move
everything into a new group. Concretely: MTSS plan management (mtssPlans,
interventionReports) lived in the behaviorSupport group, but the MTSS Coordinator
hub (mtssCoordinator + its mtssTemplates sub-page) had NO sidebar row (only an
Insights Hub page tile). Fix = render the already-defined-but-unused
`mtssCoordNavSections` inside behaviorSupport, gated `canAccessMtssHub` (the page's
own gate), and move mtssCoordinator+mtssTemplates ownership from insights →
behaviorSupport. academicsTrajectory stayed in insights (it's a dashboard, not the
plan workflow).

**Why two gates matter here:** `canAccessMtssHub` (SU/Admin/MTSS/BehaviorSpec) is a
strict SUBSET of `canManageMtssPlans` (adds PbisCoord), and showBehaviorSupport
already ORs canManageMtssPlans — so the new row can never appear in a hidden group,
and the row gate == page-render gate means zero widen/narrow. ALWAYS check the new
row's gate against the group's `show*` superset before adding it.

**Parallel-discovery convention (don't fight it):** a page reachable from BOTH a
sidebar row AND a hub tile is owned (force-expand) by whichever group holds the
SIDEBAR ROW; the hub tile is just discovery. So when you promote a hub sub-page to a
sidebar row, move its NAV_GROUP_OWNERSHIP entry to the new group even though the old
hub still launches it. **How to apply:** after any such move, re-audit that every
activeSection key is owned by exactly ONE group (zero = no force-expand, two =
wrong group wins).

**Naming is an owner decision:** the target IA calls this group "Student Support"
but it's still labeled "Academic and Behavior Supports" — renaming was deferred as
an explicit open decision (muscle-memory cost). Don't unilaterally rename nav groups
during a structural consolidation.
