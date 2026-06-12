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
pure-alphanumeric base62 (`A-Za-z0-9`) via rejection sampling (discard bytes
≥ 248 = 4×62 to avoid modulo bias); 32 chars ≈ 190 bits. Exact TEXT-column
lookups mean legacy base64url tokens keep resolving — no migration needed.
Same base64url-in-URL risk still lives in other routes that email/QR links:
`parentInvites`, `ticketing` QR, `kiosk`, and `auth`/`parentAuth` reset raw
tokens — fix them the same way if those links start failing.
