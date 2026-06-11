---
name: E-sign document tenancy
description: Why e-sign docs are creator-private (not school-wide) and how the public sign route stays safe.
---

# E-sign document tenancy

E-sign documents (`esign_documents`) are **private to their creator**, not
school-wide. Every staff query scopes by BOTH `school_id` AND `created_by`
(list/stats/get/delete). This is a deliberate departure from the usual
school-wide read model.

**Why:** product decision — staff upload sensitive docs (incl. hiring/HR), so
each creator only sees their own. An admin "see all" view was explicitly
deferred, not forgotten. Keep new e-sign surfaces creator-scoped unless the
admin-see-all feature is actually being built.

**How to apply:** any new e-sign endpoint or report must keep the
`created_by` filter alongside `school_id`. Dropping it leaks docs to other
staff in the same school.

**Public sign route:** `/sign/:token` and `GET/POST /api/esign/sign/:token`
are unauthenticated BY DESIGN (recipient has no login), gated only by a
192-bit random `shareToken`. They return just signer-needed metadata, never
other rows. Single-sign is race-safe via conditional update
(`where id=? AND status='pending'` → loser gets 409). Same security shape as
the public signage-by-id route.
