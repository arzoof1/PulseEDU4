---
name: Staff PATCH batched gating
description: Why a batched PATCH /admin/staff/:id must omit fields the actor can't change, including self-revocation caps.
---

# Staff & Roles "Edit access" modal — batched-save gating

The Staff & Roles editor sends ONE PATCH /admin/staff/:id with the whole
caps+role-flags body (StaffAccessModal). The server rejects the ENTIRE request
(not just the offending field) when the body contains a change the actor isn't
allowed to make. So the client must never build a body with a field the server
will reject — one bad field sinks every other edit in the same save.

Server rejection cases to mirror on the client:
- 403 if body includes isSuperUser/isDistrictAdmin/isAdmin the actor can't set
  (super-only / admin-or-super). Omit those flags entirely when !canSetRole.
- 403 if a non-admin/non-super sends capStaffRoles/capManageRoles at all (even
  unchanged). Lock + omit them for non-admin/super.
- 409 if the actor REVOKES capStaffRoles/capManageRoles on their OWN account
  (self-revocation). Lock them for self when currently held so the body never
  flips them to false.

**Why:** with a batched (non-per-cell) save, a single rejected field returns an
error for the whole PATCH and the user loses all other changes silently.

**How to apply:** any time you add a field to the staff edit body, check
adminStaff.ts PATCH gating and add a matching client-side lock/omit. Roles are
ADDITIVE in this modal (checking a role merges its caps; unchecking clears only
the flag) — a deliberate shift from the old role-pill REPLACE behavior.
