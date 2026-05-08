import {
  pgTable,
  serial,
  text,
  integer,
  date,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// Teacher acknowledgements for the ISS soft-reminder banner. One row per
// (teacher, period, day, student) when the teacher clicks "Posted in
// Canvas" or "Sent hard copy" on the banner. The banner is dismissed
// for that teacher/period/day once any acknowledgement is recorded.
//
// Used by the Admin Hub rollup ("3 of 5 teachers acknowledged for
// Marcus's ISS today") and is intentionally non-blocking — a teacher who
// never clicks does not lose any functionality.
export const issAcknowledgementsTable = pgTable(
  "iss_assignment_acknowledgements",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    teacherStaffId: integer("teacher_staff_id").notNull(),
    teacherName: text("teacher_name").notNull(),
    period: integer("period").notNull(),
    day: date("day").notNull(),
    method: text("method").notNull(), // 'canvas' | 'hardcopy'
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqByPeriodDay: uniqueIndex("iss_ack_period_day_uq").on(
      t.schoolId,
      t.studentId,
      t.teacherStaffId,
      t.period,
      t.day,
    ),
    bySchoolDay: index("iss_ack_school_day").on(t.schoolId, t.day),
  }),
);

export type IssAcknowledgementRow =
  typeof issAcknowledgementsTable.$inferSelect;
