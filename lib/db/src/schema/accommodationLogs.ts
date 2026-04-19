import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";

export const accommodationLogsTable = pgTable("accommodation_logs", {
  id: serial("id").primaryKey(),
  studentId: text("student_id").notNull(),
  accommodation: text("accommodation").notNull(),
  period: integer("period"),
  staffName: text("staff_name").notNull(),
  createdAt: text("created_at").notNull(),
});

export type AccommodationLogRow = typeof accommodationLogsTable.$inferSelect;
