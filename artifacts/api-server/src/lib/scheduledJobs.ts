import cron from "node-cron";
import { pool } from "@workspace/db";
import { runAstYearEndLapse } from "../cron/astLapse.js";
import {
  isDemoHeartbeatEnabled,
  runDemoHeartbeatReset,
  runDemoHeartbeatTick,
} from "../cron/demoHeartbeat.js";
import { runFeatureLicensingOverrideSweep } from "../cron/featureLicensingOverrideSweep.js";
import { runInRouteOverdueSweep } from "../cron/inRouteOverdue.js";
import { runPickupEndOfDayAutoClear } from "../cron/pickupEndOfDayAutoClear.js";
import { runPulseDnaVideoPurge } from "../cron/pulseDnaVideoPurge.js";
import { sendDailyDigestEmail } from "./dailyDigest.js";
import { runDueLotteryDraws } from "./onTimeLottery.js";
import { logger } from "./logger.js";
import { runScheduledSisRosterSyncs } from "./sisRosterSync.js";
import { startReminderScheduler } from "./scheduler.js";
import { recoverStuckPulseDnaVideos } from "./videoTranscode.js";
import { sendWeeklyHeartbeatEmails } from "./weeklyHeartbeatEmail.js";

const DAILY_DIGEST_LOCK_KEY = 47001;
const WEEKLY_HEARTBEAT_LOCK_KEY = 47002;
const LOTTERY_LOCK_KEY = 47003;
const SIS_ROSTER_SYNC_LOCK_KEY = 47004;

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

export function sisRosterSyncCronEnabled(): boolean {
  const raw = process.env.SIS_ROSTER_SYNC_ENABLED?.trim().toLowerCase();
  if (raw === "false") return false;
  if (raw === "true") return true;
  return true;
}

async function runNightlySisRosterSyncJob(): Promise<void> {
  if (!sisRosterSyncCronEnabled()) {
    logger.info(
      "Nightly SIS roster sync skipped (SIS_ROSTER_SYNC_ENABLED=false)",
    );
    return;
  }

  await withAdvisoryLock(SIS_ROSTER_SYNC_LOCK_KEY, "sis-roster-sync", async () => {
    const results = await runScheduledSisRosterSyncs();
    const ok = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    logger.info(
      { total: results.length, ok, failed },
      "Nightly SIS roster sync finished",
    );
    for (const r of results) {
      if (!r.ok) {
        logger.warn(
          {
            integrationId: r.integrationId,
            schoolId: r.schoolId,
            schoolName: r.schoolName,
            status: r.status,
            message: safeCronErrorMsg(r.message),
            errorCount: r.errorCount,
          },
          "Nightly SIS roster sync failed for integration",
        );
      } else {
        logger.info(
          {
            integrationId: r.integrationId,
            schoolId: r.schoolId,
            schoolName: r.schoolName,
            status: r.status,
            counts: r.counts,
          },
          "Nightly SIS roster sync succeeded for integration",
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

  const lotteryExpr = process.env.ON_TIME_LOTTERY_CRON ?? "*/5 12-22 * * 1-5";
  const lotteryTz = process.env.ON_TIME_LOTTERY_TZ ?? "America/New_York";
  try {
    cron.schedule(
      lotteryExpr,
      () => {
        withAdvisoryLock(LOTTERY_LOCK_KEY, "on-time-lottery", async () => {
          const results = await runDueLotteryDraws(new Date());
          for (const r of results) {
            if (r.status === "revealed") {
              logger.info(
                {
                  schoolId: r.schoolId,
                  periodNumber: r.periodNumber,
                  teacherName: r.teacherName,
                  winnerCount: r.winnerCount,
                  bonusPoints: r.bonusPoints,
                  emailedTo: r.emailedTo,
                },
                "Tardy Lottery draw revealed",
              );
            }
          }
        }).catch((cronErr: unknown) => {
          logger.error({ err: cronErr }, "Tardy Lottery draw run failed");
        });
      },
      { timezone: lotteryTz },
    );
    logger.info({ expr: lotteryExpr, tz: lotteryTz, source }, "Tardy Lottery draw scheduled");
  } catch (schedErr) {
    logger.error({ err: schedErr }, "Failed to schedule Tardy Lottery draw");
  }

  const sisExpr = process.env.SIS_ROSTER_SYNC_CRON ?? "0 2 * * *";
  const sisTz = process.env.SIS_ROSTER_SYNC_TZ ?? "America/New_York";
  try {
    cron.schedule(
      sisExpr,
      () => {
        runNightlySisRosterSyncJob().catch((cronErr: unknown) => {
          logger.error({ err: cronErr }, "Nightly SIS roster sync failed");
        });
      },
      { timezone: sisTz },
    );
    logger.info(
      { expr: sisExpr, tz: sisTz, enabled: sisRosterSyncCronEnabled(), source },
      "Nightly SIS roster sync scheduled",
    );
  } catch (schedErr) {
    logger.error({ err: schedErr }, "Failed to schedule nightly SIS roster sync");
  }

  try {
    startReminderScheduler();
  } catch (schedErr) {
    logger.error({ err: schedErr }, "Failed to schedule intervention reminders");
  }

  const astLapseExpr = process.env.AST_LAPSE_CRON ?? "5 0 1 7 *";
  const astLapseTz = process.env.AST_LAPSE_TZ ?? "America/New_York";
  try {
    cron.schedule(
      astLapseExpr,
      () => {
        runAstYearEndLapse(new Date()).catch((cronErr: unknown) => {
          logger.error({ err: cronErr }, "AST year-end lapse failed");
        });
      },
      { timezone: astLapseTz },
    );
    logger.info({ expr: astLapseExpr, tz: astLapseTz, source }, "AST year-end lapse scheduled");
  } catch (schedErr) {
    logger.error({ err: schedErr }, "Failed to schedule AST year-end lapse");
  }

  const sweepExpr = process.env.FEATURE_LICENSING_SWEEP_CRON ?? "15 2 * * *";
  try {
    cron.schedule(sweepExpr, () => {
      runFeatureLicensingOverrideSweep(new Date()).catch((cronErr: unknown) => {
        logger.error({ err: cronErr }, "Feature licensing override sweep failed");
      });
    });
    logger.info({ expr: sweepExpr, source }, "Feature licensing override sweep scheduled");
  } catch (schedErr) {
    logger.error({ err: schedErr }, "Failed to schedule feature licensing override sweep");
  }

  const pickupClearExpr = process.env.PICKUP_AUTOCLEAR_CRON ?? "0 22 * * *";
  const pickupClearTz = process.env.PICKUP_AUTOCLEAR_TZ ?? "America/New_York";
  try {
    cron.schedule(
      pickupClearExpr,
      () => {
        runPickupEndOfDayAutoClear(new Date(), pickupClearTz).catch(
          (cronErr: unknown) => {
            logger.error({ err: cronErr }, "Pickup end-of-day auto-clear failed");
          },
        );
      },
      { timezone: pickupClearTz },
    );
    logger.info(
      { expr: pickupClearExpr, tz: pickupClearTz, source },
      "Pickup end-of-day auto-clear scheduled",
    );
  } catch (schedErr) {
    logger.error({ err: schedErr }, "Failed to schedule pickup end-of-day auto-clear");
  }

  const overdueExpr = process.env.IN_ROUTE_OVERDUE_CRON ?? "* * * * *";
  try {
    cron.schedule(overdueExpr, () => {
      runInRouteOverdueSweep(new Date()).catch((cronErr: unknown) => {
        logger.error({ err: cronErr }, "In-route overdue sweep failed");
      });
    });
    logger.info({ expr: overdueExpr, source }, "In-route overdue sweep scheduled");
  } catch (schedErr) {
    logger.error({ err: schedErr }, "Failed to schedule in-route overdue sweep");
  }

  const pulseVideoPurgeExpr = process.env.PULSEDNA_PURGE_CRON ?? "30 3 * * *";
  const pulseVideoPurgeTz = process.env.PULSEDNA_PURGE_TZ ?? "America/New_York";
  try {
    cron.schedule(
      pulseVideoPurgeExpr,
      () => {
        runPulseDnaVideoPurge(new Date()).catch((cronErr: unknown) => {
          logger.error({ err: cronErr }, "PulseDNA video purge failed");
        });
      },
      { timezone: pulseVideoPurgeTz },
    );
    logger.info(
      { expr: pulseVideoPurgeExpr, tz: pulseVideoPurgeTz, source },
      "PulseDNA video purge scheduled",
    );
  } catch (schedErr) {
    logger.error({ err: schedErr }, "Failed to schedule PulseDNA video purge");
  }

  recoverStuckPulseDnaVideos().catch((err: unknown) => {
    logger.error({ err }, "PulseDNA stuck-transcode recovery failed");
  });

  if (isDemoHeartbeatEnabled() && process.env.NODE_ENV !== "test") {
    try {
      cron.schedule(
        "* * * * *",
        () => {
          runDemoHeartbeatTick().catch((cronErr: unknown) => {
            logger.error({ err: cronErr }, "Demo heartbeat tick failed");
          });
        },
        { timezone: "America/New_York" },
      );
      cron.schedule(
        "0 0 * * *",
        () => {
          runDemoHeartbeatReset().catch((cronErr: unknown) => {
            logger.error({ err: cronErr }, "Demo heartbeat midnight reset failed");
          });
        },
        { timezone: "America/New_York" },
      );
      logger.info({ source }, "Demo heartbeat scheduled (Parrott only)");
    } catch (schedErr) {
      logger.error({ err: schedErr }, "Failed to schedule demo heartbeat");
    }
  }
}
