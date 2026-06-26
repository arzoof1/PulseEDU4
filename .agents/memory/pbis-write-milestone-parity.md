---
name: PBIS write milestone parity
description: Any endpoint inserting into pbis_entries must also run processMilestonesForStudent, or milestone side-effects silently drift between endpoints.
---

# PBIS write milestone parity

Any new endpoint that inserts a row into `pbis_entries` directly (not via
`POST /pbis`) must also run `processMilestonesForStudent(studentId, schoolId)`
after the insert, and ideally return `milestoneResults` in the response.

**Why:** `POST /pbis` runs milestone processing unconditionally (for both
positive and negative entries). A second write path (e.g. the roster
`POST /interventions/quick-log` atomic behavior+intervention logger) that skips
it produces inconsistent PBIS outcomes — milestone updates/notifications fire on
one path but not the other depending on which endpoint logged the behavior.

**How to apply:** import `processMilestonesForStudent` from
`../lib/pbisMilestones.js` (it is NOT exported from `@workspace/db` — that import
fails to typecheck). Call it after the DB transaction commits; wrap in
try/catch + `req.log.error` so milestone failure is non-fatal to the write.
