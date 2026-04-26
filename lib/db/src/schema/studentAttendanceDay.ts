import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
  date,
} from "drizzle-orm/pg-core";

export const studentAttendanceDayTable = pgTable(
  "student_attendance_day",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    day: date("day").notNull(),
    status: text("status").notNull(),
    absentPeriods: integer("absent_periods").array().notNull().default([]),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    studentDayIdx: uniqueIndex("student_attendance_day_student_day_idx").on(
      t.studentId,
      t.day,
      t.schoolId,
    ),
  }),
);

export type StudentAttendanceDayRow =
  typeof studentAttendanceDayTable.$inferSelect;
