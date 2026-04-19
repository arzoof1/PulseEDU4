import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";

export const accommodationLogsTable = pgTable("accommodation_logs", {
  id: serial("id").primaryKey(),
  studentId: text("student_id").notNull(),
  accommodationId: integer("accommodation_id"),
  accommodation: text("accommodation").notNull(),
  period: integer("period"),
  staffId: integer("staff_id"),
  staffName: text("staff_name").notNull(),
  status: text("status").notNull().default("provided"),
  createdAt: text("created_at").notNull(),
});

export type AccommodationLogRow = typeof accommodationLogsTable.$inferSelect;
