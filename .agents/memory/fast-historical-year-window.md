---
name: FAST historical year window + PM3 growth series
description: Domain constraints for FL FAST historical imports and multi-year PM3 growth on the roster.
---

# FAST historical school-year window

Any feature that offers or accepts a **FAST school-year range** (historical
importer dropdown/validator, multi-year history readers) must clamp the oldest
year to **22-23**.

**Why:** FL FAST launched in the 22-23 school year. Older years are FSA on a
non-comparable scale, so surfacing them is meaningless and misleading.
**How to apply:** clamp on BOTH the server validator and the client dropdown
(they must agree — server re-validates). Constant is the 2-digit start `22`
(server) / full year `2022` (client). Max depth is 5 preceding years to match
`school_settings.fast_history_years_visible` (cap 5).

# Multi-year PM3 growth series (roster chip)

Prior-year growth on the Teacher Roster is **PM3-only** (no prior-year PM1/PM2 —
the historical importer only stores PM3). The series is built from the same
`loadFastHistory` array that feeds `priorPm3` + the learning-gain green-check —
do NOT disturb those; add the series alongside.

**Never sum PM3 deltas into a total.** FAST scale scores are re-referenced per
grade year to year, so a running total is invalid. Year-over-year deltas are
directional signal only. The growth chip shows per-year "+pts" and intentionally
omits any summed total.
