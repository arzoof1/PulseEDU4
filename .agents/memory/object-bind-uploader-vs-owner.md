---
name: Staff & Roles is active-school scoped
description: Staff & Roles roster (list/export/photo) follows the active school, not the whole district; district reach is a separate capability surface.
---

# Staff & Roles scopes to the ACTIVE school, not the district

Staff & Roles is an **operational** surface: its list, CSV export, and
per-staff photo upload/delete all scope to the actor's **active school**
(`req.schoolId`, set by the tenancy switcher / `activeSchoolOverride`) —
for everyone, including SuperUsers. A SuperUser switches schools to
manage another school's staff.

**Why:** A SuperUser reported the roster showing every school in the
district. The earlier design fanned the SuperUser branch out over
`getSchoolIdsForDistrict`, which is wrong for an operational roster.

**How to apply:**
- Scope operational/management surfaces (rosters, kiosks, hall passes,
  PBIS, per-staff mutations) by `req.schoolId`. Guard with a 400 when
  there's no active school.
- Keep **district-wide reach** as a *capability*, exposed only on
  dedicated reporting routes (e.g. `districtOverview.ts`), gated by
  `canActAsDistrict` + `getSchoolIdsForDistrict` — never bolted onto a
  per-school roster. Adding a future "District PM1 report" belongs there.

# Object storage bind/read are same-school only

`bindObjectToSchool(objectPath, schoolId)` is 2-arg and same-school: the
pending upload's school must equal the owner school, and the
`/storage/objects/*` read path allows only `policy.owner ===
school:<req.schoolId>`. There is **no** cross-school/district read or
bind widening — an earlier `uploaderSchoolIds` 3rd arg +
`viewerMayReadAcrossSchool` slow path were tried and **reverted** once
the roster became single-school (the upload target is always in the
active school, so owner == req.schoolId == pending.schoolId).

**How to apply:** if a *future* district surface needs to read another
school's object, add the widening **there**, gated by `canActAsDistrict`
— don't reintroduce it globally in `storage.ts`.
