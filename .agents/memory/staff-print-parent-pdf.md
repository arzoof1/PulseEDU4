---
name: Staff print of parent-facing PDF
description: Pattern for a staff button that downloads the exact parent HeartBEAT PDF (visibility-scoped, no-existence-leak).
---

# Staff "Print HeartBEAT" (staff downloads the parent-facing PDF)

To give staff the *same* document a parent gets, split the parent snapshot
builder into a context-tagged core rather than duplicating it:

- `buildParentSnapshot(parentId, studentId)` = thin wrapper that keeps the
  parent ownership check, then delegates to `assembleSnapshot(studentId, ctx)`.
- `buildStaffSnapshot(studentId, schoolId)` = new exported entry, same core,
  `ctx.mode="staff"`.
- Staff mode has **no parent account** → parent identity blank, **no per-parent
  prefs** → section visibility falls back to the school HeartBEAT defaults. It
  re-checks `student.schoolId === schoolId` (404 otherwise).

**Why:** parent behavior must stay byte-for-byte identical; a second builder
would drift. One core, two context entries.

## No-existence-leak invariant (the code-review catch)
The staff route (`GET /api/staff/heartbeat.pdf?studentId=<numericDbId>`) is
gated by `getVisibleStudentIds` (teachers → own roster + trusted-adult; core
team/admin/counselor → school-wide). **An in-school-but-not-visible student and
a non-existent id MUST both return an indistinguishable 404** — returning 403
for "exists but not yours" lets an authed staffer probe which students exist.

**How to apply:** any authed endpoint that loads a row *before* an
authorization/visibility check must collapse the "unauthorized" and "not found"
responses to the same status+body, or it leaks existence metadata.

## Boundaries
`localSisId` only, never FLEID. Route is `/staff/heartbeat.pdf` — distinct from
the hyphenated `staff-*` routes (staff-directory, staff-defaults), so no
shadowing. Client downloads via `authFetch` → blob → anchor click.
