---
name: Demo/test-mode data isolation
description: How synthetic "test mode" rows that share a production table must be partitioned so real aggregation paths never pick them up.
---

# Demo / test-mode data isolation

When a demo/test feature writes into the SAME table that production
aggregation reads (e.g. On-Time test-loop check-ins land in
`attendance_checkins` alongside real ones), the synthetic rows MUST be
tagged with a recognizable key prefix and excluded from every real
aggregation path — not just hidden in the UI.

**Why:** the Tardy Lottery cron discovers candidate (teacher, period)
pairs by scanning today's check-ins. Synthetic demo classes would
otherwise become eligible to win the real afternoon draw. UI-only
hiding does not protect server-side aggregation.

**How to apply:**
- Tag synthetic rows with a prefix the real path can filter on
  (test-loop check-ins use `periodKey` `testloop:<cycle>:<day>`).
- The production/cron path excludes them (`notLike(periodKey,
  'testloop:%')`) in BOTH candidate discovery AND winner selection —
  miss either and a demo class can still slip through.
- The admin "run now" demo path opts back in via a flag so a demo can
  reward the classes it just scanned.
- Destructive demo helpers that clear-then-redraw must run in a
  transaction so a failed redraw never leaves real data deleted but
  unreplaced; keep network I/O (reveal email) OUT of the transaction
  and skip it on demo re-runs.
- New demo-only columns are additive: register an `ensure*` boot
  migration in `seed.ts` (ALTER TABLE ... IF NOT EXISTS) and wire it
  into the `runSeed` boot chain, or prod DBs onboarded earlier lack
  the columns.
