import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  date,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// OSS (out-of-school suspension) admin-logged assignment. OSS has no
// daily roster (the kid is not at school), so we don't share the
// iss_attendance_day machinery. Instead:
//   - oss_logs is the parent assignment record
//   - oss_log_days is one row per assigned day (drives teacher-roster
//     "OSS" pill and parent-portal OSS section)
// No automatic absence rollover for OSS in v1 (admin manually adds days).
export const ossLogsTable = pgTable(
  "oss_logs",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    reasonId: integer("reason_id"),
    reasonText: text("reason_text"),
    notes: text("notes"),
    // Admin-entered "days for reports" — parallel to iss_admin_logs.day_count.
    // Independent of oss_log_days rows so reports can count assigned days
    // without re-deriving them from per-day rows.
    dayCount: integer("day_count"),
    createdById: integer("created_by_id").notNull(),
    createdByName: text("created_by_name").notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledById: integer("cancelled_by_id"),
    cancelledByName: text("cancelled_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    bySchool: index("oss_logs_by_school").on(t.schoolId),
    byStudent: index("oss_logs_by_student").on(t.schoolId, t.studentId),
  }),
);

export type OssLogRow = typeof ossLogsTable.$inferSelect;

export const ossLogDaysTable = pgTable(
  "oss_log_days",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    logId: integer("log_id").notNull(),
    studentId: text("student_id").notNull(),
    day: date("day").notNull(),
    cancelled: boolean("cancelled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byLog: index("oss_log_days_by_log").on(t.logId),
    byStudentDay: uniqueIndex("oss_log_days_student_day_uq").on(
      t.schoolId,
      t.studentId,
      t.day,
    ),
    bySchoolDay: index("oss_log_days_by_school_day").on(t.schoolId, t.day),
  }),
);

export type OssLogDayRow = typeof ossLogDaysTable.$inferSelect;
