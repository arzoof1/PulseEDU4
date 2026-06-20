---
name: Pickup manual override (front office vs RosterOne)
description: Override-wins semantics, the RosterOne-disagrees flag direction, and audit atomicity for front-office pickup-authorization overrides.
---

# Front-office manual override of pickup authorizations

Pickup authorizations sync from RosterOne (ClassLink). The front office can
override them by hand. Override metadata lives on `pickup_authorizations`
(`source` sis|portal|manual, `override_reason`, `override_by`, `override_at`,
`expires_at`) + a `pickup_override_audit` log.

## "RosterOne disagrees" flag direction (the one easy to invert)
`sisMayHaveContact` = the SIS emergency-contact feed appears to list a contact
matching the guardian label. RosterOne **DISAGREES** with the override when
`!sisMayHaveContact` (the office is keeping a value the SIS doesn't back up).
**Why:** the server `sisDisagrees` count is `!sisMayHaveContact`; a first cut of
the client badge rendered on `sisMayHaveContact` (inverted) so the row badge and
the summary count contradicted each other.
**How to apply:** any surface that flags disagreement must use `!sisMayHaveContact`
and stay in lockstep with the server count.

## Override-wins / sync protection
A row is office-owned (`isSyncProtected`) when `source === 'manual'` OR it carries
an `override_reason`. Bulk-assign's legacy-upgrade loop MUST skip these or a roster
re-import clobbers the manual value. "Manually cleared" = Deactivate-with-reason.
Temporary overrides carry `expires_at`; an idempotent sweep retires lapsed temps
before any office read and the curb `/pickup/lookup` excludes them the instant they
lapse.

## Audit atomicity
Each data mutation + its audit row(s) commit in ONE `db.transaction`.
`writeOverrideAudit(opts, executor=db)` takes an optional tx executor
(`Pick<typeof db, "insert">`) so the audit insert joins the surrounding tx.
**Why:** a failed audit insert must roll back the mutation — never leave a mutated
row without its audit trail.

## Client capture rules (reused project gotchas)
Reason capture is iframe-safe (inline modal / inline field, never `window.prompt`).
Client `datetime-local` expiry is converted to a UTC ISO instant
(`new Date(local).toISOString()`) before send. Reconciliation tile renders
`localSisId` only (NO FLEID). Single `canManagePickup` gate (dismissal mode keeps
`canManageDismissal`).
