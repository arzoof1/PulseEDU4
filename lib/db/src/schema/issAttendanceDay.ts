import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
  date,
} from "drizzle-orm/pg-core";
import { pulloutsTable } from "./pullouts";

export const issAttendanceDayTable = pgTable(
  "iss_attendance_day",
  {
    id: serial("id").primaryKey(),
    studentId: text("student_id").notNull(),
    day: date("day").notNull(),
    source: text("source").notNull(),
    pulloutId: integer("pullout_id").references(() => pulloutsTable.id, {
      onDelete: "set null",
    }),
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
    studentDayIdx: uniqueIndex("iss_attendance_day_student_day_idx").on(
      t.studentId,
      t.day,
    ),
  }),
);

export type IssAttendanceDayRow = typeof issAttendanceDayTable.$inferSelect;
