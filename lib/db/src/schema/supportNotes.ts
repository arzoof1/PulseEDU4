import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";

export const supportNotesTable = pgTable("support_notes", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull().default(1),
  studentId: text("student_id").notNull(),
  noteType: text("note_type").notNull(),
  noteText: text("note_text").notNull(),
  staffName: text("staff_name").notNull(),
  createdAt: text("created_at").notNull(),
});

export type SupportNoteRow = typeof supportNotesTable.$inferSelect;
