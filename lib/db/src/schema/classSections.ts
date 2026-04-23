import { pgTable, serial, text, integer, boolean, uniqueIndex } from "drizzle-orm/pg-core";

export const classSectionsTable = pgTable(
  "class_sections",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull().default(1),
    teacherStaffId: integer("teacher_staff_id").notNull(),
    period: integer("period").notNull(),
    courseName: text("course_name").notNull(),
    isPlanning: boolean("is_planning").notNull().default(false),
  },
  (t) => ({
    teacherPeriodUnique: uniqueIndex("class_sections_teacher_period_unique").on(
      t.teacherStaffId,
      t.period,
    ),
  }),
);

export type ClassSectionRow = typeof classSectionsTable.$inferSelect;
