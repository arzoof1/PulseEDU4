import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";

// Mirrors pbis_entries: stores the snapshot of the intervention name (text) at
// the time of logging so deactivating/renaming a master-list row never alters
// historical entries.
export const interventionEntriesTable = pgTable("intervention_entries", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  studentId: text("student_id").notNull(),
  interventionType: text("intervention_type").notNull(),
  // Snapshot of the behavior (pbis_reasons.name) this intervention was logged
  // to address, captured at log time. Nullable: standalone interventions
  // (logged without a paired behavior) leave this null. Drives the
  // "what has worked before for this student" effectiveness insight by tying
  // an intervention to the behavior whose recurrence we then check for.
  behaviorReason: text("behavior_reason"),
  note: text("note"),
  staffId: integer("staff_id"),
  staffName: text("staff_name").notNull(),
  createdAt: text("created_at").notNull(),
});

export type InterventionEntryRow =
  typeof interventionEntriesTable.$inferSelect;
