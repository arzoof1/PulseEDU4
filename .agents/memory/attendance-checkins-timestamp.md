---
name: attendance_checkins createdAt is a real timestamp
description: Why drizzle comparisons on attendance_checkins.createdAt need Date objects, not ISO strings
---

`attendance_checkins.createdAt` is a real `timestamp(..., { withTimezone: true })`
(JS `Date`), unlike most other PulseEDU ledger tables (`tardies`, `pbis_entries`,
`support_notes`) whose `created_at` is `text("created_at")` (a string).

**Why:** copying a `gte(table.createdAt, fromIso)` pattern from those text-based
tables onto `attendance_checkins` fails typecheck ("PgColumn ... is not assignable
to ... Aliased<string> / never") because the column expects a `Date`, not a string.

**How to apply:** when filtering `attendance_checkins` by time, compare against
`Date` values (e.g. `window.from` / `window.to`), not `.toISOString()` strings.
For day-bounded school-year queries, prefer the `day` TEXT column
(`gte(attendance_checkins.day, syStartIso)`) which IS a `YYYY-MM-DD` string and
matches the school-year bound helpers. Don't assume created_at column types are
uniform across ledger tables — check the schema.
