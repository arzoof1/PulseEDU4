# Twilio SMS — Implementation Report

**Branch:** `twilio-sms-integration` (off `main`) · **Date:** 2026-06-26

## Objective
- Add **Twilio SMS** to PulseEDU, replacing the stubbed (never-wired) AWS-SNS scaffold.
- Implement the messaging use case the **project docs** call for — the launch clarification doc's *"Text alerts for Request Pullout"* — staff-facing for launch.

## What we did
**1. Provider foundation (Twilio)**
- Added `lib/twilioClient.ts` — lazy Twilio client using **API-Key auth** (`SID + Secret` scoped to the Account SID, not the root Auth Token) + a `twilioSender()` resolver (Messaging Service SID *or* from-number).
- Rewrote `lib/sms.ts` to send via Twilio, **keeping the exact public interface** (`sendSms` / `sendSmsBatch` / `toE164`) — so the existing 3 callers needed no changes.
- Gated by `SMS_ENABLED=true` + Twilio creds + a configured sender → a **logged no-op until explicitly enabled** (safe to merge anytime).
- Added `twilio@^6` dependency; documented `TWILIO_*` / `SMS_ENABLED` in both `.env.example` files.

**2. Documented use case — Request Pullout dispatch SMS (staff)**
- Added `lib/pulloutSms.ts` → `sendPulloutDispatchSms()`: texts the **same audience** as the dispatch email (active admin / dean / MTSS coordinator / ISS teacher in the school, keyed on `staff.cell_phone`).
- Wired it into the pullout-create endpoint (`routes/pullouts.ts`) right after `sendPulloutDispatchEmail`; response now also returns `dispatchSms`.
- **Best-effort** (never throws → can't block the pullout insert) and **FLEID-safe** (body uses name / local SIS id only).

**3. Compliance / copy**
- Updated the public `/sms-policy` page (`SmsPolicyPage.tsx`) from "AWS SNS" → **Twilio** (Twilio reviewers read this page during A2P 10DLC registration).

**4. Bug fix (found in passing)**
- Fixed a **FLEID leak** in `sendPulloutDispatchEmail`: it rendered the canonical `students.student_id` (e.g. `FL000…`) in the email subject/body. Now renders `local_sis_id` instead (falls back to "a student").

## Credentials validated
- Validated the client's Twilio **Standard** API key against the live account (Messaging API → **HTTP 200**). Creds stored only in the gitignored `artifacts/api-server/.env` (never committed).

## Files
- **Added:** `lib/twilioClient.ts`, `lib/pulloutSms.ts`, `TWILIO-SMS-INTEGRATION.md` (status/runbook + phase-2 plan), `TWILIO-IMPLEMENTATION-REPORT.md` (this file).
- **Changed:** `lib/sms.ts`, `routes/pullouts.ts`, `lib/pulloutEmail.ts`, `SmsPolicyPage.tsx`, `.env.example`, `.env.production.example`, `package.json`, `pnpm-lock.yaml`.

## Verification
- `api-server` typecheck **passes** after every change (libs built first).
- Each change committed separately on the branch.

## Commits
- `f8bed9d` — Twilio provider swap (behind `SMS_ENABLED=false`)
- `538223a` — `/sms-policy` → Twilio + status/runbook doc
- `c92b486` — Request Pullout dispatch SMS → staff
- `9c47861` — FLEID fix in pullout dispatch email

## State after this work
- **Wired to SMS (auto-live once enabled), all staff-facing:** Request Pullout dispatch · overdue hall-pass alerts · school-tour lead alerts.
- **Deferred to phase 2 (parent-facing → needs documented consent + STOP/HELP webhook):** tardy alerts, pullout return-to-class, event ticket delivery.

## To go live (remaining)
- **Client must provision the sender** — a Messaging Service (`MG…`) or number — and complete **US A2P 10DLC** registration (longest lead time).
- Then set `SMS_ENABLED=true` + the sender in the server `.env`, restart, and run a live send test.
- ⚠️ Rotate any secrets shared out-of-band (Twilio key, DB password).
