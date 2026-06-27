---
name: School Store redemption engine concurrency
description: How the PBIS School Store points wallet + redemption lifecycle stays correct under concurrency (advisory lock, derived balance, stockHeld restore).
---

# School Store redemption engine

The points **wallet is derived, not stored**: `available = SUM(non-voided pbis_entries.points) − SUM(school_store_redemptions.pointsSpent WHERE status IN (pending,fulfilled))`. There is no mutable balance row.

**Rule: every balance- or stock-affecting write must serialize on a per-(school,student) `pg_advisory_xact_lock`, and must read the redemption row's authoritative state AFTER acquiring the lock — never decide on a pre-lock snapshot.**
**Why:** approve/cancel/fulfill originally read status before locking → two concurrent approves both saw `pending_approval` and double-decremented stock; approve-then-cancel could cancel without restoring stock. Use `lockRedemptionStudent()` (reads studentId, locks, caller re-reads), then a status-guarded `UPDATE ... WHERE status = <expected>` returning 0 rows ⇒ `invalid_state`.
**How to apply:** any NEW lifecycle transition (e.g. partial-refund, expire) must follow the same lock→re-read→status-guarded-update shape. Restock/refund logic lives only inside that locked section.

**Rule: restore stock on cancel from the `stock_held` column, NOT from status.**
**Why:** stock is only decremented in `quantity` inventory mode once points are held; `simple` mode never decrements. Restoring based on "status was pending/fulfilled" over-restores in simple mode and after a mode switch. `stock_held` records whether THIS row actually took a unit, so restore is exact. Keep `pointsRefunded` (audit flag) separate from the stock decision.

**Inventory modes** live on `schoolSettings.schoolStoreInventoryMode` (`simple` = inStock boolean; `quantity` = quantityOnHand, null qty = untracked/always-available). `requiresApproval` items create `pending_approval` rows that hold NO points and NO stock until a staff member approves.

**Access:** catalog writes = `hasStoreWriteAccess` (super/admin/BS/MTSS/PBIS-coord); fulfillment queue + wallet read = `canManageStoreFulfillment` (isCoreTeam || PBIS-coord) OR write-access. Wallet/list responses carry `localSisId` for display; `studentId` (FLEID) is join-key only, never rendered.
