---
name: Offline-first sync buffer flag clearing
description: How to clear a "dirty" flag after an in-flight sync without dropping edits made mid-request
---

In an offline-first buffer that POSTs the FULL local state on each flush (e.g. TourWalk live tour capture), a successful sync must NOT blindly clear the dirty flag.

**The bug:** clear `dirtyRef=false` unconditionally on success → if the user edits during the in-flight request, `mutate()` sets dirty=true, the response then resets it to false, and the retry loops (gated on dirty) skip those newer edits. The taps are silently lost.

**The fix:** snapshot the exact buffer object you send (`const sent = bufRef.current`). On success, only clear dirty if `bufRef.current === sent` (object identity — `mutate` always allocates a new object). In `finally`, if still dirty, schedule another flush.

**Why:** clear connections + fast taps make the mid-flight window real during a live building walk.
**How to apply:** any debounced/retried full-state sync (localStorage buffer → server upsert). Same pattern applies to any "flush + dirty flag" loop.
