---
name: Kiosk destination precedence
description: How the Hall Pass kiosk resolves which destinations a student may pick, and the GET/POST parity invariant.
---

Kiosk hall-pass destination eligibility has THREE sources, resolved by strict
precedence (NOT a union):

1. Activating teacher's per-staff allowlist (`teacher_destination_allowlist`,
   keyed by `staff_name` = staff `display_name`) — **authoritative when
   non-empty**: show/allow ONLY its members; the room matrix is ignored.
2. Else the school-wide room-pair matrix (`location_allowed_destinations`) for
   the origin room.
3. Else (origin has no matrix rows at all) the show-all default: every
   `active && student_visible && is_destination && kind != classroom` location.

**Why not a union:** the room-pair matrix is auto-seeded to ~everything (e.g.
1160 pairs for one school), so a prior `matrix ∪ teacher-list` union made a
teacher's curated narrowing have zero effect — students saw every restroom
regardless. The original union existed so admins "saw something"; the cost was
that no teacher could ever restrict. Teacher list must win.

**Invariant — GET listing and POST pass-creation must stay in lockstep.**
- `GET /kiosk/destinations/:token` lists with the precedence above, then
  post-filters to `active && student_visible && is_destination`.
- `POST /kiosk` (create pass) must apply the SAME precedence AND the SAME final
  eligibility predicate, or a crafted POST can mint a pass to a destination the
  listing hid (e.g. one still in a teacher list / matrix but since deactivated).
  Both live in `routes/kiosk.ts`; edit them together.

**How to apply:** any change to which destinations the kiosk offers must touch
both endpoints and preserve precedence + the `active/studentVisible/isDestination`
final filter. A teacher-list entry that points at a now-hidden/inactive location
is silently dropped by that final filter (correct).
