---
name: Family Messages attribution model
description: Why Family Messages decouples delivery (many) from acknowledgment/Power Reader (one primary).
---

Family Messages (Core Team → parent broadcast) follows **deliver to many,
attribute to one**: a message may be delivered to multiple authorized contacts
of a family, but the "Got it" acknowledgment and the derived **Power Reader**
badge roll up to ONE primary identity per family.

Today the primary = the **portal account** (`parents` row). That table is
already an email-keyed, school-scoped adult identity grouped across siblings via
`parent_students`, so it is the cleanest "family/primary" anchor that exists.
Email-only contacts (no account) still RECEIVE + count as delivered, but do not
earn the badge until they claim an account.

**Why:** SIS contact lists are messy (same parent duplicated across siblings,
step-parents, no stable household id). Anchoring attribution to one identity
avoids double-counting and keeps the badge stable; tying it to the portal
account also nudges families toward adopting the portal.

**How to apply:** if/when multi-contact email lands (Phase 2), keep delivery
fan-out separate from attribution — never let extra contact emails each earn
their own badge. Power Reader is engagement-only — it must NEVER move PBIS
points regardless of how many contacts a family has. ClassLink/the SIS adapter
does not feed guardian emails today, which is why multi-contact delivery is
deferred.
