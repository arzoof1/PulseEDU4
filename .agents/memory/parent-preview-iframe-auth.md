---
name: Preview-as-parent must hand a Bearer token to the new tab
description: Why staff "Preview as parent" needs a token handoff, not just a session-cookie swap, inside the Replit preview iframe.
---

# Staff "Preview as parent" auth handoff

Staff "Preview as parent" opens the parent HeartBEAT in a NEW tab. Swapping the
server SESSION COOKIE to a parent session is NOT enough — the new tab lands on
the parent login gate.

**Why (two compounding facts):**
1. Inside the Replit preview iframe the session cookie is blocked, so both the
   staff app and the parent app authenticate off a Bearer token in
   `sessionStorage` (`pulseed.authToken` for staff, `pulseed.parentToken` for
   parent), NOT the cookie.
2. `sessionStorage` is per-tab. A tab opened via `window.open` has its own
   empty `sessionStorage`, so it cannot see the opener's token.

**How to apply:** the preview endpoint must MINT and return a parent Bearer
token (same `issueParentAuthToken` the parent login uses). The staff client
passes it to the new tab via the URL hash (`/parent#pt=<token>`) — query/cookie
won't cross the per-tab boundary cleanly. The parent app consumes the hash at
module load BEFORE its first `/parent-auth/me` check, stores it, and strips it
with `history.replaceState`. Fragment isn't sent to the server; immediate strip
limits history exposure. Endpoint stays admin/superuser-gated; preview parent is
a sentinel with NULL password. This same pattern applies to ANY staff→other-role
"open in new tab" impersonation in this app.
