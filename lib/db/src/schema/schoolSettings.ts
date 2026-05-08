import { pgTable, serial, text, integer, boolean, uniqueIndex, jsonb } from "drizzle-orm/pg-core";

// Per-school operational settings. As of D4 there is exactly one row per
// school (enforced by `school_settings_school_id_unique`). Routes
// read-or-create the row for `req.schoolId` so a brand-new school gets
// sensible defaults the first time anyone opens its Settings page.
export const schoolSettingsTable = pgTable(
  "school_settings",
  {
    id: serial("id").primaryKey(),
    // Tenant column. NOT NULL DEFAULT 1 stays as a safety net until every
    // INSERT path is explicit — same pattern as the rest of the D2 work.
    schoolId: integer("school_id").notNull(),
    schoolName: text("school_name").notNull().default("PulseED"),
  fromName: text("from_name").notNull().default("PulseED"),
  emailSignature: text("email_signature").notNull().default("Thank you,\nPulseED"),
  periodCount: integer("period_count").notNull().default(7),
  hallPassMaxMinutes: integer("hall_pass_max_minutes").notNull().default(30),
  hallPassDefaultMinutes: integer("hall_pass_default_minutes")
    .notNull()
    .default(5),
  // Optional school-wide cap on the number of hall passes a student can take
  // in one school day. Null means no global cap.
  globalDailyHallPassLimit: integer("global_daily_hall_pass_limit"),
  // -----------------------------------------------------------------
  // ISS room daily seat capacity (Admin Hub).
  //   issDailyCapacity = max number of unique student-days the ISS room
  //     can hold per day (counts walk-in + pullout + admin-logged
  //     together). NULL = no cap.
  //   issCapacityBehavior = 'soft' shows a confirm prompt on save when
  //     the chosen day is at/over capacity (admin can override). 'hard'
  //     refuses the save. Rollover always bypasses the check (with a
  //     dashboard badge so ISS Teacher sees the over-cap state).
  // -----------------------------------------------------------------
  issDailyCapacity: integer("iss_daily_capacity"),
  issCapacityBehavior: text("iss_capacity_behavior").notNull().default("soft"),
  // PBIS Hub "Needs Attention" thresholds
  pbisQuietTeacherDays: integer("pbis_quiet_teacher_days").notNull().default(5),
  pbisInvisibleStudentDays: integer("pbis_invisible_student_days")
    .notNull()
    .default(10),
  pbisReasonImbalancePct: integer("pbis_reason_imbalance_pct")
    .notNull()
    .default(60),
  pbisColdPeriodMultiple: integer("pbis_cold_period_multiple")
    .notNull()
    .default(5),
  // When true, awarding a negative behavior subtracts its point value from
  // the student's running total. When false (default), the entry is logged
  // on the student's record as a red entry but does not affect the total.
  pbisNegativeAffectsTotal: boolean("pbis_negative_affects_total")
    .notNull()
    .default(false),
  // -----------------------------------------------------------------
  // Per-school feature flags (two-tier model).
  //
  //   super_feature_*  → SuperUser-controlled "is this feature available
  //                       to this school at all?" (the billing tier).
  //   feature_*        → Admin-controlled "do we want it on right now?"
  //
  // A feature is live when BOTH switches are on. Admins cannot enable a
  // feature whose super_* flag is off. Defaults are TRUE so existing
  // schools see no change in behavior.
  // -----------------------------------------------------------------
  featureFamilyComm: boolean("feature_family_comm").notNull().default(true),
  featurePbis: boolean("feature_pbis").notNull().default(true),
  featureSchoolStore: boolean("feature_school_store").notNull().default(true),
  featureAccommodations: boolean("feature_accommodations").notNull().default(true),
  featureLogIntervention: boolean("feature_log_intervention").notNull().default(true),
  featureRequestPullout: boolean("feature_request_pullout").notNull().default(true),
  // Expanded sellable feature catalog (T1 of school-plans work).
  featureHallPasses: boolean("feature_hall_passes").notNull().default(true),
  featureTardyPass: boolean("feature_tardy_pass").notNull().default(true),
  featureMtssPlans: boolean("feature_mtss_plans").notNull().default(true),
  featureBehaviorSpecialist: boolean("feature_behavior_specialist").notNull().default(true),
  featureIssDashboard: boolean("feature_iss_dashboard").notNull().default(true),
  featureDisplays: boolean("feature_displays").notNull().default(true),
  featureBellSchedule: boolean("feature_bell_schedule").notNull().default(true),
  featureEarlyWarning: boolean("feature_early_warning").notNull().default(true),
  featureAcademics: boolean("feature_academics").notNull().default(true),
  featureDataImports: boolean("feature_data_imports").notNull().default(true),
  featureHouses: boolean("feature_houses").notNull().default(true),
  featureParentPortal: boolean("feature_parent_portal").notNull().default(true),
  superFeatureFamilyComm: boolean("super_feature_family_comm").notNull().default(true),
  superFeaturePbis: boolean("super_feature_pbis").notNull().default(true),
  superFeatureSchoolStore: boolean("super_feature_school_store").notNull().default(true),
  superFeatureAccommodations: boolean("super_feature_accommodations").notNull().default(true),
  superFeatureLogIntervention: boolean("super_feature_log_intervention").notNull().default(true),
  superFeatureRequestPullout: boolean("super_feature_request_pullout").notNull().default(true),
  superFeatureHallPasses: boolean("super_feature_hall_passes").notNull().default(true),
  superFeatureTardyPass: boolean("super_feature_tardy_pass").notNull().default(true),
  superFeatureMtssPlans: boolean("super_feature_mtss_plans").notNull().default(true),
  superFeatureBehaviorSpecialist: boolean("super_feature_behavior_specialist").notNull().default(true),
  superFeatureIssDashboard: boolean("super_feature_iss_dashboard").notNull().default(true),
  superFeatureDisplays: boolean("super_feature_displays").notNull().default(true),
  superFeatureBellSchedule: boolean("super_feature_bell_schedule").notNull().default(true),
  superFeatureEarlyWarning: boolean("super_feature_early_warning").notNull().default(true),
  superFeatureAcademics: boolean("super_feature_academics").notNull().default(true),
  superFeatureDataImports: boolean("super_feature_data_imports").notNull().default(true),
  superFeatureHouses: boolean("super_feature_houses").notNull().default(true),
  superFeatureParentPortal: boolean("super_feature_parent_portal").notNull().default(true),
  // Advisory pointer to the tier_presets row last applied to this
  // school. The actual flags above are still authoritative — this is
  // purely so the School Plans grid can show "Currently: Pro" badges.
  tierPresetId: integer("tier_preset_id"),
  // -----------------------------------------------------------------
  // School-wide expectations (PRIDE / equivalent). Used as the optional
  // row on the Tier 3 weekly form when a plan opts in. The acronym is
  // displayed as the row label; `letters` is the per-letter breakdown
  // shown in tooltips and on the school's printable expectations page.
  // -----------------------------------------------------------------
  schoolWideExpectationAcronym: text("school_wide_expectation_acronym")
    .notNull()
    .default("PRIDE"),
  schoolWideExpectationLetters: jsonb("school_wide_expectation_letters")
    .$type<Array<{ letter: string; word: string }>>()
    .notNull()
    .default([
      { letter: "P", word: "Prepared" },
      { letter: "R", word: "Respectful" },
      { letter: "I", word: "Integrity" },
      { letter: "D", word: "Determined" },
      { letter: "E", word: "Engaged" },
    ]),
  },
  (t) => ({
    schoolIdUnique: uniqueIndex("school_settings_school_id_unique").on(
      t.schoolId,
    ),
  }),
);

export type SchoolSettingsRow = typeof schoolSettingsTable.$inferSelect;
