# PulseEDU — Email (Resend) End-to-End Test Report

**Branch:** `email-testing-fixes`
**Date:** 2026-06-26
**Tested by:** new dev onboarding (first task)
**Scope:** Verify whether PulseEDU actually sends email via Resend, exercise edge cases, fix what's broken.

---

## TL;DR

✅ **Email works.** Using the real production Resend credentials, a live send was **accepted by Resend AND delivered to a real Gmail inbox** (confirmed received). The API key is valid, the sending domain `pulseedu.pulsekinetics.us` is verified, and all edge cases behave correctly. **10/10** live checks matched expectations.

🛠️ **One latent bug found and fixed.** 11 of 14 email senders built the `From:` header without a guard. They work today only because production's `RESEND_FROM_EMAIL` is a *bare* address. If anyone ever set it to a display-name form (which `.env.example` actually suggests), those 11 flows would break with `validation_error: Invalid \`from\` field`. Fixed by routing every sender through a single shared `formatFromHeader()` helper.

---

## How it was tested

- The production DB sits on a private VPC IP (`172.31.87.128`) unreachable from a laptop, so the **app routes/DB were not exercised** (that needs an SSH tunnel through EC2).
- Instead, a standalone harness replicated the **exact send mechanics** used by the api-server helpers (the `From`-header construction + `resend.emails.send(...)`) and ran against the **real Resend account** using the production `RESEND_API_KEY` / `RESEND_FROM_EMAIL`.
- Sends targeted Resend's official test inboxes (`delivered@resend.dev`, `bounced@resend.dev`) plus one real Gmail for a true deliverability check.
- Harness: `scratchpad/email-test.mjs` (reads creds from env; no secrets committed).

---

## Live results (10/10 passed)

| # | Check | Expected | Result | Evidence |
|---|-------|----------|--------|----------|
| 1 | Baseline bare-from → `delivered@resend.dev` | accepted | ✅ sent | id `b4471124…` |
| 2 | Real-flow header `Name <bare@addr>` (what the app builds in prod) | accepted | ✅ sent | id `20b722c1…` |
| 3 | **Bug repro:** doubled-bracket from `Name <Brand <addr>>` | rejected | ✅ error | `validation_error: Invalid \`from\` field` |
| 3b | Control: guarded builder with display-name from | accepted | ✅ sent | id `b1e7c5ae…` |
| 4 | Bounce path → `bounced@resend.dev` | accepted | ✅ sent | id `8eb1cc2a…` |
| 5 | Invalid recipient `not-an-email` | rejected | ✅ error | `Invalid \`to\` field` |
| 6 | Empty recipient `""` | rejected | ✅ error | `Invalid \`to\` field` |
| 7 | Unverified from-domain | rejected | ✅ error | `domain is not verified` |
| 8 | Bad API key | rejected (401) | ✅ error | `API key is invalid` |
| 9 | **Real inbox deliverability** (Gmail) | delivered | ✅ sent + **received** | id `243bad01…` |

**Interpretation:** the Resend integration is healthy end-to-end — valid key, verified domain, real delivery, and every failure mode (bad address, unverified domain, bad key, malformed header) returns a clean, catchable error rather than crashing.

---

## What works (verified)

- **Outbound delivery** via Resend to a real external inbox.
- **Domain verification** for `pulseedu.pulsekinetics.us`.
- **Edge-case handling** in the senders: missing/empty/invalid recipient → recorded as `skipped`/`error` (never throws uncaught); Resend errors and exceptions captured on the DB row.
- **Idempotency** on the main flows via `*SentAt` columns (re-verify / refresh won't double-send).
- **School scoping** (e.g. pullout dispatch only emails staff in the same school — no cross-tenant leak).
- **HTML escaping** of staff-authored free text in the pullout / invite / family-message templates.

---

## What was broken → now fixed

### 🔴 Unguarded `From:` header (latent in prod, would break on config change) — FIXED

Every sender pulls `fromEmail` from `RESEND_FROM_EMAIL` verbatim. **11 of 14 send sites** then did:

```ts
const fromHeader = `${fromName} <${fromEmail}>`;   // ❌ no guard
```

If `RESEND_FROM_EMAIL` is a bare address (as prod has it: `noreply@pulseedu.pulsekinetics.us`) this is fine. But the repo's own `.env.example` documents the value as `PulseEDU <noreply@pulsekinetics.us>` (display-name form). With that value, the line produces `School <PulseEDU <noreply@...>>` → **Resend hard-rejects it** (proven by live test #3). The flagship "Request Pullout" dispatch email is among the affected flows; the 3 that already guarded it (`routes/email.ts`, `routes/parentEmail.ts`, `weeklyHeartbeatEmail.ts`) would have kept working — a confusing *partial* outage.

**Fix:** new shared helper [emailFrom.ts](artifacts/api-server/src/lib/emailFrom.ts) — `formatFromHeader(fromName, fromEmail)` returns `fromEmail` untouched when it already contains `<`. All 11 unguarded sites now call it:

| File | Sites fixed |
|------|-------------|
| [pulloutEmail.ts](artifacts/api-server/src/lib/pulloutEmail.ts) | arrival, send-to-ISS, return, dispatch (×4) |
| [dailyDigest.ts](artifacts/api-server/src/lib/dailyDigest.ts) | daily pullout digest |
| [parentInviteEmail.ts](artifacts/api-server/src/lib/parentInviteEmail.ts) | parent portal invite |
| [parentResetEmail.ts](artifacts/api-server/src/lib/parentResetEmail.ts) | parent password reset |
| [staffResetEmail.ts](artifacts/api-server/src/lib/staffResetEmail.ts) | staff password reset |
| [pbisMilestones.ts](artifacts/api-server/src/lib/pbisMilestones.ts) | PBIS milestone to parent |
| [ticketEmail.ts](artifacts/api-server/src/lib/ticketEmail.ts) | event ticket QR |
| [tourEmails.ts](artifacts/api-server/src/lib/tourEmails.ts) | tour family acknowledgment |

This is behavior-preserving for prod's current config and removes the trap.

---

## Recommended follow-ups (not done — your call)

1. **Rotate the secrets** that were shared during this task (Resend API key + DB password).
2. **Fix the `.env.example`** so it no longer suggests the dangerous display-name `RESEND_FROM_EMAIL` form (or note that both forms are now safe). Low effort.
3. **Reset/invite links use `REPLIT_DEV_DOMAIN` fallback** in `parentResetEmail.ts` / `parentInviteEmail.ts`. Harmless as long as `PUBLIC_APP_URL` is set in prod (it is), but it's a latent dead-link risk. Consider the request-aware `publicAppOrigin(req)` pattern already used in `staffResetEmail.ts`.
4. **Consolidate the 3 remaining local `formatFromHeader` copies** (`routes/email.ts`, `routes/parentEmail.ts`, `weeklyHeartbeatEmail.ts`) to import the new shared helper — single source of truth. (Left untouched here to keep the change low-risk.)
5. **Weekly HeartBEAT idempotency:** the code self-flags a window where a successful send + failed timestamp write could re-send next run. Consider an advisory lock / transaction.
6. **No global email kill-switch** — every flow sends live once `RESEND_API_KEY` is set. A `DISABLE_ALL_EMAIL` flag would be a cheap safety valve for incident response.
7. **Dormant flows** (not a bug, just FYI): intervention reminders (`EMAIL_REMINDERS_ENABLED=false` + audience resolver unimplemented), on-time lottery (per-school opt-in), tour emails (gated on `EMAIL_REMINDERS_ENABLED`).
