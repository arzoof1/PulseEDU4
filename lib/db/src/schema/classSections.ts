import { pgTable, serial, text, integer, boolean, uniqueIndex } from "drizzle-orm/pg-core";

export const classSectionsTable = pgTable(
  "class_sections",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    teacherStaffId: integer("teacher_staff_id").notNull(),
    period: integer("period").notNull(),
    courseName: text("course_name").notNull(),
    isPlanning: boolean("is_planning").notNull().default(false),
  },
  (t) => ({
    // A teacher can teach the same course/period at MULTIPLE schools (shared /
    // itinerant staff rows are district-global). The unique key must therefore
    // include school_id — otherwise Sync All fails when two schools share a
    // teacher+period+course (seen on Nature Coast after Parrott/Springstead).
    teacherPeriodCourseUnique: uniqueIndex(
      "class_sections_school_teacher_period_course_unique",
    ).on(t.schoolId, t.teacherStaffId, t.period, t.courseName),
  }),
);

export type ClassSectionRow = typeof classSectionsTable.$inferSelect;
