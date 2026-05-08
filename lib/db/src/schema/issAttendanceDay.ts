import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  date,
} from "drizzle-orm/pg-core";
import { pulloutsTable } from "./pullouts";

export const issAttendanceDayTable = pgTable(
  "iss_attendance_day",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    day: date("day").notNull(),
    // 'manual' (walk-in by ISS Teacher; green pill on the dashboard)
    // 'pullout' (period/partial via verified pullout flow; purple pill)
    // 'admin'   (multi-day discipline assignment via Admin Hub; blue pill)
    source: text("source").notNull(),
    pulloutId: integer("pullout_id").references(() => pulloutsTable.id, {
      onDelete: "set null",
    }),
    // Set when source='admin'. Points at the parent iss_admin_logs row so
    // the Admin Hub can show the full multi-day assignment in one place
    // and cancelling an assignment can soft-cancel every day at once.
    adminLogId: integer("admin_log_id"),
    // Set on rows that were auto-generated when the previous day was
    // marked Absent. Carries the original day forward for the "↻ rolled
    // from <date>" badge on the ISS Dashboard. NULL on the original row.
    rolledFromDate: date("rolled_from_date"),
    // Toggled true when admin clicks "Mark as served" on an absent row.
    // Suppresses rollover so an absent kid does not cascade forever.
    markedServed: boolean("marked_served").notNull().default(false),
    dispatchedByName: text("dispatched_by_name"),
    verifiedByName: text("verified_by_name"),
    presentPeriods: integer("present_periods").array().notNull().default([]),
    notes: text("notes"),
    addedById: integer("added_by_id"),
    addedByName: text("added_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // D5: include schoolId so two schools can both have a row for the same
    // student id on the same day (transferred students with reused ids).
    studentDayIdx: uniqueIndex("iss_attendance_day_student_day_idx").on(
      t.studentId,
      t.day,
      t.schoolId,
    ),
  }),
);

export type IssAttendanceDayRow = typeof issAttendanceDayTable.$inferSelect;
