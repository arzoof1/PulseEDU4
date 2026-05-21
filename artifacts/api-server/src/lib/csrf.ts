import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { Session } from "express-session";
import { isStaffBearerAuthEnabled } from "./staffBearerAuth.js";
import {
  verifyAuthToken,
  verifyParentAuthToken,
} from "./authToken.js";

export const CSRF_HEADER = "x-csrf-token";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Mint or return the per-session CSRF secret (stored server-side only). */
export function ensureCsrfToken(session: Session): string {
  const data = session as Session & { csrfToken?: string };
  if (data.csrfToken && data.csrfToken.length > 0) {
    return data.csrfToken;
  }
  const token = randomBytes(32).toString("hex");
  data.csrfToken = token;
  return token;
}

function tokensMatch(expected: string, provided: string): boolean {
  if (expected.length !== provided.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch {
    return false;
  }
}

function hasSessionCookieAuth(req: Request): boolean {
  return !!(req.session?.staffId || req.session?.parentId);
}

/** Bearer-only requests (no session identity) are not CSRF-able via cookies. */
function isBearerOnlyWithoutSession(req: Request): boolean {
  if (hasSessionCookieAuth(req)) return false;
  const auth = req.headers.authorization;
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) return false;
  const token = auth.slice(7).trim();
  if (!token) return false;
  if (isStaffBearerAuthEnabled() && verifyAuthToken(token)) return true;
  if (verifyParentAuthToken(token)) return true;
  return false;
}

function isCsrfExempt(path: string, method: string): boolean {
  if (!UNSAFE_METHODS.has(method)) return true;

  if (path === "/api/auth/login") return true;
  if (path === "/api/auth/forgot-password") return true;
  if (path === "/api/auth/reset-password") return true;
  if (path === "/api/parent-auth/login") return true;
  if (path === "/api/parent-auth/accept-invite") return true;

  // Kiosk / queue endpoints authenticated by activation token, not session.
  if (path === "/api/kiosk/activate") return true;
  if (path.startsWith("/api/kiosk/activation/")) return true;
  if (path.startsWith("/api/kiosk/branding/")) return true;
  if (path === "/api/kiosk/hall-passes" || path === "/api/kiosk/hall-passes/return") {
    return true;
  }
  if (path.startsWith("/api/kiosk/queue/")) return true;

  return false;
}

function apiRequestPath(req: Request): string {
  const base = req.baseUrl ?? "";
  const path = req.path ?? "";
  if (base) return `${base}${path}`;
  if (path.startsWith("/api")) return path;
  return `/api${path.startsWith("/") ? path : `/${path}`}`;
}

export function csrfProtectionMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const method = req.method.toUpperCase();
  const path = apiRequestPath(req);

  if (isCsrfExempt(path, method)) {
    next();
    return;
  }

  if (!UNSAFE_METHODS.has(method)) {
    next();
    return;
  }

  if (!hasSessionCookieAuth(req)) {
    next();
    return;
  }

  if (isBearerOnlyWithoutSession(req)) {
    next();
    return;
  }

  const expected = req.session.csrfToken;
  if (!expected) {
    res.status(403).json({ error: "csrf_token_required" });
    return;
  }

  const provided = req.get(CSRF_HEADER);
  if (!provided || !tokensMatch(expected, provided)) {
    res.status(403).json({ error: "csrf_token_invalid" });
    return;
  }

  next();
}
