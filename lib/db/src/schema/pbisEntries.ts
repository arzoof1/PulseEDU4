import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";

export const pbisEntriesTable = pgTable("pbis_entries", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  studentId: text("student_id").notNull(),
  reason: text("reason").notNull(),
  points: integer("points").notNull(),
  staffId: integer("staff_id"),
  staffName: text("staff_name").notNull(),
  createdAt: text("created_at").notNull(),
  voidedAt: text("voided_at"),
  voidedById: integer("voided_by_id"),
  voidedByName: text("voided_by_name"),
  voidReason: text("void_reason"),
});

export type PbisEntryRow = typeof pbisEntriesTable.$inferSelect;
