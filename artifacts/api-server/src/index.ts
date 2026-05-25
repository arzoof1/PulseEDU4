import app from "./app";
import { logger } from "./lib/logger";
import { runSeed } from "./seedRunner";
import {
  scheduledJobsEnabled,
  startScheduledJobs,
} from "./lib/scheduledJobs.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

function envFlag(name: string): boolean {
  return process.env[name]?.toLowerCase() === "true";
}

const isProduction = process.env.NODE_ENV === "production";
const runBootSeed =
  process.env.NODE_ENV !== "test" &&
  (isProduction
    ? envFlag("RUN_BOOT_SEED")
    : process.env.RUN_BOOT_SEED !== "false");
// Production boot seed is opt-in only. If explicitly enabled, keep it in the
// background so the platform health check sees an open port quickly. Local dev
// keeps the historical seed-first behavior unless RUN_BOOT_SEED=false.
const seedInBackground = isProduction && runBootSeed;
const runScheduledJobs =
  process.env.NODE_ENV !== "test" &&
  scheduledJobsEnabled(!isProduction);

function startListening(): void {
    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }

      logger.info({ port }, "Server listening");

      if (seedInBackground) {
        logger.info("Starting seed in background (post-listen)");
        runSeed()
          .then(() => logger.info("Background seed complete"))
          .catch((err: unknown) =>
            logger.error({ err }, "Background seed failed"),
          );
      }

      if (runScheduledJobs) {
        startScheduledJobs("api");
      } else {
        logger.info(
          { nodeEnv: process.env.NODE_ENV ?? "development" },
          "Scheduled jobs disabled in API process",
        );
      }
    });
}

// Boot. Production starts the API without mutating demo data unless
// RUN_BOOT_SEED=true is explicitly configured. Development keeps the original
// seed-first behavior by default for fresh local databases.
if (seedInBackground) {
  startListening();
} else if (!runBootSeed) {
  logger.info(
    { nodeEnv: process.env.NODE_ENV ?? "development" },
    "Boot seed disabled",
  );
  startListening();
} else {
  runSeed()
    .catch((err: unknown) => logger.error({ err }, "Seed failed"))
    .finally(() => startListening());
}
