import app from "./app";
import { logger } from "./lib/logger";
import { runSeed } from "./seedRunner";
import cron from "node-cron";
import { sendDailyDigestEmail } from "./lib/dailyDigest";
import { sendWeeklyHeartbeatEmails } from "./lib/weeklyHeartbeatEmail";
import { startReminderScheduler } from "./lib/scheduler";

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

function safeCronErrorMsg(errorMsg?: string | null): string | undefined {
  if (!errorMsg) return undefined;
  return errorMsg
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .slice(0, 240);
}

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

      // Daily pullout digest. Defaults to 16:00 (4pm) school local time.
      // Override with DIGEST_CRON / DIGEST_TZ env vars. Skip in test.
      if (process.env.NODE_ENV !== "test") {
        const expr = process.env.DIGEST_CRON ?? "0 16 * * 1-5";
        const tz = process.env.DIGEST_TZ ?? "America/New_York";
        try {
          cron.schedule(
            expr,
            async () => {
              try {
                const results = await sendDailyDigestEmail(new Date());
                for (const r of results) {
                  logger.info(
                    {
                      schoolId: r.schoolId,
                      status: r.status,
                      requested: r.totals.requested,
                      backlog: r.totals.unreviewedClosedBacklog,
                      errorMsg: safeCronErrorMsg(r.errorMsg),
                    },
                    "Daily digest fired",
                  );
                }
              } catch (cronErr) {
                logger.error({ err: cronErr }, "Daily digest send failed");
              }
            },
            { timezone: tz },
          );
          logger.info({ expr, tz }, "Daily digest scheduled");
        } catch (schedErr) {
          logger.error({ err: schedErr }, "Failed to schedule daily digest");
        }

        // Weekly HeartBEAT email. Default Friday 16:00 school local time —
        // late enough that the day's events have been logged, early enough
        // that families can read it over the weekend. Override with
        // WEEKLY_HEARTBEAT_CRON / WEEKLY_HEARTBEAT_TZ. Skip in test.
        const wExpr =
          process.env.WEEKLY_HEARTBEAT_CRON ?? "0 16 * * 5";
        const wTz = process.env.WEEKLY_HEARTBEAT_TZ ?? "America/New_York";
        try {
          cron.schedule(
            wExpr,
            async () => {
              try {
                const results = await sendWeeklyHeartbeatEmails(new Date());
                const sent = results.filter((r) => r.status === "sent").length;
                const failed = results.filter(
                  (r) => r.status === "failed",
                ).length;
                const skipped = results.filter(
                  (r) => r.status === "skipped_school_disallowed",
                ).length;
                logger.info(
                  { total: results.length, sent, failed, skipped },
                  "Weekly HeartBEAT email fired",
                );
                for (const r of results) {
                  if (r.status === "failed") {
                    logger.warn(
                      {
                        parentId: r.parentId,
                        studentId: r.studentId,
                        errorMsg: safeCronErrorMsg(r.errorMsg),
                      },
                      "Weekly HeartBEAT email failed for row",
                    );
                  }
                }
              } catch (cronErr) {
                logger.error(
                  { err: cronErr },
                  "Weekly HeartBEAT email send failed",
                );
              }
            },
            { timezone: wTz },
          );
          logger.info(
            { expr: wExpr, tz: wTz },
            "Weekly HeartBEAT email scheduled",
          );
        } catch (schedErr) {
          logger.error(
            { err: schedErr },
            "Failed to schedule weekly HeartBEAT email",
          );
        }

        // Tier 2 / Tier 3 reminder scheduler. Dormant by default —
        // EMAIL_REMINDERS_ENABLED=true flips it live once the
        // hcsb.k12.fl.us sender domain is verified in Resend.
        try {
          startReminderScheduler();
        } catch (schedErr) {
          logger.error(
            { err: schedErr },
            "Failed to schedule intervention reminders",
          );
        }
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
