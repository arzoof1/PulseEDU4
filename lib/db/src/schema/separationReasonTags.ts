import { pgTable, serial, text, integer, boolean, uniqueIndex } from "drizzle-orm/pg-core";

// Per-school catalog of "why these students shouldn't sit together" tags.
// Curated by the Behavior Specialist (and Admin / DA / SU / Counselor /
// Guidance Counselor / Dean / School Psychologist / MTSS Coordinator).
// Teachers pick from this dropdown when filing a Separation Suggestion in
// Teacher Roster, which makes the data aggregable for the scheduling team
// (e.g. "show me all 'verbal conflict' pairs in Grade 8") and gives the BS
// a single place to standardize vocabulary across the staff.
//
// Tags are deactivated rather than deleted so historical Separation
// Suggestions that reference a retired tag stay readable in reports.
export const separationReasonTagsTable = pgTable(
  "separation_reason_tags",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
  },
  (t) => ({
    schoolLabelUnique: uniqueIndex(
      "separation_reason_tags_school_label_unique",
    ).on(t.schoolId, t.label),
  }),
);

export type SeparationReasonTagRow =
  typeof separationReasonTagsTable.$inferSelect;
