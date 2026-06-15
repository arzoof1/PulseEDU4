---
name: Standards Book in-app reference
description: How the in-app FLDOE B.E.S.T. standards book reference is built/served, and how to add Math next.
---

# Standards Book reference (ELA shipped; Math is the same pipeline)

The "ELA BEST Standards" reference (opened from the Teacher Instruction Log
toolbar) is a searchable/browsable copy of the full FLDOE standards PDF.

## Why it's a GLOBAL (non-school-scoped) route
The standards text + codes are statewide-identical published reference data —
no tenant or student data. So the route serves ONE committed dataset for every
school, unlike almost every other route. This is an intentional exception to the
`school_id`-on-every-read rule; do not "fix" it by school-scoping it.

## Pipeline (committed dataset, not DB)
- Source PDF → `pdftotext` → text file with one form-feed (`\f`) per page.
  Split on `\f` to get the page array (ELA = exactly 220 pages).
- Benchmark index (code/grade/strand/statement) comes from the existing
  committed `benchmarkDescriptions.json`, filtered by subject.
- Each benchmark's page is resolved by scanning pages for the detail-format
  line `^\s*CODE:` (leading-space + code + colon).
- Output committed JSON shape: `{ subject, title, fileName, pageCount, pages:[{page,text}], benchmarks:[{code,grade,strand,statement,page}] }`.

## To add Math
Run the same pipeline on the Math PDF, write a second committed JSON, register
it in the `BOOKS` map in the standards-book route, and gate a "Math BEST
Standards" button on `subject === "math"` in the Instruction Log toolbar. The
client modal is subject-agnostic — it just fetches `?subject=<subject>`.

**Why the button is subject-gated:** the Instruction Log has a subject selector;
an ELA-only reference shown while subject=math is a UX mismatch (caught in review).
