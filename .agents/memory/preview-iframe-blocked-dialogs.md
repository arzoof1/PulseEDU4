---
name: Preview iframe blocks window.prompt/confirm/alert
description: Why staff-app actions using browser dialogs silently no-op inside the Replit preview, and what to use instead.
---

The Replit preview iframe is sandboxed without `allow-modals`, so
`window.prompt()`, `window.confirm()`, and `window.alert()` are silently
suppressed. `prompt()` returns `null` and `confirm()` returns `false` with no
dialog shown — so any handler gated on their return value just bails out and
the user sees "nothing happens" (no network request ever fires).

**Why:** symptom was a Rename action that did nothing and produced zero PATCH
requests server-side; the click reached the handler but `window.prompt`
returned null. Same applies to delete confirmations via `window.confirm`.

**How to apply:** never use `window.prompt/confirm/alert` for any user-facing
flow in the staff app or parent portal. Use in-document UI instead — an inline
text input (Enter to save / Escape to cancel) for prompts, and a two-step
inline Confirm/Cancel for destructive confirms. This is distinct from
getUserMedia/Web Speech, which DO work in the iframe (see
getusermedia-in-preview-iframe.md).
