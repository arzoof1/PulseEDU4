---
name: FAST importer full-replace + historical fold-in
description: Invariants for the bq_l25 (Bottom-Quartile full-replace) importer and folding prior-year PM3 into the single Florida FAST uploader.
---

# BQ / L25 full-replace importer + Florida historical fold-in

Two FAST importers on `student_fast_scores`, both CURRENT-school-year + school scoped.

## bq_l25 (Bottom Quartile / Lower 25) — full replace
- Flips ONLY `prior_year_bq`; never PM1/PM2/PM3, never `prior_year_score`.
- Scope of a full replace = **the subjects present in the file** (not all subjects) for the current school year. Clear that scope first, then flag the listed true-set.
- Rollback ledger (`fast_bq_import_batches.prior_json = {schoolYear, prior: Record<subject, string[]>}`) must snapshot the PRE-clear BQ id-set **per subject**, so undo re-clears the exact same (school, snapshotYear, subjects) scope and re-flags the prior ids.
- **Why:** a full-replace that cleared *all* subjects, or a rollback that didn't record the exact prior set per subject, would silently drop BQ flags for subjects/students not in the upload.

## Florida "import as historical" fold-in
- When the single Florida FAST xlsx is imported as historical, it ALSO upserts `prior_year_score` onto the CURRENT-year row (create if missing).
- onConflict MUST preserve `prior_year_bq` and the existing `import_job_id` (only set `prior_year_score`), so the historical job never takes ownership of a pre-existing current-year row or clobbers its PM scores.
- **Why:** rolling back the historical job must not delete pre-existing current-year rows; ownership stays with whoever created the row.

## Client picker consolidation
- `fast_prior_year` was removed from the CLIENT picker ONLY. All server plumbing/config/routes/rollback/cap for `fast_prior_year` stays, and the `Kind` union still includes it — so every `Record<Kind,...>` (KIND_DEFS, KIND_ECHO_WORDS, SAMPLES) must keep BOTH `fast_prior_year` and `bq_l25` entries or TS exhaustiveness breaks.

## Accepted limitations
- bq_l25 rollback restores flags only; rows created solely to hold a BQ flag remain as empty current-year rows.
- Historical fold-in rollback leaves the scalar `prior_year_score` on rows that pre-existed the job.
- Learning-gain is unaffected either way (it reads `loadFastHistory`, not these scalars).
