---
name: Production deployment is NOT this workspace
description: The live PulseEDU site is a separate nginx/Helmet host with its own DB; this Replit workspace + executeSql(production) do not reach it.
---

The published app at `pulseedu.pulsekinetics.us` is a **separate deployment**, not
this Replit workspace's build, and it uses a **different database**.

Evidence (gathered while recovering a locked-out SuperUser):

- The same known-good SuperUser credential (localhost:80, this repo) login returns
  **200 OK**; live site returns **401** for the identical credential.
- Live site response headers include the full **Helmet** set
  (`x-dns-prefetch-control`, `x-download-options`, `x-permitted-cross-domain-policies`,
  `origin-agent-cluster`, a strict `content-security-policy`) and `Server: nginx/1.28.3 (Ubuntu)`.
  This repo has **zero** Helmet references and serves `X-Powered-By: Express`.
- `executeSql({environment:"production"})` shows a staff row whose hash matches the
  recovered temp password, yet the live app rejects that password — so the DB
  `executeSql` reads is **not** the live app's DB. The `recover_diag` rows (boot
  self-tests + login attempts) were written by the **dev** server, not production.

**Why this matters:** A boot one-shot / diagnostic strategy that relies on
"publish from this workspace" + "read prod via executeSql" will silently only
affect the dev environment. The live site and its DB are unreachable from here.

**How to apply:** Before assuming "prod == this workspace," verify deployment
identity end-to-end: (1) curl the live domain's login with a known-good credential
and check the status, (2) inspect response headers (`Server`, Helmet presence) and
compare to the dev server, (3) confirm `executeSql(production)` actually backs the
live app (write a marker via the live app, read it via executeSql). If they diverge,
the real production is hosted elsewhere and must be fixed there (e.g. run the
verified bcrypt hash UPDATE against the real prod DB).
