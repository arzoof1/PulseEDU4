import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";

export const studentsTable = pgTable("students", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  studentId: text("student_id").notNull().unique(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  grade: integer("grade").notNull(),
  parentName: text("parent_name"),
  parentEmail: text("parent_email"),
  parentPhone: text("parent_phone"),
  // Optional PBIS house affiliation (FK to houses.id). Nullable so existing
  // students remain valid; populated by seed (round-robin) and by the
  // forthcoming admin houses screen.
  houseId: integer("house_id"),
  // Set when the row was inserted by a CSV roster importer. Lets the
  // History tab roll back a botched import: DELETE WHERE import_job_id = X.
  // Nullable because UI-created students and pre-importer rows have no job.
  importJobId: integer("import_job_id"),
});

export type StudentRow = typeof studentsTable.$inferSelect;
