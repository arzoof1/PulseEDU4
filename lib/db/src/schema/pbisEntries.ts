import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";

export const pbisEntriesTable = pgTable("pbis_entries", {
  id: serial("id").primaryKey(),
  studentId: text("student_id").notNull(),
  reason: text("reason").notNull(),
  points: integer("points").notNull(),
  staffId: integer("staff_id"),
  staffName: text("staff_name").notNull(),
  createdAt: text("created_at").notNull(),
});

export type PbisEntryRow = typeof pbisEntriesTable.$inferSelect;
