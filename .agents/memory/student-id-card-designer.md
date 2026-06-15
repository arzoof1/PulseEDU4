---
name: Student ID card designer — footer default
description: Why the printable ID card's house footer defaults ON, and the legacy-look preservation rule.
---

# Student ID card designer

The printable CR80 student ID is school-customizable: a top region (1-2
school colors OR an uploaded cover image, behind header + photo), auto/manual
contrast header text, and an OPTIONAL house footer band. QR + barcode + crisis
line are ALWAYS on clean white (scannability/legibility is non-negotiable).

## Rule: `cardShowHouse` defaults to TRUE (footer on)
**Why:** The *legacy* badge displayed the house prominently — a house-colored
top band with the house emblem + "{House} House" text. The redesign moved
house identity into the footer band. If the footer defaulted OFF for
unconfigured schools, the house NAME would vanish entirely (house would
survive only as the top background color) — a worse regression than keeping it.
Defaulting ON keeps house name visible (relocated to footer) AND the top still
falls back to house color, which is the most faithful preservation of the
legacy house-forward look.

**How to apply:** When evaluating "no visual regression for unconfigured
schools," the protected property is *house identity stays visible + top falls
back to house color*, NOT "footer is absent." A code-review that flags
footer-on-by-default as a regression has misread the legacy look. Don't flip
the default to false.

## Other invariants
- Unconfigured = empty `cardBgColors` + mode `colors` → top falls back to each
  student's house color (`LEGACY_DESIGN` baseline).
- PUT `/api/school-branding` is a whole-row upsert; the client card panel must
  GET the current row and overlay only the card fields before PUT, or it
  clobbers unrelated branding (gradient, buttons, logo).
- FLEID boundary holds: the sample badge uses a synthetic `localSisId`
  ("100200"); never render `studentId`.
