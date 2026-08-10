import type { Express } from "express";
import helmet from "helmet";
import { resolvePublicAppOrigin } from "./publicAppUrl.js";

function csvEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function frameAncestors(isProduction: boolean): string[] {
  const configured = csvEnv("SECURITY_FRAME_ANCESTORS");
  if (configured.length > 0) return configured;

  const ancestors = ["'self'"];
  ancestors.push(resolvePublicAppOrigin());

  // Replit previews are iframe-based in development; keep that opt-in and
  // production-configurable instead of using X-Frame-Options DENY/SAMEORIGIN.
  if (!isProduction) {
    ancestors.push("http://localhost:5173", "http://localhost:5174");
    const replit = process.env.REPLIT_DEV_DOMAIN?.trim();
    if (replit) ancestors.push(`https://${replit}`);
  }

  return ancestors;
}

// Default Permissions-Policy: deny the powerful browser features this app does
// not use. Successor to Feature-Policy; helmet 8 no longer emits it, so we set
// it explicitly. Override wholesale via the PERMISSIONS_POLICY env var.
export function permissionsPolicyValue(): string {
  return (
    process.env.PERMISSIONS_POLICY?.trim() ||
    "accelerometer=(), autoplay=(), camera=(), display-capture=(), " +
      "encrypted-media=(), fullscreen=(self), geolocation=(), gyroscope=(), " +
      "magnetometer=(), microphone=(), midi=(), payment=(), usb=()"
  );
}

/**
 * Apply all HTTP security-response headers (CSP, HSTS, Referrer-Policy,
 * Permissions-Policy, etc.). Extracted from app.ts so the header posture can be
 * asserted in isolation (see __tests__/securityHeaders.test.ts) without booting
 * the full app / database.
 */
export function applySecurityHeaders(app: Express, isProduction: boolean): void {
  app.use(
    helmet({
      // Development Vite/React tooling can require eval/inline assets. Keep CSP
      // strict in production and disabled locally to avoid breaking dev UX.
      contentSecurityPolicy: isProduction
        ? {
          useDefaults: true,
          directives: {
            "default-src": ["'self'"],
            "base-uri": ["'self'"],
            "object-src": ["'none'"],
            "frame-ancestors": frameAncestors(isProduction),
            "form-action": ["'self'"],
            "img-src": ["'self'", "data:", "blob:", "https:"],
            "media-src": ["'self'", "data:", "blob:", "https:"],
            "connect-src": ["'self'", ...csvEnv("CSP_CONNECT_SRC")],
            "script-src": ["'self'"],
            "style-src": ["'self'", "'unsafe-inline'"],
          },
        }
        : false,
      crossOriginEmbedderPolicy: false,
      // frame-ancestors is more precise than X-Frame-Options for this app's
      // preview/deployment needs; avoid emitting a conflicting legacy header.
      frameguard: false,
      hsts: isProduction
        ? {
          // 1 year, eligible for the HSTS preload list (maxAge >= 1y +
          // includeSubDomains + preload are the browser preload requirements).
          maxAge: 31536000,
          includeSubDomains: true,
          preload: true,
        }
        : false,
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    }),
  );

  const permissionsPolicy = permissionsPolicyValue();
  app.use((_req, res, next) => {
    res.setHeader("Permissions-Policy", permissionsPolicy);
    next();
  });
}
