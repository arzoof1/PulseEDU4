import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";

// Per-student PBIS goals. Goals are evaluated client-side against the loaded
// pbis_entries for the relevant period.
//   period_type: 'week' (Mon-Sun), 'month', 'quarter', or 'all'
//   reason:      null = any reason; otherwise must match an entry's reason text
export const pbisGoalsTable = pgTable("pbis_goals", {
  id: serial("id").primaryKey(),
  // Tenant column (D2 backfill). Routes filter by req.schoolId.
  schoolId: integer("school_id").notNull().default(1),
  studentId: text("student_id").notNull(),
  reason: text("reason"),
  targetPoints: integer("target_points").notNull(),
  periodType: text("period_type").notNull(),
  createdById: integer("created_by_id"),
  createdByName: text("created_by_name").notNull(),
  createdAt: text("created_at").notNull(),
  archivedAt: text("archived_at"),
});

export type PbisGoalRow = typeof pbisGoalsTable.$inferSelect;
