---
name: pdfkit WinAnsi glyph limit
description: Built-in pdfkit fonts can't render ★/✓ and other non-WinAnsi glyphs; draw them as vectors.
---

pdfkit's built-in fonts (Helvetica etc.) are WinAnsi (CP1252) encoded. Unicode
glyphs outside WinAnsi — ★ (U+2605), ✓ (U+2713), em-stars, most symbols/emoji —
will NOT render (they drop or box). No custom TTFs are registered for PDFs in
this repo, so every server PDF builder uses built-in Helvetica.

**Why:** the Family Note Catcher wanted ✓/★ per-stop tags; using the literal
glyphs in `doc.text` would have silently failed in print.

**How to apply:** when a PDF needs a star/check/symbol, draw it as a vector path
(`doc.moveTo/lineTo/...fill()` for a star; stroked polyline for a check), each
wrapped in `doc.save()`/`doc.restore()` so line-width/color don't leak into later
content. After drawing absolute-positioned vectors, manually advance `doc.y`
(pdfkit does not auto-advance for shape ops) before the next flowed text block.
WinAnsi-safe punctuation that DOES render: • (bullet), · (middot), – — (dashes).
See `drawStar`/`drawCheck` in `lib/tourNoteCatcherPdf.ts`.
