import {
  cleanupLooseSeedInteractionsOnce,
  ensureWatchlistSchema,
  seedEngagementEventsIfEmpty,
  seedFastScoresIfEmpty,
  seedHousesIfEmpty,
  seedIfEmpty,
  seedIreadyAndSciIfEmpty,
  seedMtssPlansIfEmpty,
  seedPbisCatalogIfEmpty,
  seedPbisEntriesIfEmpty,
  seedSafetyPlanLibraryIfEmpty,
  seedSafetyPlansIfEmpty,
  seedSeparationReasonTagsIfEmpty,
  seedStudentDemographicsIfEmpty,
  seedStudentRaceIfEmpty,
  seedTenancy,
  seedTieredInterventionsIfEmpty,
  seedWatchlistIfEmpty,
  seedWatchlistQuickEntriesIfEmpty,
} from "./seed";

// IMPORTANT: sequential, not Promise.all. seedIfEmpty() reads the schools table
// that seedTenancy() populates, so on a fresh database the order matters.
// Running these in parallel can race and leave the seed with zero schools to
// attach data to.
export async function runSeed(): Promise<void> {
  await seedTenancy();
  await seedIfEmpty();
  // One-shot sweep of loose (case_id IS NULL) demo interactions left over from
  // prior seed runs. Demo-school-gated; safe no-op once empty.
  await cleanupLooseSeedInteractionsOnce();
  // Runs after the main seed so studentsTable is populated. Idempotent
  // per-school: skipped for any school that already has at least one plan.
  await seedMtssPlansIfEmpty();
  // Tier-aware demo data for intervention plans, groups, and bell surfaces.
  await seedTieredInterventionsIfEmpty();
  // Same pattern: ensure schema + skip-if-non-empty per school.
  await seedFastScoresIfEmpty();
  await seedIreadyAndSciIfEmpty();
  await seedHousesIfEmpty();
  await seedEngagementEventsIfEmpty();
  await seedPbisCatalogIfEmpty();
  await seedSeparationReasonTagsIfEmpty();
  await seedPbisEntriesIfEmpty();
  await seedStudentDemographicsIfEmpty();
  await seedStudentRaceIfEmpty();
  await seedSafetyPlanLibraryIfEmpty();
  await seedSafetyPlansIfEmpty();
  await ensureWatchlistSchema();
  await seedWatchlistIfEmpty();
  await seedWatchlistQuickEntriesIfEmpty();
}
