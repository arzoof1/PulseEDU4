---
name: Pickup bulk-assign concurrency
description: Why the school-wide pickup number minter needs both a DB partial-unique index and a per-school advisory lock, not just app-level dedup.
---

The school-wide "Assign pickup numbers" button mints one number per
emergency contact per student in a single transaction, picking next-free
numbers from an in-memory `used` set seeded from a snapshot of active rows.

**Rule:** any school-wide number/slot minter must enforce uniqueness at the
DB level AND serialize concurrent runs — app-level dedup alone is not enough.

**Why:** two operators clicking "Assign" at once both snapshot the same
active rows and pick the same next-free numbers. Without DB enforcement they
double-issue; with only the number index they collide and surface a raw 500.

**How to apply (the pattern in `routes/pickup.ts` bulk-assign):**
- Partial unique index `pickup_auth_active_contact_slot_unique` on
  `(school_id, student_id, contact_slot) WHERE active AND contact_slot IS NOT NULL`
  enforces "one active auth per contact slot." Scoped to `contact_slot IS NOT
  NULL` so manual issues and the "Family" fallback (slot NULL) stay
  unconstrained, and pre-existing rows (all NULL slot) don't break index
  creation.
- `pg_advisory_xact_lock(<ns>, schoolId)` at the top of the transaction
  serializes per-school runs so they queue instead of race.
- Map Postgres `23505` (unique violation) in the catch to a controlled 409
  ("numbers shifted, run Assign again") since assign is idempotent — never let
  a rare race become a 500.
