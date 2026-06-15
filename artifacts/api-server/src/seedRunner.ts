import { backfillWitnessSequences } from "./lib/witnessStatementId";
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
  ensureDataImporterRollbackSchema,
  ensureDemoAdminAccountOnce,
  ensureFastItemResponsesSchema,
  ensureFeaturePlansColumns,
  ensureFeaturePlansSchema,
  ensureHallPassPriorityBypassColumn,
  ensureKioskCardsSchema,
  ensureKioskWelcomeSchema,
  ensureLocationAllowedDestinationsBackfill,
  ensureOnTimeTestModeColumns,
  ensureOneWayPassSchema,
  ensureParentMessagesSchema,
  ensurePbisInvisibleTierColumns,
  ensurePickupDemoFamily,
  ensurePickupSchema,
  ensurePulseBrainLabGroupsSchema,
  ensurePulseDnaVideosSchema,
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
  seedFastScoresIfEmpty,
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
  await ensurePickupSchema();
  await ensurePickupDemoFamily();
  await ensureAstSchema();
  await ensureFeaturePlansSchema();
  await ensureKioskCardsSchema();
  await ensureHallPassPriorityBypassColumn();
  await ensureOneWayPassSchema();
  await ensureKioskWelcomeSchema();
  await ensurePbisInvisibleTierColumns();
  await ensureBadgePrintEventsSchema();
  await ensureClassComposerSkillClusterSchema();
  await ensureFastItemResponsesSchema();
  await ensureSchoolGradeSchema();
  await ensureStaffPasswordResetsSchema();
  await ensureSchoolsTimezoneColumn();
  await ensureStudentPhotoColumns();
  await ensureOnTimeTestModeColumns();
  await ensureParentMessagesSchema();
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
}

export async function bootstrapCriticalColumns(): Promise<void> {
  try {
    await ensureSchoolsTimezoneColumn();
    await ensureStudentPhotoColumns();
    await ensureOnTimeTestModeColumns();
    await ensureParentMessagesSchema();
    await ensurePulseDnaVideosSchema();
  } catch (err) {
    logger.error({ err }, "[boot] critical column bootstrap failed");
    throw err;
  }
}
