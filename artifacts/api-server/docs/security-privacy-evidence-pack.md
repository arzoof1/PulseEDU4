# PulseEDU Security & Privacy Evidence Pack

This document summarizes the security/privacy controls currently implemented in the API and how to present evidence for launch readiness.

## Scope

- API server: `artifacts/api-server`
- Client application: `artifacts/client`
- Shared schema: `lib/db`

## Control Map (Implemented)

### Authentication and Session Security

- Staff identity is resolved from HttpOnly session cookies in `artifacts/api-server/src/app.ts`.
- Session storage uses PostgreSQL (`connect-pg-simple`) in `artifacts/api-server/src/app.ts`.
- Session cookie configuration in `artifacts/api-server/src/app.ts`:
  - `httpOnly: true`
  - `sameSite: "lax"`
  - `secure: NODE_ENV === "production"`
  - bounded lifetime (`maxAge`)
- Optional bearer token support is disabled by default unless `STAFF_BEARER_AUTH_ENABLED=true` (`artifacts/api-server/src/lib/staffBearerAuth.ts`).
- Bearer tokens are revocable through token versioning (`authTokenVersion`) in `artifacts/api-server/src/lib/staffBearerAuth.ts`.

### CSRF Protections

- CSRF middleware is implemented in `artifacts/api-server/src/lib/csrf.ts`.
- Unsafe HTTP methods (`POST`, `PUT`, `PATCH`, `DELETE`) require `x-csrf-token` when session-cookie auth is used.
- CSRF token comparison uses timing-safe comparison.
- Explicit exemptions are limited to login/reset and kiosk activation flows.

### CORS and Browser Security Headers

- CORS allowlist middleware is implemented in `artifacts/api-server/src/lib/corsConfig.ts`.
- Non-allowlisted origins are rejected and logged.
- Helmet protections configured in `artifacts/api-server/src/app.ts`:
  - CSP in production
  - HSTS in production
  - strict referrer policy
  - defensive defaults for object/base/form policies

### Role-Based Access and Tenant Isolation

- Active school context is attached to `req.schoolId` in global middleware (`artifacts/api-server/src/app.ts`).
- Access helpers enforce signed-in school context (`requireSchool`) in `artifacts/api-server/src/lib/scope.ts`.
- Multi-tenant strategy is school-scoped (`school_id`) with route-level filtering and tenant-aware schemas (`lib/db/src/schema`).

### Logging and Auditability

- Request logging via `pino-http` in `artifacts/api-server/src/app.ts`.
- Request serializer strips query string from logged URL.
- Domain-specific audit tables/flows exist in schema and routes (for example interactions/safety-plan related domains).

## Privacy Posture (Operational)

- Parent and staff auth are separated (parent auth in `artifacts/api-server/src/routes/parentAuth.ts`).
- Sensitive routing should remain school-scoped (`school_id`).
- SMS and notifications should avoid direct student PII in message bodies.

## Evidence to Collect for Client Review

- Production environment screenshots/config proving:
  - HTTPS enabled
  - secure cookie behavior in prod
  - CORS origin allowlist
  - backup snapshot policy and restore capability
- Test evidence:
  - tenant boundary test (school A cannot read school B data)
  - CSRF rejection without token on unsafe methods
  - auth rejection for inactive/nonexistent users
- Operational evidence:
  - incident escalation contact list
  - credential rotation procedure
  - recovery test date and outcome

## Known Boundaries

- This evidence pack documents technical controls and operational practices.
- Legal FERPA/COPPA determinations require district/legal review.

