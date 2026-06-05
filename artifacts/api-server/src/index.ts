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
  ensureKioskCardsSchema,
  ensureKioskWelcomeSchema,
  ensureBadgePrintEventsSchema,
  ensureFastItemResponsesSchema,
  ensureSchoolsTimezoneColumn,
  ensureStudentPhotoColumns,
  ensureStudentLocalSisIdBackfill,
  ensureStudentAccommodationsBackfill,
  ensureLocationAllowedDestinationsBackfill,
  ensureBenchmarkDeliveriesSchema,
  ensureSchoolBenchmarksCatalogBackfill,
  seedBenchmarkDeliveriesOnce,
  remapBenchmarkDeliveriesToRealTeachersOnce,
  matchDemoEmailsToNamesOnce,
  recoverSuperUserPasswordOnce,
  ensureDemoAdminAccountOnce,
  fillStudentSchedulesAtParrottOnce,
  rebalanceFlagsAtParrottOnce,
  ensureFeaturePlansColumns,
  ensureFeaturePlansSchema,
  ensureClassComposerPlansSchema,
  ensureSchoolGradeSchema,
  ensureClassComposerSkillClusterSchema,
  ensureStaffPasswordResetsSchema,
} from "./seed";
import { backfillWitnessSequences } from "./lib/witnessStatementId";
import cron from "node-cron";
import { sendDailyDigestEmail } from "./lib/dailyDigest";
import { sendWeeklyHeartbeatEmails } from "./lib/weeklyHeartbeatEmail";
import { startReminderScheduler } from "./lib/scheduler";
import { runAstYearEndLapse } from "./cron/astLapse";
import { runFeatureLicensingOverrideSweep } from "./cron/featureLicensingOverrideSweep";
import { runPickupEndOfDayAutoClear } from "./cron/pickupEndOfDayAutoClear";
import {
  runDemoHeartbeatTick,
  runDemoHeartbeatReset,
  isDemoHeartbeatEnabled,
} from "./cron/demoHeartbeat";

// -----------------------------------------------------------------------------
// Process-level error surface. Without these handlers an unhandled promise
// rejection or uncaught exception silently terminates the worker (in newer
// Node) or hangs (in older Node) with nothing in the logs. We log the error
// with pino so it lands in the same log sink as request errors, and re-throw
// uncaughtException since trying to keep running after one is undefined
// behavior.
// -----------------------------------------------------------------------------
process.on("unhandledRejection", (reason, promise) => {
  logger.error({ err: reason, promise }, "Unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception — process will exit");
  // Give pino a tick to flush.
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
  // Add schools.plan_id + school_settings.super_feature_ast BEFORE
  // seedTenancy: that function inserts into schools via Drizzle, whose
  // schema now references those columns. Idempotent ALTER … IF NOT EXISTS.
  await ensureFeaturePlansColumns();
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
  // Class Composer "Master Plans" — saved/finalized plan tables for the
  // scheduler-side lock-and-build workflow. Idempotent. Hoisted above the
  // watchlist seed because that seed can crash on pre-existing demo rows
  // (duplicate case_number) and abort the rest of the boot sequence.
  await ensureClassComposerPlansSchema();
  // Watchlist demo data: 20% of each school's roster gets activity, with a
  // ~3%-of-20% high-concern slice anchoring 3–4 cases. Idempotent per school.
  // Defense-in-depth: a crash inside the watchlist seeder would abort
  // every remaining schema ALTER in this file. Log + continue instead.
  try {
    await seedWatchlistIfEmpty();
  } catch (err) {
    logger.error(
      { err },
      "[seed] seedWatchlistIfEmpty failed — continuing boot so downstream ALTERs still run",
    );
  }
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
  await ensureFeaturePlansSchema();
  // Phase 1 — Hall pass kiosk activation cards (per-teacher enrollment
  // tokens encoded as QR + Code 128 + 6-digit PIN; sub/proxy + audit
  // columns on kiosk_activations). Idempotent.
  await ensureKioskCardsSchema();
  // Phase 3 — Kiosk "Sign in to class" welcome messages + class_signins
  // append-only ledger. Idempotent.
  await ensureKioskWelcomeSchema();
  // Phase 4 — Badge print event audit ledger. Idempotent.
  await ensureBadgePrintEventsSchema();
  // Class Composer "Master Plans" — saved/finalized plan tables for the
  // scheduler-side lock-and-build workflow. Idempotent.
  await ensureClassComposerPlansSchema();
  // Skill-cluster mode add-ons (focus_standards column + refresh
  // audit table + per-window banner dismissals). Idempotent.
  await ensureClassComposerSkillClusterSchema();
  // FAST Phase 1 — per-item benchmark response storage for the Florida
  // xlsx parser. Idempotent.
  await ensureFastItemResponsesSchema();
  // School Grade Estimated Calculator (Phase 1) — runs, history, manual
  // inputs, and survey-upload placeholder tables. Idempotent.
  await ensureSchoolGradeSchema();
  // Staff self-service password reset token store. Idempotent.
  await ensureStaffPasswordResetsSchema();
  // Packet A — Per-school IANA timezone column on schools (pre-2026
  // tenants may be missing it). Idempotent.
  await ensureSchoolsTimezoneColumn();
  // Packet B — Student photo + consent columns on students (pre-2026
  // tenants may be missing them). Idempotent.
  await ensureStudentPhotoColumns();
  // Backfill local_sis_id from the FLEID for any students missing it
  // (legacy rows). Local SIS ID is the student-facing credential
  // everywhere in the app; FLEID stays internal for FAST joins.
  await ensureStudentLocalSisIdBackfill();
  // Backfill per-student accommodations for any student whose ESE / 504 /
  // ELL flag is set but who has zero active student_accommodations rows
  // — otherwise the Teacher Roster "Programs" hover opens to an empty
  // list. Idempotent.
  // Instructional Log + Instructional Coverage tables + catalog auto-seed
  // from FAST item responses. Both idempotent. Run BEFORE any seed step
  // that has historically been fragile (e.g. the accommodations
  // backfill, which depends on a constraint that's missing on some
  // legacy tenants) so a downstream failure cannot keep this new
  // schema from being created. Also wrapped in try/catch defensively.
  try {
    await ensureBenchmarkDeliveriesSchema();
    await ensureSchoolBenchmarksCatalogBackfill();
    // One-shot backfill of the dev-entered deliveries into prod.
    // Idempotent: no-op once school_id=1 has any benchmark_deliveries row.
    await seedBenchmarkDeliveriesOnce();
    await remapBenchmarkDeliveriesToRealTeachersOnce();
    await fillStudentSchedulesAtParrottOnce();
    await rebalanceFlagsAtParrottOnce();
  } catch (err) {
    logger.error({ err }, "[boot] benchmark catalog ensure failed");
  }
  // One-shot: align demo staff emails to @pulsedemo.com (derived from their
  // display names) + reset demo passwords. Runs once per environment, guarded
  // by a marker. Wrapped separately so a benchmark failure can't block it.
  try {
    await matchDemoEmailsToNamesOnce();
  } catch (err) {
    logger.error({ err }, "[boot] demo email/password backfill failed");
  }
  // NOTE: SuperUser password recovery is intentionally NOT called here. It runs
  // early and independently in startListening() so it never sits behind this
  // long (occasionally fragile) seed chain — see the call site for rationale.
  // Ensure the demo admin handout account on the Parrott demo school.
  // Self-healing via ON CONFLICT (email). Own try/catch so a failure can't
  // block later backfills.
  try {
    await ensureDemoAdminAccountOnce();
  } catch (err) {
    logger.error({ err }, "[boot] demo admin account ensure failed");
  }
  try {
    await ensureStudentAccommodationsBackfill();
  } catch (err) {
    logger.error({ err }, "[boot] student accommodations backfill failed");
  }
  // Backfill location_allowed_destinations for schools that have locations
  // but zero origin×destination pairs — otherwise the kiosk destination
  // picker is blank for legacy tenants. Idempotent: schools with any
  // existing pair are skipped.
  await ensureLocationAllowedDestinationsBackfill();
  // Packet A — One-shot backfill of ws_seq for legacy witness
  // statements that were attached to cases before the per-case
  // numbering shipped. Idempotent: skips rows that already have a
  // ws_seq, so a second boot is a near-no-op cheap COUNT.
  try {
    const r = await backfillWitnessSequences();
    if (r.cases > 0) {
      logger.info(r, "[boot] backfilled witness statement sequences");
    }
  } catch (err) {
    logger.warn({ err }, "[boot] witness ws_seq backfill failed");
  }
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

      // Locked-out SuperUser recovery. Runs IMMEDIATELY and independently of
      // the background seed: it only touches `staff` + `app_one_shot_markers`
      // (both already present in a live DB), so it must NOT sit behind the long
      // runSeed() chain — a throw in any earlier (un-try/catched) seed step
      // would otherwise stop it from ever running in production, which is
      // exactly what stranded the earlier recovery attempts. Idempotent via its
      // own marker row. SAFE TO DELETE with the rest of the recovery one-shot.
      recoverSuperUserPasswordOnce()
        .then(() => logger.info("[boot] superuser recovery one-shot checked"))
        .catch((err) =>
          logger.error(
            { err },
            "[boot] superuser password recovery failed (early)",
          ),
        );

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

        // AST year-end lapse. Per HCTA contract, unused balance lapses
        // on June 30. Fire at 00:05 school-local on July 1 so the day
        // boundary is unambiguous. Idempotent — see runAstYearEndLapse.
        // Override window via AST_LAPSE_CRON / AST_LAPSE_TZ.
        const astLapseExpr = process.env.AST_LAPSE_CRON ?? "5 0 1 7 *";
        const astLapseTz = process.env.AST_LAPSE_TZ ?? "America/New_York";
        try {
          cron.schedule(
            astLapseExpr,
            async () => {
              try {
                const results = await runAstYearEndLapse(new Date());
                const totalStaff = results.reduce(
                  (n, r) => n + r.staffLapsed,
                  0,
                );
                const totalQh = results.reduce(
                  (n, r) => n + r.totalQuarterHoursLapsed,
                  0,
                );
                logger.info(
                  {
                    schools: results.length,
                    totalStaffLapsed: totalStaff,
                    totalQuarterHoursLapsed: totalQh,
                  },
                  "AST year-end lapse cron complete",
                );
              } catch (cronErr) {
                logger.error({ err: cronErr }, "AST year-end lapse failed");
              }
            },
            { timezone: astLapseTz },
          );
          logger.info(
            { expr: astLapseExpr, tz: astLapseTz },
            "AST year-end lapse scheduled",
          );
        } catch (schedErr) {
          logger.error(
            { err: schedErr },
            "Failed to schedule AST year-end lapse",
          );
        }

        // Phase 2 of feature licensing — daily sweep that finds
        // expired overrides and re-applies plan + remaining overrides
        // to roll the runtime super_feature_* booleans back. The read
        // path (`loadEffectiveFeatures`) already ignores expired
        // overrides, but the stored boolean is what nav-gates and
        // schoolSettings consumers see. Idempotent — partial unique
        // index on the audit table guarantees a given override is
        // swept at most once. Schedule daily at 02:15 UTC; override
        // via FEATURE_LICENSING_SWEEP_CRON.
        const sweepExpr =
          process.env.FEATURE_LICENSING_SWEEP_CRON ?? "15 2 * * *";
        try {
          cron.schedule(sweepExpr, async () => {
            try {
              const r = await runFeatureLicensingOverrideSweep(new Date());
              if (r.overridesSwept > 0) {
                logger.info(r, "Feature licensing override sweep complete");
              }
            } catch (cronErr) {
              logger.error(
                { err: cronErr },
                "Feature licensing override sweep failed",
              );
            }
          });
          logger.info(
            { expr: sweepExpr },
            "Feature licensing override sweep scheduled",
          );
        } catch (schedErr) {
          logger.error(
            { err: schedErr },
            "Failed to schedule feature licensing override sweep",
          );
        }

        // Pickup queue end-of-day auto-clear. Inserts an `auto_cleared`
        // event for every student who entered the queue today but
        // didn't get a terminal release. Append-only — preserves the
        // audit trail and resets the Admin Hub "Still on campus" tile
        // for the next morning. Default 22:00 school-local; override
        // via PICKUP_AUTOCLEAR_CRON / PICKUP_AUTOCLEAR_TZ.
        const pickupClearExpr =
          process.env.PICKUP_AUTOCLEAR_CRON ?? "0 22 * * *";
        const pickupClearTz =
          process.env.PICKUP_AUTOCLEAR_TZ ?? "America/New_York";
        try {
          cron.schedule(
            pickupClearExpr,
            async () => {
              try {
                const r = await runPickupEndOfDayAutoClear(
                  new Date(),
                  pickupClearTz,
                );
                if (r.studentsCleared > 0) {
                  logger.info(r, "Pickup end-of-day auto-clear complete");
                }
              } catch (cronErr) {
                logger.error(
                  { err: cronErr },
                  "Pickup end-of-day auto-clear failed",
                );
              }
            },
            { timezone: pickupClearTz },
          );
          logger.info(
            { expr: pickupClearExpr, tz: pickupClearTz },
            "Pickup end-of-day auto-clear scheduled",
          );
        } catch (schedErr) {
          logger.error(
            { err: schedErr },
            "Failed to schedule pickup end-of-day auto-clear",
          );
        }
      }

      // Demo Heartbeat — ambient fake PBIS awards for the houses signage.
      // Gated by DEMO_MODE=true. Hard-pinned to Parrott (school_id=1).
      // Tick every minute; the tick itself enforces jittered 90-180s
      // cadence + bell-schedule window + anti-repeat. Midnight purge
      // wipes only rows tagged `__demo_heartbeat__` — real awards are
      // never touched. See cron/demoHeartbeat.ts for the full design.
      if (isDemoHeartbeatEnabled() && process.env.NODE_ENV !== "test") {
        try {
          cron.schedule(
            "* * * * *",
            async () => {
              try {
                const r = await runDemoHeartbeatTick();
                if (r.fired) {
                  logger.info(r, "Demo heartbeat tick fired");
                }
              } catch (cronErr) {
                logger.error({ err: cronErr }, "Demo heartbeat tick failed");
              }
            },
            { timezone: "America/New_York" },
          );
          cron.schedule(
            "0 0 * * *",
            async () => {
              try {
                const r = await runDemoHeartbeatReset();
                logger.info(r, "Demo heartbeat midnight reset fired");
              } catch (cronErr) {
                logger.error(
                  { err: cronErr },
                  "Demo heartbeat midnight reset failed",
                );
              }
            },
            { timezone: "America/New_York" },
          );
          logger.info("Demo heartbeat scheduled (Parrott only)");
        } catch (schedErr) {
          logger.error(
            { err: schedErr },
            "Failed to schedule demo heartbeat",
          );
        }
      }
    });
}

// Pre-listen critical column bootstrap. Runs BEFORE we open the port
// so legacy-DB tenants don't 500 on `/students`, `/spotlight/pick`,
// or `/pickup/lookup` during the window between app.listen and the
// background runSeed() completing. Each ALTER is idempotent + cheap
// (milliseconds against a populated table), so it's safe to also
// leave the calls inside runSeed() as a defense-in-depth no-op.
async function bootstrapCriticalColumns(): Promise<void> {
  try {
    await ensureSchoolsTimezoneColumn();
    await ensureStudentPhotoColumns();
  } catch (err) {
    logger.error({ err }, "[boot] critical column bootstrap failed");
    throw err;
  }
}

// Boot. In dev we keep the original "seed first, then listen" flow so
// the workflow logs read top-to-bottom and a `pnpm dev` restart waits
// for data to be ready. In production we run the critical column
// bootstrap, listen immediately, and run the (idempotent) full seed
// in the background — see startListening().
if (seedInBackground) {
  bootstrapCriticalColumns()
    .catch((err) => {
      logger.error({ err }, "Critical bootstrap failed; exiting");
      process.exit(1);
    })
    .then(() => startListening());
} else {
  runSeed()
    .catch((err) => logger.error({ err }, "Seed failed"))
    .finally(() => startListening());
}
