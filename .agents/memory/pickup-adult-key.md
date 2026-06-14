---
name: Pickup student-anchored base + adult letter model
description: How the Parent Pick-Up redesign groups one adult across siblings and keeps base/letter consistent with the full code.
---

# Pickup: student-anchored base, per-adult letter

Each STUDENT owns ONE base number (1001+); each authorized adult on that
student gets a safe-alphabet letter suffix A–H. The full code (base+letter,
e.g. `1001A`) is what families read/scan and is stored in `pickup_number`.
Typing/scanning ONE adult's full code at the curb must resolve ALL that
adult's kids (portal AND non-portal).

This was done with THREE additive columns on
`student_pickup_authorizations` (`base_number`, `letter`, `adult_key`) — NOT
new tables. Legacy rows with null `adult_key` fall back to `parent_id`
grouping.

## Invariants (do not regress)

- **adultKey is the cross-sibling grouping key.** Portal parents key as
  `p:<parentId>` (globally unique, never collides). Non-portal SIS contacts
  key as `c:<name>|<relationship>|<phoneDigits>`.
  **Why:** the SIS feed has no guardian email, so phone is the strongest
  available discriminator. Without it, two distinct same-named adults in one
  school collide and the curb would surface unrelated families' kids — a
  release-authorization safety bug. When phone is blank the key degrades to
  name+relationship (residual risk; office fixes via guardian label edit).
  **How to apply:** any new code that computes an adultKey must route through
  `adultKeyFor` and pass `contactPhone`. Changing the key formula re-issues a
  new letter for the same adult on the next bulk-assign (no in-place match),
  so only change it at a cutover, not mid-year.

- **base/letter must stay consistent with pickup_number.** On admin manual
  override, parse the literal code: if it matches `\d+[A-H]?`, set base+letter
  from the PARSED code (never blend with the student's existing base); if it
  doesn't match the scheme, null base+letter so surfaces fall back to the
  literal code. **Why:** the tag ring + office strip render from base/letter
  while the QR/lookup uses pickup_number — divergence prints a tag whose ring
  disagrees with its QR.

- **Base anchor safety:** never reuse a base while ANY row (active OR retired)
  references it — `usedBases` must span all rows, not just active.

- **Letters retire, don't recycle within a year:** the used-letter set is
  filtered by `created_at >= schoolYearStartDate`; a removed adult's letter is
  dead until the year rolls. Soft cap 8 (A–H).

- **Restricted is server-enforced.** Curb greying is cosmetic; the real gate
  is in `/pickup/queue/add` (403 unless admin + justification).

- **No FLEID on tags/office strip** — `local_sis_id` only.
