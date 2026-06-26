# PulseEDU — Twilio SMS Integration (status, runbook & phase-2 plan)

**Branch:** `twilio-sms-integration` · **Date:** 2026-06-26

---

## Status: Phase 1 (foundation) complete — behind an off-switch

- **Provider swapped** from the AWS-SNS stub to **Twilio**, keeping the exact public interface (`sendSms` / `sendSmsBatch` / `toE164`) so the existing callers are unchanged.
- New [twilioClient.ts](artifacts/api-server/src/lib/twilioClient.ts) (lazy **API-key** client + sender resolver); [sms.ts](artifacts/api-server/src/lib/sms.ts) sends via Twilio.
- **Inert until `SMS_ENABLED=true` AND creds AND a sender are set** → safe to merge anytime; nothing texts by accident.
- `twilio@^6` added; `TWILIO_*` documented in both `.env.example` files. Credentials **validated** against the live account (Messaging API HTTP 200). `api-server` **typecheck passes**. The public [/sms-policy](artifacts/client/src/SmsPolicyPage.tsx) page updated SNS → Twilio (Twilio reviewers read it during registration).

## Architecture

- Single choke point: `lib/sms.ts` → `lib/twilioClient.ts`, env-driven.
- **Sender:** one shared sender for the whole platform via env — `TWILIO_MESSAGING_SERVICE_SID` (preferred; handles opt-out + number pooling) or `TWILIO_FROM_NUMBER`. Per-school numbering is a possible future enhancement (per-school column + lookup) — **not needed for launch**.
- Auth: API Key (SID + Secret) scoped to the Account SID — not the root Auth Token.

## Flows

**Wired to SMS today** (go live automatically once enabled):
- **Request Pullout dispatch alerts → staff** ([routes/pullouts.ts](artifacts/api-server/src/routes/pullouts.ts) → [lib/pulloutSms.ts](artifacts/api-server/src/lib/pulloutSms.ts)) — the documented "Text alerts for Request Pullout" use case (texts active admin/dean/MTSS/ISS staff with a cell phone, mirroring the dispatch email)
- Overdue hall-pass alerts → **staff** ([cron/inRouteOverdue.ts](artifacts/api-server/src/cron/inRouteOverdue.ts))
- School-tour lead alerts → **staff** ([routes/tours.ts](artifacts/api-server/src/routes/tours.ts))

**Parent-facing — NOT wired (phase 2):**
- Tardy → parent ([routes/tardies.ts](artifacts/api-server/src/routes/tardies.ts) currently calls a logging-only stub)
- Pullout return-to-class → parent (not wired)
- Event ticket delivery (today email + portal; SMS would be an added channel)

## Launch decision (current)

- **Scope: staff-only at launch.** Lowest compliance burden — staff alerts are operational/job-related and the staff flows are already built.
- **Parent texting deferred to phase 2** — it needs documented parent consent (a school/district responsibility under TCPA), and the number isn't provisioned yet, so there's no downside to deferring.

## How to turn SMS on (runbook)

1. In the Twilio account, provision a **sender** (Messaging Service recommended) and complete **US A2P 10DLC** (or toll-free) registration.
2. On the server `.env` (and local `.env`), set:
   - `SMS_ENABLED=true`
   - `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` (already validated)
   - **one** of `TWILIO_MESSAGING_SERVICE_SID` (`MG…`) or `TWILIO_FROM_NUMBER` (`+1…`)
3. Restart the API (`pm2 restart PulseEDU4-Backend`). Staff alert flows then send real texts.
- **Instant rollback:** set `SMS_ENABLED=false` and restart.

## What the client still owes (the long pole)

- A **sender** (Messaging Service `MG…` or a number) + **A2P 10DLC Brand + Campaign registration**: business legal name, EIN/Tax ID, address, authorized contact, sample messages, the `/sms-policy` URL, expected monthly volume. Vetting takes **days–weeks**.
- Confirmation of whether/when they want **parent texting**, and whether schools have **documented parent SMS consent** — this gates phase 2.

## Phase 2 (parent texting) — plan, when approved

- Wire tardy (replace `sendTardySmsStub` → `sendSms`), pullout-return, and optionally ticket SMS.
- **Consent + opt-out persistence:** add SMS consent + opt-out columns (on students/staff or a dedicated table); never text a number flagged opted-out.
- **Inbound STOP/HELP webhook:** Twilio → `POST /api/sms/webhook`, validated via `X-Twilio-Signature`; record opt-out/opt-in. (A Twilio Messaging Service with Advanced Opt-Out can also auto-handle STOP/HELP.)
- The `/sms-policy` consent language already covers parent/staff opt-in + STOP/HELP.

## Credentials

- Stored locally only in the **gitignored** `artifacts/api-server/.env` (never committed). On prod, add the same lines to the server `.env`.
- ⚠️ Rotate any secrets that were shared out-of-band.
