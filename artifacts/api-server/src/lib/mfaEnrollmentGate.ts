// Server-authoritative MFA enrollment gate (Gate A / Section 1).
//
// When a staff member's role is REQUIRED by policy but they have not enrolled,
// the global auth middleware sets req.mfaEnrollmentRequired (see app.ts). This
// middleware then blocks every /api route EXCEPT the handful needed to enroll
// or sign out, returning 403 { error: "mfa_enrollment_required" }. That is
// what makes the policy toggle real: a required user cannot use the app until
// two-factor is set up — no indefinite grace period.
//
// Enrolled users, unauthenticated requests, and deployments with the master
// switch (STAFF_MFA_ENABLED) off never reach the blocking branch because
// req.mfaEnrollmentRequired stays false for them. This module is pure (only a
// type-only express import) so its allow/deny logic is unit-testable.

import type { Request, Response, NextFunction } from "express";

// Full /api-relative paths a not-yet-enrolled user may still reach:
//   /auth/me, /auth/logout           — bootstrap the client + sign-out escape
//   /auth/mfa/{status,setup,verify-setup} — the enrollment flow itself
// Everything else (including /auth/mfa/disable and recovery-code regeneration,
// which require an already-enrolled account) is blocked.
const ALLOWLIST: ReadonlySet<string> = new Set([
  "/api/auth/me",
  "/api/auth/logout",
  "/api/auth/mfa/status",
  "/api/auth/mfa/setup",
  "/api/auth/mfa/verify-setup",
]);

// Reconstruct the full "/api/..." path regardless of how this middleware is
// mounted (with an "/api" mount prefix, req.baseUrl carries it; if mounted
// globally, the "/api" is already in req.path).
function fullApiPath(req: Request): string {
  const base = req.baseUrl ?? "";
  const path = req.path ?? "";
  const joined = `${base}${path}`;
  if (joined.startsWith("/api")) return joined;
  return `/api${joined.startsWith("/") ? joined : `/${joined}`}`;
}

export function mfaEnrollmentGate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.mfaEnrollmentRequired) {
    next();
    return;
  }
  if (ALLOWLIST.has(fullApiPath(req))) {
    next();
    return;
  }
  res.status(403).json({ error: "mfa_enrollment_required" });
}
