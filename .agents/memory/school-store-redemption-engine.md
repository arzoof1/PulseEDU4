---
name: School Store redemption engine concurrency
description: How the PBIS School Store points wallet + redemption lifecycle stays correct under concurrency (advisory lock, derived balance, stockHeld restore).
---

# School Store redemption engine

The points **wallet is derived, not stored**: `available = SUM(non-voided pbis_entries.points) − SUM(school_store_redemptions.pointsSpent WHERE status IN (pending,fulfilled))`. There is no mutable balance row.

**Rule: every balance- or stock-affecting write must serialize on a per-(school,student) advisory lock, read the row's state AFTER locking, and commit via a status-guarded conditional update (0 rows ⇒ invalid_state) — never decide on a pre-lock snapshot.**
**Why:** reading status before locking let two concurrent approves both see `pending_approval` and double-decrement stock, and let approve-then-cancel cancel without restoring stock.
**How to apply:** any NEW lifecycle transition (partial-refund, expire, etc.) follows the same lock→re-read→guarded-update shape; restock/refund logic lives only inside the locked section.

**Rule: restore stock on cancel from the `stock_held` column, NOT from status.**
**Why:** stock is only decremented in `quantity` inventory mode once points are held; `simple` mode never decrements. Restoring based on "status was pending/fulfilled" over-restores in simple mode and after a mode switch. `stock_held` records whether THIS row actually took a unit, so restore is exact. Keep `pointsRefunded` (audit flag) separate from the stock decision.

**Inventory modes** live on `schoolSettings.schoolStoreInventoryMode` (`simple` = inStock boolean; `quantity` = quantityOnHand, null qty = untracked/always-available). `requiresApproval` items create `pending_approval` rows that hold NO points and NO stock until a staff member approves.

**Access:** catalog writes = super/admin/BS/MTSS/PBIS-coord; fulfillment queue + wallet read = Core Team || PBIS-coord || catalog-write.

**FLEID rule (review-blocking, learned the hard way):** the redemption row is `studentId`-keyed (FLEID), so EVERY response shape — wallet, list, AND each redeem/approve/fulfill/cancel mutation ack — must strip `studentId` and return `localSisId` (+ name) instead. A raw `res.json(row)` or `res.json(result.redemption)` leaks the FLEID. Sanitize at the single response helper, not per-endpoint. "Comment says don't render it" does NOT satisfy the contract — it must not leave the server.

## Point-balance migration importer (carried-over balances from LiveSchool etc.)

A `points_migration` data-import kind migrates an existing per-student point balance when a school converts to PulseEDU. Per-import toggle decides where the points land:
- **"store balance only"** → `pbis_point_migrations` ledger; `computeEarned` SUMs non-voided rows so they're SPENDABLE but invisible to houses/leaderboards/recognition counts.
- **"count as earned"** → real `pbis_entries` (so they DO count toward houses), stamped with `import_job_id`.

**Rule: the two toggle paths have DIFFERENT idempotency semantics, by design.**
- Store-only is idempotent: the ledger has a UNIQUE (school_id, student_id) index and insert UPSERTs (`onConflictDoUpdate` set from `excluded.*`), so re-importing a corrected file SETS the balance, never stacks.
- "Count as earned" is additive (recognitions are an append-only audit log) — re-running adds again; rely on rollback + the in-file dedupe + UI warning.
**Why:** a wallet balance is a set-operation; a recognition is an event. Forcing earned-path idempotency would mean mutating/collapsing the PBIS history log.

**Rule: precommitValidate must reject in-file duplicate local_sis_id** (`duplicate_in_file`), not just unknown/ambiguous. Two rows for one student would double-credit AND make the store-only UPSERT touch the same key twice in one statement (Postgres errors).

**Rule: "count as earned" must pre-seed milestone-email suppression AND make it rollback-reversible.** `suppressMigratedMilestones` inserts `pbis_milestone_emails` `status:"skipped"` dedupe rows (onConflictDoNothing) for every milestone the carried-over total crosses, so the next ordinary award doesn't fire a belated email flood. Those rows carry `import_job_id`, and rollback DELETEs `pbis_milestone_emails WHERE import_job_id=job` — otherwise a rolled-back migration permanently silences future legitimate milestone emails. Do NOT call `processMilestonesForStudent` on import.

**Rollback** deletes by `import_job_id` from `pbis_point_migrations` + `pbis_entries` + `pbis_milestone_emails` (a job only ever wrote to one of the first two, but deleting from both is safe). Match is always by `local_sis_id` resolved school-scoped to FLEID; responses never carry the FLEID.
