import { backfillWitnessSequences } from "./lib/witnessStatementId";
import { reconcileAllSchoolYearFlips } from "./lib/schoolYearFlip";
import { logger } from "./lib/logger";
import {
  backfillStaffRoomLocationsAtParrottOnce,
  cleanupLooseSeedInteractionsOnce,
  ensureAcademicEvidenceSchema,
  ensureAstSchema,
  ensureBadgePrintEventsSchema,
  ensureBenchmarkDeliveriesSchema,
  ensureClassComposerPlansSchema,
  ensureClassComposerSkillClusterSchema,
  ensureCommunicationSchema,
  ensureDataChatSchema,
  ensureDataExportSchema,
  ensureDataImporterRollbackSchema,
  ensureDistrictIntegrationsSchema,
  ensureDemoAdminAccountOnce,
  ensureEligibilitySchema,
  ensureFastItemResponsesSchema,
  ensureFeaturePlansColumns,
  ensureFeaturePlansSchema,
  ensureHallPassAllowlistSchema,
  ensureHallPassPriorityBypassColumn,
  ensureKioskCardsSchema,
  ensureKioskWelcomeSchema,
  ensureL25BaselineFromPriorPm3,
  ensureLocationAllowedDestinationsBackfill,
  ensureMfaSchema,
  ensureOnTimeTestModeColumns,
  ensureOneWayPassSchema,
  ensureParentMessagesSchema,
  ensurePbisInvisibleTierColumns,
  ensurePickupDemoFamily,
  ensurePickupOverrideAuditSchema,
  ensurePickupSchema,
  ensurePulseBrainLabGroupsSchema,
  ensurePulseDnaVideosSchema,
  ensureSectionSupportSchema,
  ensureSchoolBenchmarksCatalogBackfill,
  ensureSchoolGradeSchema,
  ensureSchoolsTimezoneColumn,
  ensureSpotlightPbisReason,
  ensureStaffPasswordResetsSchema,
  ensureStudentAccommodationsBackfill,
  ensureStudentLocalSisIdBackfill,
  ensureStudentPhotoColumns,
  ensureStudentRetentionsSchema,
  ensureWatchlistSchema,
  fillStudentSchedulesAtParrottOnce,
  matchDemoEmailsToNamesOnce,
  rebalanceFlagsAtParrottOnce,
  remapBenchmarkDeliveriesToRealTeachersOnce,
  seedAcademicMinutesDemoIfEmpty,
  seedBenchmarkDeliveriesOnce,
  seedBenchmarkDescriptions,
  seedEngagementEventsIfEmpty,
  seedEligibilityForSchool1,
  seedFastScoresIfEmpty,
  seedHistoricalFastIfEmpty,
  seedHousesIfEmpty,
  seedIfEmpty,
  seedIreadyAndSciIfEmpty,
  seedMtssPlansIfEmpty,
  seedPbisCatalogIfEmpty,
  seedPbisEntriesIfEmpty,
  seedPulseBrainLabLessons,
  seedSafetyPlanLibraryIfEmpty,
  seedSafetyPlansIfEmpty,
  seedSeparationReasonTagsIfEmpty,
  seedStudentDemographicsIfEmpty,
  seedStudentRaceIfEmpty,
  seedStudentRetentionsIfEmpty,
  seedTenancy,
  seedTieredInterventionsIfEmpty,
  seedWatchlistIfEmpty,
  seedWatchlistQuickEntriesIfEmpty,
  seedWatchlistSpotlightsIfMissing,
} from "./seed";
// Schema ensures that today only run *inside* demo-seed wrappers (e.g.
// seedFastScoresIfEmpty calls a batch of ensures before seeding). runMigrations()
// calls them directly so the production migrate-only path gets full schema
// without any demo data.
import {
  ensureAdminHubSchema,
  ensureAlgebraPlacementOverridesSchema,
  ensureBenchmarkDescriptionsSchema,
  ensureBenchmarkReteachLogSchema,
  ensureCameraRegistrySchema,
  ensureCaseConsistencySchema,
  ensureCaseFootageRequestsSchema,
  ensureCaseMentionsSchema,
  ensureCaseOutcomeCatalogSchema,
  ensureCaseVideoEvidencePlayersSchema,
  ensureCaseVideoEvidenceSchema,
  ensureDisplayLiveControlSchema,
  ensureFastScoresSchema,
  ensureHeartbeatNoteSchema,
  ensureHousesSchema,
  ensureInterventionEntriesSchema,
  ensureMtssPlansSchema,
  ensureOnboardingChecklistSchema,
  ensurePbisPointMigrationsSchema,
  ensurePulseBrainLabLessonsSchema,
  ensureSchoolSettingsFeatureFlagsSchema,
  ensureTicketingSchema,
  ensureTierPresetsSchema,
  ensureTourWalksSchema,
  ensureToursSchema,
} from "./seed";
import { seedDistrictDemoExtras } from "./seedDemoExtras";

// IMPORTANT: sequential, not Promise.all. seedIfEmpty() reads the schools table
// that seedTenancy() populates, so on a fresh database the order matters.
export async function runSeed(): Promise<void> {
  await ensureFeaturePlansColumns();
  await seedTenancy();
  await seedIfEmpty();
  await cleanupLooseSeedInteractionsOnce();
  await seedMtssPlansIfEmpty();
  await seedTieredInterventionsIfEmpty();
  await seedAcademicMinutesDemoIfEmpty();
  await seedFastScoresIfEmpty();
  await seedHistoricalFastIfEmpty();
  await ensureL25BaselineFromPriorPm3();
  await seedIreadyAndSciIfEmpty();
  await seedHousesIfEmpty();
  await seedEngagementEventsIfEmpty();
  await seedPbisCatalogIfEmpty();
  await ensureSpotlightPbisReason();
  await seedSeparationReasonTagsIfEmpty();
  await seedPbisEntriesIfEmpty();
  await seedStudentDemographicsIfEmpty();
  await seedStudentRaceIfEmpty();
  await seedSafetyPlanLibraryIfEmpty();
  await seedSafetyPlansIfEmpty();
  await ensureWatchlistSchema();
  await ensureClassComposerPlansSchema();
  try {
    await seedWatchlistIfEmpty();
  } catch (err) {
    logger.error(
      { err },
      "[seed] seedWatchlistIfEmpty failed — continuing boot so downstream ALTERs still run",
    );
  }
  await seedWatchlistSpotlightsIfMissing();
  await seedWatchlistQuickEntriesIfEmpty();
  await ensureStudentRetentionsSchema();
  await seedStudentRetentionsIfEmpty();
  await ensureDataImporterRollbackSchema();
  await ensureDistrictIntegrationsSchema();
  await ensurePickupSchema();
  await ensurePickupOverrideAuditSchema();
  await ensurePickupDemoFamily();
  await ensureAstSchema();
  await ensureFeaturePlansSchema();
  await ensureKioskCardsSchema();
  await ensureHallPassPriorityBypassColumn();
  await ensureHallPassAllowlistSchema();
  await ensureOneWayPassSchema();
  await ensureKioskWelcomeSchema();
  await ensurePbisInvisibleTierColumns();
  await ensureBadgePrintEventsSchema();
  await ensureClassComposerSkillClusterSchema();
  await ensureFastItemResponsesSchema();
  await ensureSchoolGradeSchema();
  await ensureEligibilitySchema();
  await ensureStaffPasswordResetsSchema();
  await ensureMfaSchema();
  await ensureSchoolsTimezoneColumn();
  await ensureStudentPhotoColumns();
  await ensureOnTimeTestModeColumns();
  await ensureParentMessagesSchema();
  await ensureCommunicationSchema();
  await ensureDataChatSchema();
  await ensureSectionSupportSchema();
  await ensureDataExportSchema();
  await ensurePulseDnaVideosSchema();
  await ensureStudentLocalSisIdBackfill();
  try {
    await seedBenchmarkDescriptions();
    await seedPulseBrainLabLessons();
    await ensurePulseBrainLabGroupsSchema();
    await ensureAcademicEvidenceSchema();
    await ensureBenchmarkDeliveriesSchema();
    await ensureSchoolBenchmarksCatalogBackfill();
    await seedBenchmarkDeliveriesOnce();
    await remapBenchmarkDeliveriesToRealTeachersOnce();
    await fillStudentSchedulesAtParrottOnce();
    await rebalanceFlagsAtParrottOnce();
  } catch (err) {
    logger.error({ err }, "[boot] benchmark catalog ensure failed");
  }
  try {
    await matchDemoEmailsToNamesOnce();
  } catch (err) {
    logger.error({ err }, "[boot] demo email/password backfill failed");
  }
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
  await ensureLocationAllowedDestinationsBackfill();
  try {
    await backfillStaffRoomLocationsAtParrottOnce();
  } catch (err) {
    logger.error({ err }, "[boot] Parrott staff-room locations backfill failed");
  }
  try {
    const r = await backfillWitnessSequences();
    if (r.cases > 0) {
      logger.info(r, "[boot] backfilled witness statement sequences");
    }
  } catch (err) {
    logger.warn({ err }, "[boot] witness ws_seq backfill failed");
  }
  try {
    await seedDistrictDemoExtras();
  } catch (err) {
    logger.error({ err }, "[boot] district demo extras seed failed");
  }
  try {
    await seedEligibilityForSchool1();
  } catch (err) {
    logger.error({ err }, "[boot] eligibility demo seed failed");
  }
  try {
    await reconcileAllSchoolYearFlips();
  } catch (err) {
    logger.error({ err }, "[boot] school-year flip reconcile failed");
  }
}

// Production schema-migration path (companion to the RUN_BOOT_SEED work).
// Runs ONLY the idempotent schema ensures + real-data backfills — NEVER the
// demo-data seeders — so bringing up RUN_BOOT_SEED=true in production applies
// schema WITHOUT injecting demo students / schools / scores. Base tables come
// from `drizzle-kit push` (run once via SSH on a brand-new DB); these ensures
// are the incremental ADD COLUMN / CREATE TABLE IF NOT EXISTS top-ups on top,
// and are safe to run on every boot of an established database.
//
// Each step is isolated in try/catch so one failure (logged loudly) doesn't
// abort the rest — the ensures are idempotent and will re-attempt next boot.
//
// MAINTENANCE: production uses THIS path, not runSeed(). When you add a new
// ensure*Schema/Columns/Backfill, add it here too or the column won't reach
// production.
export async function runMigrations(): Promise<void> {
  const steps: Array<readonly [string, () => Promise<void>]> = [
    ["ensureFeaturePlansColumns", ensureFeaturePlansColumns],
    ["ensureFeaturePlansSchema", ensureFeaturePlansSchema],
    ["ensureSchoolsTimezoneColumn", ensureSchoolsTimezoneColumn],
    ["ensureStudentPhotoColumns", ensureStudentPhotoColumns],
    ["ensureOnTimeTestModeColumns", ensureOnTimeTestModeColumns],
    ["ensureHousesSchema", ensureHousesSchema],
    ["ensureMtssPlansSchema", ensureMtssPlansSchema],
    ["ensureSchoolSettingsFeatureFlagsSchema", ensureSchoolSettingsFeatureFlagsSchema],
    ["ensureAdminHubSchema", ensureAdminHubSchema],
    ["ensureTierPresetsSchema", ensureTierPresetsSchema],
    ["ensureOnboardingChecklistSchema", ensureOnboardingChecklistSchema],
    ["ensureFastScoresSchema", ensureFastScoresSchema],
    ["ensureFastItemResponsesSchema", ensureFastItemResponsesSchema],
    ["ensureBenchmarkReteachLogSchema", ensureBenchmarkReteachLogSchema],
    ["ensureBenchmarkDescriptionsSchema", ensureBenchmarkDescriptionsSchema],
    ["ensureBenchmarkDeliveriesSchema", ensureBenchmarkDeliveriesSchema],
    ["ensureSchoolBenchmarksCatalogBackfill", ensureSchoolBenchmarksCatalogBackfill],
    ["ensureAlgebraPlacementOverridesSchema", ensureAlgebraPlacementOverridesSchema],
    ["ensureHeartbeatNoteSchema", ensureHeartbeatNoteSchema],
    ["ensureInterventionEntriesSchema", ensureInterventionEntriesSchema],
    ["ensureAcademicEvidenceSchema", ensureAcademicEvidenceSchema],
    ["ensurePulseBrainLabLessonsSchema", ensurePulseBrainLabLessonsSchema],
    ["ensurePulseBrainLabGroupsSchema", ensurePulseBrainLabGroupsSchema],
    ["ensureClassComposerPlansSchema", ensureClassComposerPlansSchema],
    ["ensureClassComposerSkillClusterSchema", ensureClassComposerSkillClusterSchema],
    ["ensureWatchlistSchema", ensureWatchlistSchema],
    ["ensureCaseMentionsSchema", ensureCaseMentionsSchema],
    ["ensureCaseVideoEvidenceSchema", ensureCaseVideoEvidenceSchema],
    ["ensureCaseVideoEvidencePlayersSchema", ensureCaseVideoEvidencePlayersSchema],
    ["ensureCameraRegistrySchema", ensureCameraRegistrySchema],
    ["ensureCaseConsistencySchema", ensureCaseConsistencySchema],
    ["ensureCaseFootageRequestsSchema", ensureCaseFootageRequestsSchema],
    ["ensureCaseOutcomeCatalogSchema", ensureCaseOutcomeCatalogSchema],
    ["ensureToursSchema", ensureToursSchema],
    ["ensureTourWalksSchema", ensureTourWalksSchema],
    ["ensureTicketingSchema", ensureTicketingSchema],
    ["ensureDisplayLiveControlSchema", ensureDisplayLiveControlSchema],
    ["ensureStudentRetentionsSchema", ensureStudentRetentionsSchema],
    ["ensureDataImporterRollbackSchema", ensureDataImporterRollbackSchema],
    ["ensureDistrictIntegrationsSchema", ensureDistrictIntegrationsSchema],
    ["ensurePickupSchema", ensurePickupSchema],
    ["ensurePickupOverrideAuditSchema", ensurePickupOverrideAuditSchema],
    ["ensureAstSchema", ensureAstSchema],
    ["ensureKioskCardsSchema", ensureKioskCardsSchema],
    ["ensureKioskWelcomeSchema", ensureKioskWelcomeSchema],
    ["ensureHallPassPriorityBypassColumn", ensureHallPassPriorityBypassColumn],
    ["ensureHallPassAllowlistSchema", ensureHallPassAllowlistSchema],
    ["ensureOneWayPassSchema", ensureOneWayPassSchema],
    ["ensurePbisInvisibleTierColumns", ensurePbisInvisibleTierColumns],
    ["ensurePbisPointMigrationsSchema", ensurePbisPointMigrationsSchema],
    ["ensureSpotlightPbisReason", ensureSpotlightPbisReason],
    ["ensureBadgePrintEventsSchema", ensureBadgePrintEventsSchema],
    ["ensureSchoolGradeSchema", ensureSchoolGradeSchema],
    ["ensureEligibilitySchema", ensureEligibilitySchema],
    ["ensureStaffPasswordResetsSchema", ensureStaffPasswordResetsSchema],
    ["ensureMfaSchema", ensureMfaSchema],
    ["ensureParentMessagesSchema", ensureParentMessagesSchema],
    ["ensureCommunicationSchema", ensureCommunicationSchema],
    ["ensureDataChatSchema", ensureDataChatSchema],
    ["ensureSectionSupportSchema", ensureSectionSupportSchema],
    ["ensureDataExportSchema", ensureDataExportSchema],
    ["ensurePulseDnaVideosSchema", ensurePulseDnaVideosSchema],
    ["ensureStudentLocalSisIdBackfill", ensureStudentLocalSisIdBackfill],
    ["ensureStudentAccommodationsBackfill", ensureStudentAccommodationsBackfill],
    ["ensureLocationAllowedDestinationsBackfill", ensureLocationAllowedDestinationsBackfill],
    ["ensureL25BaselineFromPriorPm3", ensureL25BaselineFromPriorPm3],
  ];
  let ok = 0;
  for (const [name, fn] of steps) {
    try {
      await fn();
      ok++;
    } catch (err) {
      logger.error({ err, step: name }, "[migrate] schema step failed");
    }
  }
  logger.info(
    { ok, total: steps.length },
    "[migrate] schema migration complete (no demo data seeded)",
  );
}

export async function bootstrapCriticalColumns(): Promise<void> {
  try {
    await ensureSchoolsTimezoneColumn();
    await ensureStudentPhotoColumns();
    await ensureOnTimeTestModeColumns();
    await ensureParentMessagesSchema();
    await ensurePulseDnaVideosSchema();
    await ensureMfaSchema();
  } catch (err) {
    logger.error({ err }, "[boot] critical column bootstrap failed");
    throw err;



  }
}
