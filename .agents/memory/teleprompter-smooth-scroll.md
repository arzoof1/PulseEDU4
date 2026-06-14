---
name: Teleprompter smooth scroll
description: Why the recording-studio teleprompter scroll must be compositor-driven, and why residual jank in the Replit preview is an environment artifact, not a code bug.
---

# Teleprompter / auto-scroll over a busy app

**Rule:** An auto-scroll that must stay perfectly smooth (e.g. the recording-studio
teleprompter) should be driven by a compositor-thread transform animation
(Web Animations API animating a `translate3d` transform), NOT by setting
`scrollTop` (or `transform`) every `requestAnimationFrame` tick on the main thread.

**Why:** The studio renders as a full-screen overlay while the giant `App.tsx`
root stays mounted underneath and keeps running background timers (a 1s clock
tick + 15s polls). A main-thread rAF scroll competes with that re-render work and
stalls once per second → the "pause then jump" symptom. A composited transform
animation advances on the compositor thread and ignores that main-thread churn.

**How to apply:**
- Build one `element.animate([{transform:'translate3d(0,0,0)'},{transform:`translate3d(0,${-distance}px,0)`}], {duration, easing:'linear', fill:'both'})` where `distance = container.scrollHeight - container.clientHeight`.
- Use `translate3d` (not `translateY`) + `willChange:'transform'` + `translateZ(0)`/`backfaceVisibility:'hidden'` on the animated element to force layer promotion.
- Drive **speed** via `anim.playbackRate` (a multiple of a fixed reference px/sec) so changing speed never resets position.
- Play/pause with `anim.play()/pause()` in a separate effect (don't rebuild on toggle).
- Rebuild only when content geometry changes (script text, font, width, visible-lines), preserving progress as `currentTime/duration` fraction so a mid-read resize doesn't snap back.
- Reset-to-top = `anim.currentTime = 0`. `anim.onfinish` ends the scroll.

**Residual jank in the Replit preview is ENVIRONMENTAL — do not chase it in code.**
The Canvas embeds the app iframe inside the Replit preview iframe (double-nested),
and inside that nest Chrome does not reliably hand the transform to the compositor,
so it can still jank. Safari composites WAAPI transforms even worse. User-confirmed:
in a real Chrome/Edge tab (or the standalone unauthed `/studio` route opened
directly) the scroll is perfectly smooth with the WAAPI code alone.

**What was tried and then REMOVED (don't reintroduce without a reproducible
in-tab regression):** a global ref-counted "studio session" flag that paused the
five `App.tsx` background polling intervals while the overlay was open, plus an
imperative DOM-write recording timer (refs writing `textContent`/color instead of
`setState`). These were main-thread micro-optimizations chasing the iframe-only
jank; they added a latent footgun (a leaked ref-count would silently stop the
whole app from polling) and bought nothing in a normal browser tab. Plain React
state for the timer is fine because the scroll runs on the compositor thread,
independent of per-second reconciliation.
