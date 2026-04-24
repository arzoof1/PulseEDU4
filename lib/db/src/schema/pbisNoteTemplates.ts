import { pgTable, serial, text, integer, index } from "drizzle-orm/pg-core";

// Library of reusable note text for PBIS award entries.
// Two flavors of ownership:
//   - ownerScope='school'  + ownerStaffId=null  → school-wide, editable by
//     admin / behavior specialist / MTSS coordinator. Visible to all staff.
//   - ownerScope='teacher' + ownerStaffId=<id>  → owned by that teacher,
//     editable by them (or admin), visible to them only.
export const pbisNoteTemplatesTable = pgTable(
  "pbis_note_templates",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull(),
    createdById: integer("created_by_id"),
    ownerScope: text("owner_scope").notNull().default("school"),
    ownerStaffId: integer("owner_staff_id"),
  },
  (t) => ({
    schoolOwnerIdx: index("pbis_note_templates_school_owner_idx").on(
      t.schoolId,
      t.ownerScope,
      t.ownerStaffId,
    ),
  }),
);

export type PbisNoteTemplateRow = typeof pbisNoteTemplatesTable.$inferSelect;
