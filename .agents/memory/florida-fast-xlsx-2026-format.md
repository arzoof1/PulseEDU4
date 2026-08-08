---
name: Florida FAST xlsx 2026 format
description: State portal now ships minimal namespaced xlsx that exceljs can't open; use lib/xlsxGrid fallback + numbered quad headers
---
In Aug 2026 the Florida FAST portal changed its per-student xlsx export:
- Files are minimal OOXML (namespace-prefixed `<x:workbook>`, non-standard rel ids, no styles/sharedStrings, cells without r="A1" refs). **exceljs 4.x fails to open them** with "Cannot read properties of undefined (reading 'sheets')" — on every host, so "works in dev, fails in prod" reports about FAST uploads usually mean old-format file vs new-format file, not an environment difference.
- Benchmark quad headers are now numbered: "1. Category", "1. Benchmark", "1. Points Earned", "1. Points Possible" (older files: bare "Category"...). Quad detection must accept the optional `\d+\.\s*` prefix.

**How to apply:** read any inbound xlsx through `lib/xlsxGrid.ts` `xlsxToGrid(buffer)` — tries exceljs first, then a dependency-free fallback (node:zlib zip reader + namespace-agnostic XML scan, sharedStrings/inlineStr/r-ref aware). Don't add jszip/SheetJS deps for this. The gradebook xlsx parser still uses raw exceljs; if school gradebook exports ever hit the same failure, switch it to xlsxToGrid too.
