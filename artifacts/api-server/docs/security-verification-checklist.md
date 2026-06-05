# Security Verification Checklist (Pre-Launch)

Use this checklist to gather objective evidence without changing product behavior.

## 1) Transport and Host Security

- [ ] Confirm production is served over HTTPS.
- [ ] Confirm `NODE_ENV=production` on API host.
- [ ] Confirm HSTS header is present in production responses.
- [ ] Confirm no mixed-content browser warnings on login/dashboard.

Evidence:
- Screenshot of response headers from production.
- Deployment config excerpt (redacted).

## 2) Session and Cookie Security

- [ ] Confirm session cookie is `HttpOnly`.
- [ ] Confirm session cookie is `Secure` in production.
- [ ] Confirm `SameSite=Lax` in production.
- [ ] Confirm sessions expire according to configured `maxAge`.

Evidence:
- Browser devtools cookie screenshot (redacted).
- API response trace with `Set-Cookie`.

## 3) CSRF Controls

- [ ] Send unsafe request without CSRF header while authenticated by session cookie; verify 403.
- [ ] Send unsafe request with valid CSRF header; verify success for authorized role.
- [ ] Verify exempt endpoints (login/password reset) still function.

Evidence:
- Request/response captures for pass/fail cases.

## 4) CORS Enforcement

- [ ] Call API from an allowlisted origin; verify success.
- [ ] Call API from a non-allowlisted origin; verify blocked behavior.
- [ ] Confirm blocked origin warning appears in server logs.

Evidence:
- Capture of blocked preflight/request and API log entry.

## 5) Tenant Isolation (Most Critical)

- [ ] Create or identify two schools in same environment.
- [ ] As school A staff, attempt to fetch known school B data by ID.
- [ ] Verify school B data is not returned (404/403/empty according to endpoint contract).
- [ ] Repeat for at least: student-facing endpoint, pullout-related endpoint, and one admin list endpoint.

Evidence:
- API request/response transcript with actor and school context.
- Short test summary with pass/fail.

## 6) RBAC / Privilege Checks

- [ ] Validate restricted admin endpoints reject non-admin staff.
- [ ] Validate core team endpoints enforce expected role flags.
- [ ] Validate inactive staff cannot authenticate successfully.

Evidence:
- Endpoint matrix with role and expected response code.

## 7) Logging and Auditability

- [ ] Confirm request logs include method/path/status and exclude query secrets.
- [ ] Confirm major admin/security-relevant actions leave traceable records.
- [ ] Confirm log retention destination and retention duration with DevOps.

Evidence:
- Example structured log lines (redacted).
- Retention policy note from infrastructure owner.

## 8) Backup and Recovery (Operational)

- [ ] Confirm DB backup schedule exists.
- [ ] Confirm restore procedure is documented.
- [ ] Execute one restore drill in non-prod or approved environment.
- [ ] Record RTO/RPO observations.

Evidence:
- Backup policy screenshot.
- Restore drill date/time/outcome.

## 9) Secrets and Key Rotation

- [ ] Ensure secrets are in env/secret manager (not committed in repo).
- [ ] Rotate one non-critical key in test environment to validate runbook.
- [ ] Confirm owner and rotation interval for each critical secret.

Evidence:
- Secret inventory with owner and last-rotated date.

## 10) Client-Ready Summary

- [ ] Compile all evidence into one launch packet.
- [ ] Mark each area: Complete / Partial / Pending.
- [ ] Add known limitations and compensating controls.

