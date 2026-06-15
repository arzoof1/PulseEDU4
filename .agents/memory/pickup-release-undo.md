---
name: Pickup release-undo idempotency
description: Why the pickup "Undo release" action must be idempotent and never show a scary error for a redundant undo.
---

The teacher Pick-Up view (`PickupApp.tsx`) shows a 10s "Undo" toast after a
release. Undo writes an append-only `release_undone` event (POST
`/pickup/queue/release-undo`).

**Rule:** an undo that the user genuinely intended must never surface an error.
A redundant/double-fired undo, or one already reversed by someone else, returns
success (no-op). Only a TERMINAL forward event (`in_car` / `walker_released` —
the child was actually picked up) may block, and with a plain-language message.

**Why:** the original guard blocked on *any* later event for that student. A
double-tap on the Undo button (common on pickup touchscreens, button wasn't
disabled) fired undo twice: the first wrote `release_undone`, the second saw
that row as a "newer event" and returned a 409 that the client rendered as a
raw JSON blob — making staff feel they'd done something wrong, even though the
undo had worked.

**How to apply:**
- Server: classify events newer than the release. `release_undone` present →
  `{ ok: true }`. `in_car`/`walker_released` present → friendly 409. Otherwise
  perform the undo. Never blanket-block on "any later row."
- Client: disable the Undo button while the request is in flight, and parse
  `{ error }` from responses — never `setErr(await r.text())` (dumps raw JSON).
