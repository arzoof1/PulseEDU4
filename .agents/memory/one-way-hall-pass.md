---
name: One-way hall pass lifecycle
description: Invariants for the non-restroom one-way pass lifecycle (in-route → check-in), receiver identity, and overdue alert dedup.
---

# One-way hall pass lifecycle

Non-restroom passes are **one-way**: leave origin → in-route → checked in
(received) at the destination by staff. Restroom passes stay **round-trip**
("I'm back" at origin). The single discriminator is
`loadRestroomDestinationNames(schoolId)` in
`artifacts/api-server/src/lib/oneWayPass.ts`.

**Why:** every surface that branches on lifecycle state must use that same
restroom set, or restroom passes get mislabeled — e.g. the parent portal
flagged active restroom passes as "in route", and the end route could stamp a
meaningless `arrivedAt` on a restroom pass.

**How to apply:**
- `PATCH /hall-passes/:id/end`: ignore `arrived:true` when the destination is a
  restroom (round-trip has no destination arrival).
- Parent snapshot exposes a per-pass `oneWay` boolean (`!restroomNames.has(dest)`);
  the client computes `inRoute` only when `oneWay`. Don't infer one-way purely
  from `arrivedAt == null && status == active` — restroom passes also match that.

## Receiver identity (`endedBy`) is derived server-side
`endedBy` records WHO received/ended the pass. Derive it from the authenticated
staff (`req.staffId` → `staffTable.displayName`, school-scoped), not from
client-supplied text. **Why:** the client could otherwise spoof the receiver
name. Non-staff callers (system cleanup, unauthenticated origin "I'm back")
fall back to the sentinel/`null`.

## Overdue alert dedup must be an atomic claim
The in-route overdue cron must claim each pass with a conditional update
(`UPDATE ... SET overdue_alerted_at = now WHERE id = ? AND overdue_alerted_at
IS NULL RETURNING`) and only send when a row is returned. **Why:** a plain
select-then-unconditional-update lets two overlapping cron ticks both select the
same candidate and double-send. The stamp is the dedup key, so claiming it
atomically is the only safe pattern.
