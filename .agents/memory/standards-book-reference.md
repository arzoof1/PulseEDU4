---
name: Standards Book in-app reference
description: How the in-app FLDOE B.E.S.T. standards book reference (ELA + Math) is built/served.
---

# Standards Book reference (ELA + Math both shipped)

The "ELA BEST Standards" and "FAST BIG M GUIDE" references (opened from the
Teacher Instruction Log toolbar, gated on the subject selector) are
searchable/browsable copies of the full FLDOE standards PDFs.

## Why it's a GLOBAL (non-school-scoped) route
The standards text + codes are statewide-identical published reference data —
no tenant or student data. So the route serves ONE committed dataset for every
school, unlike almost every other route. This is an intentional exception to the
`school_id`-on-every-read rule; do not "fix" it by school-scoping it.

## Pipeline (committed dataset, not DB)
- Source PDF → `pdftotext` → text file with one form-feed (`\f`) per page.
  Split on `\f` to get the page array (ELA = 220 pages, Math = 234).
- Output committed JSON shape: `{ subject, title, fileName, pageCount, pages:[{page,text}], benchmarks:[{code,grade,strand,statement,page}] }`.
- Per subject the parser differs because the PDFs are laid out differently:
  - **ELA**: detail pages have a `^\s*CODE:` line; statements come from the
    committed `benchmarkDescriptions.json` and each page is resolved by scanning
    for that line.
  - **Math**: NO `CODE:` detail line. Parse `pdftotext -layout` (column
    geometry): statement = UP-walk for text above the code line + inline tail +
    DOWN-walk, bounded by blank lines (blank line is the benchmark boundary —
    trust it; multi-sentence benchmarks like MA.2.NSO.2.3 are real). Page =
    canonical occurrence (prefer the one near "Benchmark Clarification/Example",
    not the intro/table-of-contents hit). 642 leaf benchmarks, strands
    NSO/FR/AR/M/GR/DP/F/C/T/LT/FL/MTR, grades K,1-8,912,K12.
  - The 642 math statements are also appended to `benchmarkDescriptions.json`
    (subject:"math") so the 3 hover surfaces (already subject-aware) light up
    after a re-seed (idempotent upsert on `(subject,code)`).

## Hybrid "View original page" (math only)
Math statements with equations/notation lose meaning in plain text, so the
modal has a per-page toggle that renders the EXACT PDF page client-side via
`pdfjs-dist` (v4 — do NOT bump to v5, it throws in browsers). The PDF is a
client asset imported `?url`; book page numbers are 1-based and align with
`getPage(n)`. Gated by `SUBJECT_PDF_URL[subject]` (only math). Render only after
the canvas mounts, cancel the render task on cleanup, never swallow errors.

**Why the button is subject-gated:** the Instruction Log has a subject selector;
showing the wrong subject's reference is a UX mismatch (caught in review). Modal
takes a `subject` prop and keeps per-subject `bookCache` + `pdfDocCache`.
