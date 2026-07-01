---
name: Two data-export systems coexist
description: PulseEDU has two independent CSV/XLSX export features; do not merge or delete one for the other.
---

# Two export systems coexist (by design)

1. **Importer-mirror export** (pre-existing, committed): Settings → Data
   Management → `DataManagementHub` → default-export `DataExportPanel.tsx`,
   hits `/api/data-imports/export`. Mirrors the CSV importer's tables.
2. **Registry exporter** (newer): School Admin → Data Export →
   `DataExportRegistryPanel.tsx` (named export), hits `/api/exports/*`
   backed by `lib/exportRegistry.ts` (curated Dataset registry).

**Why:** they serve different mental models (round-trip importer data vs.
curated, permission-gated, audited cross-table extracts). They were built at
different times and intentionally left separate.

**How to apply:** when touching "data export", confirm WHICH system. New
exportable datasets = register one more `Dataset` in `exportRegistry.ts`
(routes + UI unchanged). Don't try to unify them.

**Registry guardrails (non-negotiable):** FLEID boundary (column whitelist
emits localSisId only, never student_id); `csvCell` formula-injection
neutralize on every cell; force `req.schoolId` on every query INCLUDING
joined tables (classSections/staff joins must carry schoolId, not just the
driving table); visibility via `getVisibleStudentIds`; per-dataset
`permission()` gate; audit row written BEFORE bytes on /download only (not
preview); authed blob download (not open-in-tab — preview iframe blocks cookie).
