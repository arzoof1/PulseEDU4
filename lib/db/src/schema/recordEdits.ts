import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";

export const recordEditsTable = pgTable("record_edits", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull().default(1),
  recordType: text("record_type").notNull(),
  recordId: text("record_id").notNull(),
  fieldName: text("field_name").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  editedBy: text("edited_by").notNull(),
  editedAt: text("edited_at").notNull(),
});

export type RecordEditRow = typeof recordEditsTable.$inferSelect;
