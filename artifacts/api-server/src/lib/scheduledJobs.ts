import cron from "node-cron";
import { pool } from "@workspace/db";
import { sendDailyDigestEmail } from "./dailyDigest.js";
import { logger } from "./logger.js";
import { startReminderScheduler } from "./scheduler.js";
import { sendWeeklyHeartbeatEmails } from "./weeklyHeartbeatEmail.js";

const DAILY_DIGEST_LOCK_KEY = 47001;
const WEEKLY_HEARTBEAT_LOCK_KEY = 47002;

let started = false;

export function scheduledJobsEnabled(defaultEnabled: boolean): boolean {
  const raw = process.env.RUN_SCHEDULED_JOBS?.trim().toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return defaultEnabled;
}

function safeCronErrorMsg(errorMsg?: string | null): string | undefined {
  if (!errorMsg) return undefined;
  return errorMsg
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .slice(0, 240);
}

async function withAdvisoryLock<T>(
  key: number,
  jobName: string,
  run: () => Promise<T>,
): Promise<T | null> {
  const lock = await pool.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock($1) AS locked",
    [key],
  );
  if (!lock.rows[0]?.locked) {
    logger.warn({ jobName }, "scheduled job skipped because another runner holds the lock");
    return null;
  }

  try {
    return await run();
  } finally {
    await pool.query("SELECT pg_advisory_unlock($1)", [key]).catch((err: unknown) => {
      logger.error({ err, jobName }, "failed to release scheduled job lock");
    });
  }
}

async function runDailyDigestJob(): Promise<void> {
  await withAdvisoryLock(DAILY_DIGEST_LOCK_KEY, "daily-digest", async () => {
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
  });
}

async function runWeeklyHeartbeatJob(): Promise<void> {
  await withAdvisoryLock(WEEKLY_HEARTBEAT_LOCK_KEY, "weekly-heartbeat", async () => {
    const results = await sendWeeklyHeartbeatEmails(new Date());
    const sent = results.filter((r) => r.status === "sent").length;
    const failed = results.filter((r) => r.status === "failed").length;
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
  });
}

export function startScheduledJobs(source: "api" | "worker"): void {
  if (started) return;
  started = true;

  const expr = process.env.DIGEST_CRON ?? "0 16 * * 1-5";
  const tz = process.env.DIGEST_TZ ?? "America/New_York";
  try {
    cron.schedule(
      expr,
      () => {
        runDailyDigestJob().catch((cronErr: unknown) => {
          logger.error({ err: cronErr }, "Daily digest send failed");
        });
      },
      { timezone: tz },
    );
    logger.info({ expr, tz, source }, "Daily digest scheduled");
  } catch (schedErr) {
    logger.error({ err: schedErr }, "Failed to schedule daily digest");
  }

  const wExpr = process.env.WEEKLY_HEARTBEAT_CRON ?? "0 16 * * 5";
  const wTz = process.env.WEEKLY_HEARTBEAT_TZ ?? "America/New_York";
  try {
    cron.schedule(
      wExpr,
      () => {
        runWeeklyHeartbeatJob().catch((cronErr: unknown) => {
          logger.error({ err: cronErr }, "Weekly HeartBEAT email send failed");
        });
      },
      { timezone: wTz },
    );
    logger.info({ expr: wExpr, tz: wTz, source }, "Weekly HeartBEAT email scheduled");
  } catch (schedErr) {
    logger.error({ err: schedErr }, "Failed to schedule weekly HeartBEAT email");
  }

  try {
    startReminderScheduler();
  } catch (schedErr) {
    logger.error({ err: schedErr }, "Failed to schedule intervention reminders");
  }
}
