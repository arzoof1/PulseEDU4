---
name: Object bind — uploader school vs owner school
description: Why bindObjectToSchool separates the ACL owner school from the school that minted the upload URL.
---

`/api/storage/uploads/request-url` records a pending upload under the
**uploader's** `req.schoolId` (in-memory ledger). `bindObjectToSchool` later
claims the object: it sets the ACL **owner** and verifies a matching pending
entry exists.

**Rule:** when an actor uploads on behalf of a *different* school they manage
(e.g. a SuperUser/district admin setting another school's teacher photo), the
ACL owner must be the **target's** school but the pending match must accept the
**actor's** upload school. Pass the actor's authorized schools as
`bindObjectToSchool(objectPath, ownerSchoolId, uploaderSchoolIds)`. When owner
and uploader are the same school (the common case, e.g. student photos), call
it with two args — the 3rd defaults to `[ownerSchoolId]`.

**Why:** the staff photo route originally called
`bindObjectToSchool(objectPath, target.schoolId)`; for a SuperUser whose
`req.schoolId` ≠ target school, `pending.schoolId !== target.schoolId` → bind
returned false → 403 "Object not bound". The student route never hit this
because it binds with the same `req.schoolId` it uploaded under.

**Invariant kept:** the already-bound branch still only succeeds when
`existing.owner === schoolOwnerKey(ownerSchoolId)`, so a bound object can never
be re-owned by another school, regardless of `uploaderSchoolIds`.
