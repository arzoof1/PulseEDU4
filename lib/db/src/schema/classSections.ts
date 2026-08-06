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
    // A teacher legitimately runs multiple sections in the same period — ESE
    // / self-contained / co-taught rooms (e.g. Intensive Reading 1, 2 and 3
    // all period 1). The old (teacher, period) unique key rejected real
    // rosters, so course_name is part of the key. Distinct courses in one
    // period coexist; only exact (teacher, period, course) duplicates collide
    // (the roster sync also de-dupes on this key before insert).
    teacherPeriodCourseUnique: uniqueIndex(
      "class_sections_teacher_period_course_unique",
    ).on(t.teacherStaffId, t.period, t.courseName),
  }),
);

export type ClassSectionRow = typeof classSectionsTable.$inferSelect;
