import { pgTable, serial, text, integer, boolean, uniqueIndex } from "drizzle-orm/pg-core";

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
  superFeatureFamilyComm: boolean("super_feature_family_comm").notNull().default(true),
  superFeaturePbis: boolean("super_feature_pbis").notNull().default(true),
  superFeatureSchoolStore: boolean("super_feature_school_store").notNull().default(true),
  superFeatureAccommodations: boolean("super_feature_accommodations").notNull().default(true),
  superFeatureLogIntervention: boolean("super_feature_log_intervention").notNull().default(true),
  superFeatureRequestPullout: boolean("super_feature_request_pullout").notNull().default(true),
  // Beta / hidden feature: SuperUser-only toggle for the Academic
  // Trajectories dashboard. Single-tier (no admin sibling) because the
  // SuperUser controls visibility directly. Default FALSE — opt-in per
  // school, since the surface overlaps with the existing Academics
  // dashboard and isn't ready to ship to every customer yet. When ON,
  // only admins + SuperUsers see the tile (teachers never do).
  superFeatureTrajectories: boolean("super_feature_trajectories").notNull().default(false),
  },
  (t) => ({
    schoolIdUnique: uniqueIndex("school_settings_school_id_unique").on(
      t.schoolId,
    ),
  }),
);

export type SchoolSettingsRow = typeof schoolSettingsTable.$inferSelect;
