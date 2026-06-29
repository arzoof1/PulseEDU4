---
name: Tour public asset cache-busting
description: Why index-based public photo/flyer URLs must carry a content version, or replaced images appear to persist.
---

Public School Tours photo/flyer URLs are index-based
(`/api/tours/public/:schoolId/photo/:idx`, `.../flyer/:idx`) and the bytes are
served with a `Cache-Control: ...max-age` header (object storage default ~1h).

**Problem:** delete an asset + upload a replacement → the new file lands at the
SAME index → the URL is unchanged → the browser serves the previously cached
image. The old/"seed" picture appears to persist even though the DB and storage
are correct.

**Fix / rule:** any index-based (or otherwise stable) public asset URL whose
underlying bytes can change MUST carry a content version derived from the object
key, e.g. `?v=<sha1(key).slice(0,10)>`. Each upload mints a fresh object key, so
the hash changes, the URL changes, and the cache is busted. See `assetVersion()`
in `routes/tours.ts` applied to the public `photos`/`flyers` URL lists.

**Why:** caching by stable URL + mutable content = stale image. Don't "fix" this
by dropping the cache header (kills perf); version the URL so each distinct file
is immutable at its own URL.

**How to apply:** when adding any new public-streamed asset surface (district
logo, etc.), append the same key-derived `?v=` token if the asset can be replaced
in place.
