---
name: Academic Evidence feature gate
description: How the per-school Academic Evidence (Partnering with Parents / Learning at Home) admin toggle is enforced, and the two-settings-table trap.
---

# Academic Evidence admin toggle

The "Partnering with Parents" (staff) / "Learning at Home" (parent) feature
has a per-school ON/OFF admin toggle via the two-tier feature-flag system
under key `AcademicEvidence` (`featureAcademicEvidence` + `superFeatureAcademicEvidence`
on `school_settings`, both default true; enabled = super && admin, no row = ON).

## Rule: gate server-side on EVERY route, not just the client
Client nav/render gating is bypassable by calling the API directly. The single
source of truth is `lib/academicEvidenceGate.ts::academicEvidenceEnabled(schoolId)`,
enforced as:
- staff routes: a `router.use` middleware on the academic-evidence router (gates all endpoints incl. the image preview).
- parent routes: in the cards route AND the per-sample image route.
- parent snapshot: `sectionsAvailable.academicEvidence`.

**Why:** a code review caught that UI-only gating let staff hit the API and let a
parent re-fetch a published sample image by id after the feature was disabled.
**How to apply:** when adding any new academic-evidence endpoint, it inherits the
staff middleware automatically; for any new parent endpoint, call the helper.

## Trap: two different settings tables in parentSnapshot
`parentSnapshot.ts` reads `schoolHeartbeatSettingsTable` (parent section show*
prefs, used by `gate()`), but the feature flags live on `schoolSettingsTable`.
You must issue a SEPARATE `schoolSettingsTable` query for the feature flags —
reading them off the heartbeat-settings row silently returns undefined.
