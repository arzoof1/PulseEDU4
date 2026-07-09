import app from "./app";
import { logger } from "./lib/logger";
import { s3BucketName, useS3ObjectStorage } from "./lib/storedObject.js";
import { bootstrapCriticalColumns, runMigrations, runSeed } from "./seedRunner";
import { recoverSuperUserPasswordOnce } from "./seed";
import {
  scheduledJobsEnabled,
  startScheduledJobs,
} from "./lib/scheduledJobs.js";

process.on("unhandledRejection", (reason, promise) => {
  logger.error({ err: reason, promise }, "Unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception — process will exit");
  setTimeout(() => process.exit(1), 100);
});

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
// Demo-data seeding is SEPARATE from schema migration. In production it is OFF
// unless SEED_DEMO_DATA=true, so RUN_BOOT_SEED=true applies schema
// (runMigrations) WITHOUT injecting demo students / schools / scores into a
// real database. Dev keeps demo on by default for a usable local database.
// When false, the boot runs runMigrations() (schema only) instead of runSeed().
const seedDemoData =
  process.env.NODE_ENV !== "test" &&
  (isProduction
    ? envFlag("SEED_DEMO_DATA")
    : process.env.SEED_DEMO_DATA !== "false");
const runScheduledJobs =
  process.env.NODE_ENV !== "test" &&
  scheduledJobsEnabled(!isProduction);

function startListening(): void {
  if (useS3ObjectStorage()) {
    logger.info(
      {
        bucket: s3BucketName(),
        region: process.env.AWS_REGION?.trim() || "us-east-1",
      },
      "object storage backend: s3",
    );
  } else {
    logger.info("object storage backend: replit/gcs");
  }

    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }

      logger.info({ port }, "Server listening");

      recoverSuperUserPasswordOnce()
        .then(() => logger.info("[boot] superuser recovery one-shot checked"))
        .catch((err) =>
          logger.error(
            { err },
            "[boot] superuser password recovery failed (early)",
          ),
        );

      if (seedInBackground) {
        const backgroundBoot = seedDemoData ? runSeed : runMigrations;
        logger.info(
          { mode: seedDemoData ? "seed+demo" : "migrate-only" },
          "Starting background DB boot (post-listen)",
        );
        backgroundBoot()
          .then(() => logger.info("Background DB boot complete"))
          .catch((err: unknown) =>
            logger.error({ err }, "Background DB boot failed"),
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
  bootstrapCriticalColumns()
    .catch((err) => {
      logger.error({ err }, "Critical bootstrap failed; exiting");
      process.exit(1);
    })
    .then(() => startListening());
} else if (!runBootSeed) {
  logger.info(
    { nodeEnv: process.env.NODE_ENV ?? "development" },
    "Boot seed disabled",
  );
  startListening();
} else {
  const boot = seedDemoData ? runSeed : runMigrations;
  boot()
    .catch((err: unknown) => logger.error({ err }, "Boot DB step failed"))
    .finally(() => startListening());
}
