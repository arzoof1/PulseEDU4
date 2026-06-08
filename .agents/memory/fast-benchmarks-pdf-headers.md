---
name: FAST Benchmarks PDF diagonal headers
description: How to correctly place (and verify) the rotated benchmark column headers in the FAST Benchmarks heatmap PDF.
---

# FAST Benchmarks PDF — diagonal column headers

The rotated benchmark-code headers in the FAST Benchmarks heatmap PDF
(`GET /api/teacher-roster/benchmarks/pdf`, in `routes/fastBenchmarks.ts`) have
been misaligned and re-fixed multiple times. The reliable approach:

**Anchor each code at its column's LEFT edge on the grid rule, then
`translate()` + `rotate(-45)` and draw left-aligned text (`lineBreak:false`) so
it rises up-and-to-the-right.**

**Why:** the recurring broken version anchored the text's RIGHT edge at the
column CENTER (`doc.rotate(-45, {origin:[colCenter, …]})` with a right-aligned
80pt box). After the rotation the diagonal body sags up-LEFT, so the first
column's label bleeds back over the "Student" name column and every code sits
left of its data cells. Anchoring at the left edge and rising right keeps each
label over its own column and clear of the Student column.

**Right-margin safety:** rising up-right adds only ~30pt horizontal extent; a
full page caps at ~21 columns (`maxCellsPerPage = floor(avail/28)`), so even the
narrowest math layout's rightmost code stays inside the right margin. Verified.

**Long MATH codes — the killer case.** ELA `benchmark_code` is ≤11 chars, but
MATH codes are `STRAND|BENCHMARK` composites (e.g. `MA.7.NSO.1|MA.7.NSO.1.1`,
23 chars) and up to **49 chars** for multi-standard items
(`MA.8.DP.2|MA.8.DP.2.3 and MA.8.DP.2.2|MA.8.DP.2.3`). Raw, these overflow the
header band upward into the Bottom-3 tile AND clip the right margin. Fix:
- **Display the BENCHMARK portion only** (the part after the last `|`), deduped
  across ` and ` composites and joined with ` / `. This keeps full standard
  identity (`MA.7.NSO.1.1`) at ELA length. ELA codes have no `|` so pass through.
  (Mirrors what the on-screen heatmap already does with `split(".").slice(-2)`.)
- **Size `headerHeight` dynamically** from the longest short label
  (`ceil(maxLabelW * sin45) + pad`, clamp ~[46,130]) so nothing bleeds into the
  tile above.
- **Per-label font auto-shrink** (7pt → min 5pt) when a label's diagonal reach
  (`colLeft + widthOfString*cos45`) would cross the right margin.
Caveat: distinct composites can collapse to the same visible short label (rare);
columns stay internally distinct.

**Verification loop (use this instead of eyeballing — that's why it kept
regressing):**
1. `POST /api/auth/login` → grab `authToken` from the JSON.
2. `curl` the PDF endpoint with `Authorization: Bearer <token>` and
   `?teacherId=&subject=&window=&schoolYear=` (subject is lowercase `ela`/`math`).
3. `pdftoppm -png -r 150 first.pdf out` then crop the header band with
   `magick … -crop` and actually look at it. Re-render after every tweak.

Known unrelated limitation (pre-existing, not this fix): row-overflow
continuation pages inside a benchmark chunk do not redraw the headers.
