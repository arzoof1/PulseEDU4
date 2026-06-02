---
name: Mutating production data
description: How to change prod DB data when agent tools are read-only against prod
---

# Mutating production data

The agent's `executeSql`/db tools are **read-only against production**. There is
no direct write path to the prod database from the workspace.

**To change prod data**, write an idempotent one-shot in `seed.ts`, wire it into
the boot sequence in `artifacts/api-server/src/index.ts` (inside its own
try/catch like the other `*Once` backfills), and have the user **Publish** — it
runs once on the prod app's first boot.

**Why:** prod data and dev data are separate; Publish copies code/schema, not
data rows. A boot one-shot is the established pattern here (see
`seedBenchmarkDeliveriesOnce`).

**How to apply / conventions:**
- Idempotency: guard with a marker row in `app_one_shot_markers (name pk, ran_at)`
  — check before work, insert after. Each environment (dev/prod) has its own
  marker, so it runs once per environment.
- Atomicity: wrap mutations in `db.transaction`. For bulk email/unique-column
  rewrites, do a **two-phase rename** (park every row on a unique throwaway value
  first, then assign finals) so the `unique(email)` constraint can't trip
  mid-flight.
- Fail fast: if any in-scope row can't be processed, throw BEFORE writing the
  marker so a later boot retries instead of leaving a partial backfill.
- Verify on dev first (restart the api-server workflow), then Publish for prod.

## Known-credential demo accounts

A boot one-shot that creates an account with KNOWN/hardcoded credentials (e.g.
the `admin@pulsedemo.com` demo admin) must verify its target school by a stable
identifier BEFORE writing — match `schools.id` AND `schools.name`, and return
early (log a warning) if it doesn't match. `school_id = 1` = "D. S. Parrott
Middle School" is the demo school in this deployment (same convention the other
Parrott one-shots use), but never inject a known login on the bare numeric id —
if id 1 were ever a real tenant you'd hand out an admin to real student data.
Use `INSERT ... ON CONFLICT (email) DO UPDATE` so the account self-heals to the
right role/school/password each boot.
