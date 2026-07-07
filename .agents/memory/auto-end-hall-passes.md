---
name: Auto-end forgotten hall passes
description: The shared autoEndStalePasses helper must run on EVERY surface that gates/displays active passes, or a forgotten pass lingers inconsistently.
---

# Auto-end forgotten hall passes

A school-configurable threshold (`schoolSettings.hallPassAutoEndMinutes`, default 20) closes any still-`active` pass past that age as status `auto_ended`, endedAt capped at `createdAt + threshold`, endedBy `(auto)`.

The logic lives in ONE shared helper, `lib/hallPassLifecycle.ts` `autoEndStalePasses(schoolId)` — idempotent via `WHERE status='active'` on the UPDATE so concurrent readers converge.

**Rule:** every surface that READS or GATES on "currently active" passes must call `autoEndStalePasses` first. Today that means: staff pass log (`GET/POST /hall-passes`), kiosk token queue (`GET /kiosk/queue/:token`, `POST .../add`), companion queue (`GET /hall-pass-queue`), and kiosk pass create (`POST /kiosk/hall-passes` existing-active check). The kiosk RETURN endpoint is intentionally NOT wired — it ends a pass rather than gating/displaying, so auto-ending there only risks a confusing 404.

**Why:** the first cut only wired the staff `/hall-passes` routes; the kiosk/companion queues query `status='active'` directly, so a forgotten pass stayed visible/blocking there until someone hit `/hall-passes`. Any NEW route that reads active passes will drift the same way unless it calls the shared helper.

**How to apply:** grep for `status, "active"` in hall-pass routes; each read/gate site needs `await autoEndStalePasses(schoolId)` before it. Status displays must also map `auto_ended` → "Auto Ended" (badge-overdue) and time-edit (PATCH) must preserve `auto_ended` like `system_ended`.
