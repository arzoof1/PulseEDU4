---
name: Deployment secret propagation
description: Updating a workspace secret value does not reliably reach the already-published deployment; boot one-shots that read a secret can silently stay dormant in prod.
---

# Workspace secret updates don't reach the published deployment reliably

When a boot one-shot in `seed.ts` gates on `process.env.SOME_SECRET` (early
return if empty/unchanged), it can run correctly in **dev** but silently stay
**dormant in the published deployment** — no marker row, no log line — because
the deployment did not pick up the new/updated workspace secret value.

Observed: a SuperUser password-recovery one-shot keyed to
`SUPERUSER_RECOVERY_PASSWORD` wrote its marker on the first publish, but after
the user *updated* the secret value and republished, the new-marker one-shot
never ran in prod (the deployment's env value did not reflect the update).

**Why:** workspace Secrets and the deployment's captured env are not guaranteed
to be in lockstep on a value change; agent tools also MASK secret values
(`viewEnvVars` returns the literal string `"true"`), so you cannot verify what
the deployment actually has.

**How to apply:** for one-shot prod data fixes that must be deterministic
(e.g. emergency admin password recovery), do NOT depend on a secret reaching
the deployment. Instead bake a **one-way value** (e.g. a pre-computed bcrypt
hash, cost 10) into the one-shot so it runs on boot regardless of secrets.
Compute the hash in dev (where the app already applied it), read it back from
the dev DB, embed it, bump the marker, and republish. A bcrypt hash is not a
plaintext credential; still delete the one-shot + constant after the user
confirms recovery, and have them change the password in-app.
