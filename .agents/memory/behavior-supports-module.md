---
name: Behavior Supports module
description: Confidentiality/permission model for the MTSS teacher-translation Behavior Supports snapshots
---

The rule: Behavior Supports records are a **teacher translation layer**, not a BIP/FBA — the record has NO fields where confidential info could live (5 bullet lists + status shell only), and everything on the record is teacher-visible via the roster pill hover card. Never add free-text notes or confidential-capable fields to this table.

**Why:** Florida schools must keep diagnoses/evals/counseling notes out of teacher-broadcast surfaces; the safety comes from the schema having nowhere to put them, not from display filtering.

**How to apply:**
- Permissions: EDIT = `isCoreTeam()` (covers Admin/AP/Principal, MTSS coord, psych, behavior specialist, SuperUser, Confidential Secretary); VIEW = edit + isGuidanceCounselor/isCounselor; teachers 403 on all /api/behavior-supports routes — their read-only view is the sanitized `behaviorSupport` field on GET /teacher-roster rows.
- Versioning: one current row per (school,student) via partial unique index (`archived_at IS NULL`); PUT = archive-then-insert in a tx; 23505 → 409 (concurrent save).
- 15-bullet total cap + 200-char per-bullet limit are entry-time server 400s (reject, don't truncate) — API callers can't bypass what the UI enforces.
