---
name: PulseBrainLab work-sample scan routing
description: How completed-worksheet QR scans get filed to (session, student); where decode runs and why; unmatched-tray idempotency rule.
---

# PulseBrainLab evidence-capture scan routing

The completed-worksheet evidence flow resolves an opaque base62 worksheet token
(school-scoped) → (session, student), binds the uploaded object to the school,
then files a `pulse_brain_lab_work_samples` row. Two intake paths feed it.

## Decode is split by path: phone = client, copier-batch = SERVER
**Rule:**
- Phone path: live camera decode in-browser, POSTs the token to the
  token-resolution route.
- Copier-batch path: the BS uploads ONE multi-page scanned PDF and the SERVER
  rasterizes + decodes each page itself (`POST /pulse-brain-lab/scan/batch` →
  `lib/scanDecode.ts`: `@hyzyla/pdfium` rasterize @ scale 3 → jsQR, then a ZXing
  `MultiFormatReader` TRY_HARDER fallback → unmatched tray if both miss).
**Why server-side for batch:** there is no live camera at the office MFP, so the
server must read the stack itself. An earlier "server decode is unreliable, do it
client-side" deviation was OVERRIDDEN — server batch decode is the intended,
working design.
**The real reason early server decode returned 0 matches was a GENERATOR bug, not
a decoder weakness:** the worksheet QR was rendered with `margin:0` (no quiet
zone) AND two captions overlapped its top+bottom edges, so no decoder (jsQR or
ZXing) could locate the finder patterns. Fix lived in
`pulseBrainLabWorksheetPdf.ts`: bake a quiet zone (`margin:2`), enlarge the QR,
and keep ALL captions clear of the QR (below it, with a gap).
**How to apply:** a scannable QR ALWAYS needs a quiet zone + nothing touching it;
verify decode by rendering the real PDF and decoding it, not by eyeballing the QR
(it looks "fine" to a human while finder-pattern detection fails).

## pdfium in the esbuild bundle
`@hyzyla/pdfium` is externalized in `build.mjs`; load its sibling `.wasm` via
`createRequire` + `readFileSync` and pass `wasmBinary` so it never path-traverses
at runtime. One library singleton, decode jobs serialized behind a promise chain
(WASM heap is single-threaded). api-server dev = `build && start` (no watch) —
restart the workflow after server edits.

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
