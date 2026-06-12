---
name: E-sign PDF render reliability
description: Why the in-house e-sign "Link not valid" bug was a client render failure, not a token bug, and the pdfjs-dist version constraint.
---

# E-sign signing page render reliability

The in-house e-sign signing page (`/sign/<token>`, `artifacts/client/src/sign/SignApp.tsx`)
rasterizes the PDF to a `<canvas>` with `pdfjs-dist`. Two separate, compounding
failures both surfaced to the user as the misleading **"Link not valid"** screen,
even though the token, server endpoints, and PDF file were all 200/valid (curl
passed every hop because curl never renders).

## Lesson 1 — canvas must be mounted before render; never let render errors masquerade as "invalid token"
The `<canvas>` only mounts when `phase === "ready"`. Calling the render routine
while still in `phase === "loading"` means `canvasRef.current` is null → throws →
a catch-all flipped phase to `"invalid"` ("Link not valid").
**Rule:** fetch metadata in one effect (set phase ready/signed), render in a
*separate* effect keyed on `[phase, meta]` so canvases exist first. Distinguish a
render failure (new `"render-error"` phase, honest copy) from an invalid token.
Do **not** swallow render errors silently — log them; the silent catch here cost
multiple debugging sessions because the real `TypeError` was invisible.

## Lesson 2 — pdfjs-dist v5.x is broken in browsers (pin to v4)
**Why:** `pdfjs-dist@5.x` calls `Map.prototype.getOrInsertComputed` inside
`page.render()` (via `getOptionalContentConfig`). That method is an unshipped
TC39 proposal — absent from every current browser — so `page.render()` throws
`TypeError: ...getOrInsertComputed is not a function` for EVERY document, in
every browser.
**How to apply:** keep `pdfjs-dist` pinned to the **4.x** line (was `4.10.38`)
until a v5 release stops requiring `getOrInsertComputed` (or the method ships in
browsers). v4 `RenderParameters` has no `canvas` field (v5-only) — render with
`{ canvasContext, viewport }` only. Both `pdf.worker.mjs` and
`pdf.worker.min.mjs` exist in v4. `DisplayShow.tsx` (signage PDF playback) also
depends on pdfjs and uses only v4-compatible APIs — re-check it on any bump.
