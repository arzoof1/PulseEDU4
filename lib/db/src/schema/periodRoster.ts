import { pgTable, serial, text, integer, uniqueIndex } from "drizzle-orm/pg-core";

export const periodRosterTable = pgTable(
  "period_roster",
  {
    id: serial("id").primaryKey(),
    period: integer("period").notNull(),
    studentId: text("student_id").notNull(),
  },
  (t) => ({
    periodStudentUnique: uniqueIndex("period_student_unique").on(
      t.period,
      t.studentId,
    ),
  }),
);

export type PeriodRosterRow = typeof periodRosterTable.$inferSelect;
