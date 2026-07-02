---
name: Frozen demo dataset current-school-year drift
description: Why "current school year" for seeds/readers over frozen demo data must come from the data, not the wall clock.
---

# Frozen demo dataset — derive current school year from DATA, not wall clock

Any seed OR read path that needs "the current school year" for a **frozen demo
dataset** must resolve it from the data (newest non-historical row), NOT from
the wall clock (`schoolYearLabelFor(new Date())`).

**Why:** demo/seed data is frozen at the year it was seeded. `schoolYearLabelFor`
flips at the **July** school-year boundary (`m >= 7 ? y : y-1`). Once the wall
clock crosses July, it returns e.g. `26-27` while the newest real rows are
`25-26`. That mismatch caused two concrete failures for Historical FAST:
1. The **seed** treated the real current-year rows (`25-26`, `is_historical=false`)
   as a *prior* year and minted phantom `is_historical=true` rows for it.
2. The **reader** dropped the real current-year anchor row (its year no longer
   equalled the wall-clock "current") and shifted grade-in-year math by a year.

**How to apply:** use a data-anchored resolver like `resolveCurrentFastYear(schoolId)`
= `MAX(school_year) WHERE is_historical = false` (school-scoped), falling back to
the wall clock only when the school has no current-year data at all. Use the SAME
resolver in the seed and every read route so they never disagree. Do NOT change
the shared `schoolYearLabelFor` behavior — other live-data paths depend on it.
