import { pgTable, serial, text, integer, boolean, uniqueIndex } from "drizzle-orm/pg-core";

// Editable list of family-communication methods (Phone, Email, Parent Square, ...).
// Mirrors intervention_types: per-school, rename-preserving (id stable, logs
// snapshot the name), Active/Archived via `active`. Seeded with the three
// defaults on first read if the school has none.
export const communicationTypesTable = pgTable(
  "communication_types",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => ({
    schoolNameUnique: uniqueIndex(
      "communication_types_school_id_name_unique",
    ).on(t.schoolId, t.name),
  }),
);

export type CommunicationTypeRow = typeof communicationTypesTable.$inferSelect;
