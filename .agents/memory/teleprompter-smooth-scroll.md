---
name: Teleprompter smooth scroll
description: Why the recording-studio teleprompter scroll must be compositor-driven, not main-thread rAF.
---

# Teleprompter / auto-scroll over a busy app

**Rule:** An auto-scroll that must stay perfectly smooth (e.g. the recording-studio
teleprompter) should be driven by a compositor-thread transform animation
(Web Animations API animating `translateY`), NOT by setting `scrollTop` (or
`transform`) every `requestAnimationFrame` tick on the main thread.

**Why:** The studio renders as a full-screen overlay while the giant `App.tsx`
root stays mounted underneath. `App.tsx` runs a **1-second `setNow` clock tick**
(plus 15s data polls) that re-renders the entire (very large) App tree every
second. Each re-render is tens-to-hundreds of ms of main-thread work, which
stalls the scroll once per second → the "pause then jump" symptom.

**Compositing did NOT save it.** Switching to WAAPI + `translate3d` +
`will-change`/`translateZ(0)` layer promotion was tried and STILL janked — in
the Replit preview iframe the transform animation was not reliably handed to the
compositor thread, so it kept ticking on the (busy) main thread. A time-based
animation on a stalled main thread is exactly what produces pause→jump (it
advances by wall-clock but only paints when the thread frees up).

**The fix that worked: free the main thread.** Pause the background re-renders
while the overlay is open. A module signal (`studio/recordingActivity.ts`,
ref-counted) is raised by `RecordingStudio` on mount; the `App.tsx` interval
callbacks early-return `if (isStudioSessionActive())` so the per-second tick and
polls do nothing while the studio is up. Proof the diagnosis was right: the
standalone `/studio` page (no `App.tsx` underneath) was always smooth with the
same animation code.

**How to apply:**
- Build one `element.animate([{transform:'translateY(0)'},{transform:`translateY(${-distance}px)`}], {duration, easing:'linear', fill:'both'})` where `distance = container.scrollHeight - container.clientHeight`.
- Drive **speed** via `anim.playbackRate` (a multiple of a fixed reference px/sec) so changing speed never resets position.
- Play/pause with `anim.play()/pause()` in a separate effect (don't rebuild on toggle).
- Rebuild only when content geometry changes (script text, font, width, visible-lines), preserving progress as `currentTime/duration` fraction so a mid-read resize doesn't snap back.
- Reset-to-top = `anim.currentTime = 0`. `anim.onfinish` ends the scroll.
- Set `willChange: transform` on the animated element to keep it layerized.
