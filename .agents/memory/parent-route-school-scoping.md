---
name: Parent-route school scoping
description: Parent-authenticated routes must carry an explicit school_id predicate, not just parentId.
---

Parent-app routes authenticate by `parentId` (session or Bearer token). Even
though a parent belongs to exactly one school, queries/updates on tenant-scoped
tables must STILL include an explicit `school_id` predicate — do not rely on
`parentId` being globally unique for tenant isolation.

**Why:** code review flagged broken-access-control risk: filtering by `parentId`
alone leaves cross-tenant ambiguity if IDs ever collide or a row is mis-stamped,
and it violates the project invariant that every tenant-scoped read/write filters
on `school_id`.

**How to apply:** resolve the parent's school once from `parents.school_id`
(active row only), then add `eq(<table>.schoolId, parentSchoolId)` to every
parent read/write. For an attachment/detail fetch, scope the parent row AND the
parent message by the same school. Pattern lives in `resolveParentContext` in
`routes/parentMessages.ts`.
