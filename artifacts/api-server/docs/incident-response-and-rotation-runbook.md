# Incident Response and Credential Rotation Runbook

This runbook is a practical launch-time procedure for security/privacy incidents.

## 1) Severity Levels

- **SEV-1 (Critical):** active data exposure, auth bypass, production outage affecting security controls.
- **SEV-2 (High):** suspicious access pattern, repeated auth failures, partial service degradation with security impact.
- **SEV-3 (Moderate):** misconfiguration risk, single-user impact, no confirmed exposure.

## 2) First 30 Minutes (Containment)

1. Assign incident commander (IC) and recorder.
2. Freeze non-essential deployments.
3. Confirm scope:
   - affected environment(s)
   - affected tenant(s)
   - affected endpoints/workflows
4. Apply immediate containment:
   - disable risky feature flag if available
   - block suspicious source at edge/proxy if applicable
   - force logout path if auth compromise is suspected

## 3) Technical Checks

- Pull recent API logs around first alert timestamp.
- Check auth/session anomalies.
- Verify tenant isolation was not bypassed.
- Verify no sensitive payloads were emitted to logs.

## 4) Credentials to Rotate (Priority Order)

1. `SESSION_SECRET`
2. database credentials (`DATABASE_URL` user/password)
3. notification provider keys (for example Resend/SNS)
4. integration secrets (SIS/ClassLink and other third-party secrets)

Rotation notes:
- Rotate in non-breaking sequence where possible.
- Validate service health after each rotation.
- Record timestamp, owner, and validation result.

## 5) Communication Protocol

- Internal update cadence:
  - SEV-1: every 30 minutes
  - SEV-2: hourly
- Maintain one source-of-truth incident document.
- External/client communication should include:
  - what happened
  - affected scope
  - mitigation completed
  - next update ETA

## 6) Recovery and Validation

- Restore normal traffic only after:
  - root cause isolated
  - mitigation tested
  - monitoring confirms stability
- Validate critical paths:
  - login (staff + parent, if applicable)
  - role-restricted endpoints
  - tenant boundary checks
  - key notification workflows

## 7) Post-Incident Actions (Within 48 Hours)

- Publish postmortem:
  - timeline
  - root cause
  - blast radius
  - corrective actions with owners/dates
- Add regression tests/checks for discovered failure mode.
- Update this runbook and the verification checklist.

## 8) Ownership Template (Fill Before Launch)

- Incident commander primary:
- Incident commander backup:
- DevOps on-call:
- API owner:
- Client communication owner:
- Legal/compliance contact:

