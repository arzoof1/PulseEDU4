// Server-authoritative forced-password-change gate.
//
// An account carrying staff.must_set_password is holding a credential someone
// ELSE chose — a roster-sync placeholder, or a temp password generated in bulk
// from the ClassLink Sync panel and handed over on paper or in a CSV. Until the
// holder replaces it, that password is effectively shared knowledge, so the
// account must not be usable for anything else.
//
// The global auth middleware sets req.passwordSetupRequired (see app.ts). This
// middleware then blocks every /api route EXCEPT the handful needed to change
// the password or sign out, returning 403 { error: "password_setup_required" }.
// Sibling of mfaEnrollmentGate and mounted right after it, so an account owing
// both an MFA enrolment and a password change is walled by MFA first.
//
// Accounts with a self-chosen password and unauthenticated requests never reach
// the blocking branch because req.passwordSetupRequired stays false. This module
// is pure (only a type-only express import) so its allow/deny logic is
// unit-testable.

import type { Request, Response, NextFunction } from "express";

// Full /api-relative paths a not-yet-reset user may still reach:
//   /auth/me, /auth/logout    — bootstrap the client + sign-out escape
//   /auth/change-password     — the one action that clears the flag
// Note this deliberately does NOT include the token-based reset routes: those
// are for signed-OUT users following an emailed link, and admitting them here
// would let a walled session wander outside the change-password flow.
const ALLOWLIST: ReadonlySet<string> = new Set([
  "/api/auth/me",
  "/api/auth/logout",
  "/api/auth/change-password",
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

export function passwordSetupGate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.passwordSetupRequired) {
    next();
    return;
  }
  if (ALLOWLIST.has(fullApiPath(req))) {
    next();
    return;
  }
  res.status(403).json({ error: "password_setup_required" });
}
