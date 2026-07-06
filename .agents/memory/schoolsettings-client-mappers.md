---
name: School settings client state mappers
description: Why a new school_settings feature toggle silently reverts to ON after save
---

# School settings client state reducers must enumerate every feature key

`artifacts/client/src/App.tsx` holds the `schoolSettings` state as a fully-typed
object literal, and rebuilds it from the server response in THREE hand-written
places: the state type + defaults, `loadSchoolSettings`, and the
`saveSchoolSettings` response reducer. Each explicitly copies every field via
`boolOrTrue(data.X)` — there is no spread/passthrough.

**The bug:** when a new licensable module ships (new `feature_*` /
`super_feature_*` columns), if you forget to add its keys to these reducers, the
field is DROPPED from client state on every load/save. The School Features UI
reads `ssRec['superFeature'+k] !== false`, so an absent key reads as `true` and
the checkbox shows ON. A SuperUser can uncheck + save (server persists false),
but the save-response reducer strips the key back out → the toggle "comes back
on." Server enforcement was always correct; this is purely client state loss.

**Why:** the reducers are exhaustive object literals, not `{...data}` merges, so
any key not listed is invisible to the client.

**How to apply:** whenever you add a feature toggle backed by
`feature_X`/`super_feature_X`, update all FOUR spots in App.tsx in lockstep:
(1) the `useState` generic type, (2) the defaults object, (3) `loadSchoolSettings`
mapper, (4) `saveSchoolSettings` response mapper. Note the two mappers use
DIFFERENT indentation (10 vs 8 spaces), so a single edit won't hit both.
