---
name: Admin-only staff cap that Core Team cannot delegate
description: How to make a PATCH /admin/staff cap grantable ONLY by Admin/SuperUser, not by cap_staff_roles holders.
---

# Admin-only cap (Core Team cannot delegate) in adminStaff.ts PATCH

To make a staff capability assignable **only by Admin/SuperUser** (Core Team
CANNOT delegate it), you MUST add an explicit per-field gate in the
`PATCH /api/admin/staff/:id` handler:

```ts
if ("capX" in updates && !actor.isSuperUser && !actor.isAdmin) {
  res.status(403).json({ error: "Only Admin/SuperUser can assign X." });
  return;
}
```

**Why:** the PATCH's field-strip (which limits non-privileged actors to the
data-import caps) only runs for `!hasFullRoleAuthority(actor)`. But
`hasFullRoleAuthority` **includes `capStaffRoles`** — so a Core Team member
holding `capStaffRoles` passes the strip and keeps the FULL field set. Without
an explicit admin-only gate, that actor could grant the "admin-only" cap to
anyone. Mirror the existing `capStaffRoles`/`capManageRoles` gate.

**How to apply:** whenever a cap's spec says "only admins assign, Core Team can't
delegate," don't rely on the strip or on client toggle locking (both bypassable
for a `capStaffRoles` holder) — add the explicit `isAdmin || isSuperUser` gate.
Precedent: `capViewFastHistory` (Historical FAST).
