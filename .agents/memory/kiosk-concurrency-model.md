---
name: Kiosk hall-pass concurrency model
description: How the door kiosk enforces one-student-out-at-a-time, and the gap any concurrent-pass feature opens.
---

# Kiosk one-out-at-a-time is a CLIENT-SIDE UI invariant, not a server rule

`POST /api/kiosk/hall-passes` has **no room-capacity check**. The "only one
student out at a time" behavior is enforced purely by the client: while a pass
is active the kiosk renders a full-screen `TimerScreen` that hides the main
pass-creation form, so the next student's only option is the waiting queue
("Get in line"). The queue (cap 5, period-aware reset) is the concurrency
control; it hands off one student at a time.

**Why this matters:** any feature that creates a SECOND concurrent active pass
from the same room (e.g. the "Go now" line-bypass for office/clinic summons)
silently breaks two things:

1. **Single-timer display** — the device's `TimerScreen` tracks exactly one
   `activePass`. A second concurrent pass does not show its own countdown on
   that device.
2. **Self-return** — because the form is hidden behind the timer, the
   bypass student usually cannot tap "I'm back" on that kiosk until it's free.
   Returns then rely on the teacher ending the pass from the Companion Queue /
   staff app, or the student waiting for the kiosk to clear.

**How to apply:** if you add anything that can produce concurrent passes,
decide explicitly how the device displays and returns the extra pass(es).
Today the "Go now" overlay intentionally does NOT take over the main timer
(the line/bathroom student keeps the big countdown) and leans on
teacher-ends-on-return for the bypass student.

# "Go now" bypass rules (POST /kiosk/hall-passes, bypassQueue:true)

- Restroom-kind destinations can never bypass (server rejects + client hides
  them from the picker). Restroom discriminator is `locations.kind`.
- Daily-limit is WAIVED (involuntary summons).
- Keep-apart (polarity) is STILL enforced, but on conflict it **blocks with a
  409 "see your teacher"** instead of silently enqueuing (silent-queue is the
  normal-pass behavior and would defeat the bypass).
- Pass is flagged `hall_passes.priority_bypass = true` for audit.
- `kind` must reach the kiosk via the token-authed `/kiosk/destinations/:token`
  endpoint — the staff-only `/api/locations` 401s on a kiosk device, so its
  `byId` map is usually empty there.
