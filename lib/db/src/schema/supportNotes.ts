import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";

export const supportNotesTable = pgTable("support_notes", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  studentId: text("student_id").notNull(),
  noteType: text("note_type").notNull(),
  noteText: text("note_text").notNull(),
  staffName: text("staff_name").notNull(),
  createdAt: text("created_at").notNull(),
  // Set when the row was inserted by a CSV behavior importer. Powers
  // rollback: DELETE WHERE import_job_id = X. Nullable for UI-created
  // notes and pre-importer rows.
  importJobId: integer("import_job_id"),
});

export type SupportNoteRow = typeof supportNotesTable.$inferSelect;
