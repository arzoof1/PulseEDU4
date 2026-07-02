---
name: Feature pilot semantics
description: How staff feature pilots interact with the dual district/school switches, and why embedded reads gate at school level only.
---

Effective feature enablement is computed ONLY in `loadEffectiveFeatures`:
`enabled = superOn && (schoolOn || actorHasPilotRow)`.

**Why:** District license must always win — a school admin (or a pilot row)
can never re-enable a feature the district turned off. Pilots exist to let a
few staff trial a module while the school-wide toggle stays off.

**How to apply:**
- Family-facing feature keys are `pilotable:false` (a parent has no staff
  identity, so a "pilot" would silently gate families) — the pilot PUT must
  400 them and new family-facing keys must set the flag.
- Route gating uses `requireFeature` (staff, pilot-aware via req.staffId) or
  `requireFeatureForParent` (parent, school-level only).
- Shared data loaders with NO request/staff context (e.g. gradebook
  `loadCurrentGrades`) gate on the SCHOOL-level license only (both switches),
  never pilots — they also feed parent surfaces. Pilots re-enable the staff
  workflow routes, not embedded reads.
- A licensed module must go dark on EVERY surface together: mounts, mutation
  side-doors (rollback), job/history listings, and embedded reads. The
  gradebook rollback bypass was found in review because only preview/commit
  were gated.
