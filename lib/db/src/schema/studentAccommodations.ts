import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

export const studentAccommodationsTable = pgTable("student_accommodations", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  studentId: text("student_id").notNull(),
  accommodationId: integer("accommodation_id").notNull(),
  assignedAt: timestamp("assigned_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  assignedByStaffId: integer("assigned_by_staff_id"),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  removedByStaffId: integer("removed_by_staff_id"),
});

export type StudentAccommodationRow =
  typeof studentAccommodationsTable.$inferSelect;
