import app from "./app";
import { logger } from "./lib/logger";
import {
  seedIfEmpty,
  seedTenancy,
  seedMtssPlansIfEmpty,
  seedFastScoresIfEmpty,
  seedHousesIfEmpty,
  seedIreadyAndSciIfEmpty,
  seedEngagementEventsIfEmpty,
} from "./seed";
import cron from "node-cron";
import { sendDailyDigestEmail } from "./lib/dailyDigest";
import { sendWeeklyHeartbeatEmails } from "./lib/weeklyHeartbeatEmail";

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
  // iReady AP1/AP2/AP3 (K-8) + SCI Benchmark 1/2/3 (G6-12) demo data
  // landed in the generic assessments table. Per-school + per-source
  // skip-if-non-empty so re-runs are a near-noop.
  await seedIreadyAndSciIfEmpty();
  // Houses (PBIS teams) + round-robin assign students. Idempotent per school.
  await seedHousesIfEmpty();
  // Demo engagement events (hall passes, tardies, ISS, pullouts) over the
  // last 60 days so the new Engagement dashboard renders something on first
  // launch. Skip-if-already-populated per school + per table.
  await seedEngagementEventsIfEmpty();
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
                        email: r.email,
                        errorMsg: r.errorMsg,
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
      }
    });
  });
