---
name: Kiosk dark-modal label color bleed
description: Why text inside Kiosk dark Shell modals/forms can render invisible (dark-on-dark)
---

# Kiosk dark-modal label text goes invisible

The staff app is light-themed and `artifacts/client/src/index.css` has a
**global `label { color: var(--text) }`** rule (`--text` is dark).

The Kiosk (`artifacts/client/src/Kiosk.tsx`) renders inside a dark `Shell`
that sets `color:#fff` inline on its container. Plain `<div>` text (modal
titles/subtitles) inherits that white and is visible. But `<label>`
elements do **not** inherit it — the global `label{}` rule wins over the
ancestor's inherited color — so label text (and any `<span>` inheriting
from the label) renders **dark-on-dark and invisible**.

**Rule:** any `<label>` (or its child text) inside a Kiosk dark Shell
context must set an **explicit light `color` inline** (inline beats the
stylesheet rule). Don't rely on setting color on a parent/form — the
global `label{}` rule overrides inherited color specifically for labels.

**Why:** the Deactivate Kiosk modal shipped with `<Field>` labels and a
checkbox label that were completely invisible; only the centered `<div>`
header showed. The shared `Field` component is kiosk-only (always dark),
so giving its label span an explicit light color is safe and also fixes
the activation/sign-in screen.

**How to apply:** when adding any labeled form control to Kiosk.tsx (or
any dark Shell surface), set `color` directly on the `<label>`/`<span>`,
e.g. `rgba(255,255,255,0.85)`. Placeholders also help as a secondary cue.
