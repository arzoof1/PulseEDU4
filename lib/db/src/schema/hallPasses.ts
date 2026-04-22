import { pgTable, serial, text, integer, boolean } from "drizzle-orm/pg-core";

export const hallPassesTable = pgTable("hall_passes", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull().default(1),
  studentId: text("student_id").notNull(),
  destination: text("destination").notNull(),
  originRoom: text("origin_room").notNull(),
  teacherName: text("teacher_name").notNull(),
  destinationTeacher: text("destination_teacher"),
  contactedAcknowledged: boolean("contacted_acknowledged").notNull().default(false),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  maxDurationMinutes: integer("max_duration_minutes").notNull(),
  endedAt: text("ended_at"),
  isTardyReturn: boolean("is_tardy_return").notNull().default(false),
});

export type HallPassRow = typeof hallPassesTable.$inferSelect;
