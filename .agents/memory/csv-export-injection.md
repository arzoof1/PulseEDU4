---
name: CSV export formula injection
description: Client/server CSV exports must neutralize spreadsheet formula injection, not just quote delimiters.
---

# CSV export formula injection

Any CSV export that includes user-entered text (notes, behavior/intervention
names, reasons, etc.) must neutralize CSV/Excel formula injection: a cell
whose first char is `=`, `+`, `-`, `@`, tab, or CR can execute as a formula
when opened in Excel/Sheets.

**Rule:** before delimiter-quoting, if the cell starts with a risky char,
prefix a single apostrophe (`'`). Quoting commas/quotes/newlines alone is NOT
enough — the architect flags this as a security finding.

**Why:** the first CSV export shipped (Classroom Intervention Report) only
quoted delimiters; review caught the injection gap.

**How to apply:** see `toCsvCell()` in `artifacts/client/src/App.tsx`. Reuse
that pattern for any new CSV export.
