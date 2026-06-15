---
name: Private storage assets in the preview iframe
description: Why CSS background-image / <img src> to /api/storage/objects/* renders blank in the Replit preview iframe, and the authFetch→blob fix.
---

Private object-storage assets (`/api/storage/objects/*`) are auth-gated
(require `req.staffId`/`req.schoolId` via session cookie OR Bearer token).
A CSS `background-image: url(...)` or `<img src>` pointing straight at that
URL **cannot send the Bearer token**, and the session cookie is blocked
inside the Replit preview iframe — so the request 401/404s and the element
renders transparent/blank (e.g. a white parent shows through).

**Why:** same root cause as the replit.md gotcha about blobs/PDFs in the
preview iframe — the iframe can't carry app auth on browser-initiated
sub-resource loads.

**How to apply:** to display a private storage asset in any preview/UI,
`authFetch` the resolved URL (attaches the Bearer token), `res.blob()`,
`URL.createObjectURL(blob)`, and paint that object URL. Revoke it on
dependency change/unmount; guard the async with a `cancelled` flag; clear
the URL on fetch failure for a deterministic fallback. A freshly-picked
local file already has a usable blob URL and needs no fetch — let it win.
Public assets (`/api/storage/public-objects/*`) are exempt — they load fine
as a normal URL.
