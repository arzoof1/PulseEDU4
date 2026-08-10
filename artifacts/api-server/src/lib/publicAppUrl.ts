/** Canonical production site (browser origin). Used when env is unset in production. */
export const DEFAULT_PUBLIC_APP_URL = "https://pulseedu.pulsekinetics.us";

/** Browser origin for links in emails, CORS, and CSP (no trailing slash). */
export function resolvePublicAppOrigin(): string {
  const explicit = process.env.PUBLIC_APP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const replit = process.env.REPLIT_DEV_DOMAIN?.trim();
  if (replit) return `https://${replit}`;

  if (process.env.NODE_ENV === "production") {
    return DEFAULT_PUBLIC_APP_URL;
  }

  return "http://localhost:5173";
}

/** Origins allowed for credentialed cross-origin API calls. */
export function resolveCorsOrigins(): Set<string> {
  const allowed = new Set<string>();

  for (const entry of (process.env.CORS_ORIGINS ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      allowed.add(new URL(trimmed).origin);
    } catch {
      allowed.add(trimmed);
    }
  }

  const publicOrigin = resolvePublicAppOrigin();
  if (publicOrigin) allowed.add(publicOrigin);

  if (process.env.NODE_ENV !== "production") {
    for (const origin of [
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:5175",
      "http://127.0.0.1:5173",
      "http://127.0.0.1:5174",
    ]) {
      allowed.add(origin);
    }
  }

  return allowed;
}
