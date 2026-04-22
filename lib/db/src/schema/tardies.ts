import { pgTable, serial, text } from "drizzle-orm/pg-core";

export const tardiesTable = pgTable("tardies", {
  id: serial("id").primaryKey(),
  studentId: text("student_id").notNull(),
  teacherName: text("teacher_name").notNull(),
  period: text("period").notNull(),
  reason: text("reason").notNull(),
  entryType: text("entry_type").notNull(),
  checkInWith: text("check_in_with"),
  notes: text("notes").notNull(),
  createdBy: text("created_by"),
  createdAt: text("created_at").notNull(),
});

export type TardyRow = typeof tardiesTable.$inferSelect;
