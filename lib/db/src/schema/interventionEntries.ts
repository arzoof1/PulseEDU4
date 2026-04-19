import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";

// Mirrors pbis_entries: stores the snapshot of the intervention name (text) at
// the time of logging so deactivating/renaming a master-list row never alters
// historical entries.
export const interventionEntriesTable = pgTable("intervention_entries", {
  id: serial("id").primaryKey(),
  studentId: text("student_id").notNull(),
  interventionType: text("intervention_type").notNull(),
  note: text("note"),
  staffId: integer("staff_id"),
  staffName: text("staff_name").notNull(),
  createdAt: text("created_at").notNull(),
});

export type InterventionEntryRow =
  typeof interventionEntriesTable.$inferSelect;
