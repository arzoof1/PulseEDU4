# PulseEDU Developer Migration Report

## Florida FAST Excel Import — August 2026 State Format Change

**Priority:** Critical — production FAST uploads fail until this is deployed
**Status:** Complete in development; verified against a real state export; awaiting production publish
**Date:** August 8, 2026

---

## 1. Problem

In August 2026 the Florida FAST portal changed the generator behind its per-student Excel ("StudentData") exports. The new files are valid OOXML but are produced in a stripped-down form:

- Namespace-prefixed workbook XML (`<x:workbook>`, `<x:row>`, `<x:c>`) instead of the default namespace
- Non-standard relationship IDs (e.g. `R8e74d2e35b4d4d73`)
- No `xl/styles.xml` or `xl/sharedStrings.xml` parts (strings are inline, `t="str"`)
- Cells without `r="A1"` position references (sequential placement)
- Only 5 zip members total

**Impact:** `exceljs` 4.4.0 — the library used by the FAST importer — cannot open these files at all. It throws `Cannot read properties of undefined (reading 'sheets')`, surfaced to the user as "Could not read xlsx". This affects **every environment equally**; reports of "works in dev, fails in prod" traced to old-format files having been tested in dev, not to an environment difference.

Additionally, the new format renames the repeating per-question header quadruplets:

| Old format | New (Aug 2026) format |
|---|---|
| `Category` | `1. Category` |
| `Benchmark` | `1. Benchmark` |
| `Points Earned` | `1. Points Earned` |
| `Points Possible` | `1. Points Possible` |

The old quad detector (exact match on `Category`/`Benchmark`/…) would find zero quadruplets and reject the file even if it could be opened.

---

## 2. Changes

### 2.1 New file: `artifacts/api-server/src/lib/xlsxGrid.ts`

Exports `xlsxToGrid(buffer): Promise<{ ok: true; grid: unknown[][] } | { ok: false; error }>`.

Strategy:
1. **Primary path:** exceljs (unchanged behavior for old-format files).
2. **Fallback path (new):** a dependency-free minimal XLSX reader used when exceljs fails:
   - Zip reading via a hand-rolled central-directory parser + `node:zlib inflateRawSync` (no new npm dependencies — jszip/SheetJS deliberately avoided)
   - Namespace-agnostic XML scanning of the first worksheet (matches `<row>` and `<x:row>` alike)
   - Supports sharedStrings, inline strings, `t="s"/"str"/"b"/"e"`, optional `r="A1"` refs (sparse rows), and XML entity decoding

### 2.2 Decompression safety limits (hardening, added after security review)

The fallback zip reader enforces strict budgets so a malicious "zip bomb" upload fails cleanly instead of exhausting server memory:

| Limit | Value | Real-file headroom |
|---|---|---|
| Max zip entries | 200 | Real FAST files have 5 |
| Max uncompressed size per entry | 100 MB | 220-student file ≈ 1.7 MB; ~9 MB for a 1,100-student school |
| Max aggregate uncompressed size | 300 MB | — |
| `inflateRawSync` `maxOutputLength` | capped at declared size | lying headers throw instead of allocating |
| Rejected explicitly | ZIP64, encrypted entries, out-of-range offsets, corrupt headers | clean 4xx parse error, no crash |

**Sizing note for large schools:** limits are ~12,000+ students of headroom; no legitimate district file approaches them. (The pre-existing 12 MB upload cap on the route is unchanged and equally non-binding — a 5,000-student export is ≈1 MB.)

### 2.3 Modified: `artifacts/api-server/src/routes/dataImports.ts`

- `parseFloridaXlsx()` refactored to consume the plain grid from `xlsxToGrid` instead of the ExcelJS worksheet API (1-based `getCell` accesses converted to 0-based grid indexing — verified consistent, including the quad `base + 1/+2/+3` offsets).
- Quad header detection now accepts an optional numeric prefix: `/^(?:\d+\.\s*)?category$/i` etc. — both old and new formats import.
- No changes to storage model, idempotency behavior, endpoints, auth, or the preview/commit flow. The gradebook xlsx parser is untouched (still raw exceljs; switch it to `xlsxToGrid` if school gradebook exports ever hit the same failure).

---

## 3. Verification

- Real new-format file (D.S. Parrott Grade 7 FAST ELA Reading, Aug 8 2026 download) parsed end-to-end: **220 students, subject ELA, grade 7, PM3 window, 8,800 benchmark item responses, 0 warnings**.
- Full api-server test suite: **43/43 passing**; `tsc -b` clean.
- Independent architect review completed; its one severe finding (unbounded decompression / zip-bomb DoS on the upload route) was fixed via the limits in §2.2 and re-verified.

---

## 4. Deployment

- **No schema changes. No new dependencies. No config changes.**
- Deploy = publish the current api-server code. The fix is entirely server-side; no client changes.
- Until published, production will continue to reject all new-format FAST files with "Could not read xlsx".

## 5. Invariants going forward

1. Read any inbound xlsx through `xlsxToGrid` rather than raw exceljs — the state may keep shipping minimal OOXML.
2. Keep quad detection tolerant of both bare and numbered header styles.
3. Never lift the decompression budgets without revisiting the zip-bomb analysis; they are sized with >50× headroom over the largest realistic district file.
