import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// Admin-logged ISS assignment (parent record). One row per "assignment"
// (e.g., 3-day ISS for fighting). The per-day rows live in
// iss_attendance_day with source='admin' and admin_log_id pointing here.
//
// Created from the Admin Hub + Add ISS Log modal. Distinct from:
//   - iss_roster.source='manual' (walk-in by ISS Teacher; green pill)
//   - iss_roster.source='pullout' / iss_attendance_day source='pullout'
//     (period/partial day from the verified pullout flow; purple pill)
// This table powers the BLUE pill on the ISS Dashboard.
export const issAdminLogsTable = pgTable(
  "iss_admin_logs",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    studentId: text("student_id").notNull(),
    reasonId: integer("reason_id"),
    reasonText: text("reason_text"),
    notes: text("notes"),
    createdById: integer("created_by_id").notNull(),
    createdByName: text("created_by_name").notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledById: integer("cancelled_by_id"),
    cancelledByName: text("cancelled_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    bySchool: index("iss_admin_logs_by_school").on(t.schoolId),
    byStudent: index("iss_admin_logs_by_student").on(t.schoolId, t.studentId),
  }),
);

export type IssAdminLogRow = typeof issAdminLogsTable.$inferSelect;
