import app from "./app";
import { logger } from "./lib/logger";
import { seedIfEmpty } from "./seed";
import cron from "node-cron";
import { sendDailyDigestEmail } from "./lib/dailyDigest";

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

seedIfEmpty()
  .catch((err) => logger.error({ err }, "Seed failed"))
  .finally(() => {
    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }

      logger.info({ port }, "Server listening");

      // Daily pullout digest. Defaults to 16:00 (4pm) school local time.
      // Override with DIGEST_CRON / DIGEST_TZ env vars. Skip in test.
      // TEMP (launch test window): set DIGEST_DISABLED=1 to skip scheduling.
      // Remove the env-var guard once internal testing wraps up.
      if (
        process.env.NODE_ENV !== "test" &&
        process.env.DIGEST_DISABLED !== "1"
      ) {
        const expr = process.env.DIGEST_CRON ?? "0 16 * * 1-5";
        const tz = process.env.DIGEST_TZ ?? "America/New_York";
        try {
          cron.schedule(
            expr,
            async () => {
              try {
                const r = await sendDailyDigestEmail(new Date());
                logger.info(
                  {
                    status: r.status,
                    emailTo: r.emailTo,
                    requested: r.totals.requested,
                    backlog: r.totals.unreviewedClosedBacklog,
                  },
                  "Daily digest fired",
                );
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
      }
    });
  });
