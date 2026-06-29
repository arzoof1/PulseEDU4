# Migration Report — School Tours: Live Tour Capture (Phase 4) → Production (LIVE)

**Audience:** the developer who owns the LIVE production host.
**Goal:** take the new *Live Tour Capture* feature live safely.
**Risk level:** **Low.** Additive only — two brand-new tables, new routes, new
client screen. No existing tables, columns, routes, or data are altered or removed.

> ⚠️ **Production is a separate environment.** The LIVE host
> (`pulseedu.pulsekinetics.us`) runs its **own nginx/Helmet stack and its own
> PostgreSQL database**, independent of the Replit workspace. Schema and data in
> the workspace do **not** automatically reach LIVE — the steps below must run
> against the **production** database and the **production** deploy.

---

## 1. What's shipping

**Live Tour Capture** lets a tour guide run an enrollment tour from a phone:

- A QR code on the **Tour Roadmap** (printed PDF + the on-screen lead drawer) opens
  a **token-gated, unauthenticated, offline-first** live-walk screen at
  `/tour/walk/:token`.
- The guide confirms/changes **who is guiding** (defaults to the lead owner), taps
  **once per checkpoint** (client-timestamped), and can jot **staff-only per-stop
  notes**.
- Taps are **buffered in the browser's localStorage** and **synced when online**
  (idempotent, full-buffer flush).
- Captured timings feed the **lead drawer** (planned-vs-actual per stop, total
  length, follow-up notes) and the **Outcomes report** (walks completed, average
  tour length, **per-guide rollup**).

Also included: a fix so the **Outcomes report client UI actually renders** the
per-guide analytics fields (they were computed server-side but not displayed).

---

## 2. Scope of changes

| Area | Change | Type |
| --- | --- | --- |
| DB schema | `tour_walks`, `tour_walk_steps` (new tables) | **Additive** |
| API server | New routes under `/tours/walk/*`, `/tours/requests/:id/walk`; extended `/tours/outcomes/summary`; roadmap PDF gains a QR | Additive / extend |
| Client | New `/tour/walk/:token` screen + dispatch; lead-drawer walk section; Outcomes "Live tour walks" card | Additive |
| Config | `PUBLIC_APP_URL` must be correct in prod (drives the QR deep-link) | **Verify** |

No destructive operations. No data backfill required (the feature starts empty and
populates as guides run walks).

---

## 3. Database migration

### 3.1 How it normally applies (automatic)

On server boot, the seed/boot routine calls **`ensureTourWalksSchema()`**, which
issues idempotent `CREATE TABLE IF NOT EXISTS` + `CREATE … INDEX IF NOT EXISTS`
statements. **In most cases you do nothing** — deploying the new server build and
restarting the process creates the tables automatically against whichever database
the production server is connected to.

> This project intentionally avoids `drizzle-kit push` for non-interactive
> deploys (it can block on rename prompts). Additive schema is applied via these
> idempotent `ensure*` boot statements.

### 3.2 Manual DDL (fallback / verification)

If your production deploy does **not** run the boot seed (e.g., a hardened start
command that skips seeding), run this **idempotent** SQL directly against the
**production** database. It is byte-for-byte what the boot routine runs and is safe
to re-run:

```sql
CREATE TABLE IF NOT EXISTS tour_walks (
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL,
  tour_request_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  guide_staff_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS tour_walks_request_unique ON tour_walks (tour_request_id);
CREATE UNIQUE INDEX IF NOT EXISTS tour_walks_token_unique   ON tour_walks (token);
CREATE INDEX        IF NOT EXISTS tour_walks_school_idx      ON tour_walks (school_id);

CREATE TABLE IF NOT EXISTS tour_walk_steps (
  id SERIAL PRIMARY KEY,
  school_id INTEGER NOT NULL,
  walk_id INTEGER NOT NULL,
  tour_request_id INTEGER NOT NULL,
  checkpoint_key TEXT NOT NULL,
  checkpoint_label TEXT NOT NULL DEFAULT '',
  planned_minutes INTEGER NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS tour_walk_steps_walk_checkpoint_unique ON tour_walk_steps (walk_id, checkpoint_key);
CREATE INDEX        IF NOT EXISTS tour_walk_steps_walk_idx               ON tour_walk_steps (walk_id);
```

### 3.3 Schema notes (constraints that matter)

- **`tour_walks.tour_request_id` is UNIQUE** → one walk per lead (re-opening the QR
  resumes the same walk, never duplicates it).
- **`tour_walks.token` is UNIQUE and globally unique** → the token alone resolves the
  walk and its school (it's the unauthenticated deep-link key).
- **`tour_walk_steps (walk_id, checkpoint_key)` is UNIQUE** → re-syncing the same tap
  is an idempotent upsert (no duplicate stop rows).
- `checkpoint_label` / `planned_minutes` are **snapshots at tap time** so historical
  reports survive later edits to the brag-page checkpoint config.
- `completed_at`, `started_at`, `ended_at` are **client-stamped** (the walk happens
  offline) — the server stores the client time, not the sync time.
- Every row carries **`school_id`** (multi-tenant isolation — see §7).

---

## 4. New / changed API endpoints

All under the existing tours router. The two walk endpoints are **unauthenticated by
design** (token-gated), mirroring the existing post-tour-survey and kiosk patterns.

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /tours/walk/:token` | Token only | Walk state + checkpoints (page order) + assignable guides for the picker |
| `POST /tours/walk/:token/sync` | Token only | Idempotent flush of the guide's buffer (upsert steps by `walk_id`+`checkpoint_key`; set guide/started/ended/status). Validates each `checkpoint_key` against the **lead's eligible stops** (family selections + always-include), not the whole school catalog |
| `GET /tours/requests/:id/walk` | Staff (tour guide + can-access-lead) | Mints/fetches the walk; returns state + `walkUrl` + token for the lead drawer |
| `GET /tours/outcomes/summary` | Staff | **Extended** with `walksCompleted`, `avgTourMinutes`, `byGuide[]` |
| `GET /tours/requests/:id/roadmap.pdf` | Staff | Roadmap PDF now embeds a "Start the digital tour" **QR** |

No existing endpoint contracts were broken; `outcomes/summary` only **adds** fields.

---

## 5. New client routes

- **`/tour/walk/:token`** — the guide live-walk screen (offline-first). Dispatched in
  the tour client before the survey route.
- Lead drawer gains a **Live Tour Walk** section (QR + "Open live walk" link + results).
- Outcomes report gains a **Live tour walks** card (walks completed, avg length,
  per-guide rollup) with an empty state until the first walk completes.

The client is a single Vite bundle with path-based dispatch — no new build target,
no new service.

---

## 6. Configuration / environment variables

**Critical — verify before go-live:** the QR deep-links and family-facing URLs are
built from `publicAppOrigin()`, which resolves in this order:

1. **`PUBLIC_APP_URL`** (use this — set it explicitly in production)
2. first host in `REPLIT_DOMAINS`
3. inbound forwarded host
4. `REPLIT_DEV_DOMAIN` → `http://localhost:5000` (dev fallback)

➡️ **On the LIVE host, set `PUBLIC_APP_URL=https://pulseedu.pulsekinetics.us`** (no
trailing slash). If it's unset and `REPLIT_DOMAINS` isn't the real prod domain, the
**roadmap QR and walk links will point at the wrong host** and guides/families will
hit a dead page.

> Note on secret propagation: updating a secret's value in the workspace does **not**
> always reach an already-published deployment. Set/confirm `PUBLIC_APP_URL` directly
> in the production environment's config, then restart the prod process.

No new secrets, API keys, or third-party services are required for this feature.

---

## 7. Critical invariants & gotchas (do not regress)

- **Multi-tenancy:** every query touching `tour_walks` / `tour_walk_steps` must filter
  on `school_id`. `tour_request_id` and `student_id` are **not** globally unique.
- **NO FLEID, ever:** tour leads carry no FLEID and the guide is staff, so this surface
  is clean — but if you extend it to show any student identity, render
  `local_sis_id` only, never the canonical `students.student_id`.
- **Token surface is public by design:** `/tour/walk/:token` and `/sync` have no
  session. Security rests on the opaque **base62** token (linkifier-safe — don't
  switch to base64url; trailing `-`/`_` get stripped by linkifiers → 404s) plus
  server-side validation that taps belong to the lead's eligible stops and the guide
  is a same-school active guide.
- **Offline sync race (already handled — keep it):** the flush snapshots exactly what
  it sends and only clears the dirty flag if the buffer is unchanged on return, so
  taps made mid-request aren't dropped. Don't "simplify" this to an unconditional
  clear.
- **PDFs download, not print-in-tab:** authed tour PDFs trigger a blob **download**
  (the preview/proxy iframe blocks the session cookie and `window.open().print()` can
  deadlock). Keep the download behavior.
- **Per-guide analytics need a completed walk:** the rollup only counts walks with both
  a start and an end. An empty card post-deploy is expected, not a bug.

---

## 8. Deploy procedure (recommended order)

1. **Pull/merge** the feature branch into the production build source.
2. **Set `PUBLIC_APP_URL`** in the production environment (see §6) and confirm
   `RESEND_FROM_ADDRESS` / email flags are unchanged (no change needed for this
   feature).
3. **Build** the API server and client (`pnpm run build`, or your prod build).
4. **Deploy & restart** the production API server. On boot it runs
   `ensureTourWalksSchema()` → tables created automatically. (If your start command
   skips seeding, run the SQL in §3.2 against the prod DB first.)
5. **Deploy** the client bundle.
6. Run the **smoke test** in §9.

No maintenance window required — additive, no locks on existing tables.

---

## 9. Post-deploy smoke test

Run against the **production** domain:

- [ ] **Schema present:** `\d tour_walks` and `\d tour_walk_steps` exist in the prod DB
      with the unique indexes from §3.2.
- [ ] **Bad token 404s:** open `https://pulseedu.pulsekinetics.us/tour/walk/badtoken`
      → friendly "This tour link isn't valid" screen (no crash).
- [ ] **Admin path:** open a lead in **Settings → 📋 School Tours**, confirm the
      **Live Tour Walk** section shows a QR + "Open live walk" link.
- [ ] **QR target is correct:** the QR/link host is `pulseedu.pulsekinetics.us`
      (NOT a `*.replit.dev` or `localhost` host). If wrong → fix `PUBLIC_APP_URL`.
- [ ] **Roadmap PDF:** download the Roadmap PDF for a lead → it contains a scannable
      "Start the digital tour" QR.
- [ ] **End-to-end walk:** open the walk link, confirm guide, tap a couple of stops,
      add a note, end the tour. Confirm the lead drawer shows planned-vs-actual + the
      note, and **Outcomes → Live tour walks** shows 1 walk + the guide.
- [ ] **Offline:** with dev-tools offline, tap stops → pill shows "Offline"; go back
      online → it syncs to "All changes saved".

---

## 10. Rollback plan

Because the change is additive, rollback is low-risk:

- **Code rollback:** redeploy the previous build. The new tables can remain in place
  (harmless, unused) — no need to drop them.
- **If you must remove the schema** (not recommended; destroys captured walk data):
  ```sql
  DROP TABLE IF EXISTS tour_walk_steps;
  DROP TABLE IF EXISTS tour_walks;
  ```
- No existing data is touched by this feature, so there is nothing to restore on the
  legacy tables.

---

## 11. Sign-off checklist

- [ ] Feature branch merged to prod source
- [ ] `PUBLIC_APP_URL` set correctly on LIVE
- [ ] Prod build succeeds (server + client)
- [ ] Tables exist in prod DB (auto via boot, or manual §3.2)
- [ ] Smoke test §9 passes on `pulseedu.pulsekinetics.us`
- [ ] Rollback plan understood

---

*Prepared from the PulseEDU workspace. Feature: School Tours — Live Tour Capture
(Phase 4). Migration is additive and reversible.*
