import { pgTable, serial, text, integer, boolean } from "drizzle-orm/pg-core";

export const hallPassesTable = pgTable("hall_passes", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
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
  // "Go now" line-bypass passes (student summoned to office/guidance/clinic).
  // Flagged so admins can audit who skipped the waiting queue and spot
  // patterns of overuse. Never set for normal or queued passes.
  priorityBypass: boolean("priority_bypass").notNull().default(false),
  // One-way pass lifecycle. Non-restroom passes are one-way: the student
  // leaves the origin ("in route") and is checked in / received at the
  // destination. `arrivedAt` records WHEN the check-in happened and
  // `endedBy` records WHO received them (staff displayName, or "(origin)"
  // when the origin teacher closed it, "(system)" for automated close).
  // Restroom passes stay round-trip (no destination check-in) — they end
  // on the "I'm back" return at the origin, leaving these null.
  arrivedAt: text("arrived_at"),
  endedBy: text("ended_by"),
  // Set once when the overdue-in-route alert has fired for this pass, so the
  // sweep notifies each stranded student exactly once. Null = not yet alerted.
  overdueAlertedAt: text("overdue_alerted_at"),
});

export type HallPassRow = typeof hallPassesTable.$inferSelect;
