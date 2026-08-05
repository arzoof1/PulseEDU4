---
name: Safety plan escort enforcement
description: Escort-required safety plans gate hall pass creation — how the flag works and where it must be enforced.
---

**Rule:** Only plans where the counselor explicitly answered Yes to "Does this student need an escort?" (`safety_plans.escort_required`) affect passes — NOT every active plan (user decision: don't block non-escort SP students). Enforcement = `findEscortHold` (lib/safetyPlanEscort.ts): status active + escortRequired + start/end date window vs school-tz today (YYYY-MM-DD string compare).

**Why:** A teacher asked for kiosk blocking for escort students; Chris explicitly rejected "any active plan triggers" to avoid blocking students whose plan has nothing to do with movement.

**How to apply:**
- Kiosk surfaces (pass create, queue add, Go-now bypass) = HARD block with the neutral `ESCORT_KIOSK_MESSAGE` — a shared student-facing screen must NEVER say "safety plan" or a reason.
- Staff surfaces = 409 `ESCORT_REQUIRED` with `planItems` + acknowledge-to-proceed override (`overrideEscortAck`), mirroring the keep-apart forced-ack pattern — the teacher may BE the escort.
- Any NEW pass-creation path must call `findEscortHold` or escort students route around the block.
- Editor auto-pre-checks Yes when an /escort/i item is added; counselor can flip back to No. Roster shows amber "E" badge next to the red SP pill.
