---
name: SSO identity resolution must be tenant-scoped
description: Resolving a roster student from an external SSO identity needs school scoping + ambiguity rejection, not a bare match.
---

When signing a student (or any roster-backed user) in from an external SSO
identity, the lookup keys — `sso_external_id` and the OneRoster `local_sis_id`
fallback — are **NOT globally unique** across schools. A bare
`where(eq(col, externalId)).limit(1)` can bind the wrong school's record
(cross-tenant account confusion).

**Rule:** carry the intended `schoolId` across the OAuth authorize→callback
round-trip (stash in session at `/sso/start`, read+clear in `/sso/callback`),
scope every roster lookup by it, and `.limit(2)` so you can **reject ambiguous
matches (409)** instead of silently signing into an arbitrary row.

**Why:** identifiers in this app are composite-unique `(school_id, column)`, not
unique alone (same gotcha as the rest of multi-tenancy). Pre-auth identity
resolution is the one place you don't yet have `req.schoolId`, so the tenant
must come from the SSO flow state, not the matched row.

**How to apply:** any new external-identity sign-in (SSO/OIDC/magic-link that
matches on a SIS id). The client SSO button must pass `?schoolId=` to
`/sso/start` for the scoping to engage; without it the code falls back to
unscoped lookup but still rejects ambiguity.
