import app from "./app";
import { logger } from "./lib/logger";
import {
  seedIfEmpty,
  seedTenancy,
  seedMtssPlansIfEmpty,
  seedFastScoresIfEmpty,
} from "./seed";
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

// IMPORTANT: sequential, not Promise.all. seedIfEmpty() reads the
// schools table that seedTenancy() populates, so on a fresh prod
// database the order matters — running them in parallel can race
// and leave the seed with zero schools to attach data to.
(async () => {
  await seedTenancy();
  await seedIfEmpty();
  // Runs after the main seed so studentsTable is populated. Idempotent
  // per-school: skipped for any school that already has at least one plan.
  await seedMtssPlansIfEmpty();
  // Same pattern: ensure schema + skip-if-non-empty per school. Required
  // before the Teacher Roster API has anything to render.
  await seedFastScoresIfEmpty();
})()
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
                      emailTo: r.emailTo,
                      requested: r.totals.requested,
                      backlog: r.totals.unreviewedClosedBacklog,
                      errorMsg: r.errorMsg,
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
      }
    });
  });
