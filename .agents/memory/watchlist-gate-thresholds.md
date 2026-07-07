---
name: Watch List needs-attention gate + configurable thresholds
description: Contract + threshold-consistency rules for the Insights Watch List (GET /api/insights/watchlist)
---

# Watch List "needs attention" gate + school thresholds

The Insights Watch List (`GET /api/insights/watchlist`) defaults to a
`scope=attention` gate (only students tripping ≥1 risk trigger) with a
`scope=all` "full roster" escape hatch. Count-based triggers (absence, behavior,
tardy, ISS) are school-configurable via `school_settings`
(`watchlist*Threshold` cols), edited on the "Watch List Thresholds" settings
tile. Tier≥2 and FAST bottom-quartile are always-on boolean triggers (no knob).

**Rule: the watchlist endpoint has MULTIPLE early-return branches** (visibility
short-circuit for a teacher with no roster; `students.length === 0`) in addition
to the main path. Any field added to the response contract (`scope`,
`thresholds`, `totalInScope`, `attentionCount`, …) MUST be added to every
early-return branch too, with sensible empty values.
**Why:** the architect review caught two branches still emitting the old shape,
which breaks the client for empty cohorts.
**How to apply:** grep the handler for every `res.json(` before shipping a
response-shape change.

**Rule: client chip/pillar severity must honor the server-provided
`thresholds`, not hardcoded constants.**
**Why:** the card severity chips (`rowSignals`) and 4-cell pillar grid
(`computePillars`) originally hardcoded behavior≥3 / tardy≥5 / iss>0; after an
admin retunes the thresholds those colors would diverge from the actual gate.
**How to apply:** the endpoint returns `thresholds`; store it in state and pass
it into `computePillars` / read it in `rowSignals`. Absences are `null` when the
school has no Eligibility Hub upload — never fabricate 0, and gate the chip on
`absences != null`.
