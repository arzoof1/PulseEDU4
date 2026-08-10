---
name: Hall pass close integrity
description: Who may end a pass, wrong-kiosk attempt logging, and close-type visibility (arrived vs no check-in vs auto).
---
Rule: PATCH /hall-passes/:id/end for staff callers is destination-scoped — allowed only for Core Team, the pass creator (displayName === teacherName), or staff whose loadStaffCoverage includes the pass destination OR origin room. `arrived:true` only stamps when the actor covers the destination (or Core Team); otherwise it's downgraded to a plain end. `system:true` is only accepted once the pass has outlived maxDurationMinutes (it bypasses the gate, and the client timer-cleanup fires it from ANY viewer's browser — so the server must verify expiry, not the flag).

**Why:** any-staff end let a student skip their destination and have a friendly teacher quietly close the pass with no discrepancy.

**How to apply:**
- Unauthenticated paths (origin "I'm back", kiosk arrive/return) are separate and unchanged — don't add the staff gate there.
- Wrong-kiosk check-ins: the kiosk arrive 403 branch appends {room,at} to hall_passes.arrival_attempts (TEXT JSON array, cap 10, active passes only, best-effort). The refusal itself is the signal — never end the pass there.
- Close-type semantics: status ended + arrivedAt = confirmed arrival; ended + no arrivedAt + NOT round-trip = unverified close (amber in UI); auto/system_ended = timeout. Restroom round-trips NEVER carry arrivedAt — surfaces must use the server-provided isRoundTrip flag (list + report-feed), not name heuristics, or restrooms all look "unverified".
- Known medium risk: creator identity is displayName equality (names not unique). If tightening, migrate to a staffId column on hall_passes.
- End/Receive client handlers must surface 403 text inline (banner), not console.error — dialogs are blocked in the preview iframe.
