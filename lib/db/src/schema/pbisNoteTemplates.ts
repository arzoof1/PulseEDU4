import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";

// Per-school library of reusable note text for PBIS award entries.
// Editable by admin / PBIS coordinator / behavior specialist; pickable by
// any teacher when filling out an award note.
export const pbisNoteTemplatesTable = pgTable("pbis_note_templates", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull(),
  // Short label that shows in pickers ("Group on-task", "Quiet hallway", etc.)
  title: text("title").notNull(),
  // The note body that fills the textarea when the template is chosen.
  body: text("body").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at").notNull(),
  createdById: integer("created_by_id"),
});

export type PbisNoteTemplateRow = typeof pbisNoteTemplatesTable.$inferSelect;
