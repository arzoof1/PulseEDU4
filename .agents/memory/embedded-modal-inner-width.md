---
name: Embedded modal inner width overflow
description: Reusing a fullscreen-modal component in an in-flow/embedded column — hardcoded inner widths overflow the narrower parent and overlap neighbors.
---

# Embedded modal inner width overflow

When a component built as a fullscreen fixed modal gains an `embedded`
(in-flow) mode, audit every HARDCODED inner dimension, not just the outer
wrapper. The outer wrapper switching to `width: 100%` is not enough if an
inner element keeps a fixed width like `min(560px, 92vw)`.

**Why:** CameraScanner's outer container honored `embedded` (no
fixed/zIndex), but its inner video box stayed `min(560px, 92vw)`. Placed in a
two-column attendance kiosk layout whose LEFT column was `min(480px, 94vw)`,
the 560px video overflowed ~80px into the RIGHT name list — looked like the
camera was sitting "on top of the cards." Fix: make the inner width
`embedded ? "100%" : "min(560px, 92vw)"` so it fills its column.

**How to apply:** Any time you add an `embedded`/inline variant to a
modal/overlay component, grep its JSX for fixed `width`/`min()`/`maxWidth`
on inner nodes and make them column-relative (`100%`) in embedded mode.
Verify against the actual narrower parent column, not in isolation.
