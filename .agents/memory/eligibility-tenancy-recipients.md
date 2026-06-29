---
name: Notification-recipient & join queries must re-assert school_id
description: Tenancy class-of-bug — secondary reads (notification recipients, joined-table reads, path-derived id reads) need their own school_id predicate even when the driving table is already scoped.
---

# Re-assert school_id on every secondary read, not just the driving table

When a feature is otherwise school-scoped, three read shapes still silently
leak across tenants and an architect review repeatedly catches them:

1. **Notification recipient lookups.** Selecting recipients by a *role flag*
   alone (e.g. `staff.isAthleticDirector = true AND active`) with no
   `staff.school_id = schoolId` emails other schools' staff. Role flags are
   per-school columns, not district-global — always pair with school_id (or a
   deliberate, documented district-resolution path).

2. **Joins that drive aggregation.** An innerJoin from a scoped child
   (`members.school_id = schoolId`) to a parent (`activities`) on `activityId`
   does NOT constrain the parent's school. Add
   `parent.school_id = schoolId` to the join's WHERE — defense in depth so a
   stray cross-school id can't leak the parent row (e.g. an activity name) into
   another tenant's report.

3. **Path-derived ids on write/read routes.** Routes taking `:id` for a parent
   entity (members/coaches/roster under `/activities/:id/...`) must verify that
   id belongs to `req.schoolId` before use. PATCH/DELETE that fold the id into
   a school-scoped WHERE are safe (they 404), but a bare INSERT using the
   path id, or a read helper called with the raw id, is not. Use a shared
   `assertActivityInSchool(id, schoolId)` guard.

**Why:** these are the exact gaps an `evaluate_task` architect run flagged on
the Eligibility Hub; the driving-table filter looked complete but secondary
reads were unscoped.

**How to apply:** when adding any tenant feature, audit every SELECT for its
own school_id predicate — recipient queries, every joined table, and any
id pulled from the request path.
