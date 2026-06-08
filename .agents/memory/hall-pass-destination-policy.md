---
name: Hall pass destination policy enforcement
description: Why any "which destinations show on a pass" policy must be enforced server-side, not only in CreatePassModal.
---

# Hall pass destination policy enforcement

Any policy that limits which destinations appear on a hall pass (e.g.
Restroom Access Control) must be enforced in the `POST /hall-passes`
handler, NOT only by filtering options in `CreatePassModal`.

**Why:** The modal is a client-only gate. A stale browser tab (cached
older allowed-set) or a crafted request can POST a destination the policy
should block, silently bypassing it. The user explicitly wanted a "hard
block," which a UI-only filter does not provide.

**How to apply:** Mirror the exact resolution precedence used by the modal
in a shared server helper and call it early in `POST /hall-passes` (after
basic validation, before the active-pass/polarity guards). Return a
structured 403 (e.g. `code: "RESTROOM_BLOCKED"`). Keep the helper a no-op
when the feature flag is off so legacy behavior is untouched. Note: the
kiosk self-serve path (`routes/kiosk.ts`) is a separate creation surface
with its own destination gating — extend enforcement there too if a policy
must cover student self-serve passes.
