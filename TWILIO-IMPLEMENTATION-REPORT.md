Twilio SMS Implementation Report

Branch: twilio-sms-integration (off main). Date: 2026-06-26.


What we did

Provider foundation (Twilio)
- Added lib/twilioClient.ts: a lazy Twilio client using API-Key auth (SID + Secret scoped to the Account SID, not the root Auth Token), plus a twilioSender() resolver (Messaging Service SID or from-number).
- Rewrote lib/sms.ts to send via Twilio while keeping the exact public interface (sendSms, sendSmsBatch, toE164), so the existing 3 callers needed no changes.
- Gated by SMS_ENABLED=true plus Twilio creds plus a configured sender, so it is a logged no-op until explicitly enabled (safe to merge anytime).
- Added the twilio (v6) dependency; documented the TWILIO_ vars and SMS_ENABLED in both .env.example files.

Documented use case: Request Pullout dispatch SMS to staff
- Added lib/pulloutSms.ts (sendPulloutDispatchSms): texts the same audience as the dispatch email (active admin, dean, MTSS coordinator, ISS teacher in the school, keyed on staff.cell_phone).
- Wired it into the pullout-create endpoint (routes/pullouts.ts) right after sendPulloutDispatchEmail; the response now also returns dispatchSms.
- Best-effort (never throws, so it cannot block the pullout insert) and FLEID-safe (body uses name and local SIS id only).

Compliance copy
- Updated the public /sms-policy page (SmsPolicyPage.tsx) from AWS SNS to Twilio, because Twilio reviewers read this page during A2P 10DLC registration.

Bug fix found in passing
- Fixed a FLEID leak in sendPulloutDispatchEmail: it rendered the canonical students.student_id (e.g. FL000...) in the email subject and body. It now renders local_sis_id instead, falling back to "a student".

Credentials validated
- Validated the client's Twilio Standard API key against the live account (Messaging API returned HTTP 200). Creds are stored only in the gitignored artifacts/api-server/.env and are never committed.


Files added
- lib/twilioClient.ts
- lib/pulloutSms.ts
- TWILIO-SMS-INTEGRATION.md (status, runbook, phase-2 plan)
- TWILIO-IMPLEMENTATION-REPORT.md (this file)

Files changed
- lib/sms.ts
- routes/pullouts.ts
- lib/pulloutEmail.ts
- SmsPolicyPage.tsx
- .env.example and .env.production.example
- package.json and pnpm-lock.yaml


Verification
- api-server typecheck passes after every change (libs built first).
- Each change committed separately on the branch.

Commits
- f8bed9d: Twilio provider swap (behind SMS_ENABLED=false)
- 538223a: /sms-policy to Twilio plus status/runbook doc
- c92b486: Request Pullout dispatch SMS to staff
- 9c47861: FLEID fix in pullout dispatch email


State after this work
- Wired to SMS (auto-live once enabled), all staff-facing: Request Pullout dispatch, overdue hall-pass alerts, school-tour lead alerts.
- Deferred to phase 2 (parent-facing, needs documented consent plus a STOP/HELP webhook): tardy alerts, pullout return-to-class, event ticket delivery.


To go live (remaining)
- Client must provision the sender (a Messaging Service or a number) and complete US A2P 10DLC registration (the longest lead-time item).
- Then set SMS_ENABLED=true plus the sender in the server .env, restart, and run a live send test.
- Rotate any secrets shared out-of-band (Twilio key, DB password).
