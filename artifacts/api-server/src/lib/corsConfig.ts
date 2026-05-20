import cors from "cors";
import { logger } from "./logger.js";

/** Local Vite ports when CORS_ORIGINS is unset in development. */
const DEV_DEFAULT_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
];

function originFromUrl(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function buildAllowedOrigins(): Set<string> {
  const allowed = new Set<string>();

  for (const entry of (process.env.CORS_ORIGINS ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    allowed.add(originFromUrl(trimmed) ?? trimmed);
  }

  const publicApp = process.env.PUBLIC_APP_URL?.trim();
  if (publicApp) {
    const origin = originFromUrl(publicApp);
    if (origin) allowed.add(origin);
  }

  if (allowed.size === 0 && process.env.NODE_ENV !== "production") {
    for (const origin of DEV_DEFAULT_ORIGINS) {
      allowed.add(origin);
    }
  }

  return allowed;
}

const allowedOrigins = buildAllowedOrigins();

if (process.env.NODE_ENV === "production" && allowedOrigins.size === 0) {
  throw new Error(
    "Set CORS_ORIGINS and/or PUBLIC_APP_URL before starting the API in production",
  );
}

if (allowedOrigins.size > 0) {
  logger.info(
    { origins: [...allowedOrigins] },
    "CORS allowlist configured",
  );
}

export const corsMiddleware = cors({
  origin(origin, callback) {
    // curl, health checks, same-origin reverse-proxy requests
    if (!origin) {
      callback(null, true);
      return;
    }
    if (allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    logger.warn({ origin }, "CORS request blocked");
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token"],
});
