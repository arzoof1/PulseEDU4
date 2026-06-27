# Developer Migration Doc — Sidebar Role-Aware Nav (Phase 5)

**Audience:** the developer migrating these changes to the live website.
**Scope:** ONE source file changed. No database changes, no config/env changes,
no dependency changes, no API/server changes.

---

## 1. Summary

The staff app sidebar is organized into collapsible groups (accordions). Each
group has a visibility flag (`show<Group>`) that decides whether the whole group
header renders, and each item inside the group has its own role/permission gate.

Two group visibility flags were **narrower** than the items inside them. As a
result, certain roles had a tool gated *visible* inside a group, but the group
header itself was hidden — so those users could not reach the tool from the
sidebar (a "suppression" bug).

The fix makes each of the two flags equal to the **exact OR (disjunction) of the
gates of the items rendered inside that group**, so a group appears precisely
when at least one item inside it is visible to the current user.

**Access impact:** each new flag is a strict **superset** of the old flag.
- No role loses access to anything it could reach before.
- Some roles **regain** access to a group whose item they were already
  authorized to use.

No items were moved between groups, no per-item gate was changed, no other
behavior changed.

---

## 2. File changed

| File | Change |
| --- | --- |
| `artifacts/client/src/App.tsx` | Two `const show…` boolean expressions edited inside the `App()` component (the sidebar render block). |

Nothing else needs to be deployed. (Internal planning/notes files under
`.local/` were also touched in the working copy but must **not** be migrated —
they are agent scratch files, not application code.)

---

## 3. Exact code changes

> Location: inside `function App()`, in the sidebar render block where the
> `show<Group>` flags are declared (just after `const showRecognition = …`).
> Anchor on the surrounding `const showRecognition` / `const showSpecialPrograms`
> lines if line numbers have drifted in your branch.

### 3a. `showBehaviorSupport` (the "Student Support" group)

**Before:**

```ts
const showBehaviorSupport =
  effectiveFeatures.LogIntervention ||
  effectiveFeatures.RequestPullout ||
  isBehaviorSpec ||
  canVerifyPullouts ||
  canViewIssDashboard ||
  canReviewPullouts ||
  canManageMtssPlans ||
  (canManageBehaviorLists && !isBehaviorSpec);
```

**After:**

```ts
// Phase 5 — role-aware nav: this flag must be the EXACT disjunction of
// every item gate rendered inside the Student Support group below, so
// the group appears precisely for roles that have at least one item in
// it (never an empty header, and never suppressing an item a role is
// authorized for). Previously it omitted canEditSafetyPlanClient
// (Guidance Counselor / School Psychologist could reach Safety Plans
// only if another term happened to be true) and isDistrictAdmin (the
// Log ODR / Investigations items admit District Admin). Adding the
// missing terms only ever REVEALS an already-authorized item — it
// removes no access. Keep in lockstep with the item gates below.
const showBehaviorSupport =
  effectiveFeatures.LogIntervention ||
  effectiveFeatures.RequestPullout ||
  isBehaviorSpec ||
  canVerifyPullouts ||
  canViewIssDashboard ||
  canReviewPullouts ||
  canManageMtssPlans ||
  canEditSafetyPlanClient ||
  canAccessMtssHub ||
  isDistrictAdmin ||
  isDean ||
  (canManageBehaviorLists && !isBehaviorSpec);
```

**Net change:** four terms added — `canEditSafetyPlanClient`, `canAccessMtssHub`,
`isDistrictAdmin`, `isDean`. (`canAccessMtssHub`/`isDean` are technically already
covered by other terms; they are included for literal parity with the item gates.)

### 3b. `showSchoolAdmin` (the "Admin & Settings" group)

**Before:**

```ts
// canManageBellSchedules covers admin/superuser/mtss/behaviorSpec.
// The "Interventions" behavior-lists editor moved into this group;
// its viewers are (canManageBehaviorLists && !isBehaviorSpec) =
// MTSS coordinators (already covered via isMtss) + Deans (NOT
// otherwise in this group). Add that clause so Deans keep their
// config item. Each item below stays individually gated, so this
// only ever reveals items a user is already authorized for.
const showSchoolAdmin =
  canManageBellSchedules ||
  isAdmin ||
  (canManageBehaviorLists && !isBehaviorSpec);
```

**After:**

```ts
// Phase 5 — role-aware nav: like showBehaviorSupport, this must be the
// EXACT disjunction of every item gate rendered inside the Admin &
// Settings group below. The old flag (bell schedules || admin ||
// behavior-lists) suppressed the group for roles that hold ONLY a
// narrower admin capability — e.g. a teacher granted capStaffRoles
// (canManageStaffRoles) or cap_manage_displays (canManageDisplays), a
// District Admin (canManageSettings / canApproveAst), an AST approver
// (canApproveAst), or an Eligibility manager (canManageEligibility) —
// even though those items were gated visible inside. Adding the missing
// terms only REVEALS items the role is already authorized for; it
// removes no access. Keep in lockstep with the item gates below.
const showSchoolAdmin =
  isAdmin ||
  canManageStaffRoles ||
  canManageBellSchedules ||
  canManageDisplays ||
  canAccessMtssHub ||
  canManageSettings ||
  canApproveAst ||
  canManageEligibility ||
  (canManageBehaviorLists && !isBehaviorSpec);
```

**Net change:** six terms added — `canManageStaffRoles`, `canManageDisplays`,
`canAccessMtssHub`, `canManageSettings`, `canApproveAst`, `canManageEligibility`.
All original terms retained.

---

## 4. Prerequisites / assumptions

All the boolean flags referenced by the new code are **already defined** in the
same `App()` component on the dev branch (no new variables introduced):

`canEditSafetyPlanClient`, `canAccessMtssHub`, `isDistrictAdmin`, `isDean`,
`canManageStaffRoles`, `canManageDisplays`, `canManageSettings`,
`canApproveAst`, `canManageEligibility`.

> If the live branch is significantly behind and any of these flags does not yet
> exist, that means the live branch predates the earlier sidebar phases. In that
> case, reconcile branch history first — do **not** stub these flags by hand.

There are **no** changes to:
- the database schema or any migration,
- environment variables / secrets,
- the API server (`artifacts/api-server`),
- dependencies (`package.json` / lockfile),
- the mobile `800px` sidebar breakpoint or its CSS,
- `activeSection` keys or the `NAV_GROUP_OWNERSHIP` map.

---

## 5. How to apply

1. Apply the two edits in Section 3 to `artifacts/client/src/App.tsx` on the
   live codebase (cherry-pick the commit if your repos share history, or hand-apply).
2. Typecheck the client package:
   ```bash
   pnpm --filter @workspace/client run typecheck
   ```
   Expected: exit 0.
3. Build/deploy the client artifact through your normal pipeline. (Client-only
   change — no server restart strictly required, but redeploy the static client
   bundle.)

---

## 6. Verification (post-deploy smoke test)

Confirm the newly-visible groups appear for the affected roles, and that nothing
regressed for everyone else.

**Should now SEE the group (regained access):**

| Log in as… | Expected new visibility |
| --- | --- |
| Guidance Counselor or School Psychologist (no other admin role) | "Student Support" group now visible (Safety Plans reachable from sidebar) |
| District Admin (not a school Admin/SuperUser) | "Student Support" (Log ODR / Investigations) **and** "Admin & Settings" (Settings, Kiosks) now visible |
| Dean | "Student Support" group visible |
| Teacher granted **Staff Roles** capability only | "Admin & Settings" group now visible (Staff & Roles reachable) |
| Teacher granted **Manage Displays** capability only | "Admin & Settings" group now visible (Displays reachable) |
| AST approver / Eligibility manager (no other admin role) | "Admin & Settings" group now visible |

**Should be UNCHANGED (no regression):**

| Log in as… | Expected |
| --- | --- |
| School Admin / SuperUser | Sees everything, exactly as before |
| Plain classroom teacher (no special capability) | Sidebar identical to before |
| Behavior Specialist / MTSS Coordinator | Same groups as before |

---

## 7. Rollback

Single-file, additive logic change. To roll back, restore the two `const show…`
expressions to their "Before" form in Section 3 and redeploy the client. No data
or schema cleanup is involved.
