import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";

export const schoolSettingsTable = pgTable("school_settings", {
  id: serial("id").primaryKey(),
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
});

export type SchoolSettingsRow = typeof schoolSettingsTable.$inferSelect;
