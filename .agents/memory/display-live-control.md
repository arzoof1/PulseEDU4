---
name: Display live remote control
description: Invariants for the signage live-control feature (revision-gated polling, unauthenticated public-by-id endpoints).
---

# Display live remote control

## Revision is the sole change detector — bump it atomically
TVs poll `GET /displays/public/live/:id` (~2s) and only adopt new state when
`revision` increases. Therefore any write to `display_live_control` MUST bump
`revision` atomically in SQL (`revision = display_live_control.revision + 1` in
the `onConflictDoUpdate` set, with `.returning()` to echo the true value).

**Why:** A read-then-write (`nextRevision = existing.revision + 1` computed in
app code) lets two concurrent PUTs write the same revision with different
state — one update becomes permanently invisible to the TVs until a later
write. Found in code review of the live-control build.
**How to apply:** Never compute the next revision in JS. Same rule applies to
any future per-playlist live-state writers.

## Public signage endpoints are unauthenticated-by-numeric-id BY DESIGN
`/displays/public/live/:id`, `/displays/public/playlists/:id`, `.../media/...`
all take a raw numeric playlist/item id with no auth and are enumerable.
**Why:** TVs run on a fixed `/display/:id` URL with no login, and the product
hard-requires "TVs never re-enter a URL / no token." A presentation URL shown
on a hallway TV is content meant to be public anyway. So exposing live-control
state by id is consistent with the established model, not a new leak — do NOT
"fix" it by adding a token (that would break the core requirement).
**How to apply:** Keep genuinely sensitive data off these payloads; school
scoping is enforced on the staff WRITE path (`canManageDisplays` +
`loadPlaylistForEdit`, deck same-school check), not on the public read.
