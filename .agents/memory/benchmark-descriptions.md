---
name: Benchmark descriptions reference table
description: Global (non-school-scoped) FLDOE benchmark code→full-text table; PDF extraction gotcha when loading it.
---

# benchmark_descriptions — global standards reference

`benchmark_descriptions` is deliberately **global / NOT school-scoped** (no
`school_id`). FLDOE B.E.S.T. standards are statewide and identical for every
tenant, so the table is a shared reference keyed by `unique (subject, code)`
with a `subject` index. This is the opposite of almost every other table in the
app — do not "fix" it by adding `school_id`.

**Why:** the text of `ELA.7.R.1.1` is the same for school 1 and school 103;
per-school copies would just be 103× duplication with drift risk.

**How to apply:** load/seed it once globally (idempotent chunked upsert in
seed.ts, runs first in runSeed); look it up by `code` (optionally `subject`),
never by tenant. Per-school customization (labels, which benchmarks are active)
already lives in the separate `school_benchmarks` table — keep that split.

## PDF extraction gotcha (rubric tables)

The source PDFs render some standards as multi-column **rubric tables** (the
oral-presentation `*.C.2.1` standards have a 4-level scoring rubric). Running
`pdftotext -layout` interleaves those columns into garbage like
"Student presents Student presents Present information orally...". Plain
`pdftotext` (reading-order, no `-layout`) emits the clean single benchmark
statement on one line — use it to recover the real text.

**How to apply when re-parsing any standards PDF:** after extraction, scan
descriptions for corruption signals before committing — repeated 4-word
n-grams, rubric words ("Student presents"), and stray table headers injected
mid-text ("Phonics and Word Analysis", "Fluency"). The n-gram check yields
false positives on legit a/b/c sub-skill lists, so eyeball each hit. Only the
rubric-table standards and a couple of header-injection rows were actually
corrupt; everything else from `-layout` was fine.
