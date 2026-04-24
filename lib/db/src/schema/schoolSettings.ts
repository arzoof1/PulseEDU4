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
  },
  (t) => ({
    schoolIdUnique: uniqueIndex("school_settings_school_id_unique").on(
      t.schoolId,
    ),
  }),
);

export type SchoolSettingsRow = typeof schoolSettingsTable.$inferSelect;
