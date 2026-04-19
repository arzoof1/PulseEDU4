import { pgTable, serial, integer, text, uniqueIndex } from "drizzle-orm/pg-core";

export const sectionRosterTable = pgTable(
  "section_roster",
  {
    id: serial("id").primaryKey(),
    sectionId: integer("section_id").notNull(),
    studentId: text("student_id").notNull(),
  },
  (t) => ({
    sectionStudentUnique: uniqueIndex("section_roster_section_student_unique").on(
      t.sectionId,
      t.studentId,
    ),
  }),
);

export type SectionRosterRow = typeof sectionRosterTable.$inferSelect;
