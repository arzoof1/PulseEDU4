---
name: PulseBrainLab work-sample scan routing
description: How completed-worksheet QR scans get filed to (session, student); where decode runs and why; unmatched-tray idempotency rule.
---

# PulseBrainLab evidence-capture scan routing

The completed-worksheet evidence flow has ONE server "routing brain"
(`POST /pulse-brain-lab/scan/route`) shared by both intake paths: it resolves an
opaque base62 worksheet token (school-scoped) → (session, student), binds the
uploaded object to the school, then files a `pulse_brain_lab_work_samples` row.

## Decode runs CLIENT-SIDE, not on the server
**Rule:** QR decode + PDF page rasterize happen in the browser; the server only
resolves the already-decoded token.
- Phone path: live camera decode in-browser.
- Copier-batch path: client rasterizes the multi-page PDF with pdfjs and decodes
  each page's QR with @zxing, then POSTs each token to `/scan/route`.
**Why:** server-side QR decode proved unreliable on real copier scans (skew,
compression, low contrast). Earlier server decode/rasterize deps were added then
removed. Don't re-add a server decoder expecting it to "just work" on MFP output.
**How to apply:** any new intake surface decodes client-side and calls the same
`/scan/route` brain; keep the server token-resolution-only.

## Unmatched tray = pending → assigned|discarded, must be ATOMIC
Pages whose QR won't decode are parked in `pulse_brain_lab_unmatched_scans`
(status `pending`) for one-tap manual assignment.
**Rule:** assign claims the row with a guarded
`UPDATE ... SET status='assigned' ... WHERE id=? AND school_id=? AND status='pending' RETURNING`
inside a transaction, and only files the work sample if exactly one row was
claimed. A read-then-update (select pending → insert → update) is NOT safe.
**Why:** concurrent assign/assign or assign/discard on the same scan double-filed
work samples and left half-assigned rows. The guarded UPDATE is the sole
concurrency gate: the loser sees no pending row and gets 404.
**How to apply:** verify with two parallel assigns → expect exactly one 201 and
one 404, one work-sample row, status `assigned`; a later assign is also 404.

## Tenancy / ID boundaries (same as rest of app)
- Every scan/work-sample read+write is Core-Team gated + `requireSchool`.
- Work-sample student JOIN pairs `student_id` WITH `school_id` (FLEID is NOT
  globally unique); responses carry `localSisId`, never the FLEID.
- Printed manual-routing fallback beside the QR is `local_sis_id` + session code.

## State of the feature (as of this work)
PulseBrainLab is BACKEND-ONLY: schema, seed boot-ensure, PDFs, and these scan
routes exist, but there is NO delivery client UI yet (no groups/session host
page, no phone scanner, no unmatched-tray screen). Building the scanner UI
requires first scaffolding the delivery client surface.
