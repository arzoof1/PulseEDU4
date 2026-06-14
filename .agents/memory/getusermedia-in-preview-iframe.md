---
name: getUserMedia in Replit preview iframe
description: Whether camera/mic (getUserMedia) and Web Speech work inside the embedded Replit preview iframe vs needing an own-tab pop-out.
---

The Replit preview iframe **does** grant `getUserMedia` (microphone AND camera)
and the Web Speech API — confirmed live: voice dictation worked embedded, and the
video Recording Studio runs as an in-app full-screen overlay (same tab), not a
pop-out.

**Why:** An earlier assumption was that the iframe blocks camera/mic so media
features had to `window.open` a standalone tab. That cost a cross-tab handoff
problem (recorded blob stranded in the other tab). Reality: the preview iframe
allows it, so media capture should run in-app and keep its data in app memory.

**How to apply:** Default any camera/mic/recording feature to run IN-APP. Keep an
own-tab fallback only as an escape hatch shown when `getUserMedia` actually
rejects with `NotAllowedError`/`SecurityError` for a specific browser. For
recorders, the kept blob stays in app state so the next step (upload/attach) needs
no tab handoff.
