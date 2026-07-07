---
name: L25 auto-baseline from prior PM3
description: How the start-of-year L25 (bottom-quartile) auto-designation is computed and why district uploads must be detected via the ledger, not import_job_id.
---

# L25 auto-baseline (start-of-year bottom-quartile from prior PM3)

`ensureL25BaselineFromPriorPm3()` in `seed.ts` (boot one-shot from `runSeed`, after
`seedHistoricalFastIfEmpty`) sets `student_fast_scores.prior_year_bq` for the lowest
25% per (current grade, subject) within each school, ranked by `prior_year_score`
(the prior-year PM3 anchor) via `ntile(4) ORDER BY prior_year_score ASC` group 1.
No new column; the roster BQ pill + Watch List already read `prior_year_bq`.

## Rule: a district L25 upload is detected ONLY via the ledger
**Why:** `import_job_id` on `student_fast_scores` is shared by EVERY FAST importer
(`fast_prior_year`, `fast_florida`, `bq_l25`), so a non-null `import_job_id` (or even
`import_job_id IS NOT NULL AND prior_year_bq`) does NOT mean "district L25 upload."
The only reliable signal is a live `fast_bq_import_batches` ledger row (one per
committed `bq_l25` job; `prior_json.prior` is keyed by subject = the file's scope; a
rollback DELETES the ledger row).
**How to apply:** the baseline EXCLUDES any subject present in a live ledger row for
the school+year (`subject NOT IN (SELECT jsonb_object_keys(prior_json->'prior') …)`)
and recomputes all other subjects. So district uploads always win; a rollback releases
the subject back to the auto baseline.

## Rule: never gate the baseline on "any prior_year_bq already TRUE"
**Why:** demo/seed data can flag ~25% BQ that is NOT the true bottom quartile, so a
"skip if any BQ exists" gate makes the baseline silently never run.
**How to apply:** clear stale flags on non-uploaded subjects, THEN set the true bottom
25%. Marker is `l25_baseline_v2_<schoolId>_<sy>` — bump the version suffix to force a
one-time recompute when the logic changes (old markers become dead rows).

## Notes
- No prior_year_score yet for a school → skip WITHOUT claiming the marker (retry next boot).
- `ntile` ties: students sharing the exact boundary score can land either side of the
  quartile cut, so a re-run of the same `ntile` may flag a slightly different tied
  student. Both are valid bottom-25% sets; verify via `max_flagged <= min_unflagged`
  per grade+subject, not by expecting a stable membership.
