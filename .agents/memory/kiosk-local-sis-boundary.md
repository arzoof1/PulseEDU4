---
name: Kiosk local_sis_id boundary
description: How student identifiers cross the kiosk/hall-pass/badge boundary — human-facing local_sis_id vs internal student_id.
---

# Kiosk / Hall-Pass / Badge identifier boundary

**Rule:** Every *student-facing* surface in the kiosk/hall-pass/badge workflow
uses `local_sis_id` (human-facing, numeric, 100% populated, unique per
`(school_id, local_sis_id)`). The internal FLEID-style `student_id`
(e.g. `FL000005062879`) is the canonical FK and must NEVER appear to a student
or be encoded in a badge QR / Code128 barcode.

**Why:** Schools hand students badges and a kiosk keypad; the FLEID is an
opaque state id they don't know. They scan/type their SIS id.

**How to apply:**
- Kiosk entry points resolve the typed/scanned value via
  `resolveKioskStudent(rawId, schoolId)` (matches `local_sis_id`, school-scoped)
  and then set `normalizedStudentId`/`trimmedId = student.studentId` so all
  downstream checks + inserts keep using the canonical FK. Endpoints:
  `/kiosk/hall-passes`, `/kiosk/hall-passes/return`, `/kiosk/class-signin`,
  `/kiosk/queue/:token/add`.
- Badge QR + barcode encode `localSisId ?? studentId` (fallback only if a row
  is somehow missing its SIS id).
- The next-up queue confirm needs `local_sis_id` per entry: it's **joined**
  from `students` in `clearStaleAndList` (NOT a stored column — avoids a
  migration on the drizzle-push-managed `hall_pass_queue` table). `shapeEntry`
  takes a structural row type with optional `localSisId?`.
- The next-up confirm compares the typed value to `entry.localSisId` **exactly**
  — no `toUpperCase()` (SIS ids are numeric). FLEID-based matching must not
  return.
- Internal queue delete paths (`/skip`, `consumeQueueEntry`) match
  `student_id` **exactly**. They previously `.toUpperCase()`d; that's a no-op
  for FLEID but fragile now that queue rows store the canonical id verbatim —
  removed.

**Operational note:** Any badges printed before this change encode the FLEID in
their QR/barcode and must be **reprinted** to scan correctly at the kiosk.
