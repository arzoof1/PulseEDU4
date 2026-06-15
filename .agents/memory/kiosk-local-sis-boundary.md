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
- Badge QR + barcode encode `local_sis_id` ONLY — NEVER fall back to
  `studentId` (the kiosk resolves `?signin=` by `local_sis_id`, so a FLEID
  fallback both leaks the FLEID and never scans). If a row is missing its SIS
  id, skip the barcode / emit an empty QR signin param rather than encode the
  FLEID.
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

## App-wide rule (not just kiosk)

The boundary above is the SPECIAL CASE of a hard, app-wide product rule: the
FLEID `student_id` must NEVER be rendered forward-facing ANYWHERE — staff UI,
parent portal, signage, tooltips, @mention tokens, graph nodes, table cells,
and CSV/PDF exports all included. Display ID is ALWAYS `local_sis_id`
(render `localSisId ?? "—"`, never fall back to `studentId`). This recurs
because `studentId` is the convenient FK already in scope — when adding any
student-facing surface, the server response must carry `localSisId` and the UI
must use it. Codified in `replit.md` Gotchas. Confirmed fixed so far:
kiosk/badges, safety-plan module (`/safety-plans/list` carries `localSisId`).
Known remaining offenders surface in watchlist/case tools, tardy + @mention
search, admin-hub activity logs, and some exports — sweep these when touched.
