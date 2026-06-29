---
name: Recording Studio overlay z-index
description: Absolutely-positioned overlays inside the studio video container need explicit z-index or the teleprompter gradient hides them.
---

The RecordingStudio video container is `position: relative` and holds several
absolutely-positioned overlays as siblings (mic meter, teleprompter, script
editor, review). The teleprompter overlay is full-width, pinned to the top, with
a dark top-down gradient background and `pointerEvents: none`.

**Rule:** any overlay you add to that container that sits in the top region (e.g.
the mic level meter, top-right) must declare an explicit `zIndex` (the meter uses
`zIndex: 5`). Otherwise, because the teleprompter overlay is declared *later* in
the DOM, it paints on top and the dark gradient hides your overlay — it looks
like the feature "isn't there."

**Why:** painting order = DOM order when no z-index is set. The first symptom was
"I don't see any meter" even though the meter was rendering correctly; it was just
behind the teleprompter gradient.

**How to apply:** give new top-region studio overlays a positive z-index and a
sufficiently opaque background for contrast against the gradient.
