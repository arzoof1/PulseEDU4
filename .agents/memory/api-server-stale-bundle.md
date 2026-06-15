---
name: api-server serves a stale bundle until restarted
description: Why server behavior can lag behind merged/edited code — the api-server dev workflow builds once at start and does NOT watch.
---

The `@workspace/api-server` dev workflow runs `build && start` (esbuild
bundle → `node dist/index.mjs`). It is **not** a watch process: it builds
ONCE when the workflow starts. Editing or merging server code does nothing
to the running process until the workflow is restarted.

**Symptoms of a stale bundle (look like app bugs, aren't):**
- A newly-added request/response field is silently dropped (e.g. an upsert
  ignores a column the current source clearly writes) → DB keeps the old
  default.
- A renderer/route behaves like an older version (e.g. PDF layout, validation)
  even though the source is correct and typechecks.

**Why:** no file watcher; the bundle in `dist/` is whatever was built at the
last workflow start.

**How to apply:** when server behavior contradicts the current source AND the
source reads correct (route/loader/schema all present, typecheck clean),
suspect a stale bundle BEFORE editing more code — `restart_workflow` the API
Server to rebuild, then re-verify. To prove the lib itself is correct
independently of the server, render via tsx against the source files.
