---
name: Cross-device data freshness (kiosk vs staff app)
description: Why staff-app counts/lists must poll, not just refresh on mount + own-action, when other devices (kiosks) mutate the same data.
---

The staff app and the door kiosks are separate sessions/devices writing the
same tables (hall passes, queues). A staff-app surface that loads data once on
mount and only re-fetches after the *signed-in user's own* create/end actions
will silently miss rows created on another device.

**Symptom seen:** "creating a hall pass from a kiosk does not increment the
active count, but creating one as a teacher does." Server stored the kiosk pass
correctly as `status='active'` (and every server count query already included
it) — the gap was purely client-side staleness.

**Rule:** any staff-app count/list that reflects data mutable by kiosks (or any
other device) must poll on an interval, not rely on on-mount + own-action
refresh. The repo convention is a 15s `setInterval` effect gated on
`authUser?.id` with `clearInterval` cleanup (see the pullout-count pollers and
the hall-pass poller in `App.tsx`).

**How to apply:** when adding a new staff-facing live count/list for anything a
kiosk or second surface can create, add a polling effect — don't assume the
existing load-once pattern is enough.
