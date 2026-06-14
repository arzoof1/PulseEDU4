---
name: Teleprompter smooth scroll
description: Why the recording-studio teleprompter scroll must be compositor-driven, not main-thread rAF.
---

# Teleprompter / auto-scroll over a busy app

**Rule:** An auto-scroll that must stay perfectly smooth (e.g. the recording-studio
teleprompter) should be driven by a compositor-thread transform animation
(Web Animations API animating `translateY`), NOT by setting `scrollTop` (or
`transform`) every `requestAnimationFrame` tick on the main thread.

**Why:** The studio renders as a full-screen overlay while the rest of the staff
app stays mounted underneath and keeps polling (`/api/hall-pass-queue`,
`/api/pullouts`, `/api/hall-passes`, attendance, counts) every few seconds.
Each poll response re-renders the background tree on the main thread; combined
with MediaRecorder camera encoding, that periodically starves rAF, so a
`scrollTop`-per-frame scroller visibly PAUSES, then (without a fix) JUMPS to
catch up. Clamping the per-frame `dt` removes the jump but the pause remains —
the only real fix is to move the motion off the main thread.

**How to apply:**
- Build one `element.animate([{transform:'translateY(0)'},{transform:`translateY(${-distance}px)`}], {duration, easing:'linear', fill:'both'})` where `distance = container.scrollHeight - container.clientHeight`.
- Drive **speed** via `anim.playbackRate` (a multiple of a fixed reference px/sec) so changing speed never resets position.
- Play/pause with `anim.play()/pause()` in a separate effect (don't rebuild on toggle).
- Rebuild only when content geometry changes (script text, font, width, visible-lines), preserving progress as `currentTime/duration` fraction so a mid-read resize doesn't snap back.
- Reset-to-top = `anim.currentTime = 0`. `anim.onfinish` ends the scroll.
- Set `willChange: transform` on the animated element to keep it layerized.
