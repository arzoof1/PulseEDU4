---
name: Enterprise plan feature drift
description: Why the enterprise plan must derive features from FEATURE_KEYS, and the drizzle ANY() array pitfall hit while fixing it.
---

# Enterprise plan feature drift

The enterprise plan's `features` JSONB must enable EVERY key in `FEATURE_KEYS`.
Derive it (`Object.fromEntries(FEATURE_KEYS.map(f => [f.key, true]))`) in
`ensureFeaturePlansSchema` — never a hand-maintained literal.

**Why:** the old hardcoded literal silently lagged behind `FEATURE_KEYS`
(missing `compTime`/`eligibility`/`schoolStoreNotify`), so schools that wanted
those features had to turn them on via per-school **overrides**. Those overrides
then counted as "deviations" in the admin UI even though they were really just
filling a gap in the plan.

**How to apply:**
- Seed `INSERT ... ON CONFLICT (key) DO NOTHING` can't fix an EXISTING plan row —
  add an idempotent `UPDATE plans SET features=<all-on> WHERE key='enterprise'
  AND features <> <all-on>` right after it.
- To fold redundant force-ON overrides back into the plan, gate with a one-shot
  marker (`app_one_shot_markers`) so you don't fight an admin who later re-adds a
  redundant override on purpose. Only delete overrides that are
  `enabled=TRUE AND show_upsell=FALSE AND expires_at IS NULL` AND the plan
  already enables the feature; then `reapplyLicensingToSchool(sid)` per affected
  school so `super_feature_*` booleans come from the plan. Leave force-OFF and
  expiring/trial overrides untouched — they are genuine deviations.

## Drizzle `= ANY(array)` pitfall

Passing a JS array into a drizzle `sql` template (e.g.
``sql`feature_key = ANY(${jsArr}::text[])` ``) expands to a row tuple
`($1,$2,...)` and Postgres throws **"cannot cast type record to text[]"**.
Don't pass JS arrays that way. Either match against an existing column/JSONB
(here: `COALESCE((p.features ->> sfo.feature_key)::boolean, FALSE) = TRUE`) or
use drizzle's `inArray()` helper.
