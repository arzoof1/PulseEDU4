---
name: PBIS weekly-aggregation windows must span the full 7-day week
description: Why "this week" PBIS/stat buckets must be Mon->next-Mon, not Mon-Fri
---

Weekly-bucket aggregation surfaces (e.g. the PBIS Hub home-stats tiles) must
build each week as a full Mon 00:00 -> next Mon 00:00 (7-day) half-open interval,
NOT Mon -> Sat (5 days, "Mon-Fri only").

**Why:** a Mon->Sat window plus a per-entry weekend skip left the Sat->Mon span
uncovered. Points awarded on a weekend fell into that gap and were dropped from
EVERY week's bucket permanently (not deferred to next week) — the hub showed 0
even though the rows were in `pbis_entries`. The server runs in UTC, so a reporter
adding test points on a Saturday saw nothing. Sibling endpoint
`/pbis/needs-attention` already used `thisMonday..nextMonday`, so the two surfaces
disagreed.

**How to apply:** for any "this week" count/tile, use thisMonday..nextMonday and
count entries regardless of weekday. Reserve Mon-Fri "school-day" counting
(`subtractSchoolDays`) for windows that are genuinely about instructional days
(invisible-student tier windows, quiet-teacher windows) — those legitimately skip
weekends because they measure school-day staleness, not raw activity totals.
