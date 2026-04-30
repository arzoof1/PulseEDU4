// Cron-based scheduler for intervention reminder emails. Dormant by
// default — `EMAIL_REMINDERS_ENABLED=true` flips it live. The schedule
// is defined here so the daily / Monday / Friday cadences live in one
// place; the actual email rendering and dispatch live in
// lib/emails/interventionReminders.ts.
//
// Cadence (school local time = America/New_York for HCSB):
//   * 07:00 every weekday  → Tier 2 morning digest per teacher
//   * 07:00 every Monday   → Tier 3 weekly load digest per teacher
//   * 14:00 every Friday   → Core-Team weekly summary
//
// Each tick is a no-op until the env flag flips on. We still REGISTER
// the cron jobs at boot so once the flag is enabled (no redeploy
// required for env-only changes) the jobs start firing on their next
// scheduled tick.
import cron from "node-cron";
import { logger } from "./logger.js";
import {
  emailRemindersEnabled,
  type EmailReminderType,
} from "./emails/interventionReminders.js";

let started = false;

function tick(kind: EmailReminderType): void {
  if (!emailRemindersEnabled()) {
    logger.debug(
      { kind },
      "scheduler.tick suppressed (EMAIL_REMINDERS_ENABLED!=true)",
    );
    return;
  }
  // Real audience hydration + per-teacher rendering is deliberately
  // unimplemented until the sender domain is verified. Wiring up
  // hydration here without a verified sender means we'd be silently
  // dropping batches in production — better to no-op and surface a
  // single warning so ops sees we have not yet implemented the audience
  // resolver.
  logger.warn(
    { kind },
    "scheduler.tick fired with reminders ENABLED but audience hydration is not yet implemented",
  );
}

export function startReminderScheduler(): void {
  if (started) return;
  started = true;
  // node-cron uses standard cron syntax. Defaults to server tz; we set
  // an explicit America/New_York since the HCSB district is on EST/EDT.
  const tz = process.env.SCHEDULER_TZ ?? "America/New_York";
  cron.schedule("0 7 * * 1-5", () => tick("tier2-morning"), { timezone: tz });
  cron.schedule("0 7 * * 1", () => tick("tier3-weekly-load"), {
    timezone: tz,
  });
  cron.schedule("0 14 * * 5", () => tick("core-team-friday"), {
    timezone: tz,
  });
  logger.info(
    {
      enabled: emailRemindersEnabled(),
      tz,
    },
    "intervention reminder scheduler registered",
  );
}
