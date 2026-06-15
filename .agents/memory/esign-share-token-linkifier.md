---
name: External share tokens must be linkifier-safe (no base64url)
description: Why share/QR tokens that land in emails/chat must avoid '-' and '_' (base64url) — they get truncated by auto-linkifiers and 404.
---

# External share tokens must be linkifier-safe

Tokens that travel inside a URL the recipient opens from **outside** the app
(emailed/pasted/chat links, QR fallbacks) must NOT be `base64url`
(`randomBytes(n).toString("base64url")`). base64url uses `-` and `_`; when one
lands at the **end** of a URL, email/chat auto-linkifiers commonly exclude that
trailing punctuation from the detected hyperlink, truncating the token by a
character. The server then finds no matching row and returns 404, which the UI
surfaces as "invalid or has expired" — even seconds after creation.

**Why:** A reported e-sign ("docusign") link broke immediately. Reproduced:
exact token → HTTP 200; same token with the trailing `-` dropped → HTTP 404.
~3% of base64url tokens end in `-`/`_`. There is no expiry on e-sign docs, so
the "expired" wording was a red herring.

**How to apply:** For any externally-opened link token, generate
pure-alphanumeric base62 via the shared `genUrlSafeToken(len)` helper
(`artifacts/api-server/src/lib/urlSafeToken.ts`) — rejection-sampled
(discard bytes ≥ 248 = 4×62, no modulo bias). Char-length sets entropy:
43 ≈ 256 bits, 32 ≈ 190, 24 ≈ 143 (parity with randomBytes 32/24/18).
base62 ⊆ base64url, so existing exact-TEXT lookups, format validators, and
`hash*` digests keep working — no migration; legacy tokens still resolve.
Only swap the RAW token generator, NEVER the stored `hash*(...).digest(...)`
(those never ride in a URL; changing them invalidates in-flight links).
All known external-link generators now route through the helper: e-sign
share, staff + parent password reset, parent invites, ticket QR + gate
scanner, kiosk activation + enroll, hall-pass queue viewer. New
external/emailed/QR link tokens must use the helper too.
