---
name: Hall pass create-on-behalf authorization
description: Who may attribute a hall pass to another teacher/room, and why it must be enforced server-side.
---

# Hall pass create-on-behalf authorization

On `POST /api/hall-passes`, the "From" teacher (`teacherName`) and origin
`originRoom` are **identity/authority fields, not free text**. Only Core Team
(`isCoreTeam(actor)` from `lib/coreTeam.ts`) may issue a pass attributed to
another teacher or room. For any non-Core-Team authenticated staff member, the
server DERIVES `teacherName` from `actor.displayName` and `originRoom` from
`actor.defaultRoom ?? ""`, ignoring whatever the body sent.

**Why:** locking the From/Room pickers in `CreatePassModal` (client) is
bypassable — a stale tab or crafted request can forge a pass under another
teacher's name (pollutes their queue/companion panel, keep-apart + daily-limit
attribution) or spoof a room to dodge Restroom Access policy. Same precedent as
the `endedBy` derivation on `PATCH /hall-passes/:id/end` and the
`hall-pass-destination-policy` rule: any UI permission gate on a hall-pass
field must have a matching server enforcement.

**How to apply:** the derive-from-actor block runs BEFORE the restroom check so
the policy check uses the effective (not body) values. Client
`canChangeTeacher` must mirror server `isCoreTeam()` membership exactly — the
new assignable `staff.isCoreTeam` flag is OR'd into `isCoreTeam()`, so it
auto-extends create-on-behalf along with every other gate that composes it.
Unauthenticated callers (no `req.staffId`, e.g. kiosk/origin flows) keep body
values and are gated by their own route.
