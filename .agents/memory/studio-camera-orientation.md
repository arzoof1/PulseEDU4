---
name: Studio camera capture orientation
description: Why the PulseDNA RecordingStudio camera must swap getUserMedia edges + re-acquire on rotation, not fix orientation with CSS.
---

# Studio camera capture orientation

The recorded video's orientation is determined by the **getUserMedia
width/height constraints**, not by CSS on the `<video>` element. A hard-coded
landscape constraint (e.g. `width 1280 / height 720`) makes every device —
including a phone/iPad held vertically — capture a landscape frame; `objectFit:
cover` only crops the preview, it does NOT make the recording portrait.

**Rule:** request a portrait frame (swap to `width 720 / height 1280`) when the
viewport is portrait (`matchMedia("(orientation: portrait)")`, fall back to
`innerHeight > innerWidth`). To follow the device live, listen for
`orientationchange` + the `(orientation: portrait)` media-query `change` and
**re-acquire the stream** (stop old tracks + meter, getUserMedia again, swap in).

**Never re-acquire while `recordingRef.current` is true (it breaks the live
MediaRecorder) or while a finished take is being reviewed (`recordedUrlRef`).**
Guard overlapping rotations with an `acquiringRef` boolean and track the current
capture orientation in a ref so no-op rotations are skipped.

**Why:** orientation is a stream property, so the only fix is at acquisition
time; mid-recording swaps would corrupt/abort the take.
