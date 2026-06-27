---
name: Parent-authed object/image proxy
description: How parent-facing surfaces serve school-scoped object-storage images (thumbnails) that staff-only object routes can't deliver.
---

Staff read object storage via a staff-auth + ACL-gated route; parents are NOT
staff, and inside the Replit preview iframe a plain `<img src>` carries no
cookie/Bearer, so it 401s. To show a school-store thumbnail (or any
school-scoped uploaded image) to a parent:

1. Add a parent-authed proxy route that re-authorizes by (a) resolving the
   parent -> owned student, then (b) loading the row that holds the
   `/objects/...` path **school-scoped to that student's school**, then streams
   the bytes server-side (reuse the storage `streamObjectToResponse` helper).
   The item row being school-scoped IS the authorization — no separate ACL
   re-check needed.
2. Expose only a boolean `hasImage` on the catalog view, never the raw
   `/objects/<id>` path — the client hits the proxy by item id, the path stays
   server-side.
3. On the client, load the image via the authed fetch (Bearer) -> blob ->
   `URL.createObjectURL`, revoke on unmount. A plain `<img src=proxyUrl>` will
   NOT work in the preview iframe (no Bearer). Mirror the staff `StudentPhoto`
   pattern.

**Why:** the existing `/api/storage/objects/*` route is `requireStaff` + ACL,
so it is unreachable for a parent session; and even an authed URL can't be put
in an `<img>` inside the iframe.

**Related licensing gotcha:** a license-gated tab persisted in sessionStorage
(e.g. parent "rewards" tab) can outlive the license or follow a sibling switch
into a school where the feature is off. Gate BOTH ends: the tab-bar hides the
tab AND an effect flips `activeTab` back to a safe default once the payload
reports `enabled:false`, and the tab body early-returns on `!enabled` so it
can never paint a zeroed surface.
