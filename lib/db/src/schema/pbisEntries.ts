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
  // 'positive' (green) or 'negative' (red). Independent of the sign of `points`
  // because schools can choose to log negatives without subtracting from the
  // student's total — see school_settings.pbisNegativeAffectsTotal.
  polarity: text("polarity").notNull().default("positive"),
  // Optional free-text note attached at award time. Useful for bulk awards
  // ("Class earned this together because…") and for context teachers want
  // visible on a student's record.
  note: text("note"),
});

export type PbisEntryRow = typeof pbisEntriesTable.$inferSelect;
