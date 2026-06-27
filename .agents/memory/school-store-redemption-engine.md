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
