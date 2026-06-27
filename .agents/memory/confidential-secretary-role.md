---
name: Confidential Secretary role (Core-Team mirror)
description: How a new role flag that "grants full Core Team access" must be wired so it tracks the assignable isCoreTeam flag everywhere — and the pre-existing drift it must NOT try to fix.
---

# New role flag that "is Core Team by default"

When adding a staff role flag whose contract is "full Core Team access, admin can untick pages afterward," wire it as a true peer of the **assignable `isCoreTeam` flag**, not a one-off gate.

## The rule
Add the new flag everywhere the assignable `isCoreTeam` flag is *already* checked — and nowhere it isn't.

- **Server canonical helper** (`lib/coreTeam.ts` `isCoreTeam()`): OR the flag in there. This is the single composer behind `canManageDismissal/Eligibility/Tickets/Tours/SchoolGrade/...`, so it cascades automatically to every route that uses the helper.
- **Narrow `select({...})` projections fed to the canonical helper**: these are the silent trap. The helper reads `staff.<newFlag>`; if a route selects only a subset of role columns (the tell-tale is an explicit `isSchoolPsychologist: staffTable.isSchoolPsychologist` / `isCoreTeam: staffTable.isCoreTeam` list) and then calls `isCoreTeam(row)`, the new field is `undefined` → **silently ignored**. You MUST add the new column to every such projection. Routes that use `.select()` (full row) are fine.
- **Client mirrors**: every gate that lists `authUser?.isCoreTeam` (e.g. `isCoreTeamMember`, `canManageEligibility`, the two `canManageDismissal` props) must add the new flag beside it, or the UI under-grants vs the server (dual-gate blank-page trap).
- **Plumbing**: `publicStaff()` (auth.ts), `ROLE_FLAGS` + `STAFF_SELECT` (adminStaff.ts), `ROLE_PRESETS` (StaffRolesMatrix.tsx), and the `authUser` type in App.tsx.

## What NOT to fix (pre-existing drift — out of scope)
Several routes have **route-local `isCoreTeam()` reimplementations** (insights.ts, myWatchlist.ts, teacherRoster.ts, trustedAdultLinks.ts) and a local recipient check (cron/inRouteOverdue.ts). These do **not** honor the assignable `isCoreTeam` flag *at all* (they hardcode SuperUser/Admin/BS/MTSS + PBIS/ESE). Since the existing Core Team flag is already excluded there, leaving them alone makes the new role behave **identically** to the existing flag — which is the contract. Refactoring them to the canonical helper would change behavior for existing roles = scope creep + regression risk.

**Why:** "full Core Team access" means "same as a person with the Core Team flag," not "more than them." Matching the flag's existing reach (including its existing blind spots) is the faithful, low-risk interpretation.

## Keep-in-sync invariant
`isCoreTeam()` exists in BOTH `lib/coreTeam.ts` (server) and an `isCoreTeamMember` mirror in App.tsx. Any role added to the Core Team set must land in both.
