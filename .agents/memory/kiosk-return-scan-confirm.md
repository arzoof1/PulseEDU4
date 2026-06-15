---
name: Kiosk return requires badge scan
description: Why "I'm back" on the kiosk must confirm identity by scan, and the 404 semantics of the return endpoint.
---

# Kiosk "I'm back" must confirm identity by badge scan

The kiosk TimerScreen (full-screen countdown for the one active pass) must
NOT end a pass on a bare "I'm back" tap. The student must scan/type their
badge first, and the **scanned id** is what gets sent to
`POST /api/kiosk/hall-passes/return` — never the known `activePass.studentId`.

**Why:** a one-tap return lets anyone walking up end another student's pass.
A full-screen countdown rewrite once dropped the scan step (the original
return flow always required entering/scanning the badge); it read as a
regression and had to be restored.

**How to apply:**
- Submit the scanned/typed id. The server resolves local SIS id → canonical
  student_id and room-scopes the active-pass lookup (`originRoom === room`),
  so a mismatched badge simply finds no active pass = identity + location
  enforced server-side. No client-side comparison needed (and `activePass`
  carries no localSisId to compare against anyway).
- **404 on the return endpoint = wrong badge**, NOT "already ended". Surface
  it as an error; do not silently clear the timer. Remotely-ended passes
  clear on their own via the queue poll, so a 404 on an *explicit* scan can
  only mean a mismatch.
- Reuse `CameraScanner` + module-scoped `extractStudentIdFromScan` (handles
  raw id or `?signin=<id>` badge-QR URL); auto-submit on a successful scan.
