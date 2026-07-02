---
name: Route-local staff-load tenant guard
description: Auth-context staff loads by id alone need an explicit active-school guard; several older routes lack it.
---

The rule: when a router loads the acting staff row by `req.staffId` alone (`WHERE staff.id = :staffId`), it must also verify tenant alignment before using that row for role checks — `staff.isSuperUser || staff.schoolId === req.schoolId`, else 403. Every data query in the router scopes by `req.schoolId`, so a mismatched actor context silently violates the multi-tenancy invariant.

**Why:** Architect review flagged this on the Data Chats router (July 2026). `dataChats.ts` now has the guard in its `loadStaff`. Sibling routers (e.g. `eligibility.ts`, `studentLookup.ts`) still load staff by id only — pre-existing drift; middleware normally keeps ids aligned, but the guard is the defense-in-depth the invariant demands.

**How to apply:** any NEW router with a route-local `loadStaff`/`requireStaff` helper should copy the guard from `routes/dataChats.ts` `loadStaff`. Don't mass-retrofit old routers unless touching them anyway.
