---
name: pdfkit absolute-positioned text pagination
description: Why bottom-edge .text() calls in the badge PDFs silently add a blank page, and how to keep them on one line.
---

In `studentIdBadgesPdf.ts` every element is positioned absolutely and the page
bottom margin is tiny (2pt) so the crisis hotline strip can sit at the page
edge. A `.text()` call near that edge will auto-paginate (add a blank page) if
its content wraps to a second line.

**Why:** pdfkit's `align: "center"` (and `justify`) engages the LineWrapper
*even with `lineBreak: false`* — it must measure the line to center it. If the
string's measured width exceeds the given `width`, the wrapper breaks it onto a
2nd line, and that 2nd line crosses `pageHeight - bottomMargin` → new page. The
narrow PORTRAIT badge (153pt wide) is where this bit: the fixed crisis hotline
text overflowed the bar at its nominal font size.

**How to apply:** for any centered, bottom-edge, must-not-truncate text on these
badges, auto-fit the font so `doc.widthOfString(text) <= availWidth` on ONE line
before drawing (loop down from the nominal size, floor ~4pt). Do NOT rely on
`lineBreak: false` alone, and do NOT truncate the crisis text (it's legally
required by FL HB 383). Verify by rendering the real PDF and checking
`pdfinfo … | grep Pages` is 1 — don't eyeball.
