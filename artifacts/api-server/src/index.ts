import app from "./app";
import { logger } from "./lib/logger";
import {
  cleanupLooseSeedInteractionsOnce,
  seedIfEmpty,
  seedTenancy,
  seedMtssPlansIfEmpty,
  seedTieredInterventionsIfEmpty,
  seedFastScoresIfEmpty,
  seedHousesIfEmpty,
  seedIreadyAndSciIfEmpty,
  seedEngagementEventsIfEmpty,
  seedPbisCatalogIfEmpty,
  ensureSpotlightPbisReason,
  seedSeparationReasonTagsIfEmpty,
  seedPbisEntriesIfEmpty,
  seedStudentDemographicsIfEmpty,
  seedStudentRaceIfEmpty,
  seedSafetyPlanLibraryIfEmpty,
  seedSafetyPlansIfEmpty,
  ensureWatchlistSchema,
  seedWatchlistIfEmpty,
  seedWatchlistSpotlightsIfMissing,
  seedWatchlistQuickEntriesIfEmpty,
  ensureStudentRetentionsSchema,
  seedStudentRetentionsIfEmpty,
  ensureDataImporterRollbackSchema,
  ensurePickupSchema,
  ensureAstSchema,
} from "./seed";
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

// IMPORTANT: sequential, not Promise.all. seedIfEmpty() reads the
// schools table that seedTenancy() populates, so on a fresh prod
// database the order matters — running them in parallel can race
// and leave the seed with zero schools to attach data to.
//
// Each step is idempotent (skip-if-non-empty per school) so it's safe
// to run AFTER the HTTP listener opens. We do exactly that in production
// because the full seed (60-day demo data × 7 schools) takes well over
// the platform's port-open timeout on a fresh DB.
async function runSeed(): Promise<void> {
  await seedTenancy();
  await seedIfEmpty();
  // One-shot sweep of loose (case_id IS NULL) demo interactions left
  // over from prior seed runs. Demo-school-gated; safe no-op once
  // empty. See cleanupLooseSeedInteractionsOnce in seed.ts.
  await cleanupLooseSeedInteractionsOnce();
  // Runs after the main seed so studentsTable is populated. Idempotent
  // per-school: skipped for any school that already has at least one plan.
  await seedMtssPlansIfEmpty();
  // Tier-aware demo: ~10% of each school's students get a fully wired
  // Tier 2 (CICO/group, daily) or Tier 3 (weekly with goals) plan, with
  // assigned_teacher_ids drawn from the section roster so the bell
  // surfaces "owed today" rows for the right teachers. Idempotent:
  // skipped if any plan with `opened_by_name = 'Tiered Demo Seed'`
  // already exists for that school.
  await seedTieredInterventionsIfEmpty();
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
  // PBIS catalog (reasons) per school, then 60 days of pbis_entries demo
  // data so the new Behavior dashboard renders on first launch. Catalog
  // seed runs first because the entries seed reads pbis_reasons live.
  await seedPbisCatalogIfEmpty();
  // Make sure every school has the "Class Participation (Spotlight)" reason
  // so the Spotlight Correct! flow has a stable reason row to file under.
  // Idempotent skip-if-exists per school.
  await ensureSpotlightPbisReason();
  await seedSeparationReasonTagsIfEmpty();
  await seedPbisEntriesIfEmpty();
  // Demographic flags (ELL/ESE/504/gender) for the SEB/SEL + Equity
  // dashboards. Runs LAST because it correlates demographics to existing
  // FAST BQ + recent-30d negative PBIS counts so the demo dataset surfaces
  // realistic disparity ratios. Idempotent per-school: skipped the moment
  // any student already has a flag/gender set, so a real SIS roster import
  // is never overwritten.
  await seedStudentDemographicsIfEmpty();
  // Race + ethnicity (7 buckets + Hispanic Y/N) for the Equity dashboard's
  // race disaggregation. Same two-stage idempotency contract as the
  // demographics seed: skipped when any student in a school already has a
  // race set, AND skipped for schools without the demo marker. Real SIS
  // imports remain untouched.
  await seedStudentRaceIfEmpty();
  // Safety Plans: school-wide library catalog first, then per-student
  // plans (~10% of each school's roster, plus at least one per teacher
  // so the red SP pill appears on every teacher's roster on day-1).
  await seedSafetyPlanLibraryIfEmpty();
  await seedSafetyPlansIfEmpty();
  // Watchlist Hub schema (interactions, cases, witness statements, audit log,
  // alert dismissals). Idempotent — safe on every boot; cheap on already-
  // migrated DBs.
  await ensureWatchlistSchema();
  // Watchlist demo data: 20% of each school's roster gets activity, with a
  // ~3%-of-20% high-concern slice anchoring 3–4 cases. Idempotent per school.
  await seedWatchlistIfEmpty();
  // Backfill: pile extra incidents on the top 3 case anchors per school
  // so the Schoolwide Behavior Network's Full School Web shows a clear
  // "these kids stand out" hierarchy instead of a wall of equal-sized
  // spheres. Idempotent via interactions.detail = 'spotlight-seed'.
  await seedWatchlistSpotlightsIfMissing();
  // Per-school default catalog of quick-entry templates (Hallway shove,
  // Cafeteria verbal, etc.) for the Log Interaction modal. Idempotent:
  // skipped per-school when any quick entry already exists, so Core
  // Team customizations are preserved across reboots.
  await seedWatchlistQuickEntriesIfEmpty();
  // Student retention indicator (roster + profile + parent portal). 5%
  // baseline per school, then per-teacher pass to guarantee >= 2 retained
  // students per teacher's roster. Idempotent per school.
  await ensureStudentRetentionsSchema();
  await seedStudentRetentionsIfEmpty();
  // Data Importer rollback infrastructure: FAST import_job_id column,
  // student_import_snapshots table, and the per-school
  // manual_roster_upload_enabled toggle. Idempotent — safe on every boot.
  await ensureDataImporterRollbackSchema();
  await ensurePickupSchema();
  await ensureAstSchema();
}

// In production we MUST open the port within the platform's health-check
// window, otherwise the deploy is killed. Because the seed is idempotent
// and the routes already handle empty data gracefully, we open the
// listener first and run the seed in the background. In development we
// keep the original sequential behavior so a `pnpm dev` restart blocks
// until the seed is ready (clearer logs, no stale-data confusion while
// iterating).
const seedInBackground = process.env.NODE_ENV === "production";

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
          .catch((err) =>
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

// Boot. In dev we keep the original "seed first, then listen" flow so
// the workflow logs read top-to-bottom and a `pnpm dev` restart waits
// for data to be ready. In production we listen immediately and run
// the (idempotent) seed in the background — see startListening().
if (seedInBackground) {
  startListening();
} else {
  runSeed()
    .catch((err) => logger.error({ err }, "Seed failed"))
    .finally(() => startListening());
}
