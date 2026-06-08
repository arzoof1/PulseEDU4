import cors from "cors";
import { resolveCorsOrigins } from "./publicAppUrl.js";
import { logger } from "./logger.js";

const allowedOrigins = resolveCorsOrigins();

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
