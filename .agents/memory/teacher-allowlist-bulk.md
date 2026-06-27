---
name: Teacher allowlist bulk + zone rules
description: Hall-pass teacher destination allowlist bulk CSV + zone-rule auto-assign — rollback snapshot keying invariant and the shared apply path.
---

# Teacher destination allowlist — bulk management

The per-teacher hall-pass destination allowlist supports bulk management on top
of the manual grid: CSV round-trip + zone-rule auto-assign. Both write paths go
through one shared helper `computeAndApplyBulk(schoolId, createdBy, rawRows,
commit)` in `routes/teacherAllowlist.ts`.

## Rollback snapshot MUST be staffId-keyed (array), never name-keyed

`teacher_allowlist_import_batches.prior_json` stores prior grants as an ARRAY of
`{staffId, staffName, locationIds}` — NOT an object keyed by `staffName`.

**Why:** display names are not unique. A name-keyed map silently overwrites the
snapshot for two teachers sharing a display name, so undo cannot restore both.
This was the whole point of the Phase-0 prerequisite that re-keyed the allowlist
from display-name → stable `staffId`. An architect review caught a regression
where the snapshot had reverted to name-keyed.

**How to apply:** when touching the bulk apply or rollback route, keep the
snapshot a staffId-keyed array and restore strictly by `staffId` (name only as
display metadata / fallback for legacy null-staffId rows). Both CSV bulk AND
zone auto-assign inherit this because they share `computeAndApplyBulk`.

## Other invariants

- Matching priority: email wins; display name only when unambiguous.
- Replace-listed-only: a teacher absent from the upload is untouched; matched
  teachers keep their non-restroom grants (only restroom grants are replaced).
- Zone rules: inclusive room-NUMBER range → restroom area, first match by
  `sort_order` wins; `extractRoomNumber` takes the first digit run in the room
  label. Template area pre-fill = single current area → zone suggestion → blank.
- `replaceTeacherAllowlist` already wraps each teacher's delete+insert in its
  own `db.transaction`. Do NOT wrap the apply loop in an outer `db.transaction`
  unless you thread the tx handle through — otherwise it's a misleading no-op
  (inner calls use the module `db`, not the outer tx).
